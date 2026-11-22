import { Injectable } from '@nestjs/common';

import { loadRollFormingCalculatorSpec } from './calculators/roll-forming-calculator-spec';
import { rollFormPart, type RollFormGeometrySummary, type RollFormPart } from './roll-forming-part';
import {
  buildRollFormingRoutes, chooseRollFormingRoute, rollFormingRule, ROLL_FORMING_KEYS, ROLL_FORMING_PROCESS_GROUP, ROLL_FORMING_ROUTE_CLASSES,
  ROLL_FORMING_ROUTES, WELDING_PROCESS, type RollFormingMaterial, type RollFormingRoute, type RollFormingRouteKey, type RollFormingRule, type WeldingKey,
} from './roll-forming-route';
import { DatabaseService } from '../../../../common/database/database.service';
import { escapeLikePattern, quoteFilterValue } from '../../../../common/db/postgrest-filter';
import { CalculatorCatalogService } from '../../services/calculator-catalog.service';
import { CastingReferenceService } from '../casting/casting-reference.service';
import { lineToLocal } from '../casting/sand/sand-cost';
import { SandMachineService } from '../casting/sand/sand-machine.service';
import { readStagedReference } from '../casting/sand/sand-reference.service';

import type { DbClient } from '../../../../common/db/postgrest-client';
import type { CostContext } from '../casting/casting-finishing';
import type { SandReference } from '../casting/sand/sand-reference';

export const ROLL_FORMING_SOURCE_VERSION = '2026-RollForm';
/** The material strengths the line reads (raw_material_properties of memory/Sheet metal roll forming's materials, migration 855). */
const PROPERTY_KEYS = ['tensile_yield_strength', 'ultimate_tensile_strength', 'shear_strength'] as const;

export interface RollFormingCostRequest {
  client: DbClient;
  accessToken: string;
  location: string;
  /** The grade the process prices (MaterialResolutionService.gradeForProcess: the part's own, or its closest roll forming material). */
  grade: string | null;
  geometry: RollFormGeometrySummary | null | undefined;
  /** The part's sheet thickness (mm), when the measurement gives none. */
  sheetThicknessMm?: number | null;
  forceRoute?: string;
  overrides: Record<string, unknown> | null | undefined;
  batchSize: number;
  amortizationParts: number | null;
  /** USD -> the location's currency. */
  usdToLocal: number;
  costContext: CostContext;
}

export interface RollFormingCostResult {
  /** The quoted route in the location's currency; null when none can be built (see `missing`). */
  route: RollFormingRoute | null;
  routes: RollFormingRoute[];
  rule: RollFormingRule | null;
  part: RollFormPart | null;
  material: RollFormingMaterial | null;
  note: string | null;
  missing: string[];
  warnings: string[];
}

const num = (v: unknown): number | null => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const positive = (v: unknown): number | null => {
  const n = num(v);
  return n != null && n > 0 ? n : null;
};
const r2 = (n: number) => Math.round(n * 100) / 100;

/** One route in the location's currency (it is built in USD, the units of HR Rates and the reference data); its tooling stays in USD. */
function routeToLocal(route: RollFormingRoute, usdToLocal: number): RollFormingRoute {
  if (usdToLocal === 1) return route;
  return {
    ...route,
    lines: route.lines.map((l) => lineToLocal(l, usdToLocal)),
    material: { ...route.material, costUsd: route.material.costUsd * usdToLocal },
    totalUsd: route.totalUsd != null ? r2(route.totalUsd * usdToLocal) : null,
  };
}

/** The Cost Guide's settings of a roll formed part (scenario_overrides), each null when not set or not one of its values. */
export function rollFormingOverrides(o: Record<string, unknown> | null | undefined): { cutOff: RollFormingRouteKey | null; stations: number | null; welding: WeldingKey | null; toolingMultiplier: number | null } {
  const v = o ?? {};
  const cut = String(v[ROLL_FORMING_KEYS.cutOff] ?? '').trim().toLowerCase();
  const weld = String(v[ROLL_FORMING_KEYS.welding] ?? '').trim().toLowerCase();
  const stations = num(v[ROLL_FORMING_KEYS.stations]);
  return {
    cutOff: ROLL_FORMING_ROUTES.find((r) => r.key === cut)?.key ?? null,
    stations: stations != null && stations >= 1 ? Math.round(stations) : null,
    welding: (Object.keys(WELDING_PROCESS) as WeldingKey[]).find((k) => k === weld) ?? null,
    toolingMultiplier: positive(v[ROLL_FORMING_KEYS.toolingMultiplier]),
  };
}

/**
 * Prices a roll formed sheet-metal profile: loads the staged memory/Sheet metal roll forming reference, the calculators (from the database), the
 * line's machines of the location, the tool shop and the material, builds both routes (roll-forming-route.ts) and returns them in the
 * location's currency.
 */
@Injectable()
export class RollFormingCostService {
  constructor(
    private readonly database: DatabaseService,
    private readonly machines: SandMachineService,
    private readonly catalog: CalculatorCatalogService,
    private readonly castingReference: CastingReferenceService,
  ) {}

