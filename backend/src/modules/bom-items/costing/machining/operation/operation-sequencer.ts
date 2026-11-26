/**
 * Operation Sequencer — Feature → Ordered OperationLine[]
 *
 * Converts feature_graph_v2 features (from CAD engine) into a flat, ordered
 * list of CNC operations with per-feature cycle times. This is the core of
 * Fix 3 + Fix 4: feature-based time instead of (billetVol − partVol) / MRR.
 *
 * All times are in SECONDS. The caller converts to minutes for cost calculation.
 *
 * Design rules:
 * - No DB calls. Pure function — deterministic, testable, zero latency.
 * - MRR values are imported from cost-machining-engine.ts via the MaterialClass type.
 * - TAP_CYCLE_SEC is imported from default-rates.ts.
 * - When feature_graph_v2 is absent or empty, the caller falls back to the old
 *   (billetVol − partVol) / MRR formula — no regression for legacy data.
 * - The operations on the features do not remove the stock around the part: on a
 *   milled route that is one Bulk Milling operation, of the stock excess the
 *   caller gives (stock-excess.ts).
 * - An operation on the stock itself (the cut round a plate part's outline,
 *   stock-machining/perimeter-cut.ts) is given already timed by its own
 *   calculator, and takes its place in the sequence.
 *
 * ── Sheet-metal feature-driven routing backlog (see migration 381) ─────────
 * Sheet metal's Counterboring/Countersinking/PEM Insertion/Reaming/CMM Inspection/
 * Hole Extrusion (Burring) are now feature-driven (cost-engine.ts::computeCostSummary,
 * gated on the CAD feature summary counts). Hole extrusion (burled/
 * extruded hole flanges, e.g. drawing callout "2X M3 BURLING BACK CONVEX") was
 * added via a real coaxial-hole-cluster detector in feature_extractors.py
 * (geo_v40+, extruded_flange_count) — previously listed below as undetectable
 * via surface-deviation analysis; the coaxial-cluster approach found it instead.
 * The following requested process types are still deliberately NOT implemented —
 * as of 2026-07-30 the CAD engine (cad-engine/feature_extractors.py) has no
 * detector for them, and inventing a flag that always reads "not present" would
 * be indistinguishable from a real detector silently failing. Each needs real
 * detection work before it can be routed honestly:
 *
 *   Weld seams / spot welds / MIG-TIG-Laser weld — needs a weld-symbol/seam
 *     detector (drawing callout OCR extension to drawing_analyzer.py, or a
 *     seam-geometry detector in feature_extractors.py for multi-body assemblies).
 *   Rivets / clinch features — needs a fastener-pattern detector (hole diameter
 *     + spacing pattern matching, similar approach to sm_lookup_pem_hardware).
 *   Roll forming / hems / return flanges / jog bends — needs bend-topology
 *     classifiers beyond the current radius/angle bend detector (BendFeature
 *     in feature_extractors.py only reports count + radius today).
 *   Louvers / embosses / dimples / beads / coining — needs non-planar
 *     surface-deviation detectors on the dominant flat face (none of these
 *     show up as simple cylindrical/planar/conical faces).
 *   Tabs & slots as assembly features, GD&T-driven CMM beyond the tight-
 *     tolerance case, assembly/packaging triggers — need multi-part assembly
 *     context this per-part extractor doesn't have.
 *
 * Extension recipe for any of the above (same pattern used for counterbore/
 * countersink/PEM):
 *   1. Detect the feature in feature_extractors.py (or add an OCR extractor to
 *      drawing_analyzer.py for callout-based features like welds/threads).
 *   2. Emit it into manufacturing_intelligence.features (or drawing_intelligence).
 *   3. Carry it through auto-fill.service.ts's RawGeometry and feature summary,
 *      following the counterboreGroups/countersinkGroups precedent.
 *   4. Add a gated block in cost-engine.ts::computeCostSummary + a
 *      process_calculator_mappings row (+ sm_lookup_* cycle-time table if the
 *      op needs one) for the new operation.
 *
 * Packaging & Logistics already has its own manual/auto-on-material-set UI
 * section (unrelated to this routing engine) — not part of this backlog.
 */

import { computeBoreCycle, computeDrillCycle, computeTapCycle, DRILL_DEPTH_TO_DIAMETER_RATIO, detectMaterialClass, workbookCycle, largestDrillMm, type MachiningWorkbookInput } from '../process/cost-machining-engine';
import { runMachiningCalculator, type CalcRun, type CalcSeed, type MachiningCalculators, type PlannedRun } from '../calculators/machining-calculator';
import { calculationRef, graphFeatureRef, inputStep, MACHINING_REFERENCE_DOMAIN, resultStep, withSourceRef } from '../calculators/machining-source-refs';
import type { CalculationTraceStep, SourceRef } from '../../../dto/cost-breakdown.dto';
import type { FeatureOccurrenceRef } from '../feature-occurrences';
import type { MaterialClass } from '../process/cost-machining-engine';
import { isTurnedDiameter, type StockExcess } from './stock-excess';
import type { StockFacing } from '../../stock/stock-facing';
import { holeAxes, holeUnder } from './countersunk-holes';

// drillOp/tapOp below call the same calculators cost-machining-engine.ts uses
// (computeDrillCycle / computeTapCycle)
// instead of keeping their own separate hardcoded tables — this file used
// to carry THREE independent drilling-time models across the two files
// (this one's diameter-only drillFeedMmPerMin, cost-machining-engine.ts's flat
// DRILL_CYCLE_SEC buckets, and a duplicated MRR_MM3_PER_MIN admitted by its
// own comment to need manual sync with cost-machining-engine.ts's MILLING_MRR).
// One source of truth now for all three.

// Real drilling time for `count` holes (CAD Ø + CAD depth + tblDrilling), or
// the name of the missing real input — see computeDrillCycle.
function drillOp(
  diamMm: number,
  depthMm: number,
  count: number,
  materialGrade: string | null | undefined,
  workbook: MachiningWorkbookInput | null,
  calculators: MachiningCalculators | null,
  occurrences?: readonly FeatureOccurrenceRef[],
): Pick<OperationLine, 'timeSec' | 'missing' | 'plan'> {
  const cycle = computeDrillCycle(diamMm, materialGrade, depthMm > 0 ? depthMm : undefined, workbook, calculators, count, occurrences);
  const plan = cycle.plan ? { plan: [cycle.plan] } : {};
  return cycle.sec == null ? { timeSec: 0, missing: cycle.missing.join('; '), ...plan } : { timeSec: cycle.sec, ...plan };
}

// Real tapping time for `count` threads (thread size, pitch, CAD depth +
// tblTapping), or the name of the missing real input — see computeTapCycle.
function tapOp(
  spec: string | null | undefined,
  count: number,
  matClass: MaterialClass,
  pitchMm: number | undefined,
  depthMm: number | undefined,
  workbook: MachiningWorkbookInput | null,
  calculators: MachiningCalculators | null,
  occurrences?: readonly FeatureOccurrenceRef[],
): Pick<OperationLine, 'timeSec' | 'missing' | 'plan'> {
  if (!spec) return { timeSec: 0, missing: 'a thread size' };
  const cycle = computeTapCycle({ size: spec, count, pitchMm, depthMm: depthMm && depthMm > 0 ? depthMm : undefined, ...(occurrences?.length ? { occurrences } : {}) }, matClass, workbook, calculators);
  const plan = cycle.plan ? { plan: [cycle.plan] } : {};
  return cycle.sec == null ? { timeSec: 0, missing: cycle.missing.join('; '), ...plan } : { timeSec: cycle.sec, ...plan };
}

// Every milling operation below is timed by its stored calculator (machining-calculators.json, "Machining - Facing",
// "- Rough Milling", "- Fine Finish Milling", ...): this file states which operation a feature needs and hands the
// calculator the feature's CAD measurements; it holds no time, rate or factor of its own.

/** The finishing cutter of a material class (tblMillingFinishing): the end mill used where a feature forces no smaller one, and how it runs. */
export interface MillingFinishingRow {
  toolDiameterMm: number;
  teeth: number;
  cuttingSpeedMPerMin: number;
  /** Feed per tooth over the tool diameter: the chip load scales with the cutter. */
  feedPerToothPerDiameter: number;
}

interface PocketFinishGroup { toolMm: number; floorMm2: number; wallMm2: number; pockets: number; occ: number[] }

/**
 * The finishing passes of a group of pockets, one entry per cutter. A pocket's floor is its CAD length x width and its
 * depth the measured depth_mm (an analysis from before that measurement: the removed volume over the floor). The cutter
 * is the standard finishing end mill, or the pocket's width when walls on both sides confine it to less (width_confined;
 * an open step does not). A cutter as wide as the pocket leaves both walls finished, so walls (the walled share of the
 * perimeter x depth) are a separate pass only where the cutter is narrower than the floor. null = a pocket has no CAD size.
 */
function pocketFinishGroups(occurrences: any[], standardToolMm: number): PocketFinishGroup[] | null {
  const groups = new Map<number, PocketFinishGroup>();
  for (const [i, o] of occurrences.entries()) {
    const [lengthMm, widthMm] = (Array.isArray(o.extents_mm) ? o.extents_mm.map(Number) : []).sort((a: number, b: number) => b - a);
    if (!(lengthMm > 0 && widthMm > 0)) return null;
    const confined = o.width_confined !== false;
    const toolMm = confined ? Math.max(0.1, Math.min(standardToolMm, Math.floor(widthMm * 10) / 10)) : standardToolMm;
    const floorMm2 = lengthMm * widthMm;
    const depthMm = o.depth_mm > 0 ? Number(o.depth_mm) : (o.material_removed_mm3 ?? 0) / floorMm2;
    const walledShare = typeof o.walled_fraction === 'number' ? o.walled_fraction : 1;
    const g = groups.get(toolMm) ?? { toolMm, floorMm2: 0, wallMm2: 0, pockets: 0, occ: [] };
    g.floorMm2 += floorMm2;
    if (!confined || widthMm > standardToolMm) g.wallMm2 += walledShare * 2 * (lengthMm + widthMm) * depthMm;
    g.pockets += 1;
    g.occ.push(i);
    groups.set(toolMm, g);
  }
  return [...groups.values()].sort((a, b) => b.toolMm - a.toolMm);
}

