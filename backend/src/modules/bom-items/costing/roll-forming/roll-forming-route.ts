// The Sheet Metal Roll Forming routes of a profile (memory/Sheet metal roll forming): a coil line, Coil Material Stock, Uncoiler, Coil Flattener
// (when the coil needs it), Punch Press (the strip's holes, notches, lances and forms, before the mill), Roll Forming Mill, Integrated Welding (a
// closed section) and the Cut-Off Press, by Scissor (no slug) or by Blade (a slug between parts): two routes, memory's rule picking one (a
// closed section is cut by blade), the other costed and shown. The line runs at one speed (roll-forming-line.ts); every machine is one line
// costed for the part's run plus the line's stoppages a part (coil change, die re-sharpening) at its own rate and crew, and its setup over the
// batch. Every time and cost comes from a calculator (roll-forming-calculators.json) seeded from the reference data, the part's measurements
// (roll-forming-part.ts) and the machine; every machine from HR Rates (migrations 862, 1112). The data has no formula for the cycle, the roll
// stations or the tooling: those rules are the engine's own, agreed with the user (2026-11-22), and the quote says so. Pure: the caller loads
// the data and converts the currency.
import { punchPlan, rollFormingCatalogOperations, stepRow, type PunchPlan } from './roll-forming-features';
import { flattening, LINE_ORDER, limitingCap, machineCaps, partLengthToleranceRow, slowestPress, type Line, type LineMachine, type LineRole, type SpeedCap } from './roll-forming-line';
import { stationPlan, type StationPlan } from './roll-forming-stations';
import { cutOffDiePlan, pressDie, punchDiePlan, rollTooling, type RollFormingTool } from './roll-forming-tooling';
import { machineText, machineValue, type SandMachine } from '../casting/sand/sand-machines';
import { fail, routeKit, type KitRun, type RouteKit } from '../shared/calculators/route-kit';
import { noCostFeatureLine } from '../shared/core/engine-kernel';
import { ROLL_FORMING_PROCESS_GROUP } from '../shared/core/part-family-process-group';

import type { RollFormPart } from './roll-forming-part';
import type { FeatureOp, ProcessLineCost } from '../../dto/cost-breakdown.dto';
import type { CostContext } from '../casting/casting-finishing';
import type { SandReference } from '../casting/sand/sand-reference';
import type { SeedProvider } from '../casting/sand/sand-seeds';
import type { CostedStep, StepOutcome } from '../casting/sand/sand-steps';
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
  stations: 'Roll Forming - Stations', lineSpeed: 'Roll Forming - Line Speed', coilChange: 'Roll Forming - Coil Change', dieSharpening: 'Roll Forming - Die Sharpening',
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

