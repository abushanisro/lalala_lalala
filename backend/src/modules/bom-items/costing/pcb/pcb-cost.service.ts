import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../../../common/database/database.service';
import type { DbClient } from '../../../../common/db/postgrest-client';
import { CalculatorCatalogService } from '../../services/calculator-catalog.service';
import type { CostContext } from '../casting/casting-finishing';
import { lineToLocal } from '../casting/sand/sand-cost';
import { SandMachineService } from '../casting/sand/sand-machine.service';
import type { SandReference } from '../casting/sand/sand-reference';
import { readStagedReference } from '../casting/sand/sand-reference.service';
import type { PcbGeometrySummary } from './board-graph/pcb-geometry';
import { loadPcbCalculatorSpec } from './calculators/pcb-calculator-spec';
import { laminateOf } from './pcb-laminates';
import { PCB_FINISHES, resolvePcbPart, type PcbFinish, type PcbMeasured, type PcbOverrides, type PcbPart } from './pcb-part';
import { PCB_SOURCE_VERSION } from './pcb-reference';
import {
  PCB_PROCESS_GROUP, PCB_ROUTE_CLASSES, PCB_ROUTES, buildPcbRoutes, choosePcbRoute,
  type PcbFinishOption, type PcbLaminate, type PcbRoute, type PcbRouteGap, type PcbRouteKey,
} from './pcb-route';
import type { PcbStackup } from './pcb-stackup';
import type { PcbNest } from './pcb-panel';

/** The Cost Guide keys of a printed circuit board (scenario_overrides). */
export const PCB_KEYS = {
  route: 'pcbRoute', layers: 'pcbLayers', thickness: 'pcbThicknessMm', outerOz: 'pcbOuterCopperOz', innerOz: 'pcbInnerCopperOz', finish: 'pcbFinish',
  maskSides: 'pcbSolderMaskSides', legendSides: 'pcbLegendSides', testPoints: 'pcbTestPoints', stackup: 'pcbStackupPreference', viaPlugging: 'pcbViaPlugging',
} as const;

type Obj = Record<string, unknown>;
const num = (v: unknown): number | null => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const obj = (v: unknown): Obj => (v && typeof v === 'object' ? (v as Obj) : {});
const sum = (v: unknown): number | null => {
  const o = obj(v);
  const t = (num(o['top']) ?? 0) + (num(o['bottom']) ?? 0);
  return t > 0 ? t : null;
};

/** The board as the routes take it, from a board set's measurement (feature_graph.summary.pcbGeometry: the CAD engine's board feature graph). */
export function pcbMeasuredFrom(g: PcbGeometrySummary | null | undefined): PcbMeasured | null {
  if (!g?.graph) return null;
  const graph = g.graph;
  const outline = obj(graph['outline']);
  const connectivity = obj(graph['connectivity']);
  const copper = obj(graph['copper']);
  return {
    source: 'board_files', sourceName: g.sourceName,
    outline: num(outline['lengthMm']) && num(outline['widthMm']) ? { lengthMm: num(outline['lengthMm'])!, widthMm: num(outline['widthMm'])!, areaMm2: num(outline['areaMm2']) } : null,
    thicknessMm: num(outline['thicknessMm']),
    layers: num(graph['layers']),
    holes: Array.isArray(graph['holes']) ? (graph['holes'] as Obj[]).map((h) => ({ diameterMm: Number(h['diameterMm']), plated: h['plated'] === true, count: Number(h['count']) })) : null,
    soldermask: obj(obj(graph['fabrication'])['soldermask']) as { top?: boolean; bottom?: boolean },
    silkscreen: obj(obj(graph['fabrication'])['silkscreen']) as { top?: boolean; bottom?: boolean },
    pins: num(connectivity['pins']), nets: num(connectivity['netsWithPins']),
    pasteAreaMm2: sum(graph['pasteAreaMm2']), copperAreaMm2: sum(copper['areaMm2']),
    placements: Array.isArray(graph['placements']) ? (graph['placements'] as Obj[]).map((p) => ({ side: p['side'] === 'bottom' ? 'bottom' as const : 'top' as const, packageClass: String(p['packageClass'] ?? 'unknown'), count: Number(p['count']) || 0, ...(p['footprint'] ? { footprint: String(p['footprint']) } : {}) })) : null,
    thtParts: Array.isArray(graph['thtParts']) ? (graph['thtParts'] as Obj[]).map((t) => ({ label: String(t['label']), count: Number(t['count']) || 0, jointsPerPart: Number(t['jointsPerPart']) || 0 })) : null,
    sidesPopulated: Array.isArray(graph['sidesPopulated']) ? (graph['sidesPopulated'] as string[]).filter((s): s is 'top' | 'bottom' => s === 'top' || s === 'bottom') : null,
  };
}

