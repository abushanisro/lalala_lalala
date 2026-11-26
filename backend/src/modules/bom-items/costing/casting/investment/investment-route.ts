// The route of an investment casting (lost wax), built from memory/Casting Investment: the wax pattern, its finishing and the tree, the shell
// (primary and secondary dips with their stucco coats), de-waxing, the shell's cleaning and inspection, burnout, preheat, the pour,
// cooling, knockout, cut-off, gate grinding, finishing and inspection, each on the cheapest capable machine; then the metal bought and the
// wax pattern die. Pure: the caller loads the reference data, the calculators, the machines and the part's measurements.
//
// Everything a tree shares (a dip, a furnace load, the pour) is divided by the patterns on the tree, which the Tree calculator decides.
// Nothing is substituted: what the data or the measurements lack is named, and a step no machine can do is a named gap line, which makes the
// route incomplete. Every number is computed by a calculator of calculators/investment-casting-calculators.json.
import type { ProcessLineCost, SourceRef } from '../../../dto/cost-breakdown.dto';
import type { DomainCalculatorSpec } from '../../shared/calculators/domain-calculator-spec';
import { runReferenceCalculator, type CalcSeed, type ReferenceCalcRun, type ReferenceCalculatorDef } from '../../shared/calculators/reference-calculator';
import type { CostContext } from '../casting-finishing';
import { machineValue, machineText, type SandMachine } from '../sand/sand-machines';
import type { SandReference } from '../sand/sand-reference';
import { seedsFor, valuesProvider, type SeedProvider, type SeedProviders } from '../sand/sand-seeds';
import { energyBasisOf, selectAndCost, type CostedStep, type SandMaterial, type StepOutcome } from '../sand/sand-steps';
import { INVESTMENT_CLASS, INVESTMENT_DOMAIN, INVESTMENT_PROCESS_GROUP } from './investment-reference';
import { batchSeed, calculatedSeed, costGuideSeed, energySeed, inputStep, resultStep, seedStep } from '../casting-source-refs';

const CALC = (name: string) => `Investment Casting - ${name}`;
export const TREE = CALC('Tree');
export const METAL_PER_CASTING = CALC('Metal per casting');
export const MATERIAL_COST = CALC('Material cost');
export const PATTERN_TOOLING = CALC('Wax pattern tooling');

const r2 = (n: number) => Math.round(n * 100) / 100;
const r4 = (n: number) => Math.round(n * 10000) / 10000;

/** The alloys that are melted and poured under vacuum: they react with air when molten. */
const VACUUM_MELTED = new Set(['Titanium', 'Heat Resistant Super Alloys']);

export interface InvestmentPart {
  volumeMm3: number;
  surfaceAreaMm2: number;
  /** The bounding box, longest side first (mm). */
  dimsMm: readonly [number, number, number];
  /** The thickest wall, else the nominal wall (mm); null when neither is measured. */
  wallMm: number | null;
  /** Side actions of the wax pattern die (the part's slide bundles). */
  slides: number;
}

export interface InvestmentScenario {
  batchSize: number;
  /** Cavities of the wax pattern die instead of the plant's default. */
  cavities: number | null;
  /** USD per kWh: the Cost Guide's, else the location's sourced electricity price; null when neither exists (melt energy not charged). */
  energyPricePerKwh: number | null;
  energyPriceSource?: string | null;
  /** The record it was read from (the location's electricity price row, or the Cost Guide entry), for the trace's eye. */
  energyPriceRef?: SourceRef | null;
  /** Parts made over the die's life; null: the die is not costed (and said so), never spread over an assumed volume. */
  lifetimeVolume: number | null;
}

export interface InvestmentRouteInput {
  ref: SandReference;
  spec: DomainCalculatorSpec;
  calculators: Readonly<Record<string, ReferenceCalculatorDef>>;
  /** The alloy: its raw_materials columns and raw_material_properties, and `price_usd_per_kg`, the price of the location (see priceSource). */
  material: SandMaterial;
  /** Where the alloy's price comes from (the location's price list, or the USA price). */
  priceSource: string;
  /** The row or record the price was read from (alloyPrice); absent: the alloy's cost_usa column. */
  priceRef?: SourceRef;
  part: InvestmentPart;
  machinesByClass: Readonly<Record<string, readonly SandMachine[]>>;
  scenario: InvestmentScenario;
  costContext: CostContext;
}

export interface InvestmentTree {
  patternsPerTree: number;
  layers: number;
  heightMm: number;
  widthMm: number;
  treesInBatch: number;
  primaryDips: number;
  backupDips: number;
  gatesPerPattern: number;
}

export interface InvestmentRoute {
  tree: InvestmentTree;
  /** Route lines in order, costs per casting in USD. */
  lines: ProcessLineCost[];
  /** boughtKg: net + melt loss + the gating not remelted; null when the metal is not costed. */
  material: { netKg: number; pouredKg: number; yieldPct: number; boughtKg: number | null; costUsd: number | null; runs: ReferenceCalcRun[] };
  /** The wax pattern die; null when it is not costed (the warnings say why). */
  tooling: { tools: number; toolCostUsd: number; toolingCostUsd: number; perPartUsd: number; run: ReferenceCalcRun } | null;
  /** The tree calculation, for the trace. */
  treeRun: ReferenceCalcRun;
  /** The shell's drying time (not a cost line, see the warnings): hours per tree and the calculation; null when it could not be calculated. */
  drying: { hoursPerTree: number; run: ReferenceCalcRun } | null;
  /** Material + process lines + tooling per part (USD); null while a line is a gap or the metal is not costed. */
  totalUsd: number | null;
  complete: boolean;
  warnings: string[];
}

