// A Multi-Spindle Machining part priced on each route, in the location's currency. Pure.
//
// Every route makes the part from the same bar (multi-spindle-stock.ts), each part carrying its share of the bar: the Bar Stock calculator
// (migration 1095) with the bar end the feeder cannot use (BAR_REMNANT_MM). A route's lines are its Simultaneous Turning line on its
// cheapest capable machine (multi-spindle-route.ts), the in-cycle operations the data could not time (named gaps, never priced) and the
// turning engine's lines that run off the machine (deburring, inspection, grinding, ...), which are the same on every route.
import { BAR_REMNANT_MM, BAR_REMNANT_SOURCE } from './multi-spindle-research';
import {
  MULTI_SPINDLE_CALC, MULTI_SPINDLE_MACHINE_CLASS, MULTI_SPINDLE_PROCESS_GROUP, buildMultiSpindleRoutes, chooseMultiSpindleRoute, keyName,
  type MultiSpindleRoute, type SplitRules,
} from './multi-spindle-route';
import { multiSpindleWork, type HoleGroupWork, type ThreadGroupWork } from './multi-spindle-work';
import { gap, type CostContext } from '../casting/casting-finishing';
import { lineToLocal } from '../casting/sand/sand-cost';
import { seedsFor, type SeedProvider } from '../casting/sand/sand-seeds';
import { runReferenceCalculator, type CalcSeed, type ReferenceCalcRun, type ReferenceCalculatorDef } from '../shared/calculators/reference-calculator';
import { derivedSeed, inputStep, resultStep } from '../shared/calculators/seed-refs';

import type { SelectedBar } from './multi-spindle-stock';
import type { ProcessLineCost } from '../../dto/cost-breakdown.dto';
import type { SandMachine } from '../casting/sand/sand-machines';
import type { SandReference } from '../casting/sand/sand-reference';
import type { DomainCalculatorSpec } from '../shared/calculators/domain-calculator-spec';




/** The part's material as the bar is priced: its density and the price of the bar form at the location. */
export interface MultiSpindleMaterial {
  id: string | null;
  name: string;
  densityKgM3: number | null;
  /** USD per kg; null when the location has no price for the form. */
  pricePerKgUsd: number | null;
  priceSource: string;
}

/** The part as the turning engine measured it: its length along the turning axis and its volume. */
export interface MultiSpindlePart {
  lengthMm: number;
  volumeMm3: number;
}

/** What each part takes of the bar. The cost is in the location's currency, null when it cannot be priced (`missing` says why). */
export interface MultiSpindleStock {
  run: ReferenceCalcRun | null;
  partsPerBar: number | null;
  /** The bar bought per part (its share of the whole bar, remnant included) and the part's own mass, kg. */
  massPerPartKg: number | null;
  partKg: number | null;
  pricePerKgUsd: number | null;
  cost: number | null;
  missing: string | null;
}

export interface MultiSpindleRouteQuote extends Omit<MultiSpindleRoute, 'line'> {
  /** In the location's currency: the route's Simultaneous Turning line, the untimed in-cycle operations, the lines off the machine. */
  lines: ProcessLineCost[];
  /** Lines and bar, in the location's currency. */
  total: number;
}

export interface MultiSpindleQuote {
  stock: MultiSpindleStock;
  routes: MultiSpindleRouteQuote[];
  route: MultiSpindleRouteQuote | null;
  /** The quoted route's machine fits, every in-cycle operation is timed and the bar is priced. */
  complete: boolean;
  warnings: string[];
}

const round = (n: number, d: number) => Math.round(n * 10 ** d) / 10 ** d;