/** The Cost Guide's board values. */
export function pcbOverridesFrom(o: Obj): PcbOverrides {
  const finish = String(o[PCB_KEYS.finish] ?? '').toLowerCase();
  const plug = o[PCB_KEYS.viaPlugging];
  return {
    layers: num(o[PCB_KEYS.layers]), thicknessMm: num(o[PCB_KEYS.thickness]), outerCopperOz: num(o[PCB_KEYS.outerOz]), innerCopperOz: num(o[PCB_KEYS.innerOz]),
    finish: (PCB_FINISHES as readonly string[]).includes(finish) ? (finish as PcbFinish) : null,
    soldermaskSides: num(o[PCB_KEYS.maskSides]), silkscreenSides: num(o[PCB_KEYS.legendSides]), testPoints: num(o[PCB_KEYS.testPoints]),
    stackupPreference: num(o[PCB_KEYS.stackup]), viaPlugging: plug === true || plug === 'true' ? true : plug === false || plug === 'false' ? false : null,
  };
}

export interface PcbCostRequest {
  client: DbClient;
  accessToken: string;
  location: string;
  geometry: PcbGeometrySummary | null | undefined;
  forceRoute?: string;
  overrides: Obj | null | undefined;
  batchSize: number;
  annualVolume: number | null;
  amortizationParts: number | null;
  /** USD -> the location's currency. */
  usdToLocal: number;
  costContext: CostContext;
}

export interface PcbCostResult {
  /** The quoted route in the location's currency; null when none can be built (see `missing`). */
  route: PcbRoute | null;
  routes: PcbRoute[];
  gaps: PcbRouteGap[];
  part: PcbPart | null;
  stackup: PcbStackup | null;
  nest: PcbNest | null;
  finishOptions: PcbFinishOption[];
  note: string | null;
  missing: string[];
  warnings: string[];
}

/** One route in the location's currency (built in USD, the units of HR Rates and the reference data); its tooling stays in USD. */
function routeToLocal(route: PcbRoute, usdToLocal: number): PcbRoute {
  if (usdToLocal === 1) return route;
  return {
    ...route,
    lines: route.lines.map((l) => lineToLocal(l, usdToLocal)),
    material: { ...route.material, costUsd: route.material.costUsd * usdToLocal },
    totalUsd: route.totalUsd != null ? Math.round(route.totalUsd * usdToLocal * 100) / 100 : null,
  };
}

/**
 * Prices a printed circuit board: the board measured from its files (pcbGeometry) and the Cost Guide's values, the staged memory/PCBA reference,
 * the PCB calculators (from the database), the machines of the location and the laminates; every route (pcb-route.ts) in the location's currency.
 */
@Injectable()
export class PcbCostService {
  constructor(
    private readonly database: DatabaseService,
    private readonly machines: SandMachineService,
    private readonly catalog: CalculatorCatalogService,
  ) {}

  private cached: SandReference | null = null;

  /** The staged memory/PCBA variables, stack-up tables and sourced tables (read once; a read error is reported and not cached). */
  async reference(): Promise<{ reference: SandReference | null; missing: string[] }> {
    if (this.cached) return { reference: this.cached, missing: [] };
    const read = await readStagedReference(this.database, PCB_SOURCE_VERSION, PCB_PROCESS_GROUP, 823);
    if (read.reference) this.cached = read.reference;
    return read;
  }

