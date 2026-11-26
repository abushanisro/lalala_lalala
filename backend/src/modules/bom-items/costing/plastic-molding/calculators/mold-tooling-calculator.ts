/**
 * The injection mold tooling cost, by its stored calculator (plastic-molding-calculators.json "Injection Mold - Tooling", migration 1012). The engine
 * supplies what the staged reference says for this mold (mold-tooling-engine.ts: which components, their subtotal, the design and assembly hours) and
 * the scenario; every price, hour and amortization step is a formula of the calculator, shown on the line and changeable for a part.
 */
import type { CalculationTraceStep, SourceRef } from '../../../dto/cost-breakdown.dto';
import { runReferenceCalculator, type CalcSeed, type ReferenceCalculators } from '../../shared/calculators/reference-calculator';
import type { MoldBaseReference, MoldExtrasReference, MoldToolingTables, ToolroomRates } from '../plastic-reference';
import type { MoldBaseChoice } from '../process/mold-base';
import type { MoldCavityLookup } from '../process/mold-cavity';
import type { BlockSize, SideActionSignals } from '../side-action-signals';
import { planRibInserts, ribInsertQuantities, type RibSignals } from '../process/rib-inserts';
import type { SteelTreatment } from '../reference/im-reference';
import { calculatorFingerprint, requirePlasticCalculator, withRegistryFormulas } from './plastic-cycle-time';
import { INJECTION_ASSEMBLY_HOURS, INJECTION_MOLD_COMPONENTS, MOLD_COMPONENT_DOMAIN, componentNameKey } from '../plastic-reference';
import { plasticLookup, plasticVariable, withRef } from './plastic-input-sources';
import { calc, inputStep, resultStep } from './plastic-cycle-time-seeds';
import { referencePackageRef } from '../../shared/served-reference-tables';

export const MOLD_TOOLING_CALCULATOR = 'Injection Mold - Tooling';
const OUTPUT = 'Tooling Cost Per Part';
const REF = 'memory/Plastic Modeling';
/** The injection mold's own component variables (2026-AssyPlastic). */
const COMPONENTS = 'memory/Assembly plastic molding/plastic_molding_variables';
// Formula registry (plastic-molding/formula-registry.ts): F-27 (assembly extras), F-28 (slide and lifter blocks), F-29 (heat treatment), F-30 (cooling), F-31 (rib inserts, EDM), F-33 (hot drops), F-37 (water baffles) are this
// calculator's formulas; the seeds below supply their inputs.
/** timePerTryoutBase's note: "basic hrs per tryout for <500T (x2 for bigger)". */
const TRYOUT_DOUBLE_ABOVE_TONNES = 500;
/** The approved cooling rule (F-30): water lines 3 line diameters apart. No pitch is on file; the input shows it and a part can change it. */
const WATER_LINE_PITCH_FACTOR = 3;

export interface MoldToolingFacts {
  /** The standard components the mold needs, priced (mold-tooling-engine.ts). */
  components: ReadonlyArray<{ componentName: string; qty: number; unitCostUsd: number }>;
  componentsSubtotalUsd: number;
  moldBaseAreaMm2: number;
  designHours: number;
  /** The mold_base_area_mm2 of the cmMoldBaseDesignHours row the design hours were read from; absent when not known. */
  designHoursRowAreaMm2?: number | null;
  assemblyHours: number;
  tables: MoldToolingTables;
  /** The quote location's toolroom rates; null when memory/ holds none for it (USA only). */
  toolroomRates: ToolroomRates | null;
  location: string;
  annualVolume: number;
  productionLifeYears: number;
  cavityCount: number;
  toolLifeShots: number;
  /** Where the tool life came from: the tblToolLife row of the material type, or the reference default. */
  toolLifeSource: string;
  /** The Material Type of the tblToolLife row the tool life was read from; null when it is the reference default (defaultToolLife). Absent: not known. */
  toolLifeMaterialType?: string | null;
  /** The standard mold base chosen for the part (mold-base.ts), or what is missing to choose one. */
  moldBase: MoldBaseChoice | { missing: string[] };
  moldBaseRef: MoldBaseReference;
  /** The part's height along the pull (the bounding box's smallest side), mm. */
  partHeightMm: number | null;
  /** The cavity machining rate for the part's complexity and size (mold-cavity.ts), or what is missing to choose it. */
  cavity: MoldCavityLookup | { missing: string[] };
  partSurfaceAreaMm2: number | null;
  /** The ejector pins, sprue bushing, locating ring and try-out (F-27). */
  extras: MoldExtrasReference;
  /** The press the part runs on (t): the try-out hours double above 500 t. Null when no press is chosen. */
  pressClampTonnes: number | null;
  /** The recognised slide and lifter bundles by size class (side-action-signals.ts); null when the CAD features were not recognised. */
  sideActionBlocks: SideActionSignals['blocks'] | null;
  /** The sized bundles behind those blocks (plastic feature graph ids), by kind: what the block volumes light. Absent with an older signal. */
  sideActionBundleIds?: { slide: string[]; lifter: string[] } | null;
  /** The ribs the CAD engine measured (rib-inserts.ts); null when the graph has none to read. */
  ribs: RibSignals | null;
  /** How the default tool steel grade is treated (reference/mold-steel-treatment-reference.csv); null when the grade has no row. */
  steelTreatment: SteelTreatment | null;
  /** The runner and the gates per cavity: a hot runner has one drop per gate (F-33). */
  runner: 'hot' | 'cold';
  gatesPerCavity: number;
  /** Where the runner was decided: the part's gate signal, the reference default (defaultRunnerSystem), or an LSR cold deck. Absent: not known. */
  runnerBasis?: 'gate' | 'reference' | 'lsr';
  /** How the cavity count was chosen (plastic-derived-refs.ts cavitiesRef): the Cavities per Mold input's eye. Absent: not known. */
  cavitiesRef?: SourceRef | null;
  /** The part's bounding box, longest side first (mm): the part height is its smallest side. Absent: not known. */
  bboxMm?: readonly [number, number, number] | null;
  /** Where the projected area per cavity came from (the CAD projected area, or the bounding box's footprint). Absent: not known. */
  projectedAreaSource?: string | null;
}