export interface RollFormingRoute {
  key: RollFormingRouteKey;
  label: string;
  lines: ProcessLineCost[];
  material: {
    costUsd: number; stripKg: number; partKg: number; scrapKg: number; feedLengthMm: number; slugMm: number;
    run: ReferenceCalcRun | null; stripRun: ReferenceCalcRun | null;
  };
  stations: {
    forming: number; leadIn: number; finishing: number; rule: number; total: number; override: number | null; panel: boolean;
    levels: StationPlan['levels']; levelSource: StationPlan['levelSource']; run: ReferenceCalcRun | null;
  };
  mill: { name: string; stands: number | null; shaftDiameterMm: number | null; type: string | null; curveUnit: boolean } | null;
  requiredShaftMm: number | null;
  lineSpeed: { mmPerS: number; limiting: string | null; caps: SpeedCap[]; multiplier: number; run: ReferenceCalcRun } | null;
  coil: { massKg: number; partsPerCoil: number; changeTimeS: number; perPartS: number; method: string; run: ReferenceCalcRun } | null;
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

/**
 * What keeps the part from being roll formed at all (memory's limits): a coil thicker than maxCoilThickness or of a yield above
 * maxCoilYieldStrength, a curve tighter than the curving unit's top roller (curveUnitTopRollerDiameter); and what is only warned: a bend tighter
 * than minBendRadii at the material's yield, a free flange outside minBendFlapSizeThicknessMultiplier..maxBendFlapSizeThicknessMultiplier x t.
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
  if (part.curve && roller != null && part.curve.radiusMm < roller - 1e-9) {
    infeasible.push(`the profile is curved to a ${r2(part.curve.radiusMm)} mm radius, tighter than the curving unit bends (curveUnitTopRollerDiameter ${roller} mm)`);
  }
  if (material.yieldMpa != null) {
    const row = stepRow(ref.table('minBendRadii'), 'Material Yield (N / mm^2)', material.yieldMpa);
    const k = row != null ? Number(row['Min Bend Radius Thickness Multiplier']) : null;
    const tight = k != null ? part.bends.filter((b) => b.innerRadiusMm != null && b.innerRadiusMm < k * t - 1e-9) : [];
    if (tight.length) {
      warnings.push(`${tight.length} bend(s) of ${tight.map((b) => `${r2(b.innerRadiusMm!)} mm`).join(', ')} inner radius are tighter than minBendRadii gives ${material.name} (${k} x t = ${r2(k! * t)} mm at ${r2(material.yieldMpa)} MPa yield): the profile may crack.`);
    }
  }
  const minFlap = ref.number('minBendFlapSizeThicknessMultiplier');
  const maxFlap = ref.number('maxBendFlapSizeThicknessMultiplier');
  // A flap is a free flange: the strip's edges of an open section (the first flat before the first bend, the last after the last).
  const flaps = part.section.closed || part.bends.length === 0 ? [] : [part.bends[0].flangeBeforeMm, part.lastFlangeMm].filter((f): f is number => f != null);
  const outside = flaps.filter((f) => (minFlap != null && f < minFlap * t - 1e-9) || (maxFlap != null && f > maxFlap * t + 1e-9));
  if (outside.length) {
    warnings.push(`The free flange(s) of ${outside.map((f) => `${r2(f)} mm`).join(', ')} are outside ${minFlap ?? '?'}-${maxFlap ?? '?'} x t (${r2((minFlap ?? 0) * t)}-${r2((maxFlap ?? 0) * t)} mm, minBendFlapSizeThicknessMultiplier and maxBendFlapSizeThicknessMultiplier): check the flange forms without buckling or springing back.`);
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

/** One place on the line: its process, the machines it may run on, and what a machine must have. */
interface LineStep {
  role: LineRole;
  process: string;
  machines: readonly SandMachine[];
  check: (m: SandMachine) => string | null;
  criteria: string[];
}

/** The line's speed and stoppages with a given set of machines on it, each from its calculator. */
interface LineState {
  v: number;
  caps: SpeedCap[];
  limiting: string | null;
  multiplier: number;
  speedRun: ReferenceCalcRun;
  coil: RollFormingRoute['coil'];
  coilSeed: CalcSeed;
  sharpS: number;
  sharpSeed: CalcSeed;
}

/** Every route of the part (each complete or with its gaps), and what keeps any route from being built. */
export function buildRollFormingRoutes(input: RollFormingRouteInput): { routes: RollFormingRoute[]; missing: string[] } {
  const { ref, part, material, scenario } = input;
  const none = (...missing: string[]) => ({ routes: [] as RollFormingRoute[], missing });
  if (material.densityKgM3 == null || !(material.densityKgM3 > 0)) return none(`${material.name}: its density`);
  if (material.costPerKgUsd == null || !(material.costPerKgUsd > 0)) return none(`${material.name}: its price per kg`);
  const t = part.thicknessMm;
  const W = part.stripWidthMm;
  const seed = (value: number, source: string): CalcSeed => ({ value, source });
  const cad: Record<string, CalcSeed | undefined> = {
    strip_width_mm: seed(W, part.stripWidthSource === 'neutral fibre'
      ? `the strip the coil is slit to: the section's flats and bends at the neutral fibre (mm; ${r2(part.stripWidthMidMm)} mm at the mid-line)`
      : "the strip the coil is slit to: the section's mid-line stretch-out, its area / t (mm)"),
    length_mm: seed(part.lengthMm, 'the part length along the profile (mm)'),
    thickness_mm: seed(t, 'the sheet thickness (mm)'),
  };
  const materialProvider: SeedProvider = (column) => {
    const v = column === 'density_kg_m3' ? material.densityKgM3 : column === 'cost' ? material.costPerKgUsd : column === 'shear_strength_mpa' ? material.shearStrengthMpa : null;
    if (v == null) return null;
    const label = column === 'cost' ? 'price (USD/kg)' : column === 'density_kg_m3' ? 'density (kg/m³)' : 'shear strength (MPa)';
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
  const plan = stationPlan(ref, part);
  const stationsRun = kit.run(RF_CALC.stations, null, {
    forming_passes: seed(plan.formingPasses, plan.levels.length
      ? `${plan.levels.map((l) => `level ${l.level}: ${l.bends} bend(s), largest ${r2(l.maxAngleDeg)}° / rollFormingLiftAngle ${plan.liftAngleDeg}° = ${l.passes}`).join('; ')} (levels ${plan.levelSource === 'cad' ? 'measured' : plan.levelSource === 'flats' ? 'from the flats, out from the widest' : 'assumed all on one'})`
      : 'no bend across the strip'),
    finishing_passes: kit.lookupSeed('toleranceThresholds', plan.toleranceRow, 'Number of Finishing Passes', ['Tolerance Type', 'Tolerance Name']),
  });
  if (!('run' in stationsRun)) return none(...stationsRun.reasons);
  const ruleStations = Math.round(stationsRun.sec);
  const stations = scenario.stations ?? ruleStations;
  const leadIn = stationsRun.run.outputs['Lead-in Passes'] ?? 0;
  const finishing = Math.round(stationsRun.sec - plan.formingPasses - leadIn);
  const { infeasible, warnings: feasibilityWarnings } = rollFormingFeasibility(ref, part, material);
  const punch: PunchPlan = punchPlan(ref, part, material.utsMpa);
  const flatten = flattening(ref, t, material.yieldMpa);
  const shaft = requiredShaft(ref, t, material.utsMpa);
  const tolerance = partLengthToleranceRow(ref);
  const multiplierRow = plan.toleranceRow;
  const curved = part.curve != null;
  const cutLength = punch.punched.filter((f) => f.featureType !== 'Form').reduce((s, f) => s + f.perimeterMm, 0);
  const shear = material.shearStrengthMpa;
  const force = (length: number, source: string): number | null => {
    if (!(shear != null && shear > 0) || !(length > 0)) return null;
    const r = kit.run(RF_CALC.force, null, { cut_length_mm: seed(length, source) });
    return 'run' in r ? r.sec : null;
  };
  const punchForce = force(cutLength, `the punched features' cut perimeter, all stations in one stroke (mm)`);
  const sharedWarnings = [...feasibilityWarnings];
  if (!(shear != null && shear > 0)) sharedWarnings.push(`The presses' force is not checked: ${material.name} has no shear strength on file.`);
  if (plan.levelSource === 'assumed' && plan.bendCount > 0) sharedWarnings.push('The bends\' levels out from the web were not measured: every bend is taken as one level (the fewest forming passes).');
  if (punch.punched.some((f) => f.sizeMm == null)) sharedWarnings.push('Some punched features have no size measured: whether they are too small to punch is not checked.');
  if (scenario.welding && !part.section.closed) sharedWarnings.push(`${WELDING_PROCESS[scenario.welding].process} is on the line as the Cost Guide sets it, though the section is open.`);

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
    const base = {
      key: def.key, label: def.label,
      material: {
        costUsd: materialUsd, stripKg, partKg, scrapKg: Math.max(0, stripKg - partKg), feedLengthMm: feed, slugMm: slug,
        run: 'run' in materialRun ? materialRun.run : null, stripRun: 'run' in stripRun ? stripRun.run : null,
      },
      stations: {
        forming: plan.formingPasses, leadIn, finishing, rule: ruleStations, total: stations, override: scenario.stations, panel: plan.panel,
        levels: plan.levels, levelSource: plan.levelSource, run: stationsRun.run,
      },
      requiredShaftMm: shaft.mm,
      flattener: flatten,
      welding: welding ? { process: WELDING_PROCESS[welding.key].process, machine: null as string | null, source: welding.source } : null,
    };
    if (!('run' in stripRun)) warnings.push(...stripRun.reasons);
    if (!('run' in materialRun)) warnings.push(...materialRun.reasons);

    // ── A part the line cannot make: every route is not feasible, its lines No Cost Feature lines saying why ────────────────────────
    if (infeasible.length) {
      return {
        ...base, lines: infeasible.map((reason) => noCostFeatureLine({ reason: `Not roll formed: ${reason}`, processGroup: ROLL_FORMING_PROCESS_GROUP })),
        mill: null, lineSpeed: null, coil: null, dieSharpeningPerPartS: 0, punching: null, forcesKn: { punch: null, cutOff: null }, tooling: [],
        totalUsd: null, feasible: false, infeasible, complete: false, warnings,
      };
    }

    // ── The line's places and what each machine must have ────────────────────────────────────────────────────────────────────────────
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
    const steps: LineStep[] = [
      { role: 'stock', process: ROLL_FORMING_PROCESS.stock, machines: input.machinesByClass[ROLL_FORMING_CLASS.stock] ?? [], check: () => null, criteria: ['Holds the coil as supplied'] },
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
          if (stands == null || stands < stations) return `${stands ?? 'no'} roll stands, the profile needs ${stations}`;
          if (shaft.mm == null) return `no shaft size for a ${r2(t)} mm strip (${shaft.basis})`;
          if (shaftMm == null || shaftMm < shaft.mm - 1e-9) return `a ${shaftMm ?? '?'} mm shaft, the strip needs ${shaft.mm} mm (${shaft.basis})`;
          if (maxT != null && t > maxT + 1e-9) return `takes stock up to ${maxT} mm thick, the strip is ${r2(t)} mm`;
          if (height != null && part.section.heightMm > height + 1e-9) return `forms sections up to ${height} mm high, the section is ${r2(part.section.heightMm)} mm`;
          if (space != null && W > space + 1e-9) return `a ${space} mm roll space, the strip is ${r2(W)} mm`;
          if (curved && !flag(m, 'curve_unit')) return 'no curving unit, and the profile is curved';
          if (!curved && plan.panel && type !== 'duplex') return `a ${type ?? '?'} mill, a panel profile (${plan.bendCount} bends, minNumBendsForPanelCrossSection ${plan.panelThreshold}) needs a duplex mill`;
          if (!curved && !plan.panel && type === 'duplex') return 'a duplex (panel) mill, the profile is a standard one';
          return null;
        },
        criteria: ['Enough roll stands', 'The shaft the strip needs', 'Takes the stock thickness', 'Forms the section height', 'Its roll space takes the strip',
          ...(curved ? ['A curving unit'] : [plan.panel ? 'A duplex mill (a panel profile)' : 'A standard mill']),
        ],
      },
      ...(welding ? [{
        role: 'welder' as const, process: WELDING_PROCESS[welding.key].process, machines: input.machinesByClass[WELDING_PROCESS[welding.key].machineClass] ?? [],
        check: (m: SandMachine) => {
          const mt = machineValue(m, 'max_stock_thickness_mm');
          return mt != null && t > mt + 1e-9 ? `welds stock up to ${mt} mm thick, the strip is ${r2(t)} mm` : null;
        },
        criteria: ['Welds the stock thickness'],
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

    // ── The line's speed and stoppages with a set of machines (each machine is costed for the line it is on) ───────────────────────
    const speedCache = new Map<string, LineState | { reasons: string[] }>();
    const lineState = (line: Line): LineState | { reasons: string[] } => {
      const key = LINE_ORDER.map((r) => line.get(r)?.machine.id ?? '-').join('|');
      const hit = speedCache.get(key);
      if (hit) return hit;
      const machine = machineCaps(line);
      const slowest = machine.reduce<SpeedCap | null>((b, c) => (b == null || c.mmPerS < b.mmPerS ? c : b), null);
      const tolSpeed = tolerance.row != null ? Number(tolerance.row['Maximum Line Speed (mm / s)']) : null;
      const press = slowestPress(line);
      const run = kit.run(RF_CALC.lineSpeed, null, {
        machine_line_speed_mm_s: slowest ? seed(slowest.mmPerS, `${slowest.name}: max line speed (the slowest of the line's machines)`)
          : tolSpeed != null ? seed(tolSpeed, 'no machine on the line limits the speed (the part-length tolerance\'s)') : undefined,
        part_length_tolerance_speed: kit.lookupSeed('partLengthToleranceThresholds', tolerance.row, 'Maximum Line Speed (mm / s)', ['Measurement System', 'Tolerance Name']),
        curved: seed(curved ? 1 : 0, curved ? `the profile is curved to a ${r2(part.curve!.radiusMm)} mm radius` : 'the profile is straight'),
        press_count: seed(press ? 1 : 0, press ? 'a stationary-die press on the line' : 'no press on the line'),
        press_strokes_per_minute: press ? { ...seed(machineValue(press.machine, 'strokes_per_minute')!, `${press.process} ${press.machine.name}: strokes per minute (the slowest press on the line)`),
          ref: { kind: 'machine', machineId: press.machine.id, machineName: press.machine.name, machineClass: press.machine.machineClass, location: press.machine.location, column: 'strokes_per_minute' } } : seed(0, 'no press on the line'),
        feed_length_mm: seed(feed, `${RF_CALC.strip}: the part length + the slug`),
        line_speed_multiplier: kit.lookupSeed('toleranceThresholds', multiplierRow, 'Line Speed Multiplier', ['Tolerance Type', 'Tolerance Name']),
      });
      if (!('run' in run)) {
        const out = { reasons: run.reasons };
        speedCache.set(key, out);
        return out;
      }
      const bending = ref.number('profileRollBendingSpeed');
      const pressSpeed = run.run.outputs['Press Line Speed'];
      const caps: SpeedCap[] = [
        ...machine,
        ...(tolSpeed != null ? [{ name: `the part-length tolerance (${tolerance.tolerance}, ${tolerance.system}: partLengthToleranceThresholds)`, mmPerS: tolSpeed }] : []),
        ...(curved && bending != null ? [{ name: 'profile bending on the curving unit (profileRollBendingSpeed)', mmPerS: bending }] : []),
        ...(press && pressSpeed != null ? [{ name: `${press.process} ${press.machine.name} at ${press.spm} strokes a minute (x stationaryDieLineSpeedFactor ${ref.number('stationaryDieLineSpeedFactor') ?? '?'}, one stroke a part)`, mmPerS: pressSpeed }] : []),
      ];
      const uncoiler = line.get('uncoiler');
      let coil: RollFormingRoute['coil'] = null;
      let coilSeed = seed(0, 'no uncoiler on the line');
      if (uncoiler) {
        const c = kit.run(RF_CALC.coilChange, uncoiler.machine, { strip_mass_kg: seed(stripKg, `${RF_CALC.strip}: ${r2(stripKg)} kg a part`) });
        if (!('run' in c)) {
          const out = { reasons: c.reasons };
          speedCache.set(key, out);
          return out;
        }
        const thresholdT = ref.number('coilEndWeldingThicknessThreshold');
        const method = thresholdT != null && t > thresholdT ? 'end weld (coilEndWeldTime)' : 'threading (coilThreadingTime)';
        coil = {
          massKg: c.run.outputs['Coil Mass'] ?? 0, partsPerCoil: c.run.outputs['Parts per Coil'] ?? 0, changeTimeS: c.run.outputs['Coil Change Time'] ?? 0,
          perPartS: c.sec, method: `${method} + ${uncoiler.machine.name}'s coil load time`, run: c.run,
        };
        coilSeed = seed(c.sec, `${RF_CALC.coilChange}: ${r2(coil.changeTimeS)} s every ${coil.partsPerCoil} parts`);
      }
      const sharp = kit.run(RF_CALC.dieSharpening, null, {
        punch_dies: seed(punch.stations.length ? 1 : 0, punch.stations.length ? 'the punch press\'s progressive die' : 'nothing is punched'),
        cut_off_dies: seed(1, 'the cut-off die'),
      });
      if (!('run' in sharp)) {
        const out = { reasons: sharp.reasons };
        speedCache.set(key, out);
        return out;
      }
      const limit = limitingCap(caps);
      const state: LineState = {
        v: run.sec, caps, limiting: limit?.name ?? null, multiplier: multiplierRow != null ? Number(multiplierRow['Line Speed Multiplier']) : 1, speedRun: run.run,
        coil, coilSeed, sharpS: sharp.sec, sharpSeed: seed(sharp.sec, `${RF_CALC.dieSharpening}: ${r2(sharp.sec)} s a part`),
      };
      speedCache.set(key, state);
      return state;
    };
    const evaluate = (step: LineStep, chosen: Line) => (m: SandMachine): StepOutcome => {
      const why = step.check(m);
      if (why) return fail(why);
      const line = new Map(chosen);
      line.set(step.role, { process: step.process, machine: m });
      const state = lineState(line);
      if ('reasons' in state) return fail(...state.reasons);
      return kit.timed(step.process, m, {
        feed_length_mm: seed(feed, `${RF_CALC.strip}: ${r2(part.lengthMm)} mm part + ${r2(slug)} mm slug`),
        line_speed_mm_s: seed(state.v, `${RF_CALC.lineSpeed}: ${r2(state.v)} mm/s, set by ${state.limiting ?? 'the line'}`),
        coil_change_s: state.coilSeed,
        die_sharpening_s: state.sharpSeed,
      });
    };

    // Each place takes the cheapest capable machine (preferred first) for the line the other places' machines make; repeated until no choice
    // changes, so every line is costed at the speed the chosen machines run together.
    const order: LineRole[] = ['mill', 'uncoiler', 'flattener', 'welder', 'punch', 'cutoff', 'stock'];
    const byRole = new Map(steps.map((s) => [s.role, s]));
    const chosen = new Map<LineRole, LineMachine>();
    const costed = new Map<LineRole, CostedStep>();
    for (let pass = 0; pass < 6; pass++) {
      let changed = false;
      for (const role of order) {
        const step = byRole.get(role);
        if (!step) continue;
        const result = kit.step(step.process, evaluate(step, chosen), step.criteria, { machines: step.machines });
        costed.set(role, result);
        const before = chosen.get(role)?.machine.id ?? null;
        if (result.machine) chosen.set(role, { process: step.process, machine: result.machine });
        else chosen.delete(role);
        if ((result.machine?.id ?? null) !== before) changed = true;
      }
      if (!changed && pass > 0) break;
    }
    const final = lineState(chosen);
    const state = 'reasons' in final ? null : final;
    if ('reasons' in final) warnings.push(...final.reasons);

    // ── The lines, in the line's order, each with its breakdown and memory's catalog rows ───────────────────────────────────────────
    const factor = ref.number('cycleTimeAdjustmentFactor') ?? 1;
    const catalogOps = rollFormingCatalogOperations(input.catalog ?? [], { bends: part.bends, stations: punch.stations, ends: part.ends, cutOff: def.cutOff });
    const banding = (ref.number('packBandingTime') ?? 0) / Math.max(1, ref.number('partBandedPackSize') ?? 1);
    const lineOf = (role: LineRole): ProcessLineCost | null => {
      const c = costed.get(role);
      if (!c) return null;
      if (isGap(c.line) || !state) return c.line;
      const faces = role === 'mill' ? part.bends.flatMap((b) => b.faceIds) : role === 'punch' ? punch.punched.flatMap((f) => f.faceIds) : role === 'cutoff' ? part.ends.flatMap((e) => e.faceIds) : [];
      const op = (name: string, sec: number, featureType: string, faceIds: number[] = []): FeatureOp =>
        ({ name, timeSec: r2(sec * factor), featureType, count: 1, ...(faceIds.length ? { faceIds } : {}) });
      const runName = role === 'mill' ? `Roll forming: ${stations} station${stations === 1 ? '' : 's'}, ${part.bends.length} bend${part.bends.length === 1 ? '' : 's'}`
        : role === 'punch' ? `Punching: ${punch.stations.length} die station${punch.stations.length === 1 ? '' : 's'} (${punch.stations.map((s) => `${s.operation} ${s.features.length} ${s.featureType}`).join(', ')})`
          : role === 'cutoff' ? `${def.cutOff}${blade ? ` (${r2(slug)} mm slug)` : ''}`
            : role === 'welder' ? `Seam welding ${r2(part.lengthMm)} mm`
              : role === 'flattener' ? 'Flattening the coil' : role === 'uncoiler' ? 'Uncoiling the strip' : 'Coil feed';
      const breakdown: FeatureOp[] = [
        op(`${runName}: ${r2(feed)} mm at ${r2(state.v)} mm/s`, feed / state.v, role === 'mill' ? 'StraightBend' : role === 'punch' ? 'SimpleHole' : role === 'cutoff' ? 'End' : 'Part', faces),
        ...(state.coil ? [op(`Line stopped for the coil change: ${r2(state.coil.changeTimeS)} s every ${state.coil.partsPerCoil} parts`, state.coil.perPartS, 'handling')] : []),
        op('Line stopped for die re-sharpening (stationaryDieChangeoverTime every numHitsPerDieChange hits)', state.sharpS, 'handling'),
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
      kit, ref, stripWidthMm: W, stations, panel: plan.panel, multiplierOverride: scenario.toolingMultiplier, materialType: material.materialType,
      amortizationParts: scenario.amortizationParts,
    });
    const punchDie = punch.stations.length
      ? pressDie({ kit, ref, kind: 'punch', cutOff: def.key, plan: punchPlanDie, punchedFeatures: punch.punched.length, toolShop: input.toolShop, amortizationParts: scenario.amortizationParts })
      : null;
    const cutDie = pressDie({ kit, ref, kind: 'cut-off', cutOff: def.key, plan: cutOffPlan, punchedFeatures: 0, toolShop: input.toolShop, amortizationParts: scenario.amortizationParts });
    const tooling = [rolls.tool, ...(punchDie ? [punchDie.tool] : []), cutDie.tool];
    warnings.push(...rolls.warnings, ...(punchDie?.warnings ?? []), ...cutDie.warnings);

    const millMachine = chosen.get('mill')?.machine ?? null;
    return {
      ...base, lines,
      welding: base.welding ? { ...base.welding, machine: chosen.get('welder')?.machine.name ?? null } : null,
      mill: millMachine ? {
        name: millMachine.name, stands: machineValue(millMachine, 'number_of_roll_stands'), shaftDiameterMm: machineValue(millMachine, 'shaft_diameter_mm'),
        type: machineText(millMachine, 'mill_type'), curveUnit: flag(millMachine, 'curve_unit'),
      } : null,
      lineSpeed: state ? { mmPerS: state.v, limiting: state.limiting, caps: state.caps, multiplier: state.multiplier, run: state.speedRun } : null,
      coil: state?.coil ?? null,
      dieSharpeningPerPartS: state?.sharpS ?? 0,
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

/** A run's result, or null. */
export const runSec = (r: KitRun): number | null => ('run' in r ? r.sec : null);

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