/** The end mill a cut takes: the material's own, or the cut's width when walls on both sides confine it to less (an open step does not). */
function cutterFor(widthMm: number, confined: boolean, standardToolMm: number): number {
  return confined ? Math.max(0.1, Math.min(standardToolMm, Math.floor(widthMm * 10) / 10)) : standardToolMm;
}

/** Cuts of one size, roughed or slotted alike by one cutter. */
interface CutGroup { lengthMm: number; widthMm: number; depthMm: number; depthSource: string; toolMm: number; cuts: number; occ: number[] }

/**
 * A feature's occurrences by size and cutter: those of one length, width, depth and cutter are cut alike (the workbook's End, Slot and
 * Plunge Milling sheets time one cut and multiply it by the uses). `size` reads an occurrence's CAD length, width and depth; null = an
 * occurrence lacks one, and the whole feature is a named gap, never priced on the others alone.
 */
function cutGroups(
  occurrences: any[],
  size: (o: any) => { lengthMm: number; widthMm: number; depthMm: number; depthSource: string; confined: boolean } | null,
  standardToolMm: number,
): CutGroup[] | null {
  const groups = new Map<string, CutGroup>();
  for (const [i, o] of occurrences.entries()) {
    const z = size(o);
    if (!z || !(z.lengthMm > 0 && z.widthMm > 0 && z.depthMm > 0)) return null;
    const toolMm = cutterFor(z.widthMm, z.confined, standardToolMm);
    const key = `${z.lengthMm}|${z.widthMm}|${z.depthMm}|${toolMm}`;
    const g = groups.get(key) ?? { lengthMm: z.lengthMm, widthMm: z.widthMm, depthMm: z.depthMm, depthSource: z.depthSource, toolMm, cuts: 0, occ: [] };
    g.cuts += 1;
    g.occ.push(i);
    groups.set(key, g);
  }
  return [...groups.values()];
}

/**
 * A pocket's or a slot's size: its floor's CAD box (extents_mm, longest first) and its measured depth (an analysis from before that
 * measurement: the removed volume over the floor's length x width).
 */
function floorSize(o: any): { lengthMm: number; widthMm: number; depthMm: number; depthSource: string; confined: boolean } | null {
  const [lengthMm, widthMm] = (Array.isArray(o.extents_mm) ? o.extents_mm.map(Number) : []).sort((a: number, b: number) => b - a);
  if (!(lengthMm > 0 && widthMm > 0)) return null;
  const measured = Number(o.depth_mm) > 0;
  const depthMm = measured ? Number(o.depth_mm) : Number(o.material_removed_mm3 ?? 0) / (lengthMm * widthMm);
  return {
    lengthMm, widthMm, depthMm, confined: o.width_confined !== false,
    depthSource: measured ? 'CAD: depth' : 'CAD: removed volume over the floor length x width (no measured depth)',
  };
}

/** A flat's size: the CAD length along the turned diameter, its chord width and its depth below the diameter. Open: nothing confines the cutter. */
function flatSize(o: any): { lengthMm: number; widthMm: number; depthMm: number; depthSource: string; confined: boolean } | null {
  const lengthMm = Number(o.length_mm);
  const widthMm = Number(o.width_mm);
  const depthMm = Number(o.depth_mm);
  return lengthMm > 0 && widthMm > 0 && depthMm > 0 ? { lengthMm, widthMm, depthMm, depthSource: 'CAD: depth below the diameter', confined: false } : null;
}

/** A value of a material class's tblMillingFinishing row, as a calculator input that names the table, the row and the column. */
export function finishingTableSeed(matClass: MaterialClass, value: number, column: string, note = ''): CalcSeed {
  const row = { MaterialClass: matClass };
  return {
    value, lookup: true, source: `tblMillingFinishing: ${matClass} ${column}${note}`, match: { table: 'tblMillingFinishing', row },
    ref: { kind: 'lookup', domain: MACHINING_REFERENCE_DOMAIN, table: 'tblMillingFinishing', column, row },
  };
}

/** A value of a material class's tblMillingFinishing row scaled by its machinability: the row's value, the factor, and the product. */
function machinabilityRef(name: string, base: CalcSeed, factor: number, value: number, unit: string): SourceRef {
  return calculationRef(name, [
    inputStep(`${name} (table)`, unit, base.value, base.source, base.ref),
    inputStep('Machinability factor', null, factor, 'The material\'s machinability rating over the mild-steel baseline of 75 (Raw Materials record)'),
    resultStep(name, unit, value, `${name} (table) x Machinability factor`),
  ]);
}

/**
 * How an end mill runs in a material, whatever its diameter (the chip load is per diameter): the inputs every tool-path calculator reads
 * (the finishing passes, a keyway's slotting, the cut round a plate part's outline). Empty when the material's cutter is not on file.
 */
export function cutterRunSeeds(finishing: MillingFinishingRow | null, matClass: MaterialClass, machinabilityFactor: number): Record<string, CalcSeed> {
  if (!finishing) return {};
  return {
    'Teeth': finishingTableSeed(matClass, finishing.teeth, 'Teeth'),
    'Cutting Speed': machinabilityFactor === 1
      ? finishingTableSeed(matClass, finishing.cuttingSpeedMPerMin, 'CuttingSpeedMPerMin', ` ${finishing.cuttingSpeedMPerMin} m/min x machinability factor ${machinabilityFactor}`)
      : (() => {
        const seed = finishingTableSeed(matClass, finishing.cuttingSpeedMPerMin * machinabilityFactor, 'CuttingSpeedMPerMin', ` ${finishing.cuttingSpeedMPerMin} m/min x machinability factor ${machinabilityFactor}`);
        const base = finishingTableSeed(matClass, finishing.cuttingSpeedMPerMin, 'CuttingSpeedMPerMin');
        return { ...seed, ref: machinabilityRef('Cutting Speed', base, machinabilityFactor, seed.value, 'm/min') };
      })(),
    'Feed per Tooth per Diameter': finishingTableSeed(matClass, finishing.feedPerToothPerDiameter, 'FeedPerToothPerDiameter'),
  };
}

/**
 * The Facing calculator's inputs for the stock piece's faces, as the stock model states them (stock/stock-facing.ts): each value with the
 * calculation behind it, the piece faced down to the part.
 */
export function stockFacingSeeds(facing: StockFacing): Record<string, CalcSeed> {
  const from = `Stock: ${facing.basis}`;
  const faced = (field: string, unit: string | null, value: number): CalcSeed => ({
    value, source: from,
    ref: calculationRef(`Facing: ${field}`, [
      inputStep('The stock piece faced', null, facing.basis, 'The stock chosen for the part (the stock model: its size, and the part inside it)'),
      resultStep(field, unit, value, `${field} of the piece's faces faced down to the part`),
    ]),
  });
  return {
    'Face Length': faced('Face Length', 'mm', facing.lengthMm),
    'Face Width': faced('Face Width', 'mm', facing.widthMm),
    'Stock Depth': faced('Stock Depth', 'mm', facing.depthMm),
    'Faces': faced('Faces', null, facing.faces),
  };
}

/**
 * The material's milling removal rate (tblMillingRemovalRate) scaled by its machinability, as a calculator input: the table row, the factor,
 * and their product, step by step.
 */
export function removalRateSeed(matClass: MaterialClass, removalRateMm3PerMin: number, machinabilityFactor: number): CalcSeed {
  const row = { MaterialClass: matClass };
  const tableRef: SourceRef = { kind: 'lookup', domain: MACHINING_REFERENCE_DOMAIN, table: 'tblMillingRemovalRate', column: 'RemovalRateMm3PerMin', row };
  const value = removalRateMm3PerMin * machinabilityFactor;
  return {
    value, lookup: true,
    source: `tblMillingRemovalRate: ${matClass} ${removalRateMm3PerMin} mm^3/min x machinability factor ${machinabilityFactor}`,
    match: { table: 'tblMillingRemovalRate', row },
    ref: machinabilityFactor === 1 ? tableRef : machinabilityRef('Material Removal Rate', { value: removalRateMm3PerMin, source: `tblMillingRemovalRate: ${matClass}`, ref: tableRef }, machinabilityFactor, value, 'mm^3/min'),
  };
}

/** The catalog's operation for a keyway that is milled, not broached ("Obround Slot Milling//Keyway" on the mills and the live-tool lathes). */
export const KEYWAY_MILLING = 'Obround Slot Milling';

/** The milled keyways of one size, or those that lack the same CAD measurements (`lacks`: they are not timed). */
interface KeywayGroup { lengthMm: number; widthMm: number; depthMm: number; keyways: number; lacks: string[]; occ: number[] }

/**
 * A Keyway feature's occurrences by size (CAD length_mm x width_mm x depth_mm): keyways of one size are cut alike, by a cutter of their width.
 * A keyway with a measurement missing is not given one: it is grouped with those that lack the same, to be named as a gap.
 */
function keywayGroups(occurrences: readonly { length_mm?: unknown; width_mm?: unknown; depth_mm?: unknown }[]): KeywayGroup[] {
  const groups = new Map<string, KeywayGroup>();
  for (const [i, o] of occurrences.entries()) {
    const measured = { length: Number(o.length_mm), width: Number(o.width_mm), depth: Number(o.depth_mm) };
    const lacks = Object.entries(measured).filter(([, mm]) => !(mm > 0)).map(([name]) => name);
    const key = lacks.length > 0 ? `lacks ${lacks.join(' ')}` : `${measured.length}|${measured.width}|${measured.depth}`;
    const g = groups.get(key) ?? { lengthMm: measured.length, widthMm: measured.width, depthMm: measured.depth, keyways: 0, lacks, occ: [] };
    g.keyways += 1;
    g.occ.push(i);
    groups.set(key, g);
  }
  return [...groups.values()];
}