  /** The PCB laminates of raw_materials (material group PCB, migration 855): price per m² and dielectric. */
  async laminates(client: DbClient): Promise<PcbLaminate[]> {
    const { data, error } = await client.from('raw_materials').select('id, name, base_cost_per_unit_usd').eq('material_group', PCB_PROCESS_GROUP);
    if (error || !data) return [];
    const rows = data as { id: string; name: string; base_cost_per_unit_usd: unknown }[];
    const { data: props } = await client.from('raw_material_properties').select('raw_material_id, value_num')
      .eq('property_key', 'dielectric_thickness').in('raw_material_id', rows.map((r) => r.id));
    const dielectric = new Map(((props ?? []) as { raw_material_id: string; value_num: unknown }[]).map((p) => [p.raw_material_id, num(p.value_num)]));
    return rows.map((r) => laminateOf({ id: r.id, name: r.name, usdPerM2: num(r.base_cost_per_unit_usd), dielectricMm: dielectric.get(r.id) ?? null }));
  }

  async price(req: PcbCostRequest): Promise<PcbCostResult> {
    const warnings: string[] = [];
    const none = (part: PcbPart | null, ...missing: string[]): PcbCostResult => ({ route: null, routes: [], gaps: [], part, stackup: null, nest: null, finishOptions: [], note: null, missing, warnings });
    const [{ reference, missing: refMissing }, calculators, machines, laminates] = await Promise.all([
      this.reference(),
      this.catalog.loadPcbCalculators(req.accessToken),
      this.machines.getMachinesByClass(req.client, PCB_ROUTE_CLASSES, req.location),
      this.laminates(req.client),
    ]);
    if (!reference) return none(null, ...refMissing);
    const { part, missing: partMissing } = resolvePcbPart(pcbMeasuredFrom(req.geometry), pcbOverridesFrom(req.overrides ?? {}), {
      thicknessMm: reference.number('defaultBoardThickness'), copperOz: reference.number('defaultCopperLayerWeight'),
      soldermaskSides: reference.number('defaultNumSolderMaskSides'), viaPlugging: reference.flag('defaultEnableViaPlugging'),
    });
    if (!part) return none(null, ...partMissing);
    const spec = loadPcbCalculatorSpec();
    const absent = spec.calculators.filter((c) => !calculators[c.name]).map((c) => c.name);
    if (absent.length) return none(part, `the PCB calculators are not in the database (run migration 1132): ${absent.slice(0, 3).join(', ')}${absent.length > 3 ? ', ...' : ''}`);
    if (!Object.values(machines).some((m) => m.length > 0)) return none(part, `HR Rates has no PCB machines for ${req.location}`);
    if (!laminates.some((l) => l.usdPerM2 != null)) return none(part, 'Raw Materials has no PCB laminate with a price per square metre (material group PCB)');
    if (req.location !== 'USA') warnings.push(`The laminates are priced at the reference's USA price per square metre: it holds none for ${req.location}.`);

    const keyOf = (v: unknown): PcbRouteKey | null => PCB_ROUTES.find((r) => r.key === v)?.key ?? null;
    const chosen = keyOf(req.forceRoute) ?? keyOf((req.overrides ?? {})[PCB_KEYS.route]);
    const built = buildPcbRoutes({
      ref: reference, spec, calculators, part, laminates, machinesByClass: machines, costContext: req.costContext,
      scenario: { batchSize: req.batchSize, annualVolume: req.annualVolume, amortizationParts: req.amortizationParts, route: chosen },
    });
    if (built.missing.length) return { ...none(part, ...built.missing), stackup: built.stackup, nest: built.nest };
    const { route, note } = choosePcbRoute(built.routes, built.gaps, chosen);
    if (!route) return { ...none(part, ...built.gaps.map((g) => `${g.label}: ${g.reason}`)), gaps: built.gaps, stackup: built.stackup, nest: built.nest };
    const local = built.routes.map((r) => routeToLocal(r, req.usdToLocal));
    const finishOptions = built.finishOptions.map((f) => ({ ...f, totalUsd: f.totalUsd != null ? Math.round(f.totalUsd * req.usdToLocal * 100) / 100 : null }));
    return {
      route: local[built.routes.indexOf(route)]!, routes: local, gaps: built.gaps, part, stackup: built.stackup, nest: built.nest, finishOptions,
      note, missing: [], warnings: [...warnings, ...route.warnings],
    };
  }
}