/** The Bar Stock calculator on the part's bar: what each part takes of it and costs (USD), or what it lacks. */
export function barStock(input: {
  ref: SandReference;
  spec: DomainCalculatorSpec;
  calculators: Readonly<Record<string, ReferenceCalculatorDef>>;
  bar: SelectedBar;
  part: Pick<MultiSpindlePart, 'lengthMm' | 'volumeMm3'>;
  material: MultiSpindleMaterial;
}): { run: ReferenceCalcRun | null; missing: string | null } {
  const calc = input.spec.calculators.find((c) => c.name === MULTI_SPINDLE_CALC.stock);
  if (!calc) return { run: null, missing: `${MULTI_SPINDLE_CALC.stock} is not in the calculator spec` };
  const { bar, material } = input;
  // The Multi-Spindle reference (memory/Multi-Spindle Maching) is the staged domain multi_spindle: its variables and tables open there.
  const DOMAIN = 'multi_spindle';
  const fact = (value: number, source: string, label: string, unit: string | null, why: string): CalcSeed =>
    derivedSeed(value, source, label, [inputStep(label, unit, value, source), resultStep(label, unit, value, why)]);
  const materialRef = (column: string) => (material.id ? { kind: 'material' as const, materialId: material.id, materialName: material.name, column } : undefined);
  const engine: Record<string, CalcSeed | null> = {
    part_length_mm: fact(input.part.lengthMm, 'CAD: the part\'s length along its turning axis', 'Part Length', 'mm', 'as measured'),
    bar_section_area_mm2: derivedSeed(bar.sectionAreaMm2, `${bar.sizeLabel}: its cross-section`, 'Bar section', [
      inputStep('Bar size', 'mm', bar.sizeMm, bar.snapped ? `tblPreferredSizes: ${bar.sizeLabel}, the first preferred size at least the ${round(bar.requiredMm, 3)} mm needed` : 'the size needed (not snapped)',
        bar.snapped ? { kind: 'lookup', domain: DOMAIN, table: 'tblPreferredSizes', column: 'sizeMm', row: { sizeMm: bar.sizeMm } } : undefined),
      inputStep('Form', null, bar.form, 'the bar the part is turned from'),
      resultStep('Bar Section Area', 'mm²', bar.sectionAreaMm2, bar.form === 'hex' ? '√3/2 x {Bar size}²' : bar.form === 'square' ? '{Bar size}²' : 'π/4 x {Bar size}²'),
    ]),
    bar_remnant_mm: fact(BAR_REMNANT_MM, BAR_REMNANT_SOURCE, 'Bar Remnant', 'mm', 'the bar end the feeder cannot use'),
    price_per_kg: material.pricePerKgUsd != null ? derivedSeed(material.pricePerKgUsd, material.priceSource, 'Bar price', [
      inputStep('Material', null, material.name, material.priceSource, materialRef('name')), resultStep('Price per kg', 'USD/kg', material.pricePerKgUsd, 'the bar\'s price at the location'),
    ]) : null,
  };
  const variable: SeedProvider = (name) => {
    const value = input.ref.number(name);
    return value == null ? null : { value, source: `Multi-Spindle variable ${name}${input.ref.unit(name) ? ` (${input.ref.unit(name)})` : ''}`, ref: { kind: 'variable', domain: DOMAIN, name } };
  };
  // The tblPartingRingWidth row the parting width was read from: the first whose diameter covers the bar's corners, else the last.
  const rings = input.ref.table('tblPartingRingWidth').map((r) => Number(r['diameterMm'])).filter(Number.isFinite).sort((a, b) => a - b);
  const ringRow = rings.find((d) => d >= bar.circumscribedMm - 1e-9) ?? rings.at(-1);
  const { seeds, missing } = seedsFor(calc, {
    engine: (source) => engine[keyName(source)] ?? null,
    variable,
    lookup: (source) => (source === 'tblPartingRingWidth.ringWidthMm'
      ? {
        value: bar.partingWidthMm, source: `tblPartingRingWidth: the parting tool for a bar up to Ø${round(bar.circumscribedMm, 1)} mm across its corners`,
        ...(ringRow != null ? { ref: { kind: 'lookup' as const, domain: DOMAIN, table: 'tblPartingRingWidth', column: 'ringWidthMm', row: { diameterMm: ringRow } } } : {}),
      }
      : null),
    material: (column) => (column === 'density_kg_m3' && material.densityKgM3 != null
      ? {
        value: material.densityKgM3, source: `${material.name}: density_kg_m3`,
        ...(material.id ? { ref: { kind: 'material' as const, materialId: material.id, materialName: material.name, column } } : {}),
      }
      : null),
  });
  if (missing.length) return { run: null, missing: `${MULTI_SPINDLE_CALC.stock}: ${missing.join(', ')}` };
  const run = runReferenceCalculator(input.calculators, MULTI_SPINDLE_CALC.stock, seeds, 'Material Cost');
  return run.value == null ? { run: null, missing: run.missing.join('; ') } : { run, missing: null };
}