/** "length", "length and width", "length, width and depth". */
const listed = (names: readonly string[]): string => names.join(', ').replace(/, ([^,]*)$/, ' and $1');

/** The time, steps and calculator of an operation as the sequencer plans it. */
type TimedOp = Pick<OperationLine, 'timeSec' | 'missing' | 'trace' | 'calculator' | 'plan'>;

/** The catalog has no operation for an inside fillet (an Edge is only Rounding, a convex edge): migration 1156 adds this one to the mills. */
export const CONCAVE_FILLET_MILLING = 'Concave Fillet Milling';

/** The length one edge or one toroid's path is cut along, and where it comes from. */
interface EdgeLength { lengthMm: number; source: string; occ?: number }

const mm3dp = (v: number) => Math.round(v * 1000) / 1000;

/**
 * The path a toroidal feature (a round, an inside fillet, a groove) is cut along: the arc the CAD measured (path_length_mm, geo_v89: the
 * major radius x the sweep), else, for a part analysed before that, pi x its major diameter: the whole circle, said so with the re-analysis
 * that measures the real arc. Null with neither.
 */
export function toroidPath(o: any, majorDiameterMm: number, what: string): EdgeLength | null {
  const arc = Number(o?.path_length_mm);
  if (arc > 0) {
    const sweep = Number(o?.sweep_deg);
    return { lengthMm: mm3dp(arc), source: `CAD: the ${what}'s arc${sweep > 0 ? `, ${sweep} deg of its Ø${majorDiameterMm} mm major circle` : ''} (path_length_mm)` };
  }
  if (majorDiameterMm > 0) {
    return {
      lengthMm: mm3dp(Math.PI * majorDiameterMm),
      source: `CAD: pi x Ø${majorDiameterMm} mm, the whole circle: the part was analysed before the arc was measured (geo_v89); re-analyse it for the real arc`,
    };
  }
  return null;
}

/**
 * An inside fillet the CAD measured as a torus (Edge:round with concave=true: an occurrence of a toroid feature, which states a major diameter
 * or its arc): finished by a ball nose end mill of its radius. A concave cylindrical arc (an inside fillet along a straight edge, a slot end, a
 * rounded pocket corner: no major diameter, no arc) keeps the edge model, as before.
 */
export function isConcaveToroidFillet(o: any, majorDiameterMm: number): boolean {
  return o?.concave === true && (Number(o?.path_length_mm) > 0 || o?.profile_deg != null || majorDiameterMm > 0);
}

/**
 * The length of each edge of a chamfer or a round, in the CAD's own terms: a round's measured arc (path_length_mm); else pi x the feature's
 * diameter (a round edge; for a round analysed before its arc was measured that is the whole circle, said so); else the edge face's longest
 * extent (its length on a straight edge); else none (a named gap). `n` edges when the feature lists no occurrences.
 */
function edgeLengths(diameterMm: number, occurrences: readonly any[], n: number, what: 'chamfer' | 'round'): (EdgeLength | null)[] {
  const circle = (o: any): EdgeLength | null => (what === 'round'
    ? toroidPath(o, diameterMm, 'round')
    : (diameterMm > 0 ? { lengthMm: mm3dp(Math.PI * diameterMm), source: `CAD: pi x Ø${diameterMm} mm` } : null));
  if (occurrences.length === 0) return Array.from({ length: n }, () => circle({}));
  return occurrences.map((o, occ) => {
    const round = circle(o);
    if (round) return { ...round, occ };
    const longest = Math.max(0, ...(Array.isArray(o?.extents_mm) ? o.extents_mm.map(Number).filter(Number.isFinite) : []));
    return longest > 0 ? { lengthMm: mm3dp(longest), source: 'CAD: the edge face\'s longest extent', occ } : null;
  });
}

/** Several runs of one operation as one: their times summed, each run's plan under its label, and every gap named. */
function combinedRuns(runs: readonly { label: string; run: TimedOp }[], lacks: readonly string[]): TimedOp {
  const missing = [...runs.flatMap((r) => (r.run.missing ? [r.run.missing] : [])), ...lacks];
  if (runs.length === 1 && lacks.length === 0) return runs[0]!.run;
  return {
    timeSec: runs.reduce((t, r) => t + r.run.timeSec, 0),
    ...(runs.length === 1 ? { trace: runs[0]!.run.trace } : {}),
    ...(runs[0]?.run.calculator ? { calculator: runs[0].run.calculator } : {}),
    plan: runs.flatMap((r) => (r.run.plan ?? []).map((pl) => ({ ...pl, label: r.label }))),
    ...(missing.length > 0 ? { missing: missing.join('; ') } : {}),
  };
}

/**
 * The toroidal features (rounds, inside fillets, grooves) of a part analysed before the CAD measured their arcs (geo_v89): their path is
 * read as the whole circle of their major diameter until the part is re-analysed. The count of such occurrences.
 */
export function toroidsWithoutArc(features: readonly unknown[] | null | undefined): number {
  let n = 0;
  for (const f of (features ?? []) as any[]) {
    const key = `${f?.feature_type}:${f?.variant}`;
    if (key !== 'Edge:round' && key !== 'Slot:groove' && key !== 'Ring:groove') continue;
    if (!(Number(f?.diameter_mm) > 0)) continue;
    for (const o of Array.isArray(f.occurrences) ? f.occurrences : []) if (!(Number(o?.path_length_mm) > 0)) n += 1;
  }
  return n;
}

/** One operation timed by its calculator: the time, its steps and the calculator that ran, or the missing inputs named (time 0). */
function calcOp(
  calculators: MachiningCalculators | null,
  operation: string,
  seeds: Record<string, CalcSeed>,
): Pick<OperationLine, 'timeSec' | 'missing' | 'trace' | 'calculator' | 'plan'> {
  const run = runMachiningCalculator(calculators, operation, seeds);
  return {
    timeSec: run.sec ?? 0, trace: run.trace, plan: [{ operation, seeds }],
    ...(run.calculatorId ? { calculator: { id: run.calculatorId, version: run.calculatorVersion, lookups: run.lookups } } : {}),
    ...(run.missing.length > 0 ? { missing: run.missing.join('; ') } : {}),
  };
}

export interface OperationLine {
  name: string;
  timeSec: number;
  /**
   * "feature": on a recognised feature of the part. "fixed": on the part as a whole. "stock": on the stock itself (the cut round a plate
   * part's outline), which is no feature of the part: it keeps a row of its own in the line's breakdown.
   */
  source: "feature" | "fixed" | "stock";
  // Reference CAD feature_type ('SimpleHole'/'MultiStepHole'/'Edge'/
  // 'PocketV2'/'Slot'/...) and diameter this specific op line was generated from, when it came from one feature_graph_v2
  // occurrence group. Carried through so the frontend can trace an operation
  // back to the exact CAD feature for 3D-viewer highlighting (same purpose
  // Sheet Metal's FeatureBreakdown already serves for bends/holes) — a
  // "fixed" op (Face Mill, Deburr) has neither, since it isn't tied to one
  // detected feature.
  cadFeatureType?: string;
  diameterMm?: number;
  // Real number of CAD instances this line covers (holes for a PCD pattern,
  // occurrences otherwise) — carried so the UI never infers a count from time.
  count?: number;
  // feature_graph_v2 ids of the detected feature(s) this op machines, so the
  // UI highlights exactly those occurrences instead of every feature of a type.
  featureIds?: string[];
  // Present when this op could not be priced from real inputs (timeSec is 0
  // for it): names the missing CAD measurement or lookup row. Never replaced
  // by an estimated time.
  missing?: string;
  /** The calculator steps the time came from. */
  trace?: CalculationTraceStep[];
  /** The stored calculator that timed the operation, and the reference-table row each of its lookup inputs came from. */
  calculator?: { id: string; version: number | null; lookups: CalcRun['lookups'] };
  /**
   * The calculator runs the operation is timed by, with their inputs (a stepped hole: one per step). The sequencer plans an operation
   * before any machine is chosen; each route times it again on its own machine (timeOperations), since a calculator may cap its spindle
   * at the machine's limit. Absent: a time of no calculator (a table rate, a fixed allowance), the same on every machine.
   */
  plan?: PlannedRun[];
  /** A factor the drawing put on the operation's time (a fine surface finish), kept so a re-timed plan keeps it. */
  timeFactor?: number;
  /** The tool wear its timed runs charge per part (Tool Cost per Part, rupees: the workbook's tool price over its life). */
  toolCostInr?: number;
}


// Canonical manufacturing order for sorting. Names are the real
// operation_category strings from memory/machining/operations_full__operations.csv
// (validated at runtime against the live process_taxonomy_operations table
// via resolveOperationName — see buildMachiningFeatureBreakdown in
// bom-items.service.ts), not this file's own former invented vocabulary
// ("Pocket Rough"/"Spot Drill"/"Rigid Tap"/"Corner Round"/... — renamed
// below). Several former distinct names collapse onto the SAME real name
// here (e.g. former "Pocket Rough"/"Slot Rough" both real "Rough Milling";
// former "Contour Mill"/"Profile Mill" both real "Contouring") because the
// real catalog uses one operation name across multiple FeatureTypes —
// that's a real fact about the taxonomy, not a naming collision to avoid.
const OP_ORDER: string[] = [
  "Facing",
  "Bulk Milling",
  "Fine Finish Milling",
  "Contouring",
  "Perimeter Milling",
  "Rough Milling",
  KEYWAY_MILLING,
  "Slot Milling",
  "Center Drilling",
  "Drilling",
  "Boring",
  "Ream",
  "Step Drilling",
  "Countersinking",
  "Chamfering",
  "Filleting",
  CONCAVE_FILLET_MILLING,
  "Groove Milling",
  "Tapping",
  "Deburr",
];