  private cached: SandReference | null = null;
  private cachedOperations: string[] | null = null;

  /** The staged memory/Sheet metal roll forming variables and lookup tables (read once; a read error is reported and not cached). */
  async reference(): Promise<{ reference: SandReference | null; missing: string[] }> {
    if (this.cached) return { reference: this.cached, missing: [] };
    const read = await readStagedReference(this.database, ROLL_FORMING_SOURCE_VERSION, ROLL_FORMING_PROCESS_GROUP, 863);
    if (read.reference) this.cached = read.reference;
    return read;
  }

  /**
   * Memory's catalog of the line's processes (process_taxonomy_operations, staged from memory/Sheet metal roll forming/Processes): the
   * operation each step performs on each feature. Kept once read; a failed or empty read is not kept (the rows are then not shown, and
   * costing is unchanged).
   */
  private async operationCatalog(client: DbClient): Promise<string[]> {
    if (this.cachedOperations) return this.cachedOperations;
    const { data, error } = await client.from('process_taxonomy')
      .select('process_name, process_taxonomy_operations(raw_compound_string)')
      .eq('process_group', ROLL_FORMING_PROCESS_GROUP);
    if (error) return [];
    const rows = data as { process_taxonomy_operations?: { raw_compound_string?: string | null }[] | null }[];
    const raw = rows.flatMap((r) => (r.process_taxonomy_operations ?? []).map((o) => o.raw_compound_string ?? '').filter(Boolean));
    if (raw.length) this.cachedOperations = raw;
    return raw;
  }

  /**
   * The roll forming material whose name or grade equals `grade`, case-insensitively (raw_materials, material group Sheet Metal Roll Forming),
   * with its strengths (raw_material_properties) and its price at the location. The group's materials hold the USA price (cost_usa) only: in
   * India the price is cost_india of the same material in another group (Ferrous & Non-Ferrous prices most of them; cost_india is held in
   * USD), said; only when no group prices it there, the USA price, warned. Null when the grade is not one.
   */
  async getMaterial(client: DbClient, grade: string | null, location = 'USA'): Promise<{ material: RollFormingMaterial; warning: string | null } | null> {
    const g = (grade ?? '').trim();
    if (!g) return null;
    const { data, error } = await client.from('raw_materials')
      .select('id, name, grade, material_type, density_kg_m3, density, cost_usa')
      .eq('material_group', ROLL_FORMING_PROCESS_GROUP)
      .or(`name.ilike.${quoteFilterValue(escapeLikePattern(g))},grade.ilike.${quoteFilterValue(escapeLikePattern(g))}`)
      .limit(2);
    if (error || !data || data.length !== 1) return null;
    const row = data[0] as Record<string, unknown>;
    const { data: props } = await client.from('raw_material_properties').select('property_key, value_num').eq('raw_material_id', String(row.id)).in('property_key', [...PROPERTY_KEYS]);
    const p = Object.fromEntries(((props ?? []) as { property_key: string; value_num: unknown }[]).map((x) => [x.property_key, positive(x.value_num)]));
    const name = typeof row.name === 'string' ? row.name : typeof row.grade === 'string' ? row.grade : g;
    const usa = positive(row.cost_usa);
    let price = usa;
    let priceSource = `${ROLL_FORMING_PROCESS_GROUP} cost_usa`;
    let warning: string | null = null;
    if (location === 'India') {
      const { data: priced } = await client.from('raw_materials').select('material_group, cost_india')
        .neq('material_group', ROLL_FORMING_PROCESS_GROUP).ilike('name', escapeLikePattern(name)).not('cost_india', 'is', null)
        .order('material_group').limit(1);
      const hit = ((priced ?? []) as { material_group: string | null; cost_india: unknown }[]).find((x) => positive(x.cost_india) != null);
      if (hit) {
        price = positive(hit.cost_india);
        priceSource = `India: cost_india of ${name} in ${hit.material_group ?? 'another group'}`;
        warning = `The material price in India is cost_india of ${name} in the ${hit.material_group ?? 'another'} group (${price} USD/kg): the ${ROLL_FORMING_PROCESS_GROUP} materials hold the USA price only.`;
      } else {
        warning = `The material price is the reference's USA price (cost_usa ${usa ?? '?'} USD/kg): no group prices ${name} in India.`;
      }
    } else if (location !== 'USA') {
      warning = `The material price is the reference's USA price (cost_usa): it holds none for ${location}.`;
    }
    return {
      material: {
        id: String(row.id), name, materialType: typeof row.material_type === 'string' ? row.material_type : null,
        densityKgM3: positive(row.density_kg_m3) ?? (positive(row.density) != null ? positive(row.density)! * 1000 : null),
        costPerKgUsd: price, priceSource,
        utsMpa: p.ultimate_tensile_strength ?? null, yieldMpa: p.tensile_yield_strength ?? null, shearStrengthMpa: p.shear_strength ?? null,
      },
      warning,
    };
  }