type Row = Readonly<Record<string, unknown>>;

/** A row of a reference table as a lookup provider: any of its columns, with the row it is (for the trace and the table viewer). */
function rowProvider(table: string, row: Row, identity: readonly string[]): SeedProvider {
  const id = Object.fromEntries(identity.map((c) => [c, row[c] as string | number]));
  const label = identity.map((c) => `${c} ${row[c]}`).join(', ');
  return (key) => {
    const [t, column] = [key.slice(0, key.indexOf('.')), key.slice(key.indexOf('.') + 1)];
    const value = Number(row[column]);
    if (t !== table || row[column] == null || !Number.isFinite(value)) return null;
    return {
      value, source: `${table} (${label}): ${column}`, lookup: true, match: { table, row: id },
      ref: { kind: 'lookup', domain: INVESTMENT_DOMAIN, table, column, row: id },
    };
  };
}

/** The first row whose `column` is at or above `value` (rows ascending by it), else the last row: the heaviest band covers anything heavier. */
function bandRow(rows: readonly Row[], column: string, value: number, filter: (r: Row) => boolean = () => true): Row | undefined {
  const sorted = rows.filter(filter).sort((a, b) => Number(a[column]) - Number(b[column]));
  return sorted.find((r) => Number(r[column]) >= value) ?? sorted[sorted.length - 1];
}

const fail = (...reasons: string[]): StepOutcome => ({ ok: false, reasons });
const isGap = (l: ProcessLineCost) => l.physicsGap != null;

/**
 * The route of the part, or what keeps it from being built at all (a missing size class, table row or calculator input of the tree and the
 * metal, which every later step depends on). A step that cannot be costed is a gap line on a route that is then incomplete.
 */