const SIZE_ORDER: readonly BlockSize[] = ['small', 'medium', 'large'];

/** The bundles a block volume was counted from, as the ref its eye lights; nothing when none is named. */
function bundlesRef(label: string, ids: readonly string[] | null | undefined) {
  return ids && ids.length > 0 ? { ref: { kind: 'features' as const, label, features: ids.map((featureId) => ({ featureId })) } } : {};
}

/**
 * The slide and lifter blocks the mold needs (F-28): their volume by size class, and their surface as cubes of that volume (6 x V^(2/3)). Unsized
 * bundles and an unrecognised part add nothing; the scope warning names them (mold-tooling-engine.ts).
 */
export function sideActionBlocks(blocks: SideActionSignals['blocks'] | null, x: MoldExtrasReference) {
  const list: Array<{ kind: 'slide' | 'lifter'; size: BlockSize; volumeIn3: number }> = [];
  for (const kind of ['slide', 'lifter'] as const) {
    const volumes = kind === 'slide' ? x.slideVolumeIn3 : x.lifterVolumeIn3;
    for (const size of SIZE_ORDER) for (let i = 0; i < (blocks?.[kind][size] ?? 0); i++) list.push({ kind, size, volumeIn3: volumes[size] });
  }
  const volume = (kind: 'slide' | 'lifter') => list.filter((b) => b.kind === kind).reduce((t, b) => t + b.volumeIn3, 0);
  const describe = (kind: 'slide' | 'lifter') => SIZE_ORDER
    .map((size) => [size, list.filter((b) => b.kind === kind && b.size === size).length] as const)
    .filter(([, n]) => n > 0)
    .map(([size, n]) => `${n} ${size} x ${(kind === 'slide' ? x.slideVolumeIn3 : x.lifterVolumeIn3)[size]} in³ (${size}${kind === 'slide' ? 'Slide' : 'Lifter'}Volume)`)
    .join(' + ');
  return {
    count: list.length,
    slideVolumeIn3: volume('slide'),
    lifterVolumeIn3: volume('lifter'),
    surfaceIn2: list.reduce((t, b) => t + 6 * b.volumeIn3 ** (2 / 3), 0),
    slideSource: describe('slide') || 'no slide bundles recognised',
    lifterSource: describe('lifter') || 'no lifter bundles recognised',
  };
}

/** A variable of the injection mold's own component data (memory/Assembly plastic molding, staged as assembly_plastic_molding). */
const componentVariable = (name: string): SourceRef => ({ kind: 'variable', domain: MOLD_COMPONENT_DOMAIN, name });

/** The capitalised size of a class, for the variable names that spell it (smallSlideVolume, cmDesignHrsRibInsertSmall). */
const cap = (size: BlockSize) => `${size[0]!.toUpperCase()}${size.slice(1)}`;

/**
 * Where the calculator's inputs the engine sums or decides come from, step by step (the calculations they are): the component subtotal and
 * assembly hours over the components, each from its variable or table row; the plate setups; the mold window; the part height; the try-out
 * multiplier; the slide and lifter blocks; the rib inserts by size class; the steel treatment row; the hot drops.
 */
