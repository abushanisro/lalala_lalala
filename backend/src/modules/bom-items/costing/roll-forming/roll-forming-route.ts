// The Sheet Metal Roll Forming routes of a profile (memory/Sheet metal roll forming): a coil line. The coil as supplied (Coil Material Stock)
// carries the material and takes no machine time; then the Uncoiler, the Coil Flattener (when the coil needs it), the Punch Press (the strip's
// holes, notches, lances and forms, before the mill), the Roll Forming Mill, Integrated Welding (a closed section) and the Cut-Off Press, by
// Scissor (no slug) or by Blade (a slug between parts): two routes, memory's rule picking one (a closed section is cut by blade), the other
// costed and shown. The line runs at one speed, so it is chosen whole: at every speed one of its limits allows, the cheapest machine of each
// place that runs at least that fast, the cheapest line quoted (roll-forming-line.ts). Every machine is one line costed for the part's run
// plus the line's stoppages a part (coil change, die re-sharpening) at its own rate and crew, and its setup over the batch. Every time and
// cost comes from a calculator (roll-forming-calculators.json) seeded from the reference data, the part's measurements (roll-forming-part.ts)
// and the machine; every machine from HR Rates (migrations 862, 1112). The data has no formula for the cycle, the roll stations or the
// tooling: those rules are the engine's own, agreed with the user (2026-11-22), and the quote says so. Pure: the caller loads the data and
// converts the currency.
import { punchPlan, rollFormingCatalogOperations, stepRow, type PunchPlan } from './roll-forming-features';
import {
  flattening, LINE_ORDER, limitingCap, machineCaps, machineSpeedCap, partLengthToleranceRow, slowestPress, type Line, type LineRole, type SpeedCap,
} from './roll-forming-line';
import { stationPlan, type BendGroup, type LevelPlan, type StationPlan } from './roll-forming-stations';
import { cutOffDiePlan, pressDie, punchDiePlan, rollTooling, type RollFormingTool } from './roll-forming-tooling';
import { line } from '../casting/casting-finishing';
import { machineChoice, type ChoiceEval } from '../casting/machine-choice';
import { asFinishingMachine, machineText, machineValue, type SandMachine } from '../casting/sand/sand-machines';
import { fail, routeKit, type KitRun, type RouteKit } from '../shared/calculators/route-kit';
import { noCostFeatureLine } from '../shared/core/engine-kernel';
import { ROLL_FORMING_PROCESS_GROUP } from '../shared/core/part-family-process-group';

import type { RollFormPart } from './roll-forming-part';
import type { FeatureOp, ProcessLineCost } from '../../dto/cost-breakdown.dto';
import type { CostContext } from '../casting/casting-finishing';
import type { SandReference } from '../casting/sand/sand-reference';
import type { SeedProvider } from '../casting/sand/sand-seeds';
import type { CostedStep } from '../casting/sand/sand-steps';
import type { ToolShop } from '../casting/tool-shop';
import type { DomainCalculatorSpec } from '../shared/calculators/domain-calculator-spec';
import type { CalcSeed, ReferenceCalcRun, ReferenceCalculatorDef } from '../shared/calculators/reference-calculator';

export { ROLL_FORMING_PROCESS_GROUP };
/** The reference-data domain (processes/memory-reference-domains.json): the calculator dialog opens a variable or lookup of it by this key. */
export const ROLL_FORMING_DOMAIN = 'sheet_roll_forming';
export const ROLL_FORMING_CLASS = {
  stock: 'sheet_roll_forming_coil_material_stock', uncoiler: 'sheet_roll_forming_uncoiler', flattener: 'sheet_roll_forming_coil_flattener',
  punch: 'sheet_roll_forming_punch_press', mill: 'sheet_roll_forming_roll_forming_mill', cutoff: 'sheet_roll_forming_cut_off_press',
  hfi: 'sheet_roll_forming_integrated_hfi_welding', laser: 'sheet_roll_forming_integrated_laser_welding',
  rotarySpot: 'sheet_roll_forming_integrated_rotary_spot_welding', tig: 'sheet_roll_forming_integrated_tig_welding',
} as const;
export const ROLL_FORMING_ROUTE_CLASSES: readonly string[] = Object.values(ROLL_FORMING_CLASS);
/** The catalog's processes (process_calculator_mappings.operation) of each place on the line. */
export const ROLL_FORMING_PROCESS = {
  stock: 'Coil Material Stock', uncoiler: 'Uncoiler', flattener: 'Coil Flattener', punch: 'Punch Press', mill: 'Roll Forming Mill', cutoff: 'Cut-Off Press',
} as const;
/** The integrated welding processes (rollFormWelding's values), each with its machine class. */
export const WELDING_PROCESS = {
  hfi: { process: 'Integrated HFI Welding', machineClass: ROLL_FORMING_CLASS.hfi },
  laser: { process: 'Integrated Laser Welding', machineClass: ROLL_FORMING_CLASS.laser },
  'rotary-spot': { process: 'Integrated Rotary Spot Welding', machineClass: ROLL_FORMING_CLASS.rotarySpot },
  tig: { process: 'Integrated TIG Welding', machineClass: ROLL_FORMING_CLASS.tig },
} as const;
export type WeldingKey = keyof typeof WELDING_PROCESS;
export const ROLL_FORMING_ROUTES = [
  { key: 'scissor', label: 'Roll Forming - Scissor Cut-Off', cutOff: 'Scissor Cut-Off' },
  { key: 'blade', label: 'Roll Forming - Blade Cut-Off', cutOff: 'Blade Cut-Off' },
] as const;
export type RollFormingRouteKey = (typeof ROLL_FORMING_ROUTES)[number]['key'];
export const ROLL_FORMING_ROUTE_LABEL = Object.fromEntries(ROLL_FORMING_ROUTES.map((r) => [r.key, r.label])) as Readonly<Record<RollFormingRouteKey, string>>;
/** The Cost Guide keys of a roll formed part (scenario_overrides). */
export const ROLL_FORMING_KEYS = {
  stations: 'rollFormStations', cutOff: 'rollFormCutOff', welding: 'rollFormWelding', toolingMultiplier: 'rollFormToolingMultiplier',
} as const;
export const RF_CALC = {
  stock: 'Roll Forming - Coil Material Stock', uncoiler: 'Roll Forming - Uncoiler', flattener: 'Roll Forming - Coil Flattener', punch: 'Roll Forming - Punch Press',
  mill: 'Roll Forming - Roll Forming Mill', welding: 'Roll Forming - Integrated Welding', cutoff: 'Roll Forming - Cut-Off Press',
  levelPasses: 'Roll Forming - Level Passes', stations: 'Roll Forming - Stations', lineSpeed: 'Roll Forming - Line Speed', coilChange: 'Roll Forming - Coil Change', dieSharpening: 'Roll Forming - Die Sharpening',
  strip: 'Roll Forming - Strip', material: 'Roll Forming - Material', force: 'Roll Forming - Press Force',
} as const;

export interface RollFormingMaterial {
  id: string | null;
  name: string;
  materialType: string | null;
  densityKgM3: number | null;
  /** USD per kg. */
  costPerKgUsd: number | null;
  utsMpa: number | null;
  yieldMpa: number | null;
  shearStrengthMpa: number | null;
  /** Where the price per kg was read (said on the material's calculator input); the material's own row when absent. */
  priceSource?: string | null;
}

export interface RollFormingScenario {
  batchSize: number;
  /** The cut-off the Cost Guide sets (rollFormCutOff), or the route forced by the route comparison; null: memory's rule. */
  route: RollFormingRouteKey | null;
  /** The Cost Guide's roll stations (rollFormStations); null: the rule's. */
  stations: number | null;
  /** The Cost Guide's welding (rollFormWelding); null: auto (autoIncludeIntegratedWeldingProcess on a closed section). */
  welding: WeldingKey | null;
  /** The Cost Guide's roll tooling multiplier (rollFormToolingMultiplier); null: the data's. */
  toolingMultiplier: number | null;
  /** Parts the tooling is spread over (annual volume x production life); null when the scenario gives none. */
  amortizationParts: number | null;
}

export interface RollFormingRouteInput {
  ref: SandReference;
  spec: DomainCalculatorSpec;
  calculators: Readonly<Record<string, ReferenceCalculatorDef>>;
  material: RollFormingMaterial;
  part: RollFormPart;
  machinesByClass: Readonly<Record<string, readonly SandMachine[]>>;
  scenario: RollFormingScenario;
  costContext: CostContext;
  toolShop: ToolShop | null;
  /** Memory's catalog of the process (process_taxonomy_operations raw strings): each step's operation on each feature, for the tree. */
  catalog?: readonly string[];
}