export function buildInvestmentRoute(input: InvestmentRouteInput): { route: InvestmentRoute | null; missing: string[] } {
  const { ref, part, scenario, material } = input;
  const none = (...missing: string[]) => ({ route: null, missing });
  const num = (name: string) => ref.number(name);
  const [lengthMm, widthMm, heightMm] = part.dimsMm;

  const density = material.columns['density_kg_m3'];
  if (density == null || !(density > 0)) return none(`${material.name}: density_kg_m3`);
  const netKg = part.volumeMm3 * 1e-9 * density;

  // The size classes the plant variables are kept by, each from its own pair of weight thresholds.
  const classOf = (lowName: string, highName: string): 'small' | 'medium' | 'large' | null => {
    const [low, high] = [num(lowName), num(highName)];
    return low == null || high == null ? null : netKg <= low ? 'small' : netKg <= high ? 'medium' : 'large';
  };
  const gateClass = classOf('partMassThreshold_small', 'partMassThreshold_medium');
  const spacingClass = classOf('partMassSizeThreshold_low', 'partMassSizeThreshold_medium');
  const dipClass = classOf('partWeightThreshold_small', 'partWeightThreshold_large');
  if (!gateClass || !spacingClass || !dipClass) return none('investment casting variables: the part weight thresholds (partMassThreshold_*, partMassSizeThreshold_*, partWeightThreshold_*)');
  const backupName = { small: 'numBackupDipCycles_min', medium: 'numBackupDipCycles_low', large: 'numBackupDipCycles_high' }[dipClass];
  const named = {
    gatingEfficiency: `gatingEfficiency_${gateClass}`, runnerWidth: `${gateClass}RunnerWidth`, spacing: `waxPatternSpacingAllowance_${spacingClass}`,
    backupDips: backupName, primaryDips: 'defaultNumPrimaryDipCycles',
  };
  const absent = Object.values(named).filter((n) => num(n) == null);
  if (absent.length) return none(...absent.map((n) => `investment casting variable ${n}`));
  const primaryDips = num(named.primaryDips)!;
  const backupDips = num(named.backupDips)!;
  const totalDips = primaryDips + backupDips;

  // The rows of the weight- and dip-based tables this part reads.
  const massRow = bandRow(ref.table('partMassBasedData'), 'Mass (kg)', netKg);
  const dipRow = bandRow(ref.table('dipCycleBasedData'), 'Total Number of Dip Cycles', totalDips);
  const waxRow = ref.table('tblWaxProperties')[0];
  const waxDensity = Number(waxRow?.['Density (kg / m^3)']);
  if (!massRow || !dipRow || !waxRow || !(waxDensity > 0)) return none('investment casting lookup tables partMassBasedData, dipCycleBasedData and tblWaxProperties (not staged, migration 874)');
  const patternKg = part.volumeMm3 * 1e-9 * waxDensity;
  const handlingRow = bandRow(ref.table('tblHandlingTimes'), 'Max Weight (kg)', patternKg);
  if (!handlingRow) return none('investment casting lookup table tblHandlingTimes (not staged, migration 874)');
  const lookups: Record<string, SeedProvider> = {
    partMassBasedData: rowProvider('partMassBasedData', massRow, ['Mass (kg)']),
    dipCycleBasedData: rowProvider('dipCycleBasedData', dipRow, ['Total Number of Dip Cycles']),
    tblWaxProperties: rowProvider('tblWaxProperties', waxRow, ['Name']),
    tblHandlingTimes: rowProvider('tblHandlingTimes', handlingRow, ['Equipment', 'Max Weight (kg)']),
  };
  const lookup: SeedProvider = (key) => lookups[key.slice(0, key.indexOf('.'))]?.(key) ?? null;
  const gates = Number(massRow['Number of Gates']);

  // A side of the part's bounding box, as the step it is: the box, and which of its sides is taken (and why).
  const box = `${r2(lengthMm)} x ${r2(widthMm)} x ${r2(heightMm)}`;
  const side = (value: number, source: string, name: string, which: string): CalcSeed => calculatedSeed(value, source, name, [
    inputStep('Part box', 'mm', box, "CAD: the part's bounding box, longest side first"),
    resultStep(name, 'mm', value, which),
  ]);
  const cad: Record<string, CalcSeed> = {
    volume_mm3: { value: part.volumeMm3, source: 'part volume (mm³)' },
    area_mm2: { value: part.surfaceAreaMm2, source: 'part surface (mm²)' },
    modulus_mm: { value: part.volumeMm3 / part.surfaceAreaMm2, source: 'casting modulus: volume / surface (mm)' },
    length_mm: side(lengthMm, 'longest side of the part (mm)', 'Part Length', 'The longest side'),
    width_mm: side(widthMm, 'second side of the part (mm)', 'Part Width', 'The second side'),
    height_mm: side(heightMm, 'shortest side of the part (mm): the wax die opens along it', 'Pattern Height', 'The shortest side: the wax die opens along it'),
    stack_mm: side(widthMm, 'second side of the part (mm): along the tree, the plant\'s default pattern orientation', 'Stack', "The second side: along the tree, the plant's default pattern orientation"),
    radial_mm: side(heightMm, 'shortest side of the part (mm): out from the down pole', 'Radial', 'The shortest side: out from the down pole'),
  };
  const variable: SeedProvider = (name) => {
    const value = num(name);
    return value == null ? null : {
      value, source: `Investment casting variable ${name}${ref.unit(name) ? ` (${ref.unit(name)})` : ''}`,
      ref: { kind: 'variable', domain: INVESTMENT_DOMAIN, name },
    };
  };
  /** A plant variable of memory/Casting Investment as a seed the route supplies itself, opening the variable. */
  const ivar = (name: string, note = ''): CalcSeed => ({
    value: num(name) ?? NaN, source: `Investment casting variable ${name}${note}`, ref: { kind: 'variable', domain: INVESTMENT_DOMAIN, name },
  });
  const scenarioSeeds: Record<string, CalcSeed | undefined> = {
    batch_size: batchSeed(scenario.batchSize, 'batch size'),
    lifetime_volume: scenario.lifetimeVolume != null
      ? calculatedSeed(scenario.lifetimeVolume, 'annual volume x production life', 'Lifetime Volume', [
        inputStep('Lifetime volume', null, scenario.lifetimeVolume, "The part's annual volume x production life (its costing inputs)", { kind: 'costingInput', field: 'annualVolume' }),
        resultStep('Lifetime Volume', null, scenario.lifetimeVolume, '{Annual volume} x {Production life}'),
      ])
      : undefined,
    energy_price: energySeed(scenario),
  };

  /** One calculator run: every input seeded from its declared source, or the inputs nobody could supply. */
  const run = (calculator: string, machine: SandMachine | null, engine: Record<string, CalcSeed>, output = 'Cycle Time'): { run: ReferenceCalcRun } | { reasons: string[] } => {
    const calc = input.spec.calculators.find((c) => c.name === calculator);
    if (!calc) return { reasons: [`${calculator} is not in the calculator spec`] };
    const providers: SeedProviders = {
      variable, lookup, cad: valuesProvider(cad), engine: valuesProvider(engine), scenario: valuesProvider(scenarioSeeds),
      material: (key) => {
        const value = material.columns[key];
        if (value == null) return null;
        if (key === 'price_usd_per_kg') {
          return { value, source: `${material.name}: ${input.priceSource}`, ref: input.priceRef ?? { kind: 'material', materialId: material.id, materialName: material.name, column: 'cost_usa' } };
        }
        return { value, source: `${material.name}: ${key}`, ref: { kind: 'material', materialId: material.id, materialName: material.name, column: key } };
      },
      machine: (key) => {
        const value = machine ? machineValue(machine, key) : null;
        return value == null || !machine ? null : {
          value, source: `machine ${machine.name}: ${key}`,
          ref: { kind: 'machine', machineId: machine.id, machineName: machine.name, machineClass: machine.machineClass, location: machine.location, column: key },
        };
      },
    };
    const { seeds, missing } = seedsFor(calc, providers);
    if (missing.length) return { reasons: missing.map((m) => `${calculator}: ${m}`) };
    const result = runReferenceCalculator(input.calculators, calculator, seeds, output);
    return result.value == null ? { reasons: result.missing } : { run: result };
  };

  // The tree and the metal: every later step is shared by the patterns of the tree.
  const cavitiesOfDie = scenario.cavities ?? num('defaultWaxPatternsNumCavities');
  if (cavitiesOfDie == null) return none('investment casting variable defaultWaxPatternsNumCavities');
  // The tallest tree the plant builds (defaultMaxTreeBoxHeight) that every step can also take: a tank's working depth, a furnace bed, the knockout machine.
  const heightLimits: Array<{ limit: number; source: string; ref?: SourceRef }> = [];
  const treeLimit = num('defaultMaxTreeBoxHeight');
  if (treeLimit == null) return none('investment casting variable defaultMaxTreeBoxHeight');
  heightLimits.push({ limit: treeLimit, source: 'Investment casting variable defaultMaxTreeBoxHeight', ref: { kind: 'variable', domain: INVESTMENT_DOMAIN, name: 'defaultMaxTreeBoxHeight' } });
  const tankDepthFactor = num('slurryTankSafetyMultiplier_depth');
  const tallest = (machineClass: string, key: string, factor = 1) => {
    const sized = (input.machinesByClass[machineClass] ?? []).map((m) => ({ m, h: machineValue(m, key) })).filter((x): x is { m: SandMachine; h: number } => x.h != null && x.h > 0);
    const top = sized.sort((a, b) => b.h - a.h)[0];
    if (top) {
      heightLimits.push({
        limit: top.h * factor, source: `the tallest ${machineClass.replace('casting_investment_', '').replace(/_/g, ' ')} machine${factor !== 1 ? ` x ${factor}` : ''}`,
        ref: { kind: 'machine', machineId: top.m.id, machineName: top.m.name, machineClass: top.m.machineClass, location: top.m.location, column: key },
      });
    }
  };
  const dewaxClass = ref.text('isEnabledFlashFireFurnace') === 'true' ? INVESTMENT_CLASS.flashFire : INVESTMENT_CLASS.autoclave;
  for (const c of [dewaxClass, INVESTMENT_CLASS.burnout, INVESTMENT_CLASS.preheat]) tallest(c, 'bed_height_mm');
  tallest(INVESTMENT_CLASS.knockout, 'useable_height_mm');
  if (tankDepthFactor != null) for (const c of [INVESTMENT_CLASS.primaryDip, INVESTMENT_CLASS.secondaryDip]) tallest(c, 'tank_dept_header_truncated', tankDepthFactor);
  const height = heightLimits.reduce((a, b) => (b.limit < a.limit ? b : a));

  const treeRun = run(TREE, null, {
    max_tree_height_mm: calculatedSeed(height.limit, `${height.source}: the tallest tree the plant builds that every step can take`, 'Max Tree Height', [
      ...heightLimits.map((h) => inputStep(h.source, 'mm', h.limit, h.source, h.ref)),
      resultStep('Max Tree Height', 'mm', height.limit, 'The lowest of the limits: the tallest tree the plant builds that every step can take'),
    ]),
    layer_spacing_mm: ivar(named.spacing, ` (${spacingClass} part weight)`),
    runner_width_mm: ivar(named.runnerWidth, ` (${gateClass} part)`),
  }, 'Patterns per Tree');
  if (!('run' in treeRun)) return none(...treeRun.reasons);
  const patterns = treeRun.run.value!;
  const tree: InvestmentTree = {
    patternsPerTree: patterns, layers: treeRun.run.outputs['Layers']!, heightMm: r2(treeRun.run.outputs['Tree Height']!), widthMm: r2(treeRun.run.outputs['Tree Width']!),
    treesInBatch: treeRun.run.outputs['Trees in Batch']!, primaryDips, backupDips, gatesPerPattern: gates,
  };
  const treeRef: SourceRef = { kind: 'calculation', name: TREE, evidence: null, steps: treeRun.run.trace };
  const perTree: Record<string, CalcSeed> = {
    patterns_per_tree: { value: patterns, source: 'patterns on the tree (Tree calculator)', ref: treeRef },
    trees_in_batch: { value: tree.treesInBatch, source: 'trees the batch needs (Tree calculator)', ref: treeRef },
    tree_width_mm: { value: tree.widthMm, source: 'tree width (Tree calculator)', ref: treeRef },
  };
  const metalRun = run(METAL_PER_CASTING, null, {
    ...perTree,
    gating_efficiency: ivar(named.gatingEfficiency, ` (${gateClass} part)`),
  }, 'Poured Weight');
  if (!('run' in metalRun)) return none(...metalRun.reasons);
  const pouredKg = metalRun.run.value!;
  const pouredPerTreeKg = metalRun.run.outputs['Poured per Tree']!;
  const metalRef = { kind: 'calculation' as const, name: METAL_PER_CASTING, evidence: 'part_volume' as const, steps: metalRun.run.trace };

  const warnings: string[] = [];
  const enabled = (name: string) => ref.text(name) === 'true';
  const robotic = enabled('isEnabledAutomatedDipping');
  const vents = enabled('defaultEnableWaxVents') ? num('defaultNumWaxVentsPerTree') ?? 0 : 0;

  // The tree as the shell machines hold it: the wax (patterns and gating) and the shell on it.
  const shellPerArea = (num('primaryLayerShellMassPerArea') ?? 0) + (num('secondaryLayerShellMassPerArea') ?? 0); // g/cm²
  const treeKg = patterns * (patternKg / num(named.gatingEfficiency)! + (part.surfaceAreaMm2 / 100) * shellPerArea / 1000);

  const step = (process: string, machineClass: string, evaluate: (m: SandMachine) => StepOutcome, criteria: string[], machines?: readonly SandMachine[]): CostedStep =>
    selectAndCost({
      process, machineClass, machines: machines ?? input.machinesByClass[machineClass] ?? [], evaluate, criteria,
      batchSize: scenario.batchSize, costContext: input.costContext, ref, processGroup: INVESTMENT_PROCESS_GROUP,
    });
  const timed = (calculator: string, machine: SandMachine, engine: Record<string, CalcSeed> = {}): StepOutcome => {
    const r = run(calculator, machine, { ...perTree, ...engine });
    return 'run' in r ? { ok: true, sec: r.run.value!, run: r.run, energyCostUsd: 0, notes: [] } : fail(...r.reasons);
  };

  /** A bench operation: the bench with the crew the plant sets for that operation (the bench record carries none). */
  const bench = (process: string, calculator: string, operatorsVariable: string, engine: Record<string, CalcSeed> = {}): CostedStep => {
    const operators = num(operatorsVariable);
    const benches = (input.machinesByClass[INVESTMENT_CLASS.bench] ?? []).map((m) => ({ ...m, operators }));
    return step(process, INVESTMENT_CLASS.bench, (m) => (operators == null ? fail(`investment casting variable ${operatorsVariable}`) : timed(CALC(`Bench: ${calculator}`), m, engine)),
      [`The crew of the operation (${operatorsVariable})`], benches);
  };

  const holdsTree = (m: SandMachine, length: string, width: string, height: string): string[] => {
    const [l, w, h] = [machineValue(m, length), machineValue(m, width), machineValue(m, height)];
    if (l == null || w == null || h == null) return [`machine ${m.name}: ${length}, ${width} and ${height}`];
    const reasons: string[] = [];
    if (tree.widthMm > Math.min(l, w)) reasons.push(`the tree is ${tree.widthMm} mm wide, the machine takes ${Math.min(l, w)} mm`);
    if (tree.heightMm > h) reasons.push(`the tree is ${tree.heightMm} mm high, the machine takes ${h} mm`);
    return reasons;
  };
  const furnace = (process: string, calculator: string, machineClass: string): CostedStep =>
    step(process, machineClass, (m) => {
      const unfit = holdsTree(m, 'bed_length_mm', 'bed_width_mm', 'bed_height_mm');
      return unfit.length ? fail(...unfit) : timed(CALC(calculator), m);
    }, ['The bed takes the tree (its width and height)']);

  // ── The wax pattern ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  const chillAt = num('waxPatternChillMaxThicknessThreshold');
  const measuredWall = part.wallMm ?? (2 * part.volumeMm3) / part.surfaceAreaMm2;
  if (part.wallMm == null) warnings.push(`Wall thickness not measured: the wax cooling time uses 2 x volume / surface (${r2(measuredWall)} mm), the thickness of a plate of the part's volume and surface.`);
  const chilled = chillAt != null && measuredWall > chillAt;
  // The wall the wax cools through, as measured (the casting analysis's thickest wall), else the plate of the part's volume and surface.
  const wallSeedOf: CalcSeed = part.wallMm != null
    ? calculatedSeed(measuredWall, 'thickest wall of the part (mm)', 'Thickest wall', [
      inputStep('Thickest wall', 'mm', measuredWall, 'CAD casting analysis: the wall thickness profile, rays cast inward from every face of the part, its thickest sample (else the nominal wall)', { kind: 'cad', evidence: 'part_surface' }),
    ])
    : calculatedSeed(measuredWall, '2 x volume / surface (mm)', 'Wall', [
      inputStep('Part volume', 'mm³', part.volumeMm3, 'CAD: the part volume', { kind: 'cad', evidence: 'part_volume' }),
      inputStep('Part surface', 'mm²', part.surfaceAreaMm2, 'CAD: the part surface', { kind: 'cad', evidence: 'part_surface' }),
      resultStep('Wall', 'mm', measuredWall, "Not measured: 2 x {Part volume} / {Part surface}, a plate of the part's volume and surface"),
    ]);
  const cavitiesSeed: CalcSeed = scenario.cavities != null
    ? costGuideSeed('Cavities', null, cavitiesOfDie, 'cavityCount', 'defaultWaxPatternsNumCavities', 'cavities set in the Cost Guide')
    : ivar('defaultWaxPatternsNumCavities');
  if (chilled) warnings.push(`The pattern is thicker than ${chillAt} mm (waxPatternChillMaxThicknessThreshold): it is molded around a chill, so the wax cools through ${chillAt} mm and the chill is loaded each shot.`);
  const waxPattern = step('Wax Pattern Molding', INVESTMENT_CLASS.waxPattern, (m) => {
    const need = ['formingRegionLengthMargin_patternWax', 'formingRegionWidthMargin_patternWax', 'moldBaseLengthMargin_patternWax', 'moldBaseWidthMargin_patternWax',
      'moldBaseHeightMargin_patternWax', 'waxPatternMinimumToolLength', 'waxPatternMinimumToolWidth', 'waxPatternMoldOpenStrokeFactor', 'defaultWaxPatternLoadChillTime'];
    const lacking = need.filter((n) => num(n) == null);
    if (chillAt == null) lacking.push('waxPatternChillMaxThicknessThreshold');
    if (lacking.length) return fail(...lacking.map((n) => `investment casting variable ${n}`));
    const toolL = Math.max(num('waxPatternMinimumToolLength')!, lengthMm + 2 * num('formingRegionLengthMargin_patternWax')! + 2 * num('moldBaseLengthMargin_patternWax')!);
    const toolW = Math.max(num('waxPatternMinimumToolWidth')!, widthMm + 2 * num('formingRegionWidthMargin_patternWax')! + 2 * num('moldBaseWidthMargin_patternWax')!);
    const open = heightMm + 2 * num('moldBaseHeightMargin_patternWax')! + heightMm * num('waxPatternMoldOpenStrokeFactor')!;
    const [pl, pw, daylight] = [machineValue(m, 'platen_length_mm'), machineValue(m, 'platen_width_mm'), machineValue(m, 'maximum_daylight_mm')];
    if (pl == null || pw == null || daylight == null) return fail(`machine ${m.name}: platen length, platen width and maximum daylight`);
    if (Math.max(toolL, toolW) > Math.max(pl, pw) || Math.min(toolL, toolW) > Math.min(pl, pw)) return fail(`the die is ${toolL.toFixed(0)} x ${toolW.toFixed(0)} mm, the platen ${pl} x ${pw} mm`);
    if (open > daylight) return fail(`the die and its opening stroke need ${open.toFixed(0)} mm, the daylight is ${daylight} mm`);
    return timed(CALC('Wax pattern molding'), m, {
      cavities: cavitiesSeed,
      cooling_wall_mm: chilled ? ivar('waxPatternChillMaxThicknessThreshold', ' (the pattern is chilled)') : wallSeedOf,
      chill_load_s: chilled ? ivar('defaultWaxPatternLoadChillTime') : calculatedSeed(0, 'no chill: the pattern is not thicker than waxPatternChillMaxThicknessThreshold', 'Chill Load Time', [
        seedStep('Wall', 'mm', wallSeedOf),
        seedStep('waxPatternChillMaxThicknessThreshold', 'mm', ivar('waxPatternChillMaxThicknessThreshold')),
        resultStep('Chill Load Time', 's', 0, 'No chill: the wall is not thicker than waxPatternChillMaxThicknessThreshold'),
      ]),
    });
  }, ['The platen takes the wax die (pattern with its forming and mold base margins)', 'The daylight takes the die and its opening stroke']);

  // ── The shell ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  const dipTime = robotic ? 'slurryDipTimePerTreeRobotic' : gateClass === 'large' ? 'slurryDipTimePerTree_large' : 'slurryDipTimePerTree_small';
  const coatTime = robotic ? 'sandCoatTimePerTreeRobotic' : 'sandCoatTimePerTree';
  const coatGroup = (dips: CalcSeed): Record<string, CalcSeed> => ({
    dips,
    dip_time_s: ivar(dipTime),
    coat_time_s: ivar(coatTime),
  });
  const tank = (m: SandMachine): string[] => {
    const [diameter, depth] = [machineValue(m, 'tank_d_header_truncated'), machineValue(m, 'tank_dept_header_truncated')];
    const [kd, kh] = [num('slurryTankSafetyMultiplier_diameter'), num('slurryTankSafetyMultiplier_depth')];
    if (diameter == null || depth == null) return [`machine ${m.name}: tank diameter and depth`];
    if (kd == null || kh == null) return ['investment casting variables slurryTankSafetyMultiplier_diameter and slurryTankSafetyMultiplier_depth'];
    const reasons: string[] = [];
    if (tree.widthMm > diameter * kd) reasons.push(`the tree is ${tree.widthMm} mm wide, the tank works to ${r2(diameter * kd)} mm`);
    if (tree.heightMm > depth * kh) reasons.push(`the tree is ${tree.heightMm} mm high, the tank works to ${r2(depth * kh)} mm`);
    return reasons;
  };
  const dipping = (process: string, machineClass: string, dips: CalcSeed) =>
    step(process, machineClass, (m) => {
      const unfit = tank(m);
      return unfit.length ? fail(...unfit) : timed(CALC('Slurry dipping'), m, coatGroup(dips));
    }, ['The slurry tank takes the tree within its working diameter and depth']);
  const coating = (process: string, machineClass: string, dips: CalcSeed) =>
    step(process, machineClass, (m) => timed(CALC('Sand coating'), m, coatGroup(dips)), ['A machine hour rate on file']);
  const primarySeed = ivar(named.primaryDips);
  const backupSeed = ivar(backupName, ` (${dipClass} part weight)`);
  const totalDipsSeed = {
    total_dips: calculatedSeed(totalDips, 'primary and backup dip cycles', 'Dip Cycles', [
      seedStep('Primary dips', null, primarySeed), seedStep('Backup dips', null, backupSeed),
      resultStep('Dip Cycles', null, totalDips, '{Primary dips} + {Backup dips}'),
    ]),
  };

  const shell: CostedStep[] = [
    dipping('Primary Slurry Dipping', INVESTMENT_CLASS.primaryDip, primarySeed),
    coating('Primary Sand Coating', INVESTMENT_CLASS.primarySand, primarySeed),
    dipping('Secondary Slurry Dipping', INVESTMENT_CLASS.secondaryDip, backupSeed),
    coating('Secondary Sand Coating', INVESTMENT_CLASS.secondarySand, backupSeed),
    ...(robotic ? [step('Robotic Assist', INVESTMENT_CLASS.robot, (m) => {
      const payload = machineValue(m, 'max_pa_header_truncated');
      if (payload == null) return fail(`machine ${m.name}: maximum payload`);
      return payload < treeKg ? fail(`carries ${payload} kg, the shelled tree weighs ${r2(treeKg)} kg`) : timed(CALC('Robotic assist'), m, totalDipsSeed);
    }, ['The robot carries the tree with its shell'])] : []),
  ];
  // Drying is hours per tree in a room that holds many trees at once, and the reference data gives the drying work centre no capacity: its rate
  // for a tree's whole drying time would charge each tree the whole room. So drying is not a cost line: its time is calculated and reported.
  const dryingRun = run(CALC('Drying'), null, { ...perTree, ...totalDipsSeed });
  const dryingHoursPerTree = 'run' in dryingRun ? r2((dryingRun.run.value! * patterns) / 3600) : null;

  // ── De-waxing to the pour ────────────────────────────────────────────────────────────────────────────────────────────────────────────
  const dewax = dewaxClass === INVESTMENT_CLASS.flashFire
    ? furnace('Flash Fire De-Waxing', 'Flash fire de-waxing', INVESTMENT_CLASS.flashFire)
    : furnace('Steam Autoclave De-Waxing', 'Steam autoclave de-waxing', INVESTMENT_CLASS.autoclave);
  // A step the plant switches off (a variable not 'true'): 0, opening the switch.
  const off = (name: string, switchName: string, source: string): CalcSeed => calculatedSeed(0, source, name, [
    inputStep(switchName, null, ref.text(switchName) ?? 'none', `Investment casting variable ${switchName}`, { kind: 'variable', domain: INVESTMENT_DOMAIN, name: switchName }),
    resultStep(name, null, 0, `Off (${switchName} is not true): 0`),
  ]);
  const ventSeed = { wax_vents: vents > 0 ? ivar('defaultNumWaxVentsPerTree') : off('Wax Vents', 'defaultEnableWaxVents', 'wax vents are off (defaultEnableWaxVents)') };
  const inspectionTime = (switchName: string, timeName: string): CalcSeed =>
    (enabled(switchName) ? ivar(timeName) : off(timeName, switchName, `off (${switchName})`));

  const pourTemp = material.columns['pour_temp'];
  const needsVacuum = material.materialType != null && VACUUM_MELTED.has(material.materialType);
  const pouring = step('Metal Pouring', INVESTMENT_CLASS.pouring, (m) => {
    const [maxTemp, capacity, fill] = [machineValue(m, 'maximum_header_truncated'), machineValue(m, 'furnace_capacity_m3'), num('meltingFurnaceCrucibleFillFactor')];
    const reasons: string[] = [];
    if (pourTemp == null) reasons.push(`${material.name}: pour_temp`);
    if (maxTemp == null) reasons.push(`machine ${m.name}: maximum temperature`);
    if (capacity == null) reasons.push(`machine ${m.name}: furnace_capacity_m3`);
    if (fill == null) reasons.push('investment casting variable meltingFurnaceCrucibleFillFactor');
    if (reasons.length) return fail(...reasons);
    if (needsVacuum && machineText(m, 'furnac_header_truncated') !== 'vacuum') return fail(`${material.materialType} is melted under vacuum, this is an air furnace`);
    if (maxTemp! < pourTemp!) return fail(`reaches ${maxTemp} °C, the metal is poured at ${pourTemp} °C`);
    const holdsKg = capacity! * density * fill!;
    if (holdsKg < pouredPerTreeKg) return fail(`the crucible holds ${r2(holdsKg)} kg, one tree needs ${r2(pouredPerTreeKg)} kg`);
    const r = run(CALC('Metal pouring'), m, { ...perTree, poured_per_tree_kg: { value: pouredPerTreeKg, source: 'metal per casting x patterns on the tree', ref: metalRef } });
    if (!('run' in r)) return fail(...r.reasons);
    const priced = scenario.energyPricePerKwh != null;
    return {
      ok: true, sec: r.run.value!, run: r.run, energyCostUsd: priced ? r.run.outputs['Energy Cost'] ?? 0 : 0, ...(priced ? { energyBasis: energyBasisOf(scenario) } : {}),
      notes: priced ? [] : ['Melting energy is not charged: the location has no electricity price (location_electricity_prices) and none is set in the Cost Guide.'],
    };
  }, ['It reaches the pouring temperature', 'The crucible holds the metal of one tree', ...(needsVacuum ? [`A vacuum furnace (${material.materialType})`] : [])]);

  // ── Cut-off and finishing: the machine while the casting is light enough for it, the bench above that ────────────────────────────────
  const [sawLimit, sandLimit] = [num('partMassBandSawAllowance'), num('partMassBeltSandAllowance')];
  const cutOff = sawLimit != null && netKg <= sawLimit
    ? step('Band Saw', INVESTMENT_CLASS.bandSaw, (m) => {
      const takes = Math.min(machineValue(m, 'max_stock_width_mm') ?? 0, machineValue(m, 'max_stock_height_mm') ?? 0);
      return tree.widthMm > takes ? fail(`the tree is ${tree.widthMm} mm wide, the saw takes ${takes} mm`) : timed(CALC('Band saw cut-off'), m);
    }, ['The saw takes the tree'])
    : bench('Abrasive Wheel Cutting', 'Abrasive wheel cutting', 'defaultNumOperatorsAbrasiveWheelCutting');
  const gateGrind = sandLimit != null && netKg <= sandLimit
    ? step('Belt Sand', INVESTMENT_CLASS.beltSand, (m) => timed(CALC('Belt sanding'), m), ['A machine hour rate on file'])
    : bench('Abrasive Disc Grinding', 'Abrasive disc grinding', 'defaultNumOperatorsAbrasiveDiscGrinding');

  const steps: CostedStep[] = [
    waxPattern,
    bench('Pattern Finishing', 'Pattern finishing', 'defaultNumOperatorsPatternFinishing'),
    bench('Tree Assembly', 'Tree assembly', 'defaultNumOperatorsTreeAssembly', ventSeed),
    ...shell,
    dewax,
    ...(vents > 0 ? [bench('Wax Vent Plugging', 'Wax vent plugging', 'defaultNumOperatorsWaxVentPlugging', ventSeed)] : []),
    bench('Mold Cleaning', 'Mold cleaning', 'defaultNumOperatorsMoldCleaning'),
    bench('Shell Inspection', 'Shell inspection', 'defaultNumOperatorsVisualInspecting', {
      blue_dye_s: inspectionTime('enableSurfaceInspection', 'defaultInvestmentShellBlueDyeInspectionTime'),
      borescope_s: inspectionTime('enableInternalInspection', 'defaultInvestmentShellBorescopeInspectionTime'),
    }),
    furnace('Mold Burnout', 'Mold burnout', INVESTMENT_CLASS.burnout),
    furnace('Mold Preheating', 'Mold preheating', INVESTMENT_CLASS.preheat),
    pouring,
    step('Cooling', INVESTMENT_CLASS.cooling, (m) => timed(CALC('Cooling'), m), ['A machine hour rate on file']),
    step('Knockout', INVESTMENT_CLASS.knockout, (m) => {
      const unfit = holdsTree(m, 'useable_length_mm', 'useable_width_mm', 'useable_height_mm');
      return unfit.length ? fail(...unfit) : timed(CALC('Knockout'), m);
    }, ['The machine takes the tree (its width and height)']),
    cutOff,
    gateGrind,
    bench('Finishing', 'Finishing', 'defaultNumOperatorsFinishing'),
    bench('Dimensional Inspection', 'Dimensional inspecting', 'defaultNumOperatorsDimensionalInspecting'),
  ];
  const lines = steps.map((s) => s.line);
  warnings.push(...steps.flatMap((s) => s.warnings));
  warnings.push(
    `The tree is a carousel of ${tree.layers} layer${tree.layers === 1 ? '' : 's'} with ${patterns} pattern${patterns === 1 ? '' : 's'} (${tree.heightMm} mm high, ${tree.widthMm} mm wide); the shell has ${primaryDips} primary and ${backupDips} backup dips (${dipClass} part weight).`,
    `Shell drying${dryingHoursPerTree != null ? ` (${dryingHoursPerTree} h per tree)` : ''} is not charged and is not a line of the route: a drying room holds many trees at once, and the reference data gives the drying work centre no capacity to share its rate over.`,
    'Slurry, stucco sand and pattern wax are not priced: the reference data has no price for them.',
    'Holes and voids are taken as formed by the shell: the route has no ceramic or soluble wax cores.',
    'The wax press is checked for platen and daylight, not clamping force: the reference data has no wax injection pressure.',
  );
  if (material.materialType === 'Titanium') warnings.push('Chemical etching (alpha case removal on titanium) is not costed.');

  // Metal bought: the melt loss of the chosen furnace; the gating returns to it (the remelt allowance).
  let materialCost: number | null = null;
  let boughtKg: number | null = null;
  const runs: ReferenceCalcRun[] = [metalRun.run];
  if (pouring.machine) {
    const m = run(MATERIAL_COST, null, {
      net_kg: { value: netKg, source: 'metal per casting', ref: metalRef }, poured_kg: { value: pouredKg, source: 'metal per casting', ref: metalRef },
      furnace_yield: {
        value: machineValue(pouring.machine, 'yield_l_header_truncated') ?? NaN, source: `machine ${pouring.machine.name}: yield`,
        ref: { kind: 'machine', machineId: pouring.machine.id, machineName: pouring.machine.name, machineClass: pouring.machine.machineClass, location: pouring.machine.location, column: 'yield_l_header_truncated' },
      },
    }, 'Material Cost');
    if ('run' in m) {
      materialCost = m.run.value!;
      boughtKg = m.run.outputs['Bought Weight'] ?? null;
      runs.push(m.run);
    } else warnings.push(`The metal is not costed: ${m.reasons.join('; ')}`);
  }

  // The wax pattern die, over the lifetime volume; off when the data disables amortization.
  let tooling: InvestmentRoute['tooling'] = null;
  if (scenario.lifetimeVolume == null) warnings.push('The wax pattern die is not costed: it is amortised over annual volume x production life, and one of them is not set.');
  else {
    const tolerance = (ref.text('defaultWaxPatternToolingTolerance') ?? '').split(' ')[0]!.toLowerCase();
    const toleranceName = `waxPatternToleranceFactor_${tolerance}`;
    const t = run(PATTERN_TOOLING, null, {
      tolerance_factor: ivar(toleranceName, ' (defaultWaxPatternToolingTolerance)'),
      slides: calculatedSeed(part.slides, 'slide bundles of the part', 'Slides', [inputStep('Slide bundles', null, part.slides, "CAD: the SlideBundle features of the part (the wax die's side actions)")]),
      cavities: cavitiesSeed,
    }, 'Cost per Part');
    if ('run' in t) {
      tooling = { tools: t.run.outputs['Tools']!, toolCostUsd: r2(t.run.outputs['Tool Cost']!), toolingCostUsd: r2(t.run.outputs['Tooling Cost']!), perPartUsd: r4(t.run.value!), run: t.run };
      warnings.push('The wax pattern die cost is the plant\'s regression on the mold base area and the pattern height, read in square inches and inches (the reference data does not name its units).');
    } else warnings.push(`The wax pattern die is not costed: ${t.reasons.join('; ')}`);
  }
  const toolingPerPart = tooling && ref.text('disableInvestmentAmortization') !== 'true' ? tooling.perPartUsd : 0;

  const complete = !lines.some(isGap) && materialCost != null;
  const processUsd = lines.reduce((s, l) => s + l.totalCost, 0);
  return {
    missing: [],
    route: {
      tree, lines, treeRun: treeRun.run,
      drying: 'run' in dryingRun ? { hoursPerTree: dryingHoursPerTree!, run: dryingRun.run } : null,
      material: { netKg: r4(netKg), pouredKg: r4(pouredKg), yieldPct: r2((100 * netKg) / pouredKg), boughtKg, costUsd: materialCost != null ? r2(materialCost) : null, runs },
      tooling,
      totalUsd: complete ? r2(materialCost! + processUsd + toolingPerPart) : null,
      complete, warnings,
    },
  };
}