/** The part's operations timed for a machine: what the multi-spindle work is built from. */
export interface MultiSpindleEngine {
  lines: readonly ProcessLineCost[]; liveMilling: readonly string[]; holes: readonly HoleGroupWork[]; threads: readonly ThreadGroupWork[];
  turned: readonly { diameterMm: number; lengthMm: number }[];
}

export function quoteMultiSpindle(input: {
  ref: SandReference;
  spec: DomainCalculatorSpec;
  calculators: Readonly<Record<string, ReferenceCalculatorDef>>;
  machines: readonly SandMachine[];
  rules: SplitRules;
  bar: SelectedBar;
  part: MultiSpindlePart;
  material: MultiSpindleMaterial;
  /**
   * The turning engine's lines on the bar (in the location's currency), which of them a live tool mills (by name), the holes timed by
   * diameter group, the threads by size, and the cylinders it turns down from the bar (each one's diameter and length), as a machine does
   * them: timed on its own spindle limits. null: no machine of the route takes the part, the operations as the turning rate times them.
   */
  engineFor: (m: SandMachine | null) => MultiSpindleEngine;
  /** A route set by hand (Cost Guide) or priced on its own (the route comparison). */
  chosen: string | null;
  batchSize: number;
  costContext: CostContext;
  usdToLocal: number;
}): MultiSpindleQuote {
  const { bar, part } = input;
  const material = barStock(input);
  const outputs = material.run?.outputs ?? {};
  const partKg = input.material.densityKgM3 != null && part.volumeMm3 > 0 ? (part.volumeMm3 / 1e9) * input.material.densityKgM3 : null;
  const stock: MultiSpindleStock = {
    run: material.run,
    partsPerBar: outputs['Parts per Bar'] ?? null,
    massPerPartKg: outputs['Mass per Part'] ?? null,
    partKg,
    pricePerKgUsd: input.material.pricePerKgUsd,
    cost: material.run?.value != null ? material.run.value * input.usdToLocal : null,
    missing: material.missing,
  };

  // The part's work as each machine does it (its operations timed on that machine's spindle limits), built once a machine.
  const works = new Map<SandMachine | null, ReturnType<typeof multiSpindleWork>>();
  const workOf = (m: SandMachine | null) => {
    const held = works.get(m);
    if (held) return held;
    const engine = input.engineFor(m);
    const work = multiSpindleWork({
      lines: engine.lines, liveMilling: engine.liveMilling, holes: engine.holes, threads: engine.threads,
      partLengthMm: part.lengthMm, partVolumeMm3: part.volumeMm3,
      turned: engine.turned, barSectionAreaMm2: bar.sectionAreaMm2, stockLengthMm: part.lengthMm + bar.facingStockMm,
    });
    works.set(m, work);
    return work;
  };
  const built = buildMultiSpindleRoutes({
    ref: input.ref, spec: input.spec, calculators: input.calculators, machines: input.machines, rules: input.rules,
    workFor: (m) => ({ ops: workOf(m).ops, barCircumscribedMm: bar.circumscribedMm, lengthPerPartMm: bar.lengthPerPartMm }),
    batchSize: input.batchSize, costContext: input.costContext,
  });
  // A route's lines are its machine's: the operations it cannot time, and those off the machine, as that machine's work states them.
  const gapsOf = (m: SandMachine | null) => workOf(m).gaps;
  const routes: MultiSpindleRouteQuote[] = built.map(({ line, ...route }) => {
    const work = workOf(route.machine);
    const gapLines = work.gaps.map((g) => gap(g.process, MULTI_SPINDLE_PROCESS_GROUP, MULTI_SPINDLE_MACHINE_CLASS, g.reason));
    const lines = [lineToLocal(line, input.usdToLocal), ...gapLines, ...work.offMachine];
    return { ...route, lines, total: round(lines.reduce((s, l) => s + l.totalCost, 0) + (stock.cost ?? 0), 2) };
  });
  const quoted = chooseMultiSpindleRoute(routes, input.chosen, (r) => r.total);
  const gaps = gapsOf(quoted?.machine ?? null);
  const warnings = [
    ...(quoted?.warnings ?? []),
    ...(stock.missing ? [`The bar is not priced: ${stock.missing}. The total excludes it.`] : []),
    ...(gaps.length ? [`Not timed on the machine: ${gaps.map((g) => g.process).join(', ')}. The total excludes them.`] : []),
  ];
  return { stock, routes, route: quoted, complete: !!quoted?.complete && gaps.length === 0 && stock.cost != null, warnings };
}