function opOrderIndex(name: string): number {
  const idx = OP_ORDER.findIndex((o) => name.startsWith(o));
  return idx >= 0 ? idx : OP_ORDER.length;
}

/**
 * Build an ordered operation sequence from feature_graph_v2 features.
 *
 * @param fgv2Features  feature_graph_v2.features array from CAD engine response
 * @param matClass      resolved MaterialClass for MRR lookup
 * @param machinabilityFactor  (machinabilityRating / 75); 1.0 = mild steel baseline
 * @param materialGrade  raw material grade string (e.g. "SS304") for the real
 *   material-family-aware tap/drill physics below — optional; a missing
 *   grade falls back to the mild-steel-family default the same way
 *   resolveDrillingSpeedFeed/resolveTapPhysicsInputs already do.
 * @param workbook  the machining workbook's cutting data: drilling, step drilling (a counterbore), boring (a hole the drills do not reach)
 *   and tapping are timed on it; a material or size it has no row for is a named gap.
 * Chamfering, filleting, spotting and countersinking are timed on the workbook (migration 1152): the edges by its End
 *   Milling sheet with the material's end mill, the spots and countersinks by its Drilling sheet. Inside fillets and grooves are finished by
 *   a ball nose end mill of their radius along their arc, on Haas Tooling's ball nose data (tblBallNoseCutData, migrations 1154-1155).
 * @param stockAround  on a milled route, the stock around the part (stock-excess.ts):
 *   what it holds beyond the part and its features is milled away by one Bulk
 *   Milling operation. null/absent (a lathe's plan, a part with no stock chosen)
 *   adds none.
 * @param stockOps  the operations on the stock itself that this mill performs
 *   (the cut round a plate part's outline of Perimeter Milling with Drop-off),
 *   each already timed by its own calculator. None for any other stock.
 * @returns flat OperationLine[] sorted in manufacturing order, or [] if no features
 */
export interface SequenceOptions {
  matClass: MaterialClass;
  machinabilityFactor?: number;
  materialGrade?: string | null;
  /** The machining workbook's cutting data (migration 1137): what drilling, tapping, step drilling and boring are timed on. */
  workbook?: MachiningWorkbookInput | null;
  calculators?: MachiningCalculators | null;
  /** The material's milling removal rate (tblMillingRemovalRate). Null = not on file: every operation that divides a volume by it is a named gap. */
  removalRateMm3PerMin?: number | null;
  /** The material's finishing cutter (tblMillingFinishing). Null = not on file: every finishing pass is a named gap. */
  finishing?: MillingFinishingRow | null;
  stockAround?: StockExcess | null;
  stockOps?: readonly OperationLine[];
  /** On a milled route, what the mill faces off the stock piece (stock/stock-facing.ts). Null/absent: nothing is faced (no stock chosen, a lathe's plan). */
  facing?: StockFacing | null;
}