function toolingRefs(f: MoldToolingFacts, sa: ReturnType<typeof sideActionBlocks>, rq: ReturnType<typeof ribInsertQuantities>, plan: ReturnType<typeof planRibInserts>) {
  const v = plasticVariable;
  const x = f.extras;
  const ri = x.ribInsert;
  const injection = (name: string) => INJECTION_MOLD_COMPONENTS.find((c) => componentNameKey(c.name) === componentNameKey(name));
  const staged = (table: string, column: string, rows: ReadonlyArray<{ name: string }>, wanted: string) => {
    const name = rows.find((r) => componentNameKey(r.name) === componentNameKey(wanted))?.name;
    return name ? plasticLookup(table, column, { name }) : undefined;
  };
  const components = calc('Purchased Components Cost: the components the mold needs', [
    ...f.components.flatMap((c) => {
      const inj = injection(c.componentName);
      return [
        inputStep(`${c.componentName} unit cost`, 'USD', c.unitCostUsd, inj ? `memory/Assembly plastic molding: ${inj.cost}` : `${REF}/lookup/cmStandardToolingComponents: ${c.componentName}`,
          inj ? componentVariable(inj.cost) : staged('cmStandardToolingComponents', 'unit_cost_usd', f.tables.components, c.componentName)),
        inputStep(`${c.componentName} quantity`, null, c.qty, inj ? `memory/Assembly plastic molding: ${inj.quantity}` : `${REF}/lookup/cmStandardToolingComponents: ${c.componentName}`,
          inj ? componentVariable(inj.quantity) : staged('cmStandardToolingComponents', 'quantity', f.tables.components, c.componentName)),
      ];
    }),
    resultStep('Purchased Components Cost', 'USD', f.componentsSubtotalUsd, 'The sum of each component\'s unit cost x its quantity'),
  ]);
  const hoursOf = (name: string) => f.tables.assemblyTimes.find((a) => componentNameKey(a.name) === componentNameKey(name));
  const assembled = f.components.filter((c) => hoursOf(c.componentName));
  const assembly = calc('Assembly Hours: each component\'s hours x its quantity', [
    ...assembled.flatMap((c) => {
      const inj = injection(c.componentName);
      const hydraulic = INJECTION_ASSEMBLY_HOURS.find((a) => componentNameKey(a.name) === componentNameKey(c.componentName));
      const variable = inj?.hours ?? hydraulic?.hours;
      return [
        inputStep(`${c.componentName} assembly hours`, 'h', hoursOf(c.componentName)!.hours, variable ? `memory/Assembly plastic molding: ${variable}` : `${REF}/lookup/cmToolAssemblyTimes: ${c.componentName}`,
          variable ? componentVariable(variable) : staged('cmToolAssemblyTimes', 'assembly_time_hr', f.tables.assemblyTimes, c.componentName)),
        inputStep(`${c.componentName} quantity`, null, c.qty, 'The component\'s quantity in the mold (Purchased Components Cost)'),
      ];
    }),
    resultStep('Assembly Hours', 'h', f.assemblyHours, 'The sum of each component\'s assembly hours x its quantity (a component with no time on file adds none)'),
  ]);
  const setupRow = (name: string) => plasticLookup('cmToolMachiningSetups', 'setup_time_hr', { name });
  const plateSetup = calc('Plate Setup Hours: the cavity and core plate setups', [
    inputStep('Cavity plate setups', 'h', f.tables.cavityPlateSetupHr, `${REF}/lookup/cmToolMachiningSetups: Cavity Plate General Machining, number_of_setups x setup_time_hr`, setupRow('Cavity Plate General Machining')),
    inputStep('Core plate setups', 'h', f.tables.corePlateSetupHr, `${REF}/lookup/cmToolMachiningSetups: Core Plate General Machining, number_of_setups x setup_time_hr`, setupRow('Core Plate General Machining')),
    resultStep('Plate Setup Hours', 'h', f.tables.cavityPlateSetupHr + f.tables.corePlateSetupHr, '{Cavity plate setups} + {Core plate setups}'),
  ]);
  const pocketSetup = calc('Insert Pocket Setup Hours', [
    inputStep('Insert pocket setups', 'h', ri.pocketSetupHours, `${REF}/lookup/cmToolMachiningSetups: Insert Pocket, number_of_setups x setup_time_hr`, setupRow('Insert Pocket')),
    resultStep('Insert Pocket Setup Hours', 'h', ri.pocketSetupHours, 'number_of_setups x setup_time_hr of the Insert Pocket row'),
  ]);
  const cavities = f.cavitiesRef ?? undefined;
  const perCavity = f.cavityCount > 0 ? f.moldBaseAreaMm2 / f.cavityCount : 0;
  const window = calc('Mold Base Area: the required mold window', [
    inputStep('Projected area per cavity', 'mm2', perCavity, f.projectedAreaSource ?? 'CAD: the part\'s projected area along the pull'),
    inputStep('Cavities per Mold', null, f.cavityCount, 'The costed cavity count', cavities),
    resultStep('Mold Base Area', 'mm2', f.moldBaseAreaMm2, '{Projected area per cavity} * {Cavities per Mold}'),
  ]);
  const box = f.bboxMm ?? null;
  const height = calc('Part Height: the bounding box\'s smallest side', [
    ...(box
      ? (['Longest side', 'Middle side', 'Smallest side'] as const).map((label, i) => inputStep(label, 'mm', box[i]!, 'CAD: the part\'s bounding box'))
      : [inputStep('Smallest side', 'mm', f.partHeightMm ?? 0, 'CAD: the part\'s bounding box')]),
    resultStep('Part Height', 'mm', f.partHeightMm ?? 0, 'The smallest side, along the pull direction (the mold opens along it)'),
  ]);
  const tryout = calc('Tryout Press Multiplier: x2 above 500 t', [
    inputStep('Try-out hours rule', null, '<500T (x2 for bigger)', `${REF}/variables: timePerTryoutBase's note`, v('timePerTryoutBase')),
    inputStep('Press force', 't', f.pressClampTonnes ?? 0, 'The press the part runs on: its clamp force'),
    resultStep('Tryout Press Multiplier', null, (f.pressClampTonnes ?? 0) > TRYOUT_DOUBLE_ABOVE_TONNES ? 2 : 1, `2 when the press is over ${TRYOUT_DOUBLE_ABOVE_TONNES} t, else 1`),
  ]);
  const bundleRef = (label: string, ids: readonly string[] | undefined): SourceRef | undefined =>
    ids && ids.length > 0 ? { kind: 'features', label, features: ids.map((featureId) => ({ featureId })) } : undefined;
  const blockVolume = (kind: 'slide' | 'lifter') => {
    const volumes = kind === 'slide' ? x.slideVolumeIn3 : x.lifterVolumeIn3;
    const total = kind === 'slide' ? sa.slideVolumeIn3 : sa.lifterVolumeIn3;
    const ids = f.sideActionBundleIds?.[kind];
    const word = kind === 'slide' ? 'Slide' : 'Lifter';
    return calc(`${word} Block Volume: the ${kind} bundles by size class`, [
      ...SIZE_ORDER.flatMap((size) => [
        inputStep(`${cap(size)} ${kind} bundles`, null, f.sideActionBlocks?.[kind][size] ?? 0, f.sideActionBlocks ? `CAD: the recognised ${kind} bundles of the ${size} class` : 'CAD features not recognised: none', bundleRef(`${kind} bundles`, ids)),
        inputStep(`${cap(size)} ${kind} volume`, 'in3', volumes[size], `${REF}/variables: ${size}${word}Volume`, v(`${size}${word}Volume`)),
      ]),
      resultStep(`${word} Block Volume`, 'in3', total, `The sum of each class's bundles x its ${kind} volume`),
    ]);
  };
  const allBundles = [...(f.sideActionBundleIds?.slide ?? []), ...(f.sideActionBundleIds?.lifter ?? [])];
  const sideActions: SourceRef = bundleRef('slide and lifter bundles', allBundles) ?? calc('Side Actions: the sized slide and lifter bundles', [
    inputStep('Slide and lifter bundles with a size class', null, sa.count, f.sideActionBlocks ? 'CAD: the recognised slide and lifter bundles' : 'CAD features not recognised: no bundles to price'),
    resultStep('Side Actions', null, sa.count, 'One per sized bundle'),
  ]);
  const surface = calc('Side Action Block Surface: each block as a cube of its volume', [
    inputStep('Slide Block Volume', 'in3', sa.slideVolumeIn3, 'The slide blocks (Slide Block Volume)', blockVolume('slide')),
    inputStep('Lifter Block Volume', 'in3', sa.lifterVolumeIn3, 'The lifter blocks (Lifter Block Volume)', blockVolume('lifter')),
    inputStep('Blocks', null, sa.count, 'The sized slide and lifter bundles, one block each', sideActions),
    resultStep('Side Action Block Surface', 'in2', sa.surfaceIn2, 'The sum over the blocks of 6 x V^(2/3) (a cube of the block\'s volume)'),
  ]);
  // The rib inserts by class: the CAD ribs taller than the threshold, each classed by its footprint against the class insert areas.
  const ribClass = (label: string, unit: string, variable: (size: BlockSize) => string, value: (size: BlockSize) => number, total: number, formula: string, extra: CalculationTraceStep[] = []) =>
    calc(`${label}: the rib inserts by size class`, [
      ...SIZE_ORDER.flatMap((size) => [
        inputStep(`${cap(size)} inserts`, null, plan.counts[size], `CAD ribs taller than machinedRibThreshold ${ri.thresholdMm} mm whose footprint the ${size} class holds`),
        inputStep(`${cap(size)} ${label.toLowerCase()}`, unit, value(size), `${REF}/variables: ${variable(size)}`, v(variable(size))),
      ]),
      ...extra,
      resultStep(label, unit, total, formula),
    ]);
  const ribInserts = calc('Rib Inserts: the ribs too tall to machine, by size class', [
    inputStep('Ribs measured', null, f.ribs?.measured.length ?? 0, 'CAD: the ribs the analysis measured along the pull (plastic feature graph)'),
    inputStep('Machined rib threshold', 'mm', ri.thresholdMm, `${REF}/variables: machinedRibThreshold`, v('machinedRibThreshold')),
    ...SIZE_ORDER.map((size) => inputStep(`${cap(size)} insert area`, 'in2', ri.areaIn2[size], `${REF}/variables: ${size}InsertArea`, v(`${size}InsertArea`))),
    resultStep('Rib Inserts', null, rq.inserts, `The ribs taller than the threshold, each in the smallest class whose insert area holds its footprint: ${rq.breakdown}`),
  ]);
  const electrode = ribClass('Electrode Volume', 'in3', (s) => `${s}CalcRibInsertElectrodeSize`, (s) => ri.electrodeIn3[s], rq.electrodeIn3,
    'The sum of each class\'s inserts x its electrode size x its burns', SIZE_ORDER.map((size) => inputStep(`${cap(size)} burns`, null, ri.burns[size], `${REF}/variables: num${cap(size)}InsertsBurns`, v(`num${cap(size)}InsertsBurns`))));
  return {
    components, assembly, plateSetup, pocketSetup, window, height, tryout, sideActions, surface, ribInserts, electrode,
    slideVolume: blockVolume('slide'), lifterVolume: blockVolume('lifter'),
    ribArea: ribClass('Insert Area', 'in2', (s) => `${s}InsertArea`, (s) => ri.areaIn2[s], rq.areaIn2, 'The sum of each class\'s inserts x its insert area'),
    ribDesign: ribClass('Design Hours', 'h', (s) => `cmDesignHrsRibInsert${cap(s)}`, (s) => ri.designHours[s], rq.designHours, 'The sum of each class\'s inserts x its design hours'),
    burned: calc('Rib Insert Burned Volume: the share of the electrodes burnt', [
      inputStep('Rib Insert Electrode Volume', 'in3', rq.electrodeIn3, 'The electrodes of the rib inserts', electrode),
      inputStep('Electrode volume burnt', null, ri.electrodeBurnFraction, `${REF}/variables: edmElectrodeVolumeBurn`, v('edmElectrodeVolumeBurn')),
      resultStep('Rib Insert Burned Volume', 'in3', rq.burnedIn3, '{Rib Insert Electrode Volume} * {Electrode volume burnt}'),
    ]),
  };
}