/** Which cut-off memory's rule gives the part: cutOffOperationType when the data sets one, else Blade for a closed section, Scissor otherwise. */
export interface RollFormingRule {
  route: RollFormingRouteKey;
  closed: boolean;
  basis: string;
}

/** A level of bends on the chosen mill: its passes, the degrees a pass forms and what limits them (the lift angle, or the flange it carries). */
export interface StationLevel extends LevelPlan {
  passes: number;
  degreesPerPass: number;
  governedBy: 'lift angle' | 'flange length';
}

export interface RollFormingRoute {
  key: RollFormingRouteKey;
  label: string;
  lines: ProcessLineCost[];
  material: {
    costUsd: number; stripKg: number; partKg: number; scrapKg: number; feedLengthMm: number; slugMm: number;
    /** The strip the coil is slit to (mm): the measured width, wider for bends modelled sharp (sharpBends). */
    stripWidthMm: number;
    run: ReferenceCalcRun | null; stripRun: ReferenceCalcRun | null;
  };
  stations: {
    forming: number; leadIn: number; finishing: number; rule: number; total: number; override: number | null; panel: boolean;
    levels: StationLevel[]; levelSource: StationPlan['levelSource']; flangeSource: StationPlan['flangeSource'];
    /** The groups of bends close together, each a rib (formed as one unit, carrying its own span) or formed as flanges. */
    groups: BendGroup[]; directionsMeasured: boolean;
    /** The stand spacing the passes were found on (the chosen mill's horizontal center length); null with no mill. */
    standSpacingMm: number | null;
    run: ReferenceCalcRun | null;
  };
  /** Bends modelled sharp (no radius), priced at the material's minimum bend radius; null when none is. */
  sharpBends: { count: number; pricedRadiusMm: number | null; stripAddedMm: number; basis: string } | null;
  mill: { name: string; stands: number | null; shaftDiameterMm: number | null; type: string | null; curveUnit: boolean } | null;
  requiredShaftMm: number | null;
  lineSpeed: { mmPerS: number; limiting: string | null; caps: SpeedCap[]; multiplier: number; speedsTried: number; run: ReferenceCalcRun } | null;
  coil: { massKg: number; partsPerCoil: number; changeTimeS: number; perPartS: number; method: string; setupMethod: string; run: ReferenceCalcRun } | null;
  dieSharpeningPerPartS: number;
  punching: { dieStations: string[]; punched: number; notPunched: { featureType: string; count: number; reason: string }[]; minHoleMm: number | null } | null;
  welding: { process: string; machine: string | null; source: 'rule' | 'cost guide' } | null;
  flattener: { needed: boolean; reason: string };
  forcesKn: { punch: number | null; cutOff: number | null };
  tooling: RollFormingTool[];
  totalUsd: number | null;
  /** False when the part cannot be roll formed (named in `infeasible`): its lines are then No Cost Feature lines saying why. */
  feasible: boolean;
  infeasible: string[];
  complete: boolean;
  warnings: string[];
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const r4 = (n: number) => Math.round(n * 10000) / 10000;
const isGap = (l: ProcessLineCost) => l.physicsGap != null;
const flag = (m: SandMachine, key: string) => m.specs[key] === true || String(m.specs[key]).toLowerCase() === 'true';

/** Memory's cut-off rule for the part (see RollFormingRule). */
export function rollFormingRule(ref: SandReference, part: Pick<RollFormPart, 'section'>): RollFormingRule {
  const set = (ref.text('cutOffOperationType') ?? '').trim().toLowerCase();
  if (set === 'scissor' || set === 'blade') return { route: set, closed: part.section.closed, basis: `cutOffOperationType ${ref.text('cutOffOperationType')}` };
  return part.section.closed
    ? { route: 'blade', closed: true, basis: 'a closed section is cut off by blade (cutOffOperationType Let eMithran Decide)' }
    : { route: 'scissor', closed: false, basis: 'an open section is cut off by scissor (cutOffOperationType Let eMithran Decide)' };
}

/** The material's minimum bend radius (minBendRadii at its yield, x t), with how it is found; null when its yield is not on file. */
export function minBendRadius(ref: SandReference, thicknessMm: number, yieldMpa: number | null): { mm: number | null; k: number | null; basis: string } {
  if (yieldMpa == null) return { mm: null, k: null, basis: 'the material has no yield strength on file for minBendRadii' };
  const row = stepRow(ref.table('minBendRadii'), 'Material Yield (N / mm^2)', yieldMpa);
  const k = row != null ? Number(row['Min Bend Radius Thickness Multiplier']) : null;
  return k != null && Number.isFinite(k)
    ? { mm: k * thicknessMm, k, basis: `minBendRadii ${k} x t at ${r2(yieldMpa)} MPa yield` }
    : { mm: null, k: null, basis: `minBendRadii has no row for ${r2(yieldMpa)} MPa yield` };
}

/**
 * What keeps the part from being roll formed at all (memory's limits): a coil thicker than maxCoilThickness or of a yield above
 * maxCoilYieldStrength, and a curve the curving unit cannot bend: the profile wraps its top roller, so the radius to the profile's inner face
 * (the curve's radius at the section's centroid less half the section's depth) may be no smaller than the roller's radius,
 * curveUnitTopRollerDiameter / 2. Only warned: a radiused bend tighter than minBendRadii at the material's yield (a bend modelled sharp is
 * priced at that radius instead), and a free edge flange shorter than minBendFlapSizeThicknessMultiplier x t. A roll formed flange has no
 * maximum: a long one costs passes (roll-forming-stations.ts), so maxBendFlapSizeThicknessMultiplier is not applied.
 */
export function rollFormingFeasibility(ref: SandReference, part: RollFormPart, material: Pick<RollFormingMaterial, 'yieldMpa' | 'name'>): { infeasible: string[]; warnings: string[] } {
  const t = part.thicknessMm;
  const infeasible: string[] = [];
  const warnings: string[] = [];
  const maxT = ref.number('maxCoilThickness');
  if (maxT != null && t > maxT + 1e-9) infeasible.push(`the ${r2(t)} mm sheet is thicker than a coil is roll formed (maxCoilThickness ${maxT} mm)`);
  const maxYield = ref.number('maxCoilYieldStrength');
  if (maxYield != null && material.yieldMpa != null && material.yieldMpa > maxYield + 1e-9) {
    infeasible.push(`${material.name}'s ${r2(material.yieldMpa)} MPa yield is above what a coil is roll formed at (maxCoilYieldStrength ${maxYield} MPa)`);
  }
  const roller = ref.number('curveUnitTopRollerDiameter');
  if (part.curve && roller != null) {
    const halfDepth = (part.tube?.outerDiameterMm ?? part.section.heightMm) / 2;
    const inner = part.curve.radiusMm - halfDepth;
    if (inner < roller / 2 - 1e-9) {
      infeasible.push(`the profile is curved to a ${r2(inner)} mm radius at its inner face (${r2(part.curve.radiusMm)} mm at its centroid less half its ${r2(2 * halfDepth)} mm depth), `
        + `tighter than it wraps the curving unit's top roller (curveUnitTopRollerDiameter ${roller} mm: ${r2(roller / 2)} mm radius)`);
    }
  }
  const minimum = minBendRadius(ref, t, material.yieldMpa);
  const tight = minimum.mm != null ? part.bends.filter((b) => !b.sharp && b.innerRadiusMm != null && b.innerRadiusMm < minimum.mm! - 1e-9) : [];
  if (tight.length) {
    warnings.push(`${tight.length} bend(s) of ${tight.map((b) => `${r2(b.innerRadiusMm!)} mm`).join(', ')} inner radius are tighter than ${material.name} bends (${minimum.basis} = ${r2(minimum.mm!)} mm): the profile may crack.`);
  }
  const minFlap = ref.number('minBendFlapSizeThicknessMultiplier');
  // A flap is a free flange: the strip's edges of an open section (the first flat before the first bend, the last after the last).
  const flaps = part.section.closed || part.tube || part.bends.length === 0 ? [] : [part.bends[0].flangeBeforeMm, part.lastFlangeMm].filter((f): f is number => f != null);
  const short = minFlap != null ? flaps.filter((f) => f < minFlap * t - 1e-9) : [];
  if (short.length) {
    warnings.push(`The free flange(s) of ${short.map((f) => `${r2(f)} mm`).join(', ')} are shorter than minBendFlapSizeThicknessMultiplier ${minFlap} x t (${r2(minFlap! * t)} mm): the rolls may not grip them to bend.`);
  }
  return { infeasible, warnings };
}

/** The mill shaft the strip needs: millShaftDiameters at its thickness, uHSMaterialMillShaftDiameters for a material at or above ultraHighStrengthMaterialThresholdLow UTS. */
export function requiredShaft(ref: SandReference, thicknessMm: number, utsMpa: number | null): { mm: number | null; basis: string } {
  const threshold = ref.number('ultraHighStrengthMaterialThresholdLow');
  const uhs = utsMpa != null && threshold != null && utsMpa >= threshold;
  const table = uhs ? 'uHSMaterialMillShaftDiameters' : 'millShaftDiameters';
  const row = stepRow(ref.table(table), 'Max Thickness (mm)', thicknessMm);
  const mm = row != null ? Number(row['Diameter (mm)']) : null;
  return { mm, basis: `${table} at ${r2(thicknessMm)} mm${uhs ? ` (UTS ${r2(utsMpa)} MPa at or above ultraHighStrengthMaterialThresholdLow ${threshold} MPa)` : ''}` };
}

/** coilSetupMethod as the Coil Change calculator reads it: 0 Let eMithran Decide (the thickness rule), 1 Threading, 2 Welding, 3 Accumulator. */
export function coilSetupMethod(ref: SandReference): { code: number; name: string } {
  const name = ref.text('coilSetupMethod') ?? 'Let eMithran Decide';
  const v = name.trim().toLowerCase();
  return { code: v === 'threading' ? 1 : v === 'welding' ? 2 : v === 'accumulator' ? 3 : 0, name };
}

/** One place on the line: its process, the machines it may run on, and what a machine must have (its speed apart). */
interface LinePlace {
  role: LineRole;
  process: string;
  machines: readonly SandMachine[];
  check: (m: SandMachine) => string | null;
  criteria: string[];
}

/** A machine of a place: why it cannot do the step (null when it can, at some speed), and the fastest it lets the line run. */
interface Candidate {
  m: SandMachine;
  reason: string | null;
  cap: number | null;
}

/** Every route of the part (each complete or with its gaps), and what keeps any route from being built. */
export function buildRollFormingRoutes(input: RollFormingRouteInput): { routes: RollFormingRoute[]; missing: string[] } {
  const { ref, part, material, scenario } = input;
  const none = (...missing: string[]) => ({ routes: [] as RollFormingRoute[], missing });
  if (material.densityKgM3 == null || !(material.densityKgM3 > 0)) return none(`${material.name}: its density`);
  if (material.costPerKgUsd == null || !(material.costPerKgUsd > 0)) return none(`${material.name}: its price per kg`);
  const t = part.thicknessMm;
  // A bend modelled sharp is priced at the material's minimum bend radius r, and the strip the coil is slit to grows by its bend allowance
  // θ(r + K t) (K 0.33 below r = 2t, else 0.41: the extractor's rule) less the θ 0.33 t the measurement bends a sharp corner by.
  const minRadius = minBendRadius(ref, t, material.yieldMpa);
  const sharp = part.bends.filter((b) => b.sharp);
  const sharpAddMm = minRadius.mm == null ? 0 : sharp.reduce((sum, b) => {
    const theta = (b.angleDeg * Math.PI) / 180;
    const k = minRadius.mm! < 2 * t ? 0.33 : 0.41;
    return sum + theta * (minRadius.mm! + k * t) - theta * 0.33 * t;
  }, 0);
  const W = part.stripWidthMm + sharpAddMm;
  const priced: RollFormPart = sharpAddMm > 0 ? { ...part, stripWidthMm: W } : part;
  const seed = (value: number, source: string): CalcSeed => ({ value, source });
  const measuredStrip = part.stripWidthSource === 'neutral fibre'
    ? `the section's flats and bends at the neutral fibre (${r2(part.stripWidthMidMm)} mm at the mid-line)`
    : "the section's mid-line stretch-out, its area / t";
  const cad: Record<string, CalcSeed | undefined> = {
    strip_width_mm: seed(W, sharpAddMm > 0
      ? `the strip the coil is slit to (mm): ${r2(part.stripWidthMm)} mm measured (${measuredStrip}) + ${r2(sharpAddMm)} mm for ${sharp.length} sharp bend(s) at the ${r2(minRadius.mm!)} mm radius they are priced at`
      : `the strip the coil is slit to: ${measuredStrip} (mm)`),
    length_mm: seed(part.lengthMm, 'the part length along the profile (mm)'),
    thickness_mm: seed(t, 'the sheet thickness (mm)'),
  };
  const materialProvider: SeedProvider = (column) => {
    const v = column === 'density_kg_m3' ? material.densityKgM3 : column === 'cost' ? material.costPerKgUsd : column === 'shear_strength_mpa' ? material.shearStrengthMpa : null;
    if (v == null) return null;
    const label = column === 'cost' ? `price (USD/kg${material.priceSource ? `: ${material.priceSource}` : ''})` : column === 'density_kg_m3' ? 'density (kg/m³)' : 'shear strength (MPa)';
    return { value: v, source: `${material.name}: ${label}`, ...(material.id ? { ref: { kind: 'material' as const, materialId: material.id, materialName: material.name, column } } : {}) };
  };
  const welding = (() => {
    if (scenario.welding) return { key: scenario.welding, source: 'cost guide' as const };
    if (!part.section.closed) return null;
    const auto = (ref.text('autoIncludeIntegratedWeldingProcess') ?? 'Integrated HFI Welding').trim().toLowerCase();
    const key = (Object.keys(WELDING_PROCESS) as WeldingKey[]).find((k) => WELDING_PROCESS[k].process.toLowerCase() === auto);
    return key ? { key, source: 'rule' as const } : null;
  })();
  const processClass: Record<string, string> = {
    [ROLL_FORMING_PROCESS.stock]: ROLL_FORMING_CLASS.stock, [ROLL_FORMING_PROCESS.uncoiler]: ROLL_FORMING_CLASS.uncoiler,
    [ROLL_FORMING_PROCESS.flattener]: ROLL_FORMING_CLASS.flattener, [ROLL_FORMING_PROCESS.punch]: ROLL_FORMING_CLASS.punch,
    [ROLL_FORMING_PROCESS.mill]: ROLL_FORMING_CLASS.mill, [ROLL_FORMING_PROCESS.cutoff]: ROLL_FORMING_CLASS.cutoff,
    ...Object.fromEntries(Object.values(WELDING_PROCESS).map((w) => [w.process, w.machineClass])),
  };
  const kit: RouteKit = routeKit({
    ref, spec: input.spec, calculators: input.calculators, machinesByClass: input.machinesByClass, batchSize: scenario.batchSize, costContext: input.costContext,
    domain: ROLL_FORMING_DOMAIN, domainLabel: 'Roll Forming', processGroup: ROLL_FORMING_PROCESS_GROUP, processClass, partName: 'part', cad, material: materialProvider,
  });

  // ── What the part needs of the line, whatever the cut-off ─────────────────────────────────────────────────────────────────────────
  const sharpBends = sharp.length ? {
    count: sharp.length, pricedRadiusMm: minRadius.mm, stripAddedMm: sharpAddMm,
    basis: minRadius.mm != null
      ? `modelled sharp: priced at the material's minimum bend radius ${minRadius.k} x t = ${r2(minRadius.mm)} mm (${minRadius.basis}); the strip is ${r2(sharpAddMm)} mm wider for it `
        + `(each bend's allowance θ(r + K t) less the θ 0.33 t the measurement bends a sharp corner by): ${r2(W)} mm, measured ${r2(part.stripWidthMm)} mm`
      : `modelled sharp: priced with no radius, as modelled (${minRadius.basis})`,
  } : null;
  const plan = stationPlan(ref, priced, minRadius.mm);
  // The passes of each level on a mill of stand spacing S (its horizontal center length), and the stations they make: per spacing, once.
  const passesBySpacing = new Map<string, { levels: StationLevel[]; forming: number } | { reasons: string[] }>();
  const levelPasses = (mill: SandMachine | null): { levels: StationLevel[]; forming: number } | { reasons: string[] } => {
    const spacing = mill ? machineValue(mill, 'horizontal_center_length_mm') : null;
    const key = String(spacing ?? '-');
    const hit = passesBySpacing.get(key);
    if (hit) return hit;
    const levels: StationLevel[] = [];
    for (const l of plan.levels) {
      const measured = l.flangeCarriedMm != null && spacing != null && spacing > 0;
      const r = kit.run(RF_CALC.levelPasses, null, {
        largest_angle_deg: seed(l.maxAngleDeg, `level ${l.level}: the largest of its ${l.bends} bend(s)`),
        flange_carried_mm: seed(measured ? l.flangeCarriedMm! : 0, measured
          ? `level ${l.level}: the longest flange its bends carry (${plan.flangeSource === 'tube' ? "half the tube's strip, to the seam" : plan.flangeSource === 'closed section' ? 'to the seam, the shorter way' : 'out to the free edge'})`
          : l.flangeCarriedMm == null ? 'the flats were not measured: the lift angle alone' : 'no mill: the lift angle alone'),
        stand_spacing_mm: spacing != null ? {
          ...seed(spacing, `${mill!.name}: its horizontal center length (the stand spacing)`),
          ref: { kind: 'machine', machineId: mill!.id, machineName: mill!.name, machineClass: mill!.machineClass, location: mill!.location, column: 'horizontal_center_length_mm' },
        } : seed(0, 'no mill: the lift angle alone'),
      });
      if (!('run' in r)) {
        const out = { reasons: r.reasons };
        passesBySpacing.set(key, out);
        return out;
      }
      const perPass = r.run.outputs['Degrees per Pass'] ?? plan.liftAngleDeg;
      levels.push({ ...l, passes: Math.round(r.sec), degreesPerPass: perPass, governedBy: perPass < plan.liftAngleDeg - 1e-9 ? 'flange length' : 'lift angle' });
    }
    const out = { levels, forming: levels.reduce((s, l) => s + l.passes, 0) };
    passesBySpacing.set(key, out);
    return out;
  };
  const stationsByForming = new Map<number, KitRun>();
  const stationsOf = (forming: number, levels: readonly StationLevel[]): KitRun => {
    const hit = stationsByForming.get(forming);
    if (hit) return hit;
    const r = kit.run(RF_CALC.stations, null, {
      forming_passes: seed(forming, levels.length
        ? `${levels.map((l) => `level ${l.level}: ${l.bends} bend(s), largest ${r2(l.maxAngleDeg)}° at ${r2(l.degreesPerPass)}° a pass (${l.governedBy}) = ${l.passes}`).join('; ')} (levels ${plan.levelSource === 'cad' ? 'measured' : plan.levelSource === 'flats' ? 'from the flats, out from the widest' : 'assumed all on one'})`
        : 'no bend across the strip'),
      finishing_passes: kit.lookupSeed('toleranceThresholds', plan.toleranceRow, 'Number of Finishing Passes', ['Tolerance Type', 'Tolerance Name']),
    });
    stationsByForming.set(forming, r);
    return r;
  };
  interface Stations { levels: StationLevel[]; forming: number; run: ReferenceCalcRun; rule: number; leadIn: number; finishing: number; total: number }
  /** The stations a mill must have for the profile (the Cost Guide's when set), with the passes behind them. */
  const stationsOn = (mill: SandMachine | null): Stations | { reasons: string[] } => {
    const p = levelPasses(mill);
    if ('reasons' in p) return { reasons: p.reasons };
    const run = stationsOf(p.forming, p.levels);
    if (!('run' in run)) return { reasons: run.reasons };
    const rule = Math.round(run.sec);
    const leadIn = run.run.outputs['Lead-in Passes'] ?? 0;
    return { ...p, run: run.run, rule, leadIn, finishing: Math.round(run.sec - p.forming - leadIn), total: scenario.stations ?? rule };
  };
  /** The rolls a mill needs (its stations on its own stand spacing), spread over the job's parts: weighed in the line's choice when the job has a volume. */
  const rollsByStations = new Map<number, number>();
  const rollsPerPart = (mill: SandMachine): { usd: number; stations: number } | null => {
    const parts = scenario.amortizationParts;
    const st = stationsOn(mill);
    if (!(parts != null && parts > 0) || 'reasons' in st) return null;
    const hit = rollsByStations.get(st.total);
    if (hit != null) return { usd: hit, stations: st.total };
    const r = rollTooling({
      kit, ref, stripWidthMm: W, stations: st.total, panel: plan.panel, multiplierOverride: scenario.toolingMultiplier, materialType: material.materialType, amortizationParts: parts,
    });
    const usd = r.tool.investmentUsd != null ? r.tool.investmentUsd / parts : 0;
    rollsByStations.set(st.total, usd);
    return { usd, stations: st.total };
  };
  const plain = stationsOn(null);
  if ('reasons' in plain) return none(...plain.reasons);
  const { infeasible, warnings: feasibilityWarnings } = rollFormingFeasibility(ref, part, material);
  const punch: PunchPlan = punchPlan(ref, part, material.utsMpa);
  const flatten = flattening(ref, t, material.yieldMpa);
  const shaft = requiredShaft(ref, t, material.utsMpa);
  const tolerance = partLengthToleranceRow(ref);
  const multiplierRow = plan.toleranceRow;
  const multiplier = multiplierRow != null && Number.isFinite(Number(multiplierRow['Line Speed Multiplier'])) ? Number(multiplierRow['Line Speed Multiplier']) : 1;
  const curved = part.curve != null;
  const dieFactor = ref.number('stationaryDieLineSpeedFactor') ?? 1;
  const setup = coilSetupMethod(ref);
  const usePreferred = ref.flag('usePreferredMachines') === true;
  const cutLength = punch.punched.filter((f) => f.featureType !== 'Form').reduce((s, f) => s + f.perimeterMm, 0);
  const shear = material.shearStrengthMpa;
  const force = (length: number, source: string): number | null => {
    if (!(shear != null && shear > 0) || !(length > 0)) return null;
    const r = kit.run(RF_CALC.force, null, { cut_length_mm: seed(length, source) });
    return 'run' in r ? r.sec : null;
  };
  const punchForce = force(cutLength, `the punched features' cut perimeter, all stations in one stroke (mm)`);
  const sharedWarnings = [...feasibilityWarnings];
  if (sharpBends) sharedWarnings.push(`${sharpBends.count} bend(s) ${sharpBends.basis}.`);
  if (!(shear != null && shear > 0)) sharedWarnings.push(`The presses' force is not checked: ${material.name} has no shear strength on file.`);
  if (plan.levelSource === 'assumed' && plan.bendCount > 0) sharedWarnings.push('The bends\' levels out from the web were not measured: every bend is taken as one level (the fewest forming passes).');
  if (plan.flangeSource === 'not measured' && plan.bendCount > 0) sharedWarnings.push('The flats across the strip were not measured: each level\'s passes are its angle over rollFormingLiftAngle, without the flange-length limit.');
  const ribs = plan.groups.filter((g) => g.rib);
  if (ribs.length) {
    sharedWarnings.push(`${ribs.length} rib(s) (bends within ${r2(plan.groupGapMm ?? 0)} mm whose turns cancel: distanceBetweenGroupBendsMax x distanceBetweenGroupBendsMultiplier) `
      + 'formed each as one unit at its inner bend\'s level, carrying only its own span, not the panel beyond it.');
  }
  if (plan.groups.length && !plan.directionsMeasured) {
    sharedWarnings.push(`Bend directions were not measured: ${plan.groups.length} group(s) of bends within ${r2(plan.groupGapMm ?? 0)} mm are formed as flanges `
      + '(a rib, whose turns cancel, would carry only its own span: press Refresh analysis once the cad-engine measures directions).');
  }
  if (plan.levels.some((l) => l.flangeCarriedMm != null)) {
    sharedWarnings.push('A long flange takes more passes: a pass bends it no more than the stand spacing allows (rigid-plastic deformation length, Bhattacharyya et al. 1984), '
      + 'which is conservative (later studies find the deformation length shorter).');
  }
  if (punch.punched.some((f) => f.sizeMm == null)) sharedWarnings.push('Some punched features have no size measured: whether they are too small to punch is not checked.');
  if (scenario.welding && !part.section.closed) sharedWarnings.push(`${WELDING_PROCESS[scenario.welding].process} is on the line as the Cost Guide sets it, though the section is open.`);
  if (setup.code === 3) {
    sharedWarnings.push('coilSetupMethod Accumulator: each coil is end welded while the accumulator feeds the line, which stops only for the uncoiler\'s coil load '
      + '(not at all on a double mandrel uncoiler); the accumulator is not among the line\'s machines, so it is not costed.');
  }

  const routes = ROLL_FORMING_ROUTES.map((def): RollFormingRoute => {
    const blade = def.key === 'blade';
    const slug = blade ? ref.number('slugDieCutOffLength') ?? 0 : 0;
    const stripRun = kit.run(RF_CALC.strip, null, {
      slug_mm: seed(slug, blade ? `slugDieCutOffLength ${slug} mm: the blade cuts a slug out between parts` : 'a scissor cut-off leaves no slug'),
    });
    const warnings = [...sharedWarnings];
    const fallbackFeed = part.lengthMm + slug;
    const stripKg = 'run' in stripRun ? stripRun.sec : (W * fallbackFeed * t * material.densityKgM3!) / 1e9;
    const feed = 'run' in stripRun ? stripRun.run.outputs['Feed Length'] ?? fallbackFeed : fallbackFeed;
    const materialRun = kit.run(RF_CALC.material, null, { strip_mass_kg: seed(stripKg, `${RF_CALC.strip}: ${r2(W)} x ${r2(feed)} mm x ${r2(t)} mm`) });
    const materialUsd = 'run' in materialRun ? materialRun.sec : stripKg * material.costPerKgUsd!;
    const punchedArea = punch.punched.filter((f) => f.featureType !== 'Form').reduce((s, f) => s + f.areaMm2, 0);
    const partKg = Math.max(0, (W * part.lengthMm - punchedArea) * t * material.densityKgM3!) / 1e9;
    const stationsView = (s: Stations, spacing: number | null) => ({
      forming: s.forming, leadIn: s.leadIn, finishing: s.finishing, rule: s.rule, total: s.total, override: scenario.stations, panel: plan.panel,
      levels: s.levels, levelSource: plan.levelSource, flangeSource: plan.flangeSource, groups: plan.groups, directionsMeasured: plan.directionsMeasured,
      standSpacingMm: spacing, run: s.run,
    });
    const base = {
      key: def.key, label: def.label,
      material: {
        costUsd: materialUsd, stripKg, partKg, scrapKg: Math.max(0, stripKg - partKg), feedLengthMm: feed, slugMm: slug, stripWidthMm: W,
        run: 'run' in materialRun ? materialRun.run : null, stripRun: 'run' in stripRun ? stripRun.run : null,
      },
      sharpBends,
      requiredShaftMm: shaft.mm,
      flattener: flatten,
      welding: welding ? { process: WELDING_PROCESS[welding.key].process, machine: null as string | null, source: welding.source } : null,
    };
    if (!('run' in stripRun)) warnings.push(...stripRun.reasons);
    if (!('run' in materialRun)) warnings.push(...materialRun.reasons);

    // ── A part the line cannot make: every route is not feasible, its lines No Cost Feature lines saying why ────────────────────────
    if (infeasible.length) {
      return {
        ...base, stations: stationsView(plain, null),
        lines: infeasible.map((reason) => noCostFeatureLine({ reason: `Not roll formed: ${reason}`, processGroup: ROLL_FORMING_PROCESS_GROUP })),
        mill: null, lineSpeed: null, coil: null, dieSharpeningPerPartS: 0, punching: null, forcesKn: { punch: null, cutOff: null }, tooling: [],
        totalUsd: null, feasible: false, infeasible, complete: false, warnings,
      };
    }

    // ── The line's places and what each machine must have, its speed apart ───────────────────────────────────────────────────────
    const cutOffPlan = cutOffDiePlan(ref, part.section, def.key);
    const punchPlanDie = punch.stations.length ? punchDiePlan(ref, W, punch.stations) : null;
    // The cut is the end's own cut length (the strip width for a square cut; longer for a notched or angled end), once by scissor, twice by blade.
    const endCut = Math.max(0, ...part.ends.map((e) => e.cutPerimeterMm ?? 0));
    const cut = endCut > 0 ? endCut : W;
    const cutWhat = endCut > 0 ? "the end's measured cut length" : 'the strip width';
    const cutOffForce = force(cut * (blade ? 2 : 1), blade ? `${cutWhat} cut twice (both sides of the slug, mm)` : `${cutWhat} cut once (mm)`);
    const fits = (m: SandMachine, die: { lengthMm: number; widthMm: number } | null): string | null => {
      const tl = machineValue(m, 'press_table_length_mm');
      const tw = machineValue(m, 'press_table_width_mm');
      if (!die || tl == null || tw == null) return null;
      const ok = (die.lengthMm <= tl + 1e-9 && die.widthMm <= tw + 1e-9) || (die.lengthMm <= tw + 1e-9 && die.widthMm <= tl + 1e-9);
      return ok ? null : `its ${tl} x ${tw} mm table is under the ${r2(die.lengthMm)} x ${r2(die.widthMm)} mm die`;
    };
    const forceOk = (m: SandMachine, kn: number | null): string | null => {
      const cap = machineValue(m, 'press_force_kn');
      return kn != null && cap != null && kn > cap + 1e-9 ? `${r2(kn)} kN of cutting over its ${cap} kN` : null;
    };
    // The section the welder's working envelope must take: a tube's outside (an oval's two sizes), else the section's width and height.
    const tube = part.tube;
    const weldSection = tube?.outerDiameterMm != null
      ? { a: tube.outerDiameterMm, b: tube.outerDiameterMm, what: `the ${r2(tube.outerDiameterMm)} mm tube` }
      : tube?.outerWidthMm != null && tube.outerHeightMm != null
        ? { a: tube.outerWidthMm, b: tube.outerHeightMm, what: `the ${r2(tube.outerWidthMm)} x ${r2(tube.outerHeightMm)} mm tube` }
        : { a: part.section.widthMm, b: part.section.heightMm, what: `the ${r2(part.section.widthMm)} x ${r2(part.section.heightMm)} mm section` };
    const places: LinePlace[] = [
      {
        role: 'uncoiler', process: ROLL_FORMING_PROCESS.uncoiler, machines: input.machinesByClass[ROLL_FORMING_CLASS.uncoiler] ?? [],
        check: (m) => {
          const w = machineValue(m, 'max_stock_width_mm');
          return w != null && W > w + 1e-9 ? `takes stock up to ${w} mm wide, the strip is ${r2(W)} mm` : null;
        },
        criteria: ['Takes the strip width'],
      },
      ...(flatten.needed ? [{
        role: 'flattener' as const, process: ROLL_FORMING_PROCESS.flattener, machines: input.machinesByClass[ROLL_FORMING_CLASS.flattener] ?? [],
        check: (m: SandMachine) => {
          const w = machineValue(m, 'max_stock_width_mm');
          const mt = machineValue(m, 'max_stock_thickness_mm');
          if (w != null && W > w + 1e-9) return `takes stock up to ${w} mm wide, the strip is ${r2(W)} mm`;
          return mt != null && t > mt + 1e-9 ? `takes stock up to ${mt} mm thick, the strip is ${r2(t)} mm` : null;
        },
        criteria: ['Takes the strip width', 'Takes the stock thickness'],
      }] : []),
      ...(punch.stations.length ? [{
        role: 'punch' as const, process: ROLL_FORMING_PROCESS.punch, machines: input.machinesByClass[ROLL_FORMING_CLASS.punch] ?? [],
        check: (m: SandMachine) => forceOk(m, punchForce) ?? fits(m, punchPlanDie),
        criteria: ['Its press force takes the punching', 'The progressive die fits its table'],
      }] : []),
      {
        role: 'mill', process: ROLL_FORMING_PROCESS.mill, machines: input.machinesByClass[ROLL_FORMING_CLASS.mill] ?? [],
        check: (m) => {
          const stands = machineValue(m, 'number_of_roll_stands');
          const shaftMm = machineValue(m, 'shaft_diameter_mm');
          const maxT = machineValue(m, 'max_stock_thickness_mm');
          const height = machineValue(m, 'max_section_height_mm');
          const space = machineValue(m, 'roll_space_mm');
          const type = machineText(m, 'mill_type');
          if (shaft.mm == null) return `no shaft size for a ${r2(t)} mm strip (${shaft.basis})`;
          if (shaftMm == null || shaftMm < shaft.mm - 1e-9) return `a ${shaftMm ?? '?'} mm shaft, the strip needs ${shaft.mm} mm (${shaft.basis})`;
          if (maxT != null && t > maxT + 1e-9) return `takes stock up to ${maxT} mm thick, the strip is ${r2(t)} mm`;
          if (height != null && part.section.heightMm > height + 1e-9) return `forms sections up to ${height} mm high, the section is ${r2(part.section.heightMm)} mm`;
          if (space != null && W > space + 1e-9) return `a ${space} mm roll space, the strip is ${r2(W)} mm`;
          if (curved && !flag(m, 'curve_unit')) return 'no curving unit, and the profile is curved';
          if (!curved && plan.panel && type !== 'duplex') return `a ${type ?? '?'} mill, a panel profile (${plan.bendCount} bends, minNumBendsForPanelCrossSection ${plan.panelThreshold}) needs a duplex mill`;
          if (!curved && !plan.panel && type === 'duplex') return 'a duplex (panel) mill, the profile is a standard one';
          const need = stationsOn(m);
          if ('reasons' in need) return need.reasons.join('; ');
          if (stands == null || stands < need.total) {
            return `${stands ?? 'no'} roll stands, the profile needs ${need.total} on its ${machineValue(m, 'horizontal_center_length_mm') ?? '?'} mm stand spacing`;
          }
          return null;
        },
        criteria: ['The shaft the strip needs', 'Takes the stock thickness', 'Forms the section height', 'Its roll space takes the strip',
          ...(curved ? ['A curving unit'] : [plan.panel ? 'A duplex mill (a panel profile)' : 'A standard mill']), 'Enough roll stands for the passes on its stand spacing',
        ],
      },
      ...(welding ? [{
        role: 'welder' as const, process: WELDING_PROCESS[welding.key].process, machines: input.machinesByClass[WELDING_PROCESS[welding.key].machineClass] ?? [],
        check: (m: SandMachine) => {
          const mt = machineValue(m, 'max_stock_thickness_mm');
          if (mt != null && t > mt + 1e-9) return `welds stock up to ${mt} mm thick, the strip is ${r2(t)} mm`;
          const wh = machineValue(m, 'working_height_mm');
          const ww = machineValue(m, 'working_width_mm');
          if (wh == null || ww == null) return null;
          const [big, small] = [Math.max(wh, ww), Math.min(wh, ww)];
          return Math.max(weldSection.a, weldSection.b) > big + 1e-9 || Math.min(weldSection.a, weldSection.b) > small + 1e-9
            ? `a ${ww} x ${wh} mm working envelope, under ${weldSection.what}` : null;
        },
        criteria: ['Welds the stock thickness', 'Its working envelope takes the section'],
      }] : []),
      {
        role: 'cutoff', process: ROLL_FORMING_PROCESS.cutoff, machines: input.machinesByClass[ROLL_FORMING_CLASS.cutoff] ?? [],
        check: (m) => {
          const stroke = machineValue(m, 'max_stroke_length_mm');
          const allowanceName = blade ? 'bladeAllowanceGap' : 'cutOffScissorMarginCutAllowance';
          const need = part.section.heightMm + (ref.number(allowanceName) ?? 0);
          if (stroke != null && stroke < need - 1e-9) return `a ${stroke} mm stroke, the cut needs ${r2(need)} mm (the section + ${allowanceName})`;
          return forceOk(m, cutOffForce) ?? fits(m, cutOffPlan);
        },
        criteria: ['Its stroke clears the section', 'Its press force takes the cut', 'The cut-off die fits its table'],
      },
    ];
    const candidates = new Map<LineRole, Candidate[]>(places.map((p) => [p.role, p.machines.map((m) => ({
      m, reason: m.machineRatePerHr == null ? 'no machine hour rate on file, and the HR Rates engine could not price it' : p.check(m), cap: machineSpeedCap(p.role, m, feed, dieFactor),
    }))]));
    const working = places.filter((p) => candidates.get(p.role)!.some((c) => c.reason == null));

    // ── The line's own limits, the stoppages a part, and the time of each place at a speed ──────────────────────────────────────────
    const tolSpeed = tolerance.row != null ? Number(tolerance.row['Maximum Line Speed (mm / s)']) : null;
    const bending = curved ? ref.number('profileRollBendingSpeed') : null;
    const partCaps: SpeedCap[] = [
      ...(tolSpeed != null && tolSpeed > 0 ? [{ name: `the part-length tolerance (${tolerance.tolerance}, ${tolerance.system}: partLengthToleranceThresholds)`, mmPerS: tolSpeed }] : []),
      ...(bending != null && bending > 0 ? [{ name: 'profile bending on the curving unit (profileRollBendingSpeed)', mmPerS: bending }] : []),
    ];
    const partLimit = Math.min(Infinity, ...partCaps.map((c) => c.mmPerS));
    const sharpRun = kit.run(RF_CALC.dieSharpening, null, {
      punch_dies: seed(punch.stations.length ? 1 : 0, punch.stations.length ? 'the punch press\'s progressive die' : 'nothing is punched'),
      cut_off_dies: seed(1, 'the cut-off die'),
    });
    const sharpS = 'run' in sharpRun ? sharpRun.sec : 0;
    if (!('run' in sharpRun)) warnings.push(...sharpRun.reasons);
    const coils = new Map<string, KitRun>();
    const coilOf = (u: SandMachine): KitRun => {
      const hit = coils.get(u.id);
      if (hit) return hit;
      const r = kit.run(RF_CALC.coilChange, u, {
        strip_mass_kg: seed(stripKg, `${RF_CALC.strip}: ${r2(stripKg)} kg a part`),
        setup_method: seed(setup.code, `coilSetupMethod ${setup.name}`),
        double_mandrel: seed(flag(u, 'has_double_mandrel') ? 1 : 0, `${u.name}: ${flag(u, 'has_double_mandrel') ? 'a' : 'no'} double mandrel`),
      });
      coils.set(u.id, r);
      return r;
    };
    const cycles = new Map<string, KitRun>();
    /** A place's cycle at a line speed and stoppage a part, from its calculator (the same for every machine of the place). */
    const cycleOf = (process: string, v: number, coilS: number): KitRun => {
      const k = `${process}|${v}|${coilS}`;
      const hit = cycles.get(k);
      if (hit) return hit;
      const r = kit.run(kit.calcOf(process), null, {
        feed_length_mm: seed(feed, `${RF_CALC.strip}: ${r2(part.lengthMm)} mm part + ${r2(slug)} mm slug`),
        line_speed_mm_s: seed(v, `${RF_CALC.lineSpeed}: ${r2(v)} mm/s`),
        coil_change_s: seed(coilS, RF_CALC.coilChange),
        die_sharpening_s: seed(sharpS, `${RF_CALC.dieSharpening}: ${r2(sharpS)} s a part`),
      });
      cycles.set(k, r);
      return r;
    };
    /** A machine's line cost per part for a cycle (its rate, crew and setup over the batch), as selectAndCost costs it. */
    const costOf = (process: string, m: SandMachine, sec: number): number => line({
      process, processGroup: ROLL_FORMING_PROCESS_GROUP, processRoute: process, machineClass: m.machineClass, machine: asFinishingMachine(m), sec,
      batchSize: scenario.batchSize, costContext: input.costContext, breakdown: '', warnings: [],
    }).totalCost;
    const poolAt = (role: LineRole, v: number): Candidate[] => {
      const ok = (candidates.get(role) ?? []).filter((c) => c.reason == null && (c.cap == null || c.cap >= v - 1e-6));
      return usePreferred && ok.some((c) => c.m.preferred) ? ok.filter((c) => c.m.preferred) : ok;
    };

    // ── The whole line, chosen at one speed: at every speed one of its limits allows, the cheapest machine of each place that runs at least
    //    that fast (the uncoiler also for the stoppage its coil change puts on every machine); the cheapest line is quoted ────────────────
    const speeds = [...new Set([...working.flatMap((p) => candidates.get(p.role)!.filter((c) => c.reason == null && c.cap != null).map((c) => c.cap!)),
      ...(Number.isFinite(partLimit) ? [partLimit] : [])])].filter((v) => v > 0 && v <= partLimit + 1e-6).sort((a, b) => b - a);
    interface Pick { total: number; v: number; machines: Map<LineRole, SandMachine>; coilS: number }
    let best: Pick | null = null;
    const choose = (v: number, coilS: number, fixed: ReadonlyMap<LineRole, SandMachine>): Pick | null => {
      const machines = new Map<LineRole, SandMachine>();
      let total = 0;
      for (const p of working) {
        const sec = cycleOf(p.process, v * multiplier, coilS);
        if (!('run' in sec)) return null;
        const pool = fixed.has(p.role) ? [{ m: fixed.get(p.role)! }] : poolAt(p.role, v);
        let pick: { m: SandMachine; cost: number } | null = null;
        for (const c of pool) {
          const cost = costOf(p.process, c.m, sec.sec) + (p.role === 'mill' ? rollsPerPart(c.m)?.usd ?? 0 : 0);
          if (pick == null || cost < pick.cost - 1e-12 || (Math.abs(cost - pick.cost) <= 1e-12 && c.m.name.localeCompare(pick.m.name) < 0)) pick = { m: c.m, cost };
        }
        if (!pick) return null;
        machines.set(p.role, pick.m);
        total += pick.cost;
      }
      return { total, v, machines, coilS };
    };
    for (const v of speeds) {
      if (working.some((p) => poolAt(p.role, v).length === 0)) continue;
      const uncoilers = working.some((p) => p.role === 'uncoiler') ? poolAt('uncoiler', v).map((c) => c.m) : [null];
      for (const u of uncoilers) {
        const coil = u ? coilOf(u) : null;
        if (coil && !('run' in coil)) continue;
        const coilS = coil && 'run' in coil ? coil.sec : 0;
        const pick = choose(v, coilS, new Map(u ? [['uncoiler', u]] : []));
        if (!pick) continue;
        // The line runs as fast as its slowest chosen machine and the part allow: costed at that speed.
        const actual = Math.min(partLimit, ...[...pick.machines.entries()].map(([role, m]) => machineSpeedCap(role, m, feed, dieFactor) ?? Infinity));
        const atActual = actual > v + 1e-6 && Number.isFinite(actual) ? choose(actual, coilS, pick.machines) ?? pick : pick;
        if (best == null || atActual.total < best.total - 1e-9) best = atActual;
      }
    }

    // ── The lines of the chosen line, each costed by its calculator, with the machines every place weighed ─────────────────────────
    const chosen: Line = new Map(best ? [...best.machines.entries()].map(([role, m]) => [role, { process: places.find((p) => p.role === role)!.process, machine: m }]) : []);
    const finalUncoiler = chosen.get('uncoiler')?.machine ?? null;
    const finalCoil = finalUncoiler ? coilOf(finalUncoiler) : null;
    const machineCapsList = machineCaps(chosen);
    const slowestMachine = limitingCap(machineCapsList);
    const press = slowestPress(chosen);
    const speedRun = best ? kit.run(RF_CALC.lineSpeed, null, {
      machine_line_speed_mm_s: slowestMachine ? seed(slowestMachine.mmPerS, `${slowestMachine.name}: max line speed (the slowest of the line's machines)`)
        : tolSpeed != null ? seed(tolSpeed, 'no machine on the line limits the speed (the part-length tolerance\'s)') : undefined,
      part_length_tolerance_speed: kit.lookupSeed('partLengthToleranceThresholds', tolerance.row, 'Maximum Line Speed (mm / s)', ['Measurement System', 'Tolerance Name']),
      curved: seed(curved ? 1 : 0, curved ? `the profile is curved to a ${r2(part.curve!.radiusMm)} mm radius` : 'the profile is straight'),
      press_count: seed(press ? 1 : 0, press ? 'a stationary-die press on the line' : 'no press on the line'),
      press_strokes_per_minute: press ? {
        ...seed(press.spm, `${press.process} ${press.machine.name}: strokes per minute (the slowest press on the line)`),
        ref: { kind: 'machine', machineId: press.machine.id, machineName: press.machine.name, machineClass: press.machine.machineClass, location: press.machine.location, column: 'strokes_per_minute' },
      } : seed(0, 'no press on the line'),
      feed_length_mm: seed(feed, `${RF_CALC.strip}: the part length + the slug`),
      line_speed_multiplier: kit.lookupSeed('toleranceThresholds', multiplierRow, 'Line Speed Multiplier', ['Tolerance Type', 'Tolerance Name']),
    }) : null;
    if (speedRun && !('run' in speedRun)) warnings.push(...speedRun.reasons);
    const v = speedRun && 'run' in speedRun ? speedRun.sec : null;
    const caps: SpeedCap[] = [
      ...machineCapsList, ...partCaps,
      ...(press ? [{ name: `${press.process} ${press.machine.name} at ${press.spm} strokes a minute (x stationaryDieLineSpeedFactor ${dieFactor}, one stroke a part)`, mmPerS: (press.spm * dieFactor * feed) / 60 }] : []),
    ];
    const limiting = limitingCap(caps);
    const coilRun = finalCoil && 'run' in finalCoil ? finalCoil.run : null;
    const coilS = finalCoil && 'run' in finalCoil ? finalCoil.sec : 0;
    const endWeld = (coilRun?.outputs['End Weld'] ?? 0) > 0;
    const coil: RollFormingRoute['coil'] = coilRun && finalUncoiler ? {
      massKg: coilRun.outputs['Coil Mass'] ?? 0, partsPerCoil: coilRun.outputs['Parts per Coil'] ?? 0, changeTimeS: coilRun.outputs['Coil Change Time'] ?? 0, perPartS: coilS,
      method: setup.code === 3 ? `accumulator: the end weld made while the line runs; the line stops for ${flag(finalUncoiler, 'has_double_mandrel') ? 'nothing (a double mandrel loads the next coil running)' : `${finalUncoiler.name}'s coil load`}`
        : `${endWeld ? 'end weld (coilEndWeldTime)' : 'threading (coilThreadingTime)'} + ${finalUncoiler.name}'s coil load time`,
      setupMethod: setup.name, run: coilRun,
    } : null;
    const coilSeed = coil ? seed(coilS, `${RF_CALC.coilChange}: ${r2(coil.changeTimeS)} s every ${coil.partsPerCoil} parts`) : seed(0, 'no uncoiler on the line');
    const ruleText = 'The cheapest whole line: at every speed the line\'s limits allow, the cheapest capable machine of each place that runs at least that fast '
      + '(machine rate, crew and setup); the cheapest line quoted';
    const parts = scenario.amortizationParts;
    const millRule = parts != null && parts > 0
      ? `${ruleText}. The mill is weighed with its rolls spread over the job's ${parts.toLocaleString('en-US')} parts (multiplier x strip x its stations on its own `
        + 'stand spacing): a mill with a longer spacing needs fewer stations for a long flange and can win on tooling though its hour rate is higher'
      : `${ruleText}. The rolls are not weighed: the job has no volume to spread them over`;
    const costed = new Map<LineRole, CostedStep>();
    for (const p of places) {
      const pick = chosen.get(p.role);
      if (!pick || v == null) {
        // No capable machine (or no line): a named gap carrying every machine's reason.
        const cands = candidates.get(p.role) ?? [];
        costed.set(p.role, kit.step(p.process, (m) => fail(cands.find((c) => c.m === m)?.reason ?? 'no whole line could be costed with it (a calculator input is missing)'), p.criteria, { machines: p.machines }));
        continue;
      }
      const step = kit.step(p.process, (m) => kit.timed(p.process, m, {
        feed_length_mm: seed(feed, `${RF_CALC.strip}: ${r2(part.lengthMm)} mm part + ${r2(slug)} mm slug`),
        line_speed_mm_s: seed(v, `${RF_CALC.lineSpeed}: ${r2(v)} mm/s, set by ${limiting?.name ?? 'the line'}`),
        coil_change_s: coilSeed,
        die_sharpening_s: seed(sharpS, `${RF_CALC.dieSharpening}: ${r2(sharpS)} s a part`),
      }), p.criteria, { machines: [pick.machine] });
      const sec = cycleOf(p.process, v, coilS);
      const pool = new Set(poolAt(p.role, best!.v).map((c) => c.m));
      const evals: ChoiceEval[] = (candidates.get(p.role) ?? []).map((c) => {
        const reasons = c.reason ? [c.reason]
          : c.cap != null && c.cap < best!.v - 1e-6 ? [`lets the line run at most ${r2(c.cap)} mm/s; the cheapest line runs at ${r2(v)} mm/s`]
            : !pool.has(c.m) ? ['not a preferred machine (usePreferredMachines)'] : [];
        if (reasons.length || !('run' in sec)) return { name: c.m.name, reasons, cost: null };
        const lineUsd = costOf(p.process, c.m, sec.sec);
        const rolls = p.role === 'mill' ? rollsPerPart(c.m) : null;
        return rolls
          ? { name: c.m.name, reasons, cost: lineUsd + rolls.usd, note: `line ${r4(lineUsd)} + rolls ${r4(rolls.usd)} USD a part (${rolls.stations} stations)` }
          : { name: c.m.name, reasons, cost: lineUsd };
      });
      costed.set(p.role, { ...step, line: { ...step.line, machineChoice: machineChoice({ rule: p.role === 'mill' ? millRule : ruleText, criteria: p.criteria, evals, chosen: pick.machine.name }) } });
    }

    // ── The lines, in the line's order, each with its breakdown and memory's catalog rows ───────────────────────────────────────────
    const factor = ref.number('cycleTimeAdjustmentFactor') ?? 1;
    const catalogOps = rollFormingCatalogOperations(input.catalog ?? [], { bends: part.bends, stations: punch.stations, ends: part.ends, cutOff: def.cutOff });
    const banding = (ref.number('packBandingTime') ?? 0) / Math.max(1, ref.number('partBandedPackSize') ?? 1);
    const millMachine = chosen.get('mill')?.machine ?? null;
    const onMill = stationsOn(millMachine);
    const stations = 'reasons' in onMill ? plain : onMill;
    const lineOf = (role: LineRole): ProcessLineCost | null => {
      const c = costed.get(role);
      if (!c) return null;
      if (isGap(c.line) || v == null) return c.line;
      const faces = role === 'mill' ? part.bends.flatMap((b) => b.faceIds) : role === 'punch' ? punch.punched.flatMap((f) => f.faceIds) : role === 'cutoff' ? part.ends.flatMap((e) => e.faceIds) : [];
      const op = (name: string, sec: number, featureType: string, faceIds: number[] = []): FeatureOp =>
        ({ name, timeSec: r2(sec * factor), featureType, count: 1, ...(faceIds.length ? { faceIds } : {}) });
      const runName = role === 'mill' ? `Roll forming: ${stations.total} station${stations.total === 1 ? '' : 's'}, ${part.bends.length} bend${part.bends.length === 1 ? '' : 's'}`
        : role === 'punch' ? `Punching: ${punch.stations.length} die station${punch.stations.length === 1 ? '' : 's'} (${punch.stations.map((s) => `${s.operation} ${s.features.length} ${s.featureType}`).join(', ')})`
          : role === 'cutoff' ? `${def.cutOff}${blade ? ` (${r2(slug)} mm slug)` : ''}`
            : role === 'welder' ? `Seam welding ${r2(part.lengthMm)} mm`
              : role === 'flattener' ? 'Flattening the coil' : 'Uncoiling the strip';
      const breakdown: FeatureOp[] = [
        op(`${runName}: ${r2(feed)} mm at ${r2(v)} mm/s`, feed / v, role === 'mill' ? 'StraightBend' : role === 'punch' ? 'SimpleHole' : role === 'cutoff' ? 'End' : 'Part', faces),
        ...(coil ? [op(`Line stopped for the coil change: ${r2(coil.changeTimeS)} s every ${coil.partsPerCoil} parts`, coil.perPartS, 'handling')] : []),
        op('Line stopped for die re-sharpening (stationaryDieChangeoverTime every numHitsPerDieChange hits)', sharpS, 'handling'),
        ...(role === 'cutoff' ? [op('Banding (packBandingTime per partBandedPackSize)', banding, 'handling')] : []),
      ];
      const rows = role === 'mill' ? catalogOps.mill : role === 'punch' ? catalogOps.punch : role === 'cutoff' ? catalogOps.cutOff : [];
      return { ...c.line, featureBreakdown: breakdown, ...(rows.length ? { catalogOperations: rows } : {}) };
    };
    const machineLines = LINE_ORDER.map(lineOf).filter((l): l is ProcessLineCost => l != null);
    for (const c of costed.values()) warnings.push(...c.warnings);
    const notPunched = punch.notPunched.map((g) => noCostFeatureLine({ reason: `${g.reason} (not punched)`, processGroup: ROLL_FORMING_PROCESS_GROUP }));
    const lines = [...machineLines, ...notPunched];
    const complete = lines.every((l) => !isGap(l));

    // ── The tooling: the mill's rolls, the punch press's die, the cut-off die ───────────────────────────────────────────────────────
    const rolls = rollTooling({
      kit, ref, stripWidthMm: W, stations: stations.total, panel: plan.panel, multiplierOverride: scenario.toolingMultiplier, materialType: material.materialType,
      amortizationParts: scenario.amortizationParts,
    });
    const punchDie = punch.stations.length
      ? pressDie({ kit, ref, kind: 'punch', cutOff: def.key, plan: punchPlanDie, punchedFeatures: punch.punched.length, toolShop: input.toolShop, amortizationParts: scenario.amortizationParts })
      : null;
    const cutDie = pressDie({ kit, ref, kind: 'cut-off', cutOff: def.key, plan: cutOffPlan, punchedFeatures: 0, toolShop: input.toolShop, amortizationParts: scenario.amortizationParts });
    const tooling = [rolls.tool, ...(punchDie ? [punchDie.tool] : []), cutDie.tool];
    warnings.push(...rolls.warnings, ...(punchDie?.warnings ?? []), ...cutDie.warnings);

    return {
      ...base, lines,
      stations: stationsView(stations, millMachine ? machineValue(millMachine, 'horizontal_center_length_mm') : null),
      welding: base.welding ? { ...base.welding, machine: chosen.get('welder')?.machine.name ?? null } : null,
      mill: millMachine ? {
        name: millMachine.name, stands: machineValue(millMachine, 'number_of_roll_stands'), shaftDiameterMm: machineValue(millMachine, 'shaft_diameter_mm'),
        type: machineText(millMachine, 'mill_type'), curveUnit: flag(millMachine, 'curve_unit'),
      } : null,
      lineSpeed: v != null && speedRun && 'run' in speedRun ? { mmPerS: v, limiting: limiting?.name ?? null, caps, multiplier, speedsTried: speeds.length, run: speedRun.run } : null,
      coil,
      dieSharpeningPerPartS: sharpS,
      punching: part.features.length ? {
        dieStations: punch.stations.map((s) => `${s.operation} ${s.featureType}`), punched: punch.punched.length,
        notPunched: punch.notPunched.map((g) => ({ featureType: g.featureType, count: g.features.length, reason: g.reason })), minHoleMm: punch.minHoleMm,
      } : null,
      forcesKn: { punch: punchForce, cutOff: cutOffForce },
      tooling,
      totalUsd: complete ? r2(materialUsd + lines.reduce((s, l) => s + l.totalCost, 0)) : null,
      feasible: true, infeasible: [], complete, warnings,
    };
  });
  return { routes, missing: [] };
}

/**
 * The route to quote: the one the Cost Guide sets (or the comparison forces); else memory's rule's route when it is complete; else the other
 * when it is complete; else the rule's. The note names the rule and the other route.
 */
export function chooseRollFormingRoute(routes: readonly RollFormingRoute[], rule: RollFormingRule, chosen: RollFormingRouteKey | null): { route: RollFormingRoute | null; note: string | null } {
  if (routes.length === 0) return { route: null, note: null };
  const money = (n: number) => `${n.toFixed(2)} USD`;
  const gapOf = (l: ProcessLineCost) => (l.physicsGap && 'reason' in l.physicsGap ? l.physicsGap.reason : l.process);
  const said = (r: RollFormingRoute) => (r.complete && r.totalUsd != null ? `${r.label} ${money(r.totalUsd)}`
    : !r.feasible ? `${r.label} not feasible (${r.infeasible.join('; ')})` : `${r.label} incomplete (${r.lines.filter(isGap).map(gapOf).join('; ')})`);
  const ruleText = `memory's rule: ${rule.basis}, gives ${ROLL_FORMING_ROUTE_LABEL[rule.route]}`;
  const other = (pick: RollFormingRoute) => routes.filter((r) => r !== pick).map(said).join('; ');
  const user = chosen ? routes.find((r) => r.key === chosen) : undefined;
  if (user) return { route: user, note: `${ROLL_FORMING_PROCESS_GROUP}: ${user.label} is set (${ruleText}). ${other(user)}.` };
  const byRule = routes.find((r) => r.key === rule.route) ?? routes[0];
  if (byRule.complete) return { route: byRule, note: `${ROLL_FORMING_PROCESS_GROUP}: ${byRule.label} is quoted, ${ruleText}. ${other(byRule)}.` };
  const complete = routes.find((r) => r.complete);
  if (complete) return { route: complete, note: `${ROLL_FORMING_PROCESS_GROUP}: ${complete.label} is quoted: ${ruleText}, but that route is ${byRule.feasible ? 'incomplete' : 'not feasible'}. ${other(complete)}.` };
  return { route: byRule, note: `${ROLL_FORMING_PROCESS_GROUP}: no route is complete (${ruleText}). ${other(byRule)}.` };
}