  async price(req: RollFormingCostRequest): Promise<RollFormingCostResult> {
    const warnings: string[] = [];
    const none = (part: RollFormPart | null, material: RollFormingMaterial | null, ...missing: string[]): RollFormingCostResult =>
      ({ route: null, routes: [], rule: null, part, material, note: null, missing, warnings });
    const { part, missing: partMissing } = rollFormPart(req.geometry, req.sheetThicknessMm);
    if (!part) return none(null, null, ...partMissing);
    for (const what of part.unmeasured) warnings.push(`The cad-engine could not measure ${what}.`);
    const [{ reference, missing: refMissing }, calculators, machines, toolShop, operations, found] = await Promise.all([
      this.reference(),
      this.catalog.loadRollFormingCalculators(req.accessToken),
      this.machines.getMachinesByClass(req.client, ROLL_FORMING_ROUTE_CLASSES, req.location),
      this.castingReference.getToolShop(),
      this.operationCatalog(req.client),
      this.getMaterial(req.client, req.grade, req.location),
    ]);
    if (!reference) return none(part, null, ...refMissing);
    if (!found) return none(part, null, `"${req.grade ?? '(no material)'}" is not a roll forming material in Raw Materials (material group ${ROLL_FORMING_PROCESS_GROUP}): choose one in Material Grade`);
    const material = found.material;
    if (found.warning) warnings.push(found.warning);
    if (material.utsMpa == null || material.yieldMpa == null) {
      warnings.push(`${material.name} has no ${[material.utsMpa == null ? 'UTS' : null, material.yieldMpa == null ? 'yield strength' : null].filter(Boolean).join(' or ')} on file: `
        + 'the checks that read it (the ultra-high-strength shaft, the smallest hole, the coil flattener, the yield limit, the bend radius) go without it.');
    }
    const spec = loadRollFormingCalculatorSpec();
    const absent = spec.calculators.filter((c) => !(c.name in calculators)).map((c) => c.name);
    if (absent.length) return none(part, material, `the roll forming calculators are not in the database (run migration 1113): ${absent.slice(0, 3).join(', ')}${absent.length > 3 ? ', ...' : ''}`);
    if (!Object.values(machines).some((m) => m.length > 0)) return none(part, material, `HR Rates has no ${ROLL_FORMING_PROCESS_GROUP} machines for ${req.location}`);
    if (!toolShop.shop) warnings.push(`The press dies are not costed: ${toolShop.missing.join('; ')}.`);

    const o = rollFormingOverrides(req.overrides);
    const keyOf = (v: unknown): RollFormingRouteKey | null => ROLL_FORMING_ROUTES.find((r) => r.key === v)?.key ?? null;
    const chosen = keyOf(req.forceRoute) ?? o.cutOff;
    const { routes, missing } = buildRollFormingRoutes({
      ref: reference, spec, calculators, material, part, machinesByClass: machines, costContext: req.costContext, toolShop: toolShop.shop, catalog: operations,
      scenario: {
        batchSize: req.batchSize, route: chosen, stations: o.stations, welding: o.welding, toolingMultiplier: o.toolingMultiplier, amortizationParts: req.amortizationParts,
      },
    });
    if (missing.length) return none(part, material, ...missing);
    const rule = rollFormingRule(reference, part);
    const { route, note } = chooseRollFormingRoute(routes, rule, chosen);
    if (!route) return { ...none(part, material, 'no roll forming route could be built'), rule };
    // The USA machines are rated at the Netherlands export's overheads (migration 1112): said once, naming the quoted line's machines.
    const proxied = route.lines.filter((l) => l.mhrId && Object.values(machines).flat().some((m) => m.id === l.mhrId && typeof m.specs.rate_basis === 'string' && m.specs.rate_basis.includes('Netherlands')));
    if (proxied.length) {
      warnings.push(`The line's ${req.location} rates (${proxied.map((l) => l.process).join(', ')}) are the Netherlands export's overheads (no export lists the USA) with the USA labour of each wage grade (migration 1112).`);
    }
    warnings.push(
      `Disclosed (the engine's rules, agreed 2026-11-22; the data has none): the roll stations (bend levels in passes of at most rollFormingLiftAngle `
      + 'and of no more than the flange each level carries takes between the mill\'s stands), the line chosen whole at one speed (the slowest of its '
      + 'limits), the cycle (the feed at the line speed plus the line\'s stoppages a part), the roll tooling (multiplier x strip width x stations) '
      + 'and the compact press die model. The coil as supplied takes no machine time.',
    );
    if (req.overrides?.[ROLL_FORMING_KEYS.stations] != null && o.stations != null) warnings.push(`The roll stations are the Cost Guide's ${o.stations} (the rule gives ${route.stations.rule}).`);
    const local = routes.map((r) => routeToLocal(r, req.usdToLocal));
    return {
      route: local[routes.indexOf(route)], routes: local, rule, part, material, note, missing: [],
      warnings: [...warnings, ...route.warnings].filter((w, i, all) => all.indexOf(w) === i),
    };
  }
}