/** Where the steel treatment flags were read: the steel grade's row of the reference package, or that it has none (not charged, a named gap). */
function treatmentRef(st: SteelTreatment | null, steelName: string, column: 'heat_treatment_required' | 'stress_relief_required', label: string): SourceRef {
  if (st) return referencePackageRef('mold-steel-treatment-reference.csv', column, { steel_grade: st.steelGrade });
  return calc(`${label}: no row for ${steelName}`, [
    inputStep('Tool steel', null, steelName, `${REF}/process/digital_factory_settings_usa defaultToolMaterialName`, plasticLookup('digital_factory_settings_usa', 'defaultToolMaterialName', { name: 'Default' })),
    resultStep(label, null, 0, 'reference/mold-steel-treatment-reference.csv has no row for the grade: not charged (a named gap)'),
  ]);
}

/** The hot drops: one per gate of every cavity on a hot runner; none on a cold one. */
function hotDropsRef(f: MoldToolingFacts): SourceRef {
  const runnerSource = f.runnerBasis === 'reference' ? `${REF}/variables: defaultRunnerSystem (no gate on the part)`
    : f.runnerBasis === 'lsr' ? 'An LSR mold: a self-degating cold deck' : 'The part\'s gate';
  const runner = inputStep('Runner', null, f.runner, runnerSource, f.runnerBasis === 'reference' ? plasticVariable('defaultRunnerSystem') : undefined);
  if (f.runner !== 'hot') return calc('Hot Drops: a cold runner has none', [runner, resultStep('Hot Drops', null, 0, 'A cold runner: no hot drops')]);
  return calc('Hot Drops: one per gate of every cavity', [
    runner,
    inputStep('Cavities per Mold', null, f.cavityCount, 'The costed cavity count', f.cavitiesRef ?? undefined),
    inputStep('Gates per cavity', null, f.gatesPerCavity, `${REF}/variables: defaultNumberOfGatesPerCavity`, plasticVariable('defaultNumberOfGatesPerCavity')),
    resultStep('Hot Drops', null, f.cavityCount * f.gatesPerCavity, '{Cavities per Mold} * {Gates per cavity}'),
  ]);
}

export type MoldToolingRun =
  | { derivable: true; outputs: Record<string, number>; perPartUsd: number; trace: CalculationTraceStep[]; calculator: { id: string | null; version: number | null; name: string; fingerprint: string } }
  | { derivable: false; missing: string[]; calculatorProblem?: string };