export function buildOperationSequence(fgv2Features: unknown[] | null | undefined, options: SequenceOptions): OperationLine[] {
  const {
    matClass, machinabilityFactor = 1.0, materialGrade = null,
    workbook = null, calculators = null, removalRateMm3PerMin = null, finishing = null, stockAround = null, stockOps = [], facing = null,
  } = options;
  if (!Array.isArray(fgv2Features) || fgv2Features.length === 0) return [];

  const ops: OperationLine[] = [];

  // The inputs every volume- or area-based milling calculator shares, and the per-operation calls.
  const mrrSeed: Record<string, CalcSeed> = removalRateMm3PerMin != null && removalRateMm3PerMin > 0 ? {
    'Material Removal Rate': removalRateSeed(matClass, removalRateMm3PerMin, machinabilityFactor),
  } : {};
  const volumeOp = (operation: string, removedMm3: number, ref: SourceRef | undefined) => calcOp(calculators, operation, {
    'Removed Volume': withSourceRef({ value: removedMm3, source: 'CAD: volume the features remove' }, ref), ...mrrSeed,
  });
  // A finishing pass is a tool path at the cutter's feed: the cutter and how it runs in this material, from the table.
  // How an end mill runs in this material, whatever its diameter: every tool-path calculator reads these.
  const cutterRun = (): Record<string, CalcSeed> => cutterRunSeeds(finishing, matClass, machinabilityFactor);
  const cutterSeeds = (toolMm: number, toolWhy: string, ref?: SourceRef): Record<string, CalcSeed> => (finishing ? {
    'Tool Diameter': toolMm === finishing.toolDiameterMm
      ? finishingTableSeed(matClass, toolMm, 'ToolDiameterMm')
      : withSourceRef({ value: toolMm, source: toolWhy }, ref),
    ...cutterRun(),
  } : {});
  const standardToolMm = finishing?.toolDiameterMm ?? Number.POSITIVE_INFINITY;
  // A region's walls and surfaces (the feature's faces): the CAD values light them.
  const contourOp = (operation: string, wallMm2: number, surfaceMm2: number, faces: number, ref: SourceRef | undefined) => calcOp(calculators, operation, {
    'Wall Area': withSourceRef({ value: wallMm2, source: 'CAD: area of the walls' }, ref),
    'Surface Area': withSourceRef({ value: surfaceMm2, source: 'CAD: area of the free-form surfaces' }, ref),
    'Faces': withSourceRef({ value: faces, source: 'CAD: faces to contour' }, ref),
    ...cutterSeeds(standardToolMm, ''),
  });
  const faceFinishOp = (areaMm2: number, faces: number, ref: SourceRef | undefined) => calcOp(calculators, 'Fine Finish Milling', {
    'Floor Area': withSourceRef({ value: areaMm2, source: 'CAD: area of the planar faces' }, ref),
    'Wall Area': withSourceRef({ value: 0, source: 'A planar face has no wall' }, ref),
    'Faces': withSourceRef({ value: faces, source: 'CAD: planar faces to finish' }, ref),
    ...cutterSeeds(standardToolMm, ''),
  });
  const pocketFinishOp = (g: PocketFinishGroup, ref: SourceRef | undefined) => calcOp(calculators, 'Fine Finish Milling', {
    'Floor Area': withSourceRef({ value: g.floorMm2, source: `CAD: floor of ${g.pockets} pocket(s), length x width` }, ref),
    'Wall Area': withSourceRef(g.wallMm2 > 0
      ? { value: g.wallMm2, source: 'CAD: pocket perimeter x depth (removed volume over the floor area)' }
      : { value: 0, source: 'The cutter is as wide as the pocket: the walls are finished with the floor' }, ref),
    'Faces': withSourceRef({ value: g.pockets, source: 'CAD: pockets to finish' }, ref),
    ...cutterSeeds(g.toolMm, `CAD: pocket width ${g.toolMm} mm, narrower than the standard finishing cutter`, ref),
  });
  // A milled keyway is cut by an end mill of its own width, in passes between its two end centres.
  const keywayOp = (g: KeywayGroup, ref: SourceRef | undefined) => calcOp(calculators, KEYWAY_MILLING, {
    'Keyway Length': withSourceRef({ value: g.lengthMm, source: 'CAD: keyway length' }, ref),
    'Keyway Width': withSourceRef({ value: g.widthMm, source: 'CAD: keyway width, the diameter of the cutter' }, ref),
    'Keyway Depth': withSourceRef({ value: g.depthMm, source: 'CAD: keyway depth' }, ref),
    'Keyways': withSourceRef({ value: g.keyways, source: 'CAD: keyways of this size' }, ref),
    ...cutterRun(),
  });
  // A workbook-form milling run (the Face, End, Slot and Plunge Milling sheets): its speeds and feeds from the workbook's milling
  // conditions for the material, planned before any machine is chosen (each route times it again on its own machine).
  const workbookOp = (operation: string, seeds: Record<string, CalcSeed>): Pick<OperationLine, 'timeSec' | 'missing' | 'trace' | 'calculator' | 'plan'> => {
    const cycle = workbookCycle(operation, workbook, calculators, matClass, seeds, {});
    return {
      timeSec: cycle.sec ?? 0, trace: cycle.trace,
      ...(cycle.plan ? { plan: [cycle.plan] } : {}),
      ...(cycle.calculatorId ? { calculator: { id: cycle.calculatorId, version: cycle.calculatorVersion, lookups: cycle.lookups } } : {}),
      ...(cycle.sec == null ? { missing: cycle.missing.join('; ') } : {}),
    };
  };
  // The end mill a cut is made with, and its teeth: the material's own (tblMillingFinishing), or one as wide as the cut.
  const noEndMill = `the material's end mill (tblMillingFinishing has no row for ${matClass})`;
  const endMillSeeds = (toolMm: number, narrower: string, ref?: SourceRef): Record<string, CalcSeed> | null => finishing ? {
    'Cutter Diameter': toolMm === finishing.toolDiameterMm ? finishingTableSeed(matClass, toolMm, 'ToolDiameterMm') : withSourceRef({ value: toolMm, source: narrower }, ref),
    'Teeth': finishingTableSeed(matClass, finishing.teeth, 'Teeth'),
  } : null;
  // A pocket or a flat roughed with an end mill (the workbook's End Milling sheet), one run per size.
  const roughOp = (g: CutGroup, what: string, ref: SourceRef | undefined): Pick<OperationLine, 'timeSec' | 'missing' | 'trace' | 'calculator' | 'plan'> => {
    const cutter = endMillSeeds(g.toolMm, `CAD: ${what} width ${g.toolMm} mm, narrower than the material's end mill`, ref);
    if (!cutter) return { timeSec: 0, missing: noEndMill };
    return workbookOp('Rough Milling', {
      'Cut Length': withSourceRef({ value: g.lengthMm, source: `CAD: ${what} length` }, ref),
      'Cut Width': withSourceRef({ value: g.widthMm, source: `CAD: ${what} width` }, ref),
      'Cut Depth': withSourceRef({ value: g.depthMm, source: g.depthSource }, ref),
      'Cuts': withSourceRef({ value: g.cuts, source: `CAD: ${what}s of this size` }, ref),
      ...cutter,
    });
  };
  // A slot (the catalog's Slot Milling) cut by the workbook's Slot Milling sheet or by plunging (its Plunge Milling sheet, corrected),
  // whichever is quicker: plunging wins on a deep slot. Both run the same cutter at the same speed, so a route machine's spindle limit
  // scales them alike and the quicker one stays the quicker on every machine.
  const slotOp = (g: CutGroup, ref: SourceRef | undefined): Pick<OperationLine, 'timeSec' | 'missing' | 'trace' | 'calculator' | 'plan'> => {
    const cutter = endMillSeeds(g.toolMm, `CAD: slot width ${g.toolMm} mm, narrower than the material's end mill`, ref);
    if (!cutter) return { timeSec: 0, missing: noEndMill };
    const seeds: Record<string, CalcSeed> = {
      'Slot Length': withSourceRef({ value: g.lengthMm, source: 'CAD: slot length' }, ref),
      'Slot Width': withSourceRef({ value: g.widthMm, source: 'CAD: slot width' }, ref),
      'Slot Depth': withSourceRef({ value: g.depthMm, source: g.depthSource }, ref),
      'Slots': withSourceRef({ value: g.cuts, source: 'CAD: slots of this size' }, ref),
      ...cutter,
    };
    // Compared before any machine is chosen, with no spindle limit: the limit would slow both alike.
    const uncapped = { 'Max Spindle Speed': { value: 1e12, source: 'No machine yet: Slot and Plunge Milling compared with no spindle limit' } };
    const slotted = workbookCycle('Slot Milling', workbook, calculators, matClass, seeds, uncapped).sec;
    const plunged = workbookCycle('Plunge Milling', workbook, calculators, matClass, seeds, uncapped).sec;
    return workbookOp(plunged != null && (slotted == null || plunged < slotted) ? 'Plunge Milling' : 'Slot Milling', seeds);
  };
  // A counterbore, drilled with a step drill to its diameter and depth (no CAD depth: the drilling depth rule's, stated).
  const stepOp = (diamMm: number, depthMm: number, n: number, ref: SourceRef | undefined) => {
    const depth = depthMm > 0
      ? withSourceRef({ value: depthMm, source: 'CAD: counterbore depth' }, ref)
      : {
        value: diamMm * DRILL_DEPTH_TO_DIAMETER_RATIO, source: `Assumption: no CAD depth, ${DRILL_DEPTH_TO_DIAMETER_RATIO} x the counterbore diameter`,
        ref: calculationRef('Counterbore depth (no CAD depth)', [
          inputStep('Counterbore diameter', 'mm', diamMm, 'CAD: counterbore diameter', ref),
          inputStep('Depth to diameter ratio', null, DRILL_DEPTH_TO_DIAMETER_RATIO, 'The drilling depth rule (DRILL_DEPTH_TO_DIAMETER_RATIO): a hole with no CAD depth is taken 2.5 x its diameter deep'),
          resultStep('Step Depth', 'mm', diamMm * DRILL_DEPTH_TO_DIAMETER_RATIO, 'Counterbore diameter x Depth to diameter ratio'),
        ]),
      };
    const seeds: Record<string, CalcSeed> = {
      'Step Diameter': withSourceRef({ value: diamMm, source: 'CAD: counterbore diameter' }, ref), 'Step Depth': depth, 'Holes': withSourceRef({ value: n, source: 'CAD: counterbores' }, ref),
    };
    const cycle = workbookCycle('Step Drilling', workbook, calculators, matClass, seeds, {});
    const plan = cycle.plan ? { plan: [cycle.plan] } : {};
    return cycle.sec == null ? { timeSec: 0, missing: cycle.missing.join('; '), ...plan } : { timeSec: cycle.sec, trace: cycle.trace, ...plan };
  };
  // A hole larger than the workbook's drills reach: drilled at the largest of them, then bored to its diameter on the mill.
  const largestDrill = largestDrillMm(workbook, matClass);
  /** Wider than the workbook's drills reach (its drilling table's top band): no drill, spot drill, step drill or countersink of this size is on file. */
  const widerThanDrills = (diamMm: number): boolean => largestDrill != null && diamMm > largestDrill;
  const boreOp = (diamMm: number, depthMm: number, n: number, occurrences?: readonly FeatureOccurrenceRef[], fromMm: number = largestDrill!) => {
    const cycle = computeBoreCycle('Boring', fromMm, diamMm, depthMm, n, matClass, workbook, calculators, occurrences);
    return cycle.sec == null ? { timeSec: 0, missing: cycle.missing.join('; '), plan: cycle.plan ? [cycle.plan] : undefined } : { timeSec: cycle.sec, plan: cycle.plan ? [cycle.plan] : undefined };
  };
  // A hole spotted before it is drilled, or countersunk after (the workbook's Drilling sheet: the spot or countersink's depth plus the
  // approach over the feed, at the drilling speed for the diameter; migration 1152).
  // A hole wider than the drills reach is spotted for the drill that enters it (the largest), not at its own diameter.
  const spotOp = (diamMm: number, n: number, ref: SourceRef | undefined) => workbookOp('Center Drilling', {
    'Hole Diameter': withSourceRef(widerThanDrills(diamMm)
      ? { value: largestDrill!, source: `The largest drill, Ø${largestDrill} mm: the Ø${diamMm} mm hole is wider than the drills reach, so it is spotted for the drill that enters it and bored to size` }
      : { value: diamMm, source: 'CAD: hole diameter' }, ref),
    'Holes': withSourceRef({ value: n, source: 'CAD: holes of this diameter' }, ref),
  });
  const countersinkOp = (countersinkMm: number, holeMm: number, holeWhy: string, n: number, ref: SourceRef | undefined, holeRef: SourceRef | undefined) => workbookOp('Countersinking', {
    'Countersink Diameter': withSourceRef({ value: countersinkMm, source: 'CAD: countersink diameter' }, ref),
    'Hole Diameter': withSourceRef({ value: holeMm, source: holeWhy }, holeRef),
    'Holes': withSourceRef({ value: n, source: 'CAD: countersinks of this size' }, ref),
  });
  // An edge chamfered or rounded in one pass of the material's end mill (the workbook's End Milling sheet; migration 1152): edges of one
  // length are cut alike. Each edge's length is given (edgeLengths); one with none is a named gap.
  // `refOf` lights the edges of a group (their occurrences of the feature; all of them for edges the feature does not list one by one).
  const edgeOp = (operation: string, edges: readonly (EdgeLength | null)[], refOf: (label: string, occ?: readonly number[]) => SourceRef | undefined): TimedOp => {
    const cutter = endMillSeeds(standardToolMm, '');
    if (!cutter) return { timeSec: 0, missing: noEndMill };
    const groups = new Map<string, { lengthMm: number; edges: number; source: string; occ: number[] }>();
    let unmeasured = 0;
    for (const e of edges) {
      if (!e) { unmeasured += 1; continue; }
      const key = `${e.lengthMm}|${e.source}`;
      const g = groups.get(key) ?? { lengthMm: e.lengthMm, edges: 0, source: e.source, occ: [] };
      g.edges += 1;
      if (e.occ != null) g.occ.push(e.occ);
      groups.set(key, g);
    }
    const runs = [...groups.values()].map((g) => {
      const ref = refOf(`${g.edges} edge${g.edges === 1 ? '' : 's'} of ${g.lengthMm} mm`, g.occ.length > 0 ? g.occ : undefined);
      return { label: `Edge ${g.lengthMm} mm`, run: workbookOp(operation, {
        'Edge Length': withSourceRef({ value: g.lengthMm, source: g.source }, ref), 'Edges': withSourceRef({ value: g.edges, source: 'CAD: edges of this length' }, ref), ...cutter,
      }) };
    });
    return combinedRuns(runs, unmeasured > 0 ? [`the CAD length of ${unmeasured} edge${unmeasured === 1 ? '' : 's'}`] : []);
  };
  // A round-bottomed groove or an inside fillet, finished by a ball nose end mill of its own radius in one pass along the path its centre
  // follows (the Groove Milling and Concave Fillet Milling calculators, migration 1155): those of one radius and path are cut alike. The
  // ball's speed, feed and teeth are read from tblBallNoseCutData by the material and the ball's diameter (workbookSeeds). An occurrence with
  // no CAD radius, or with neither its arc nor a major diameter, is a named gap, never priced on the others alone.
  const ballNoseOp = (
    operation: 'Groove Milling' | typeof CONCAVE_FILLET_MILLING, what: 'groove' | 'fillet', occs: readonly any[], majorDiameterMm: number,
    refOf: (label: string, occ: readonly number[]) => SourceRef | undefined,
  ): TimedOp => {
    const countField = what === 'groove' ? 'Grooves' : 'Fillets';
    const groups = new Map<string, { cutterMm: number; radiusMm: number; path: EdgeLength; n: number; occ: number[] }>();
    let noRadius = 0;
    let noPath = 0;
    for (const o of occs) {
      const radiusMm = Number(o?.radius_mm);
      const path = toroidPath(o, majorDiameterMm, what);
      if (!(radiusMm > 0)) { noRadius += 1; continue; }
      if (!path) { noPath += 1; continue; }
      const cutterMm = Math.round(2 * radiusMm * 1000) / 1000;
      const key = `${cutterMm}|${path.lengthMm}|${path.source}`;
      const g = groups.get(key) ?? { cutterMm, radiusMm, path, n: 0, occ: [] };
      g.n += 1;
      if (typeof o?.__occ === 'number') g.occ.push(o.__occ);
      groups.set(key, g);
    }
    const plural = (n: number) => `${n} ${what}${n === 1 ? '' : 's'}`;
    const lacks = [
      ...(noRadius > 0 ? [`the CAD radius of ${plural(noRadius)} (the ball nose end mill is chosen by it)`] : []),
      ...(noPath > 0 ? [`the CAD path length of ${plural(noPath)} (no arc and no major diameter)`] : []),
    ];
    const runs = [...groups.values()].map((g) => {
      const ref = refOf(`R${g.radiusMm} ${what}${g.n === 1 ? '' : 's'}`, g.occ);
      return {
        label: `R${g.radiusMm} ${what}, ${g.path.lengthMm} mm`,
        run: workbookOp(operation, {
          'Path Length': withSourceRef({ value: g.path.lengthMm, source: g.path.source }, ref),
          [countField]: withSourceRef({ value: g.n, source: `CAD: ${what}s of this radius and path` }, ref),
          'Cutter Diameter': withSourceRef({ value: g.cutterMm, source: `CAD: 2 x the ${what}'s radius (R${g.radiusMm} mm): a ball nose end mill of the ${what}'s own radius` }, ref),
        }),
      };
    });
    return combinedRuns(runs, lacks);
  };

  // The piece's faces, faced down to the part before any feature is cut (the workbook's Face Milling sheet). The stock model states the
  // faces and the stock on them; a piece with none (no stock chosen, a lathe's plan) is not faced.
  if (facing) {
    ops.push({
      name: "Facing",
      ...workbookOp('Facing', stockFacingSeeds(facing)),
      source: "fixed", count: facing.faces,
    });
  }

  // The stock around the part: no operation on a feature below removes it, so it is milled away in bulk, at the material's removal rate.
  if (stockAround && stockAround.excessMm3 > 0) {
    const mm3 = (v: number) => Math.round(v * 100) / 100;
    ops.push({
      name: "Bulk Milling",
      ...calcOp(calculators, 'Bulk Milling', {
        'Removed Volume': {
          value: stockAround.excessMm3,
          // Every volume the value is worked out from is named, so the caption adds up to it: what Facing takes off the piece too.
          source: `Stock around the part: the piece ${mm3(stockAround.pieceMm3)} mm^3 less the part ${mm3(stockAround.partMm3)} mm^3${stockAround.facedMm3 ? `, the ${mm3(stockAround.facedMm3)} mm^3 Facing takes off the piece` : ''} and the ${mm3(stockAround.featureRemovedMm3)} mm^3 its features remove`,
          ref: calculationRef('Stock around the part', [
            inputStep('Stock piece volume', 'mm^3', stockAround.pieceMm3, 'The stock chosen for the part (the stock model)'),
            inputStep('Part volume', 'mm^3', stockAround.partMm3, 'CAD: the part\'s volume'),
            inputStep('Volume the features remove', 'mm^3', stockAround.featureRemovedMm3, 'CAD: the material_removed_mm3 of every feature the operations cut'),
            ...(stockAround.facedMm3 ? [inputStep('Volume faced off the piece', 'mm^3', stockAround.facedMm3, 'The Facing of the piece\'s faces (the stock model)')] : []),
            resultStep('Removed Volume', 'mm^3', stockAround.excessMm3, `Stock piece volume - Part volume - Volume the features remove${stockAround.facedMm3 ? ' - Volume faced off the piece' : ''}`),
          ]),
        },
        ...mrrSeed,
      }),
      source: "fixed",
    });
  }
  ops.push(...stockOps);

  // The part's hole axes: a countersink on one of them is that hole's mouth, not a hole to drill again.
  const holes = holeAxes(fgv2Features as any[]);
  for (const f of fgv2Features as any[]) {
    // feature_graph_v2 entries carry a reference catalog feature_type
    // (cad-engine/shared/reference_features.json) plus its geometric variant;
    // together they decide the real operation chain below.
    const ft: string = f.feature_type;
    const variant: string = f.variant ?? "default";
    const occurrences: any[] = Array.isArray(f.occurrences) ? f.occurrences : [];
    const count = occurrences.length || 1;
    const diamMm: number = f.diameter_mm ?? 0;

    // Aggregate removed volume across all occurrences
    const totalRemovedMm3: number = occurrences.reduce(
      (s: number, o: any) => s + (o.material_removed_mm3 ?? 0),
      0,
    );

    // Real aggregate classified area (PlanarFace/CurvedWall/CurvedSurface/
    // Cutout regions) -- these carry no material_removed_mm3 of their own
    // (classifying a face does not reveal how much stock sat above it).
    const totalAreaMm2: number = occurrences.reduce(
      (s: number, o: any) => s + (o.area_mm2 ?? 0),
      0,
    );

    // The faces a finishing pass enters: a region with no area is not one.
    const faceCount = occurrences.filter((o: any) => (o.area_mm2 ?? 0) > 0).length;

    // Representative depth: first occurrence, fallback 2.5×D
    const depthMm: number = occurrences[0]?.depth_mm ?? diamMm * 2.5;

    // Thread spec: occurrences[0].spec (e.g. "M6×1.0"). pitch_mm is real
    // CAD data when present; undefined lets computeTapCycleSec fall back to
    // the standard ISO coarse-pitch series.
    const threadSpec: string | null = occurrences[0]?.spec ?? null;
    const threadPitchMm: number | undefined = occurrences[0]?.pitch_mm ?? undefined;

    const firstOpOfFeature = ops.length;
    // The feature's occurrences (all, or those at `occ`) as the ref of the CAD values measured or counted on them.
    const refOf = (label: string, occ?: readonly number[]) => graphFeatureRef(f, label, occ);
    const all = refOf(`${ft} ${variant}`.replace(' default', ''));
    // The same occurrences as the drilling and tapping calculators take them (FeatureOccurrenceRef).
    const occRefs = (occ?: readonly number[]): FeatureOccurrenceRef[] | undefined => (typeof f.id === 'string' && f.id
      ? (occ ?? occurrences.map((_: unknown, i: number) => i)).map((occurrenceIndex) => ({ featureId: f.id as string, occurrenceIndex }))
      : undefined);
    // Drilling a hole of this diameter: at its own diameter, or, when it is wider than the drills reach, at the largest drill and then
    // bored to size (the workbook's Internal Boring sheet). No hole is left unpriced for want of a drill of its size.
    const drilledOps = (holeMm: number, holeDepthMm: number, n: number, occ: readonly FeatureOccurrenceRef[] | undefined, rest: Partial<OperationLine>): OperationLine[] => (widerThanDrills(holeMm)
      ? [
        { name: "Drilling", ...drillOp(largestDrill!, holeDepthMm, n, materialGrade, workbook, calculators, occ), source: "feature" as const, cadFeatureType: ft, ...rest },
        { name: "Boring", ...boreOp(holeMm, holeDepthMm, n, occ), source: "feature" as const, cadFeatureType: ft, ...rest },
      ]
      : [{ name: "Drilling", ...drillOp(holeMm, holeDepthMm, n, materialGrade, workbook, calculators, occ), source: "feature" as const, cadFeatureType: ft, ...rest }]);
    const instanceCount = variant === "pcd_pattern"
      ? occurrences.reduce((s: number, o: any) => s + (o.hole_count ?? 1), 0)
      : count;

    switch (`${ft}:${variant}`) {
      case "PocketV2:default":
        // "Rough Milling//PocketV2" is the real catalog op, roughed with an end mill (the workbook's End Milling sheet), one run per
        // pocket size; no PocketV2-specific finish row exists, so the real generic "Fine Finish Milling" is reused.
        {
          const rough = cutGroups(occurrences, floorSize, standardToolMm);
          if (!rough) ops.push({ name: "Rough Milling", timeSec: 0, missing: 'the CAD length, width and depth of every pocket', source: "feature", cadFeatureType: ft });
          for (const g of rough ?? []) ops.push({ name: "Rough Milling", ...roughOp(g, 'pocket', refOf(`${g.cuts} pocket${g.cuts === 1 ? '' : 's'}`, g.occ)), source: "feature", cadFeatureType: ft, count: g.cuts });
        }
        {
          // One finishing line per cutter the pockets need; a pocket with no CAD size is a named gap.
          const groups = pocketFinishGroups(occurrences, standardToolMm);
          if (!groups) ops.push({ name: "Fine Finish Milling", timeSec: 0, missing: 'the CAD length and width of every pocket', source: "feature", cadFeatureType: ft });
          for (const g of groups ?? []) ops.push({ name: "Fine Finish Milling", ...pocketFinishOp(g, refOf(`${g.pockets} pocket${g.pockets === 1 ? '' : 's'}`, g.occ)), source: "feature", cadFeatureType: ft, count: g.pockets });
        }
        break;

      case "Slot:straight":
      case "Slot:radial": {
        // The whole slot is cut by its Slot Milling (or plunged, when that is quicker), one run per slot size: no separate roughing of
        // its volume. Walls on both sides confine the cutter to the slot's width.
        const slots = cutGroups(occurrences, (o) => { const z = floorSize(o); return z && { ...z, confined: true }; }, standardToolMm);
        if (!slots) ops.push({ name: "Slot Milling", timeSec: 0, missing: 'the CAD length, width and depth of every slot', source: "feature", cadFeatureType: ft });
        for (const g of slots ?? []) ops.push({ name: "Slot Milling", ...slotOp(g, refOf(`${g.cuts} slot${g.cuts === 1 ? '' : 's'}`, g.occ)), source: "feature", cadFeatureType: ft, count: g.cuts });
        break;
      }

      case "Keyway:default":
        // A keyway no broach in the reference cuts (keyway-routing.ts): the catalog's "Obround Slot Milling//Keyway", one line per
        // keyway size. Not the volume at the bulk removal rate: that rate is a large cutter's in open material, and a keyway is cut
        // by a cutter of its own width. A keyway with no CAD length, width or depth is a named gap.
        for (const g of keywayGroups(occurrences)) {
          const timed = g.lacks.length > 0
            ? { timeSec: 0, missing: `the CAD ${listed(g.lacks)} of ${g.keyways > 1 ? `${g.keyways} keyways` : 'the keyway'}` }
            : keywayOp(g, refOf(`${g.keyways} keyway${g.keyways === 1 ? '' : 's'}`, g.occ));
          ops.push({ name: KEYWAY_MILLING, ...timed, source: "feature", cadFeatureType: ft, count: g.keyways });
        }
        break;

      case "Flat:default": {
        // A flat milled on a turned diameter (cad-engine _classify_turned_flat): the catalog's "Rough Milling//Flat", roughed with an
        // end mill as the workbook's End Milling sheet times it, over the flat's CAD length, chord width and depth below the diameter,
        // one run per flat size. A flat is open: nothing confines the cutter. The reference stores no calculator of the catalog's
        // "Surface Finishing//Flat", so no second pass is added. A flat with no CAD size is a named gap, never free.
        const flats = cutGroups(occurrences, flatSize, standardToolMm);
        if (!flats) {
          ops.push({ name: "Rough Milling", timeSec: 0, missing: `the CAD length, width and depth of ${count > 1 ? `${count} flats` : 'the flat'}`, source: "feature", cadFeatureType: ft });
        }
        for (const g of flats ?? []) ops.push({ name: "Rough Milling", ...roughOp(g, 'flat', refOf(`${g.cuts} flat${g.cuts === 1 ? '' : 's'}`, g.occ)), source: "feature", cadFeatureType: ft, count: g.cuts });
        break;
      }

      case "SimpleHole:through":
      case "SimpleHole:blind":
      case "SimpleHole:cross":
        if (diamMm > 0) {
          ops.push({ name: "Center Drilling", ...spotOp(diamMm, count, all), source: "feature", cadFeatureType: ft, diameterMm: diamMm });
          ops.push(...drilledOps(diamMm, depthMm, count, occRefs(), { diameterMm: diamMm }));
        }
        break;

      case "SimpleHole:pcd_pattern": {
        // One occurrence per pattern; each carries the real number of holes
        // it stands for (hole_count), so drilling is costed per real hole.
        const holes = occurrences.reduce((s: number, o: any) => s + (o.hole_count ?? 1), 0);
        if (diamMm > 0 && holes > 0) {
          ops.push({ name: "Center Drilling", ...spotOp(diamMm, holes, all), source: "feature", cadFeatureType: ft, diameterMm: diamMm });
          ops.push(...drilledOps(diamMm, depthMm, holes, occRefs(), { diameterMm: diamMm }));
        }
        break;
      }

      case "MultiStepHole:stepped": {
        // Each occurrence carries its own real steps[] (3+ coaxial bores). One
        // spot drill per hole assembly; drill time is the same drillTimeSec
        // physics applied per real step.
        let spots = 0;
        const spotDiameters = new Map<number, number[]>();
        let drillSec = 0;
        const stepMissing: string[] = [];
        const stepPlans: PlannedRun[] = [];
        // Steps wider than the drills reach: drilled at the largest drill, then bored to size.
        let boreSec = 0;
        const boreMissing: string[] = [];
        const borePlans: PlannedRun[] = [];
        for (const [i, occ] of occurrences.entries()) {
          const steps: Array<{ diameter_mm: number; depth_mm: number }> = Array.isArray(occ.steps) ? occ.steps : [];
          if (steps.length === 0) continue;
          spots += 1;
          // The hole is spotted at its entry: its first step's diameter.
          const entry = Number(steps[0]!.diameter_mm);
          if (entry > 0) spotDiameters.set(entry, [...(spotDiameters.get(entry) ?? []), i]);
          for (const step of steps) {
            const wide = widerThanDrills(step.diameter_mm);
            const op = drillOp(wide ? largestDrill! : step.diameter_mm, step.depth_mm, 1, materialGrade, workbook, calculators, occRefs([i]));
            drillSec += op.timeSec;
            if (op.missing) stepMissing.push(op.missing);
            stepPlans.push(...(op.plan ?? []).map((p) => ({ ...p, label: `Step Ø${step.diameter_mm}` })));
            if (wide) {
              const bore = boreOp(step.diameter_mm, step.depth_mm, 1, occRefs([i]));
              boreSec += bore.timeSec;
              if (bore.missing) boreMissing.push(bore.missing);
              borePlans.push(...(bore.plan ?? []).map((p) => ({ ...p, label: `Step Ø${step.diameter_mm}` })));
            }
          }
        }
        if (spots > 0 || drillSec > 0) {
          for (const [entryMm, occ] of spotDiameters) ops.push({ name: "Center Drilling", ...spotOp(entryMm, occ.length, refOf(`Ø${entryMm} stepped holes`, occ)), source: "feature", cadFeatureType: ft, diameterMm: entryMm });
          ops.push({
            name: "Drilling", timeSec: drillSec, source: "feature", cadFeatureType: ft,
            ...(stepPlans.length ? { plan: stepPlans } : {}), ...(stepMissing.length ? { missing: stepMissing.join('; ') } : {}),
          });
          if (borePlans.length > 0 || boreMissing.length > 0) {
            ops.push({
              name: "Boring", timeSec: boreSec, source: "feature", cadFeatureType: ft,
              ...(borePlans.length ? { plan: borePlans } : {}), ...(boreMissing.length ? { missing: boreMissing.join('; ') } : {}),
            });
          }
        }
        break;
      }

      case "SimpleHole:threaded":
        if (diamMm > 0) {
          ops.push({ name: "Center Drilling", ...spotOp(diamMm, count, all), source: "feature", cadFeatureType: ft, diameterMm: diamMm });
          ops.push(...drilledOps(diamMm * 0.8, depthMm, count, occRefs(), { diameterMm: diamMm })); // minor diameter
          ops.push({ name: "Chamfering", ...edgeOp('Chamfering', edgeLengths(diamMm, [], count, 'chamfer'), (label) => refOf(label)), source: "feature", cadFeatureType: ft, diameterMm: diamMm });
          ops.push({ name: "Tapping", ...tapOp(threadSpec, count, matClass, threadPitchMm, depthMm, workbook, calculators, occRefs()), source: "feature", cadFeatureType: ft, diameterMm: diamMm });
        }
        break;

      case "MultiStepHole:counterbore":
        if (diamMm > 0) {
          // A counterbore over a tapped bore the CAD lists as a threaded hole of its own (bore_spec): that hole is drilled and tapped as
          // itself, so the counterbore adds only its step. One whose bore is part of it is spotted and drilled here, as before.
          const ownBoreOcc = occurrences.flatMap((o: any, i: number) => (o.bore_spec ? [] : [i]));
          const ownBore = occurrences.length > 0 ? ownBoreOcc.length : count;
          if (ownBore > 0) {
            const boreOcc = occurrences.length > 0 ? ownBoreOcc : undefined;
            ops.push({ name: "Center Drilling", ...spotOp(diamMm, ownBore, refOf(`${ownBore} counterbored hole${ownBore === 1 ? '' : 's'}`, boreOcc)), source: "feature", cadFeatureType: ft, diameterMm: diamMm, count: ownBore });
            ops.push(...drilledOps(diamMm * 0.6, depthMm, ownBore, occRefs(boreOcc), { diameterMm: diamMm, count: ownBore })); // through bore
          }
          // The counterbore itself: the catalog's Step Drilling, timed as the workbook's Step Drilling sheet times it. One wider than the
          // drills reach has no step drill on file: it is bored out from the hole under it.
          ops.push(widerThanDrills(diamMm)
            ? { name: "Boring", ...boreOp(diamMm, depthMm, count, occRefs(), Math.min(diamMm * 0.6, largestDrill!)), source: "feature", cadFeatureType: ft, diameterMm: diamMm }
            : { name: "Step Drilling", ...stepOp(diamMm, depthMm, count, all), source: "feature", cadFeatureType: ft, diameterMm: diamMm });
        }
        break;

      case "Edge:countersink":
        if (diamMm > 0) {
          // A countersink on a hole the CAD recognised is that hole's mouth: the hole is drilled as its own feature, so only the
          // countersinking is added, over that hole's diameter (countersunk-holes.ts). One with no hole under it is spotted and drilled
          // here at 0.6 x its diameter, and countersunk over that drilled hole.
          const under = new Map<string, { holeMm: number; why: string; n: number; occ: number[] }>();
          // A countersink wider than the drills reach has no countersink tool on file: its mouth is chamfer milled, one pass of the end
          // mill round it (the Chamfering calculator, as a chamfer of that diameter is).
          const mouth = (n: number, occ: readonly number[] | undefined): EdgeLength[] => Array.from({ length: n }, (_, k) => ({
            lengthMm: mm3dp(Math.PI * diamMm),
            source: `CAD: pi x Ø${diamMm} mm, the countersink's mouth (wider than the countersink tools reach, so it is chamfer milled)`,
            ...(occ?.[k] != null ? { occ: occ[k] } : {}),
          }));
          let alone = occurrences.length > 0 ? 0 : count;
          const aloneOcc: number[] = [];
          for (const [i, o] of occurrences.entries()) {
            const hole = holeUnder(o, holes);
            if (!hole) { alone += 1; aloneOcc.push(i); continue; }
            const holeMm = hole.diameterMm ?? diamMm * 0.6;
            const why = hole.diameterMm !== null
              ? `CAD: the hole the countersink sits on, Ø${holeMm} mm`
              : 'The hole the countersink sits on has no diameter in the CAD: 0.6 x the countersink diameter';
            const group = under.get(why) ?? { holeMm, why, n: 0, occ: [] };
            group.n += 1;
            group.occ.push(i);
            under.set(why, group);
          }
          if (alone > 0) {
            const occ = occurrences.length > 0 ? aloneOcc : undefined;
            const ref = refOf(`${alone} countersink${alone === 1 ? '' : 's'}`, occ);
            // The hole drilled under it: 0.6 x the countersink's diameter, the calculation shown step by step.
            const drilledRef = calculationRef('The hole drilled under the countersink', [
              inputStep('Countersink diameter', 'mm', diamMm, 'CAD: countersink diameter', ref),
              inputStep('Drilled share of the diameter', null, 0.6, 'The drilling under a countersink with no hole of its own in the CAD: 0.6 x its diameter'),
              resultStep('Hole Diameter', 'mm', diamMm * 0.6, 'Countersink diameter x Drilled share of the diameter'),
            ]);
            ops.push({ name: "Center Drilling", ...spotOp(diamMm, alone, ref), source: "feature", cadFeatureType: ft, diameterMm: diamMm, count: alone });
            ops.push(...drilledOps(diamMm * 0.6, depthMm, alone, occRefs(occ), { diameterMm: diamMm, count: alone }));
            ops.push(widerThanDrills(diamMm)
              ? { name: "Chamfering", ...edgeOp('Chamfering', mouth(alone, occ), refOf), source: "feature", cadFeatureType: ft, diameterMm: diamMm, count: alone }
              : { name: "Countersinking", ...countersinkOp(diamMm, diamMm * 0.6, 'The hole drilled under the countersink: 0.6 x its diameter, as the drilling above takes it', alone, ref, drilledRef), source: "feature", cadFeatureType: ft, diameterMm: diamMm, count: alone });
          }
          for (const { holeMm, why, n, occ } of under.values()) {
            const ref = refOf(`${n} countersink${n === 1 ? '' : 's'}`, occ);
            ops.push(widerThanDrills(diamMm)
              ? { name: "Chamfering", ...edgeOp('Chamfering', mouth(n, occ), refOf), source: "feature", cadFeatureType: ft, diameterMm: diamMm, count: n }
              : { name: "Countersinking", ...countersinkOp(diamMm, holeMm, why, n, ref, ref), source: "feature", cadFeatureType: ft, diameterMm: diamMm, count: n });
          }
        }
        break;

      case "Edge:chamfer":
        ops.push({ name: "Chamfering", ...edgeOp('Chamfering', edgeLengths(diamMm, occurrences, count, 'chamfer'), refOf), source: "feature", cadFeatureType: ft, diameterMm: diamMm > 0 ? diamMm : undefined });
        break;

      case "Edge:round": {
        // An inside fillet the CAD measured as a torus (concave): finished by a ball nose end mill of its radius along its arc (Concave Fillet
        // Milling, user decision 2026-11-25). One at a turned shoulder (turned_shoulder) is formed by the finish turning pass on a lathe,
        // which mills no Edge feature (lathe-milling.ts), so it is cut only on a mill route, where nothing turns it. Every other round
        // (convex, or a concave cylindrical arc): one pass of the end mill along its edge (the Filleting calculator, the workbook's End
        // Milling sheet), over its arc when the CAD measured one.
        const inside = occurrences.filter((o) => isConcaveToroidFillet(o, diamMm));
        const edges = occurrences.filter((o) => !inside.includes(o));
        // The edges' and fillets' own positions among the feature's occurrences, for their refs.
        const indexOf = (o: any) => occurrences.indexOf(o);
        if (edges.length > 0 || occurrences.length === 0) {
          const edgeRefOf = (label: string, occ?: readonly number[]) => refOf(label, occ ? occ.map((k) => indexOf(edges[k])) : edges.map(indexOf));
          ops.push({
            name: "Filleting", ...edgeOp('Filleting', edgeLengths(diamMm, edges, count, 'round'), occurrences.length === 0 ? refOf : edgeRefOf), source: "feature", cadFeatureType: ft,
            diameterMm: diamMm > 0 ? diamMm : undefined, count: edges.length || count,
          });
        }
        if (inside.length > 0) {
          ops.push({
            name: CONCAVE_FILLET_MILLING, ...ballNoseOp(CONCAVE_FILLET_MILLING, 'fillet', inside.map((o) => ({ ...o, __occ: indexOf(o) })), diamMm, refOf), source: "feature", cadFeatureType: ft,
            diameterMm: diamMm > 0 ? diamMm : undefined, count: inside.length,
          });
        }
        break;
      }

      case "Slot:groove":
      case "Ring:groove":
        // A round-bottomed groove ("Groove Milling//Slot" on a mill): a ball nose end mill of its radius along its path (user decision
        // 2026-11-25). A turned groove ("Plunging//Ring") is plunged on a lathe (the turning engine's Plunging line); on a mill, or milled
        // with a live tool, it is milled the same way.
        ops.push({ name: "Groove Milling", ...ballNoseOp('Groove Milling', 'groove', occurrences.map((o, i) => ({ ...o, __occ: i })), diamMm, refOf), source: "feature", cadFeatureType: ft, diameterMm: diamMm > 0 ? diamMm : undefined });
        break;

      case "PlanarFace:default":
        ops.push({ name: "Fine Finish Milling", ...faceFinishOp(totalAreaMm2, faceCount, all), source: "feature", cadFeatureType: ft });
        break;

      case "CurvedWall:default":
      case "CurvedSurface:default":
        // The real catalog uses the same "Contouring" op for both feature types.
        ops.push({ name: "Contouring", ...(ft === 'CurvedWall' ? contourOp('Contouring', totalAreaMm2, 0, faceCount, all) : contourOp('Contouring', 0, totalAreaMm2, faceCount, all)), source: "feature", cadFeatureType: ft });
        break;

      case "Cutout:default":
        // Non-circular through-opening: its wall (totalAreaMm2) followed with the side of the cutter.
        ops.push({ name: "Perimeter Milling", ...contourOp('Perimeter Milling', totalAreaMm2, 0, faceCount, all), source: "feature", cadFeatureType: ft });
        break;

      default:
        // A turned outer diameter states its own cylinder, not material to
        // remove (stock-excess.ts): a lathe turns the stock round it, and on a
        // mill that stock is in the Bulk Milling of the stock around the part.
        // Any other feature with no milling case contributes its removed
        // volume to "Bulk Milling", the real catalog's generic-removal op.
        if (totalRemovedMm3 > 0 && !isTurnedDiameter(f)) {
          ops.push({ name: "Bulk Milling", ...volumeOp('Bulk Milling', totalRemovedMm3, all), source: "feature" });
        }
    }
    for (let i = firstOpOfFeature; i < ops.length; i++) {
      ops[i]!.count ??= instanceCount;
      if (typeof f.id === "string" && f.id) ops[i]!.featureIds = [f.id];
    }
  }

  // Deburr always follows machining (bench operation). Left un-renamed
  // deliberately: this op is excluded from the milling line's own cost sum
  // (MILLING_DOUBLE_BILLED_ELSEWHERE) and never validated against THIS
  // process's own operation_category list anyway — its real catalog home is
  // a different real ProcessName ("Manual Deburr"/"Automated Deburr"), which
  // is a real per-part billing already handled elsewhere (bom-items.service.ts's
  // separate, real getDeburrParams()-driven "Deburring" line).
  ops.push({ name: "Deburr", timeSec: 90, source: "fixed" });

  // Sort into canonical manufacturing order
  ops.sort((a, b) => opOrderIndex(a.name) - opOrderIndex(b.name));

  return ops;
}