/** The calculator's inputs from the facts, or what is missing. Nothing is defaulted: a location without toolroom rates is a named gap. */
export function moldToolingSeeds(f: MoldToolingFacts): { seeds: Record<string, CalcSeed> } | { missing: string[] } {
  const missing: string[] = [];
  if (!f.toolroomRates) missing.push(`toolroom rates for ${f.location} (memory/ holds digital_factory_settings_usa only)`);
  if ('missing' in f.moldBase) missing.push(...f.moldBase.missing.map((m) => `mold base: ${m}`));
  if (!(f.partHeightMm != null && f.partHeightMm > 0)) missing.push('the part height (CAD bounding box)');
  if ('missing' in f.cavity) missing.push(...f.cavity.missing.map((m) => `cavity: ${m}`));
  if (!(f.pressClampTonnes != null && f.pressClampTonnes > 0)) missing.push('the press force (the try-out hours depend on it)');
  if (missing.length > 0 || !f.toolroomRates || 'missing' in f.moldBase || 'missing' in f.cavity) return { missing };
  const cav = f.cavity;
  const b = f.moldBase;
  const mb = f.moldBaseRef;
  const x = f.extras;
  const sa = sideActionBlocks(f.sideActionBlocks, x);
  const ri = x.ribInsert;
  const st = f.steelTreatment;
  const treatmentSource = (column: string, applies: boolean | undefined) => st
    ? `reference/mold-steel-treatment-reference.csv: ${st.steelGrade} (${st.deliveryCondition}) ${column} -> ${applies ? 'charged' : 'not charged'} (${st.confidence}${st.reviewRequired ? ', review required' : ''}; ${st.source})`
    : `reference/mold-steel-treatment-reference.csv: no row for ${mb.steel.name}, not charged (named gap)`;
  const plan = planRibInserts(f.ribs, ri);
  const rq = ribInsertQuantities(plan, ri);
  const r = toolingRefs(f, sa, rq, plan);
  const ribSource = `CAD ribs taller than machinedRibThreshold ${ri.thresholdMm} mm, classed by footprint (length x thickness) against {small,medium,large}InsertArea: ${rq.breakdown}`;
  const vars = `${REF}/variables`;
  const steel = `${REF}/process/digital_factory_tool_materials_usa: ${mb.steel.name} (digital_factory_settings_usa defaultToolMaterialName)`;
  const listed = f.components.map((c) => `${c.componentName} ${c.qty} x ${c.unitCostUsd}`).join(', ');
  const settings = `${REF}/process/digital_factory_settings_usa: Default`;
  // Where each value was read (plastic-input-sources.ts): the staged variable, or the lookup table's column and row. A value summed or multiplied over
  // several rows or variables (the component subtotal, the assembly hours, the plate setups, the block volumes, the rib insert quantities), a CAD
  // bounding-box size and the try-out and hot-drop rules open the calculation they are (toolingRefs); the scenario opens the part's costing inputs.
  const v = plasticVariable;
  const settingsRef = (column: string) => plasticLookup('digital_factory_settings_usa', column, { name: 'Default' });
  const steelRef = (column: string) => plasticLookup('digital_factory_tool_materials_usa', column, { name: mb.steel.name });
  const machiningRate = (rowName: string) => plasticLookup('cmToolMachiningRates', 'rate', { name: rowName });
  /** A component's staged row name (the tables spell components differently: componentNameKey), for its row. */
  const stagedName = (rows: ReadonlyArray<{ name: string }>, wanted: string) => rows.find((r) => componentNameKey(r.name) === componentNameKey(wanted))?.name;
  const rowNamed = (table: string, column: string, rows: ReadonlyArray<{ name: string }>, wanted: string) => {
    const name = stagedName(rows, wanted);
    return name ? plasticLookup(table, column, { name }) : undefined;
  };
  // A base name repeats in the table (two 11X12 sizes in inches): the row is the one with this name, unit and size, in the table's own unit.
  const baseUnitMm = mb.system === 'Imperial' ? 25.4 : 1;
  const baseRow = {
    'Mold Base Name': b.base.name, 'Reference Uom': mb.system === 'Imperial' ? 'inches' : 'mm',
    'Actual Width': b.base.widthMm / baseUnitMm, 'Actual Length': b.base.lengthMm / baseUnitMm,
  };
  const toolLifeRef = f.toolLifeMaterialType === undefined ? undefined
    : f.toolLifeMaterialType === null ? v('defaultToolLife') : plasticLookup('tblToolLife', 'Num Shots Per Tool', { 'Material Type': f.toolLifeMaterialType });
  const designRef = f.designHoursRowAreaMm2 != null ? plasticLookup('cmMoldBaseDesignHours', 'base_design_hrs_hr', { mold_base_area_mm2: f.designHoursRowAreaMm2 }) : undefined;
  return {
    seeds: {
      'Purchased Components Cost': {
        value: f.componentsSubtotalUsd, lookup: true,
        source: `memory/Assembly plastic molding variables (pins, bushings, side locks) and ${REF}/lookup/cmStandardToolingComponents for the rest: ${listed || 'none'}`,
        ref: r.components,
      },
      'Mold Base Area': { value: f.moldBaseAreaMm2, source: `CAD projected area x ${f.cavityCount} cavit${f.cavityCount === 1 ? 'y' : 'ies'} (the required mold window)`, ref: r.window },
      'Design Hours': withRef({ value: f.designHours, source: `${REF}/lookup/cmMoldBaseDesignHours: the first row covering ${Math.round(f.moldBaseAreaMm2)} mm²`, lookup: true }, designRef),
      'Plate Machining Rate': {
        value: f.tables.plateMachiningRateM2PerHr, source: `${REF}/lookup/cmToolMachiningRates: Cavity Core Plate General Machining`, lookup: true,
        ref: machiningRate('Cavity Core Plate General Machining'),
      },
      'Plate Setup Hours': {
        value: f.tables.cavityPlateSetupHr + f.tables.corePlateSetupHr, source: `${REF}/lookup/cmToolMachiningSetups: cavity ${f.tables.cavityPlateSetupHr} h + core ${f.tables.corePlateSetupHr} h`,
        lookup: true, ref: r.plateSetup,
      },
      'Assembly Hours': {
        value: f.assemblyHours, source: 'memory/Assembly plastic molding assemblyTimeHrs* and cmToolAssemblyTimes for the rest: hours per component x its quantity', lookup: true,
        ref: r.assembly,
      },
      'Design Rate': { value: f.toolroomRates.designUsdPerHr, source: `${settings} designRateUsdPerHr`, ref: settingsRef('designRateUsdPerHr') },
      'Machining Rate': { value: f.toolroomRates.machiningUsdPerHr, source: `${settings} machiningRateUsdPerHr`, ref: settingsRef('machiningRateUsdPerHr') },
      'Assembly Rate': { value: f.toolroomRates.assemblyUsdPerHr, source: `${settings} assemblyRateUsdPerHr`, ref: settingsRef('assemblyRateUsdPerHr') },
      'Annual Volume': { value: f.annualVolume, source: 'Scenario: annual volume', ref: { kind: 'costingInput', field: 'annualVolume' } },
      'Production Life': { value: f.productionLifeYears, source: 'Scenario: production life (years)', ref: { kind: 'costingInput', field: 'productionLifeYears' } },
      'Cavities per Mold': withRef({ value: f.cavityCount, source: 'The costed cavity count' }, f.cavitiesRef ?? undefined),
      'Tool Life Shots': withRef({ value: f.toolLifeShots, source: f.toolLifeSource, lookup: true }, toolLifeRef),
      'Mold Base Width': {
        value: b.base.widthMm, lookup: true, ref: plasticLookup('tblStandardMoldBaseSizes', 'Actual Width', baseRow),
        source: `${REF}/lookup/tblStandardMoldBaseSizes: ${b.base.name} (${mb.system}), the smallest holding ${Math.round(b.requiredWidthMm)} x ${Math.round(b.requiredLengthMm)} mm: `
          + `${b.layout.widthWise} x ${b.layout.lengthWise} cavities (layoutNumCav) with ${mb.betweenPartsMm} mm between parts, edge borders ${b.edgeBorderXMm} / ${b.edgeBorderYMm} mm (tblEdgeMoldBorderX/Y)`,
      },
      'Mold Base Length': { value: b.base.lengthMm, source: `${REF}/lookup/tblStandardMoldBaseSizes: ${b.base.name}`, lookup: true, ref: plasticLookup('tblStandardMoldBaseSizes', 'Actual Length', baseRow) },
      'Part Height': { value: f.partHeightMm!, source: 'CAD bounding box: the smallest side, along the pull direction', ref: r.height },
      'A Plate Cavity Ratio': { value: mb.aPlateCavityRatio, source: `${vars}: aPlateFlatCavityRatio`, ref: v('aPlateFlatCavityRatio') },
      'Cavity Plate Depth Border': {
        value: b.cavityDepthBorderMm, source: `${REF}/lookup/tblCavityPlateDepthBorder: by the press force (inches, in mm)`, lookup: true,
        ref: plasticLookup('tblCavityPlateDepthBorder', 'Cavity Plate Depth Border (in)', { 'Max Press Force (kN)': b.cavityDepthBorderRowKn }),
      },
      'Core Plate Depth Border': {
        value: b.coreDepthBorderMm, source: `${REF}/lookup/tblCorePlateDepthBorder: by the press force (inches, in mm)`, lookup: true,
        ref: plasticLookup('tblCorePlateDepthBorder', 'Core Plate Depth Border (in)', { 'Max Press Force (kN)': b.coreDepthBorderRowKn }),
      },
      'A Plate Min Thickness': { value: mb.aPlateMinMm, source: `${vars}: aPlateMinThickness`, ref: v('aPlateMinThickness') },
      'B Plate Min Thickness': { value: mb.bPlateMinMm, source: `${vars}: bPlateMinThickness`, ref: v('bPlateMinThickness') },
      'Top Clamp Plate Thickness': { value: mb.topClampMm, source: `${vars}: topClampPlateThickness`, ref: v('topClampPlateThickness') },
      'Support Plate Thickness': { value: mb.supportPlateMm, source: `${vars}: supportPlateThickness`, ref: v('supportPlateThickness') },
      'Bottom Clamp Plate Thickness': { value: mb.bottomClampMm, source: `${vars}: bottomClampPlateThickness`, ref: v('bottomClampPlateThickness') },
      'Tool Steel Density': { value: mb.steel.densityKgM3, source: `${steel}: densityKgPerM3`, lookup: true, ref: steelRef('densityKgPerM3') },
      'Tool Steel Price': { value: mb.steel.priceUsdPerKg, source: `${steel}: materialCostUsdPerKg`, lookup: true, ref: steelRef('materialCostUsdPerKg') },
      'Mold Base Cost Factor': { value: mb.steel.moldBaseCostFactor, source: `${steel}: moldBaseCostFactor`, lookup: true, ref: steelRef('moldBaseCostFactor') },
      'Part Surface Area': { value: f.partSurfaceAreaMm2!, source: 'CAD part surface area', ref: { kind: 'cad', evidence: 'part_surface' } },
      'Cavity Machining Hours Per Sq In': {
        value: cav.hoursPerSqIn, lookup: true,
        ref: plasticLookup(`tblHrsPerSqInch${cav.complexity}`, `Hrs Per Sq Inch ${cav.complexity} (hr)`, { [`Surface Area ${cav.complexity} (in^2)`]: cav.rowUpToSqIn }),
        source: `${REF}/lookup/tblHrsPerSqInch${cav.complexity}: the row up to ${cav.rowUpToSqIn} in² (${cav.complexity}: ${cav.faceCount} CAD faces against `
          + `cmMoldSurfaceCountThreshold ${mb.complexityFaceThresholds.simple} / ${mb.complexityFaceThresholds.average}, borrowed from compression molding)`,
      },
      'Polish Hours Per Sq Meter': {
        value: mb.finish.hoursPerSqM, source: `${REF}/lookup/SPIFinishes: ${mb.finish.name} (defaultCavityFinishIM)`, lookup: true,
        ref: plasticLookup('SPIFinishes', 'Hrs Per Sq Meter (hr / m^2)', { 'Finish Name': mb.finish.name }),
      },
      'Area Per Ejector Pin': { value: x.areaPerEjectorPinMm2, source: `${vars}: areaCoveredPerEjectorPin`, ref: v('areaCoveredPerEjectorPin') },
      'Ejector Pin Cost': withRef(
        { value: x.ejectorPinUsd, source: `${REF}/lookup/cmStandardToolingComponents: Ejector Pin (its quantity "is calculated in the cost model")`, lookup: true },
        rowNamed('cmStandardToolingComponents', 'unit_cost_usd', f.tables.components, 'Ejector Pin'),
      ),
      'Ejector Pin Assembly Hours': withRef(
        { value: x.ejectorPinAssemblyHours, source: `${REF}/lookup/cmToolAssemblyTimes: Ejector Pin`, lookup: true },
        rowNamed('cmToolAssemblyTimes', 'assembly_time_hr', f.tables.assemblyTimes, 'Ejector Pin'),
      ),
      'Sprue Bushing Cost': { value: x.sprueBushingUsd, source: `${vars}: sprueBushingCost (one per mold)`, ref: v('sprueBushingCost') },
      'Locating Ring Cost': { value: x.locatingRingUsd, source: `${vars}: locatingRingsCost (one per mold)`, ref: v('locatingRingsCost') },
      'Tryout Base Hours': { value: x.tryoutBaseHours, source: `${vars}: timePerTryoutBase`, ref: v('timePerTryoutBase') },
      'Tryout Press Multiplier': {
        value: f.pressClampTonnes! > TRYOUT_DOUBLE_ABOVE_TONNES ? 2 : 1,
        source: `${vars}: timePerTryoutBase note "<500T (x2 for bigger)": the press is ${Math.round(f.pressClampTonnes!)} t`,
        ref: r.tryout,
      },
      'Number of Tryouts': { value: x.tryouts, source: `${vars}: defaultNumTryOuts`, ref: v('defaultNumTryOuts') },
      'Tryout Rate': { value: f.toolroomRates.tryoutUsdPerHr, source: `${settings} tryoutRateUsdPerHr`, ref: settingsRef('tryoutRateUsdPerHr') },
      // The bundles the volume was counted from light their CAD faces; with none, the volume opens its calculation (no bundles, so 0).
      'Slide Block Volume': withRef({ value: sa.slideVolumeIn3, source: `CAD slide bundles: ${sa.slideSource}`, lookup: true, ...bundlesRef('slide bundles', f.sideActionBundleIds?.slide) }, f.sideActionBundleIds?.slide?.length ? undefined : r.slideVolume),
      'Lifter Block Volume': withRef(
        { value: sa.lifterVolumeIn3, source: `CAD lifter bundles (a bundle a slide could also serve is costed as a lifter): ${sa.lifterSource}`, lookup: true, ...bundlesRef('lifter bundles', f.sideActionBundleIds?.lifter) },
        f.sideActionBundleIds?.lifter?.length ? undefined : r.lifterVolume,
      ),
      'Side Action Block Surface': { value: sa.surfaceIn2, source: `each of the ${sa.count} block${sa.count === 1 ? '' : 's'} as a cube of its volume, 6 x V^(2/3) in², summed`, ref: r.surface },
      'Side Actions': { value: sa.count, source: f.sideActionBlocks ? 'CAD: the recognised slide and lifter bundles with a size class' : 'CAD features not recognised: no bundles to price', ref: r.sideActions },
      'CMM Hours Per Side Action': { value: x.cmmHoursPerSideAction, source: `${vars}: cmmInspectionMultiplier`, ref: v('cmmInspectionMultiplier') },
      'CMM Base Hours': { value: x.cmmBaseHours, source: `${vars}: cmmInspectionAdder`, ref: v('cmmInspectionAdder') },
      'Heat Treat Rate': {
        value: f.toolroomRates.heatTreatUsdPerKg, source: `${settings} heatTreatRateUsdPerKg (the cavity and core plates and the slide and lifter blocks)`,
        ref: settingsRef('heatTreatRateUsdPerKg'),
      },
      'Stress Relief Rate': { value: f.toolroomRates.stressReliefUsdPerKg, source: `${settings} stressReliefRateUsdPerKg (the clamp and support plates)`, ref: settingsRef('stressReliefRateUsdPerKg') },
      'Water Line Diameter': { value: x.waterLineDiameterMm, source: `${vars}: defaultWaterLineDiameter`, ref: v('defaultWaterLineDiameter') },
      'Water Line Pitch Factor': {
        value: WATER_LINE_PITCH_FACTOR, source: 'Approved rule: lines 3 line diameters apart across the cavity plate (no pitch is on file)',
        ref: calc('Water Line Pitch Factor: the approved cooling rule', [
          inputStep('Water Line Diameter', 'mm', x.waterLineDiameterMm, `${vars}: defaultWaterLineDiameter`, v('defaultWaterLineDiameter')),
          resultStep('Water Line Pitch Factor', null, WATER_LINE_PITCH_FACTOR, 'The approved rule (formula registry F-30): water lines 3 line diameters apart across the cavity plate; no pitch is on file'),
        ]),
      },
      'Line Drilling Rate': {
        value: x.lineDrillingMmPerMin, source: `${REF}/lookup/cmToolMachiningRates: Heater Line Drilling (the only line drilling rate on file)`, lookup: true,
        ref: machiningRate('Heater Line Drilling'),
      },
      'Water Hose Cost': { value: x.waterHoseUsd, source: `${vars}: waterHosesCost (2 per line)`, ref: v('waterHosesCost') },
      'Water Fitting Cost': { value: x.waterFittingUsd, source: `${vars}: waterManifoldFittingsCost (2 per line)`, ref: v('waterManifoldFittingsCost') },
      'Water Manifold Cost': { value: x.waterManifoldUsd, source: `${vars}: waterManifoldsCost (one per side)`, ref: v('waterManifoldsCost') },
      'Baffle Spacing': { value: x.baffle.spacingMm, source: `${COMPONENTS}: baffleSpacing (between baffle holes in the cavity and core plates)`, ref: componentVariable('baffleSpacing') },
      'Water Baffle Cost': { value: x.baffle.usd, source: `${COMPONENTS}: waterBafflesCost`, ref: componentVariable('waterBafflesCost') },
      'Baffle Assembly Hours': { value: x.baffle.assemblyHours, source: `${COMPONENTS}: assemblyTimeHrsWaterBaffles`, ref: componentVariable('assemblyTimeHrsWaterBaffles') },
      'Baffle Tapping Hours': { value: x.baffle.tappingHours, source: `${COMPONENTS}: baffleTappingTimeHrs`, ref: componentVariable('baffleTappingTimeHrs') },
      'Baffle Tap Setup Hours': { value: x.baffle.tapSetupHours, source: `${COMPONENTS}: baffleTapSetup (per tool)`, ref: componentVariable('baffleTapSetup') },
      'Rib Inserts': { value: rq.inserts, source: ribSource, lookup: true, ref: r.ribInserts },
      'Rib Insert Area': { value: rq.areaIn2, source: `${rq.breakdown} x {small,medium,large}InsertArea ${ri.areaIn2.small} / ${ri.areaIn2.medium} / ${ri.areaIn2.large} in²`, lookup: true, ref: r.ribArea },
      'Rib Insert Electrode Volume': {
        value: rq.electrodeIn3, lookup: true, ref: r.electrode,
        source: `${rq.breakdown} x {small,medium,large}CalcRibInsertElectrodeSize ${ri.electrodeIn3.small} / ${ri.electrodeIn3.medium} / ${ri.electrodeIn3.large} in³ x num*InsertsBurns (one electrode per burn)`,
      },
      'Rib Insert Burned Volume': { value: rq.burnedIn3, source: `the electrode volume x edmElectrodeVolumeBurn ${ri.electrodeBurnFraction}`, ref: r.burned },
      'Rib Insert Design Hours': { value: rq.designHours, source: `${rq.breakdown} x cmDesignHrsRibInsert{Small,Medium,Large} ${ri.designHours.small} / ${ri.designHours.medium} / ${ri.designHours.large} h`, lookup: true, ref: r.ribDesign },
      'Cutter Path Hours Per Insert': { value: ri.cutterPathHours, source: `${vars}: cutterPathHrsPerInsert`, ref: v('cutterPathHrsPerInsert') },
      'Spotting Hours Per Insert': { value: ri.spottingHours, source: `${vars}: spottingHrsPerInsert`, ref: v('spottingHrsPerInsert') },
      'Rib Insert Assembly Hours': withRef(
        { value: ri.assemblyHours, source: `${REF}/lookup/cmToolAssemblyTimes: Rib Insert`, lookup: true },
        rowNamed('cmToolAssemblyTimes', 'assembly_time_hr', f.tables.assemblyTimes, 'Rib Insert'),
      ),
      'Electrode Material Cost': {
        value: ri.electrodeUsdPerIn3, source: `${settings} edmMaterialCostCarbonUsdPerIn3 (graphite, the approved electrode material)`,
        ref: settingsRef('edmMaterialCostCarbonUsdPerIn3'),
      },
      'EDM Burn Rate': { value: ri.burnRateMm3PerMin, source: `${REF}/lookup/cmToolMachiningRates: EDM Electrode Burn`, lookup: true, ref: machiningRate('EDM Electrode Burn') },
      'EDM Rate': { value: f.toolroomRates.edmUsdPerHr, source: `${settings} edmRateUsdPerHr`, ref: settingsRef('edmRateUsdPerHr') },
      'Insert Pocket Rate': { value: ri.pocketRateMm3PerMin, source: `${REF}/lookup/cmToolMachiningRates: Insert Pocket Machining`, lookup: true, ref: machiningRate('Insert Pocket Machining') },
      'Insert Pocket Setup Hours': { value: ri.pocketSetupHours, source: `${REF}/lookup/cmToolMachiningSetups: Insert Pocket (setups x hours)`, lookup: true, ref: r.pocketSetup },
      'Hardening Applies': {
        value: st?.hardening ? 1 : 0, source: treatmentSource('heat_treatment_required', st?.hardening), lookup: true,
        ref: treatmentRef(st, mb.steel.name, 'heat_treatment_required', 'Hardening Applies'),
      },
      'Stress Relief Applies': {
        value: st?.stressRelief ? 1 : 0, source: treatmentSource('stress_relief_required', st?.stressRelief), lookup: true,
        ref: treatmentRef(st, mb.steel.name, 'stress_relief_required', 'Stress Relief Applies'),
      },
      'Hot Drops': {
        value: f.runner === 'hot' ? f.cavityCount * f.gatesPerCavity : 0,
        source: f.runner === 'hot' ? `hot runner: ${f.cavityCount} cavit${f.cavityCount === 1 ? 'y' : 'ies'} x ${f.gatesPerCavity} gate(s) per cavity (defaultNumberOfGatesPerCavity), one drop per gate` : 'cold runner: no hot drops',
        ref: hotDropsRef(f),
      },
      'Hot Drop Unit Cost': {
        value: x.hotDrop.usd, source: `${vars}: ${x.hotDrop.type === 'SVG' ? 'costPerSVGHotDrop' : 'costPerStandardHotDrop'} (defaultHotDropType ${x.hotDrop.type})`,
        ref: v(x.hotDrop.type === 'SVG' ? 'costPerSVGHotDrop' : 'costPerStandardHotDrop'),
      },
    },
  };
}

/** The mold tooling cost by the stored calculator, or what is missing (an input, or the calculator itself). */
export function runMoldTooling(f: MoldToolingFacts, calculators: ReferenceCalculators | null | undefined): MoldToolingRun {
  const seeded = moldToolingSeeds(f);
  if ('missing' in seeded) return { derivable: false, missing: seeded.missing };
  const found = requirePlasticCalculator(calculators, MOLD_TOOLING_CALCULATOR);
  if ('problem' in found) return { derivable: false, missing: [found.problem], calculatorProblem: found.problem };
  const run = runReferenceCalculator(calculators, MOLD_TOOLING_CALCULATOR, seeded.seeds, OUTPUT);
  if (run.missing.length > 0 || run.value == null) return { derivable: false, missing: run.missing.length > 0 ? run.missing : [`${MOLD_TOOLING_CALCULATOR} produced no ${OUTPUT.toLowerCase()}`] };
  return {
    derivable: true, outputs: run.outputs, perPartUsd: run.value, trace: withRegistryFormulas(run.trace, MOLD_TOOLING_CALCULATOR),
    calculator: { id: run.calculatorId, version: run.calculatorVersion, name: MOLD_TOOLING_CALCULATOR, fingerprint: calculatorFingerprint(found.def) },
  };
}