/**
 * Sum total cycle time (seconds) from an OperationLine array.
 */
export function totalCycleTimeSec(ops: OperationLine[]): number {
  return ops.reduce((s, o) => s + o.timeSec, 0);
}

/**
 * Inject drawing intelligence overrides into an existing operation list.
 *
 * Rules applied (Fix 5):
 *  - Ra < 1.6 μm → scale any Finish* operation +30%, or add a Finish Pass
 *  - Tight tolerance < 0.05 mm → add CMM Inspect (60 s/feature)
 *  - Thread callouts → ensure Rigid Tap exists for each thread size
 *
 * Surface treatment (anodize, powder coat) is handled at a higher level via
 * computeSurfaceTreatmentLine() because it needs surfaceArea + batchSize.
 * This function only modifies machine-time ops.
 */
export function injectDrawingIntelligence(
  ops: OperationLine[],
  di: Record<string, any> | null | undefined,
  materialGrade: string | null = null,
  workbook: MachiningWorkbookInput | null = null,
  calculators: MachiningCalculators | null = null,
): OperationLine[] {
  if (!di) return ops;

  const result = [...ops];

  // Ra finish pass
  const raValue = di.surfaceFinishRa?.value ?? di.surface_finish_ra ?? null;
  const raMicron = typeof raValue === "number" ? raValue : parseFloat(raValue ?? "");
  if (isFinite(raMicron) && raMicron < 1.6 && raMicron > 0) {
    // A keyway's milling passes leave its finished walls and floor: they take the allowance as a roughing or finishing pass does.
    const finishIdx = result.findIndex((o) =>
      o.name.includes("Finish") || o.name.includes("Rough") || o.name === KEYWAY_MILLING,
    );
    if (finishIdx >= 0) {
      result[finishIdx] = { ...result[finishIdx], timeSec: result[finishIdx].timeSec * 1.3, timeFactor: (result[finishIdx].timeFactor ?? 1) * 1.3 };
    } else {
      result.push({ name: "Finish Pass", timeSec: 120, source: "feature" });
    }
  }

  // Thread callouts — add tapping if not already present
  const threads: any[] = Array.isArray(di.threads) ? di.threads : [];
  for (const t of threads) {
    const spec = t.spec ?? t.size ?? null;
    const count = t.count ?? 1;
    const alreadyHas = result.some((o) => o.name === "Tapping");
    if (!alreadyHas && spec) {
      result.push({ name: "Tapping", ...tapOp(spec, count, detectMaterialClass(materialGrade), t.pitchMm, t.depthMm, workbook, calculators), source: "feature" });
    }
  }

  // Tight tolerance → CMM
  const tightest = di.tolerances?.tightest ?? di.tightest_tolerance_mm ?? null;
  const tightestMm = typeof tightest === "number" ? tightest : parseFloat(tightest ?? "");
  const hasCmm = result.some((o) => o.name.toLowerCase().includes("cmm"));
  if (isFinite(tightestMm) && tightestMm < 0.05 && !hasCmm) {
    result.push({ name: "CMM Inspect", timeSec: 300, source: "feature" });
  }

  result.sort((a, b) => opOrderIndex(a.name) - opOrderIndex(b.name));
  return result;
}
