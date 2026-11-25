// Every calculator input on a plastic-molding line says where its value came from (SourceRef), so the calculator dialog's eye beside it opens
// that source: the staged variable or lookup row, the press's or loader's HR Rates record, the resin's Raw Materials record, the reference
// package row (plastic-molding/reference/*.csv), the location's electricity price, the CAD faces, the part's costing inputs, or the
// calculation it was worked out by. This guard runs every plastic-molding engine and route on rich fixtures (injection with every secondary
// operation and slides, structural foam, LSR, compression, reaction injection, the three insert-molding load methods, a two-shot part with
// components) and lists every input with no ref, and every ref that opens nothing.
import { readdirSync } from 'fs';
import { join } from 'path';

import { sandMachineFromRow, type SandMachine } from '../../../../../modules/bom-items/costing/casting/sand/sand-machines';
import { resolveSandReference } from '../../../../../modules/bom-items/costing/casting/sand/sand-reference';
import { plasticMoldingCalculatorsByName } from '../../../../../modules/bom-items/costing/plastic-molding/calculators/plastic-molding-calculator-spec';
import {
  assemblyMoldingCalculatorsByName, loadAssemblyMoldingCalculatorSpec,
} from '../../../../../modules/bom-items/costing/plastic-molding/insert/calculators/assembly-molding-calculator-spec';
import { priceInsertRoutes, type MoldInsert } from '../../../../../modules/bom-items/costing/plastic-molding/insert/insert-molding';
import {
  assemblyPlasticMoldingCalculatorsByName, loadAssemblyPlasticMoldingCalculatorSpec,
} from '../../../../../modules/bom-items/costing/plastic-molding/multi-shot/calculators/assembly-plastic-molding-calculator-spec';
import {
  MULTI_SHOT_DESIGN_HOURS_FACTOR, MULTI_SHOT_PRESS_CLASS, multiShotCycleRun, multiShotPressOf, priceMultiShotRoutes, type MultiShotPress, type MultiShotShot,
} from '../../../../../modules/bom-items/costing/plastic-molding/multi-shot/multi-shot';
import { computeCompressionMoldingCost } from '../../../../../modules/bom-items/costing/plastic-molding/process/cost-compression-molding-engine';
import { computeInjectionMoldedCostSummary, costMoldOnPresses, type InjectionMoldingCostInput } from '../../../../../modules/bom-items/costing/plastic-molding/process/cost-injection-molding-engine';
import { computeReactionInjectionMoldingCost } from '../../../../../modules/bom-items/costing/plastic-molding/process/cost-reaction-injection-molding-engine';
import { electricityUsd } from '../../../../../modules/bom-items/costing/shared/location-electricity';
import type { CostSummaryDto, ProcessLineCost, SourceRef } from '../../../../../modules/bom-items/dto/cost-breakdown.dto';
import { inputsWithoutRef, refsOpeningNothing } from '../source-ref-guard';
import { realMaterialClamp, realPlasticReference, realPress, realResinInputs } from './real-plastic-reference';

interface Csv { columns: string[]; rows: Record<string, string | undefined>[] }
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { readCsv } = require('../../../../../../migrations/scripts/lib/memory-machine-seed.js') as { readCsv: (path: string) => Csv };

const MEMORY = join(__dirname, '../../../../../../../memory');
const clean = (h: string) => h.replace(/^﻿/, '');
const csvRows = (path: string) => readCsv(path).rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [clean(k), v])));
const n = (v: unknown) => Number(v);
const staged = (dir: string, variablesFile: string) => resolveSandReference({
  variables: csvRows(join(dir, variablesFile)).map((r) => ({ key: String(r['Variable Name']), value: r['String Value'] == null ? null : String(r['String Value']), unit_type: null })),
  lookups: readdirSync(join(dir, 'Lookup')).filter((f) => f.endsWith('.csv')).map((f) => ({
    key: f.replace(/\.csv$/, ''),
    raw: { rows: csvRows(join(dir, 'Lookup', f)).map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : v]))) },
  })),
});

const CALCULATORS = plasticMoldingCalculatorsByName();
const PRESS_NAME = 'Arburg Allrounder 420 C 1300 - 350';
const PRESS = realPress(PRESS_NAME);
const PRESS_RECORD = { id: 'mhr-press-1', name: PRESS_NAME, machineClass: 'injection_molding', location: 'USA' };
const ABS = { id: 'rm-abs', name: 'ABS' };
const USA_POWER = electricityUsd({ pricePerKwh: 0.0851, currency: 'USD', basis: 'U.S. EIA Electric Power Monthly, Table 5.3', location: 'USA' }, 'USA', () => null);
const rate = (machineClass: string, usd: number, name: string | null) => ({ rate: usd, labourRate: 34.48, operators: 1, source: 'mhr_database' as const, machineClass, machineName: name, commodityCode: null });

// An ABS part with a parting line, two slides, inserts and both secondary checks: every secondary operation the injection route has.
const part = (over: Partial<InjectionMoldingCostInput> = {}): InjectionMoldingCostInput => ({
  volume: 50_000, surfaceArea: 40_000, wallThicknessNominalMm: 2, materialGrade: 'ABS', materialCostPerKg: 3.046, materialDensityKgM3: 1040, materialSource: 'db',
  batchSize: 250, family: 'plastic_molded', mhrRate: { ...rate('injection_molding', PRESS.mhrUsd, PRESS_NAME), setupTimeHr: 2 },
  deburrRate: rate('deburring', 12, 'Bench'), inspectionRate: rate('cmm', 0, null), machineClampTonnes: PRESS.maxTonnage, machineShotCapacityG: PRESS.shotCapacityGrams,
  pressTiming: { ...PRESS.timing, record: PRESS_RECORD }, goodPartYield: PRESS.goodPartYield, calculators: CALCULATORS,
  materialClamp: realMaterialClamp('ABS'), realResinInputs: realResinInputs('ABS'), materialRecord: ABS, materialType: 'ABS', electricity: USA_POWER,
  plasticReference: realPlasticReference(), location: 'USA', annualVolume: 100_000, productionLifeYears: 3, cadFaceCount: 120,
  bboxMaxMm: 120, bboxMidMm: 80, bboxMinMm: 30, secondaryChecks: { insertPullTest: true, weightCheck: true },
  signals: {
    projectedAreaMm2: 9_600, undercutCount: 2, partingComplexity: 0.6, partingLineLengthMm: 400, partingLineFeatureId: 'parting-line', insertCount: 2,
    slideBundleCount: 2, slideOrLifterBundleCount: 2, maxSlideStrokeMm: 25, maxSlideStrokeBundleId: 'slide-bundle-1',
  },
  ...over,
});

/** A quote's lines and its mold tooling run (shown with the same eyes on the Invest tab), as one more line. */
const withTooling = (s: CostSummaryDto): ProcessLineCost[] => [
  ...s.processLines,
  ...(s.tooling?.calculationTrace?.length ? [{ process: 'Mold Tooling', calculationTrace: s.tooling.calculationTrace } as ProcessLineCost] : []),
];
const im = (over: Partial<InjectionMoldingCostInput> = {}) => withTooling(computeInjectionMoldedCostSummary(part(over)));

// Insert molding: the real memory/Assembly molding reference and loaders, on the insert press (a rotary table).
const INSERT_DIR = join(MEMORY, 'Assembly molding');
const insertRef = staged(INSERT_DIR, 'variables_extract.csv');
const insertLoaders: SandMachine[] = csvRows(join(INSERT_DIR, 'Machines/machines_insert_pick_and_place.csv')).map((r, i) => sandMachineFromRow({
  id: `loader-${i}`, machine_name: r['Primary ID Name'], machine_class: 'assembly_molding_insert_pick_and_place', location: 'USA',
  mhr_usd_per_hour: n(r['Direct Overhead Rate (USD / hr)']) + n(r['Indirect Overhead Rate (USD / hr)']),
  usd_labor_rate_per_hr: r['Labor Rate (USD / hr)'], operators: r['Number of Operators'], setup_time_hr: r['Setup Time (hr)'],
  specs: { max_payload: n(r['Max Payload']), loading: r.Loading },
}, () => null));
const ZERO = { qairPerHr: 0, inspTimeMin: 0, samplingRate: 0, yieldPct: 1, netMatCost: 0, netWeightKg: 0, scrapPricePerKg: 0 };
const appendLines = (dto: CostSummaryDto, lines: ProcessLineCost[]): CostSummaryDto => ({
  ...dto, processLines: [...dto.processLines, ...lines],
  totalProcessCost: dto.totalProcessCost + lines.reduce((t, l) => t + l.totalCost, 0), totalCost: dto.totalCost + lines.reduce((t, l) => t + l.totalCost, 0),
});
const INSERT_PRESS = { id: 'mhr-insert-press', name: 'Engel IN 350-60 V - 18.0 RT', machineClass: 'assembly_molding_insert_injection_molding', location: 'USA' };
const inserts: MoldInsert[] = [{ id: 'c1', name: 'M4 brass insert', perPart: 2, massKg: 0.003, source: 'bom' }];
const insertInput = part({
  mhrRate: { ...rate('assembly_molding_insert_injection_molding', PRESS.mhrUsd, INSERT_PRESS.name), setupTimeHr: 2 }, pressTiming: { ...PRESS.timing, record: INSERT_PRESS },
});
const insertRoutes = priceInsertRoutes({
  ref: insertRef, spec: loadAssemblyMoldingCalculatorSpec(), calculators: assemblyMoldingCalculatorsByName(), inserts, loaders: insertLoaders,
  batchSize: 250, costContext: ZERO, press: { name: INSERT_PRESS.name, tablePress: true, record: INSERT_PRESS, tableConfiguration: 'Rotary' },
  toLocal: (l) => l, appendLines,
  runEngine: (shot) => costMoldOnPresses({ ...insertInput, shotCycle: shot, signals: { ...insertInput.signals, insertCount: 2 } }, [{
    mhrRate: insertInput.mhrRate, machineClampTonnes: insertInput.machineClampTonnes ?? null, machineShotCapacityG: insertInput.machineShotCapacityG ?? null,
    pressTiming: insertInput.pressTiming ?? null, goodPartYield: insertInput.goodPartYield ?? null, tieBarXMm: null, tieBarYMm: null,
  }]).result,
});

// Multi-shot: a PC substrate overmolded with TPE on the real memory/Assembly plastic molding presses, with a component loaded every shot.
const MS_DIR = join(MEMORY, 'Assembly plastic molding');
const msRef = staged(MS_DIR, 'plastic_molding_variables.csv');
const india = new Map(csvRows(join(MEMORY, 'Countries data/India_XML_Data_.csv')).filter((r) => r['Commodity'] === 'Assembly Plastic Molding' && r['Machine Type'] === 'Multi-Shot Molding').map((r) => [String(r['name']), r]));
const msPresses: MultiShotPress[] = csvRows(join(MS_DIR, 'Machines/injection_molders.csv')).flatMap((r, i) => {
  const name = String(r['Name']).replace('2900kN | 2K | 1060g', '2900kN | 2K | 1860g');
  const a = india.get(name);
  if (!a) return [];
  const machine: SandMachine = sandMachineFromRow({
    id: `press-${i}`, machine_name: name, machine_class: MULTI_SHOT_PRESS_CLASS, location: 'USA',
    mhr_usd_per_hour: n(r['Direct Overhead Rate (USD / hr)']) + n(r['Indirect Overhead Rate (USD / hr)']),
    usd_labor_rate_per_hr: r['Labor Rate (USD / hr)'], operators: r['Number of Operators'], setup_time_hr: r['Setup Time (hr)'],
    specs: {
      injection_units: n(a['numInjectionBarrels']), stations: n(a['numMoldStations']), rotating_stack: String(a['rotatingStackPlaten']).toUpperCase() === 'TRUE',
      orientation: a['orientation'], tool_index_time_s: n(a['toolIndexTime']),
    },
  }, () => null);
  const p = multiShotPressOf(machine, { maxTonnage: n(a['clampForce']) / 9.80665, shotCapacityG: n(a['maxShotSize']) },
    { injectionRateMm3PerS: n(a['maxInjectionRate']), dryCycleTimeS: n(a['dryCycleTime']), goodPartYield: 1, record: { id: machine.id, name, machineClass: MULTI_SHOT_PRESS_CLASS, location: 'USA' } });
  return p ? [p] : [];
});
const msLoaders: SandMachine[] = csvRows(join(MS_DIR, 'Machines/machines_pick_and_place.csv')).map((r, i) => sandMachineFromRow({
  id: `ms-loader-${i}`, machine_name: r['Name'], machine_class: 'assembly_plastic_molding_pick_and_place', location: 'USA',
  mhr_usd_per_hour: n(r['Direct Overhead Rate (USD / hr)']) + n(r['Indirect Overhead Rate (USD / hr)']),
  usd_labor_rate_per_hr: r['Labor Rate (USD / hr)'], operators: r['Number of Operators'], setup_time_hr: r['Setup Time (hr)'],
  specs: { max_payload: n(r['Max Payload (kg)']), loading: r['Loading Type'] },
}, () => null));
const shotInput = (material: string, id: string, over: Partial<InjectionMoldingCostInput> = {}): InjectionMoldingCostInput => ({
  ...part(), volume: 20_000, surfaceArea: 15_000, materialGrade: material, materialCostPerKg: 4, materialDensityKgM3: 1100, batchSize: 1000,
  materialClamp: realMaterialClamp(material), realResinInputs: realResinInputs(material), materialType: material, materialRecord: { id, name: material },
  secondaryChecks: null, bboxMaxMm: 80, bboxMidMm: 60, bboxMinMm: 20, cadFaceCount: 300, annualVolume: 10_000,
  signals: { projectedAreaMm2: 3000, undercutCount: 0 }, ...over,
});
const shots: MultiShotShot[] = [
  { name: 'Substrate', source: 'bom', itemId: 's1', grade: 'Polycarbonate', volumePct: null, input: shotInput('Polycarbonate', 'rm-pc') },
  { name: 'Overmold', source: 'bom', itemId: 's2', grade: 'TPE', volumePct: null, input: shotInput('TPE', 'rm-tpe', { volume: 8_000, surfaceArea: 9_000, signals: { projectedAreaMm2: 2500, undercutCount: 0 } }) },
];
const msCalculators = assemblyPlasticMoldingCalculatorsByName();
const multiShotRoutes = priceMultiShotRoutes({
  shots, needs: shots.map((s) => {
    const r = computeInjectionMoldedCostSummary(s.input).injectionMolding;
    return { clampT: r?.clampRequiredT ?? null, shotGppsG: r?.shotRequiredG ?? null, reason: null };
  }),
  presses: msPresses, components: [{ id: 'c1', name: 'Steel pin', perPart: 1, massKg: 0.01, source: 'bom' }], batchSize: 1000,
  loading: { ref: msRef, spec: loadAssemblyPlasticMoldingCalculatorSpec(), calculators: msCalculators, loaders: msLoaders, costContext: ZERO },
  mold: { surfaceAreaMm2: 24_000, designHoursFactor: MULTI_SHOT_DESIGN_HOURS_FACTOR, tryouts: 5 },
  onPress: (s, p) => ({
    ...s.input,
    mhrRate: { rate: p.machine.machineRatePerHr ?? 0, labourRate: p.machine.labourRatePerHr, operators: p.machine.operators ?? 1, source: 'mhr_database', machineClass: MULTI_SHOT_PRESS_CLASS, machineName: p.machine.name, commodityCode: null },
    machineClampTonnes: p.clampT, machineShotCapacityG: p.shotPerUnitG, pressTiming: p.timing, goodPartYield: 1,
  }),
  runEngine: (i) => computeInjectionMoldedCostSummary(i),
  cycle: multiShotCycleRun(msCalculators),
  toLocal: (l) => l, appendLines,
});

const COMPRESSION_PRESS = { id: 'mhr-cm-1', name: 'Compression press', machineClass: 'compression_molding', location: 'USA' };
const RIM_PRESS = { id: 'mhr-rim-1', name: 'RIM press', machineClass: 'reaction_injection_molding', location: 'USA' };

const routes: Array<[string, ProcessLineCost[]]> = [
  ['injection, every secondary operation and slides', im()],
  ['injection, a hot-tip gate and the reference cavity default (no mold pricing)', im({ annualVolume: undefined, productionLifeYears: undefined, signals: { ...part().signals, gateType: 'hot_tip' } })],
  ['injection, cavities set in the Cost Guide', im({ cavityCountOverride: 2 })],
  ['structural foam', im({ mhrRate: { ...rate('structural_foam_molding', PRESS.mhrUsd, 'Foam press'), setupTimeHr: 2 } })],
  ['liquid silicone (LSR)', im({ materialGrade: 'Silicone, LSR', materialType: 'Silicone' })],
  ['compression, cure time on file', computeCompressionMoldingCost({
    batchSize: 250, partWeightKg: 0.2, rate: { ...rate('compression_molding', 40, 'Compression press'), pressCycleTimeS: 26.2, setupTimeHr: 1 },
    cureTimeMinFromMaterial: 3, machineRecord: COMPRESSION_PRESS, materialRecord: { id: 'rm-smc', name: 'SMC' }, calculators: CALCULATORS,
  }).processLines],
  ['compression, no cure time on file', computeCompressionMoldingCost({
    batchSize: 250, partWeightKg: 0.2, rate: { ...rate('compression_molding', 40, 'Compression press'), pressCycleTimeS: 26.2, setupTimeHr: 1 },
    cureTimeMinFromMaterial: null, machineRecord: COMPRESSION_PRESS, materialRecord: { id: 'rm-smc', name: 'SMC' }, calculators: CALCULATORS,
  }).processLines],
  ['reaction injection', computeReactionInjectionMoldingCost({
    batchSize: 100, rate: { ...rate('reaction_injection_molding', 60, 'RIM press'), pressCycleTimeS: 10 }, cureTimeMinFromMaterial: null,
    partVolumeMm3: 500_000, injectionRateMm3PerS: 100_000, machineRecord: RIM_PRESS, materialRecord: { id: 'rm-pu', name: 'PU' }, calculators: CALCULATORS,
  }).processLines],
  ['injection, a hot runner, sized slides and lifters, tall ribs and an engineer\'s values', im({
    signals: {
      ...part().signals, gateType: 'hot_tip',
      sideActionBlocks: { slide: { small: 1, medium: 1, large: 0 }, lifter: { small: 1, medium: 0, large: 0 }, unsized: 0 },
      sideActionBundleIds: { slide: ['slide-bundle-1', 'slide-bundle-2'], lifter: ['lifter-bundle-1'] },
      ribs: { measured: [{ heightMm: 30, lengthMm: 20, thicknessMm: 2 }, { heightMm: 40, lengthMm: 60, thicknessMm: 3 }], unmeasured: 0 },
    },
    calculatorOverrides: {
      'Injection Molding - Cycle Time': { 'Cycle Time Adjustment Factor': { value: 1.1, reason: 'plant trial' } },
      'Injection Mold - Tooling': { 'Number of Tryouts': { value: 3, reason: 'two-stage try-out' }, 'Water Line Pitch Factor': { value: 4, reason: 'tight cavity' } },
    },
  })],
  ...insertRoutes.map((r): [string, ProcessLineCost[]] => [`insert molding, ${r.label}`, withTooling(r.summary)]),
  ...multiShotRoutes.map((r): [string, ProcessLineCost[]] => [`multi-shot, ${r.label}`, withTooling(r.summary)]),
];

describe('every plastic-molding calculator input says where its value came from', () => {
  it.each(routes)('%s', (_name, lines) => {
    expect(lines.some((l) => (l.calculationTrace ?? []).length > 0)).toBe(true);
    expect(inputsWithoutRef(lines)).toEqual([]);
    expect(refsOpeningNothing(lines)).toEqual([]);
  });

  it('covers every plastic calculator the engines run, and the steps run inside the molding line', () => {
    const lines = routes.flatMap(([, ls]) => ls);
    expect(new Set(lines.map((l) => l.calculatorName).filter(Boolean))).toEqual(new Set([
      'Injection Molding - Cycle Time', 'Structural Foam Molding - Cycle Time', 'Injection Molding - LSR Cycle Time', 'Compression Molding - Cycle Time',
      'Reaction Injection Molding - Cycle Time', 'Injection Molding - Deflashing', 'Injection Molding - Gate Trimming', 'Injection Molding - Visual Inspection',
      'Injection Molding - Weight Check', 'Injection Molding - Insert Pull Test',
    ]));
    // The loaders' lines (run by the assembly-molding calculators) and the steps grouped into the molding line.
    const processes = new Set(lines.map((l) => l.process));
    for (const p of ['Insert Pick and Place', 'Pick and Place', 'Insert Injection Molding', 'Multi-Shot Molding', 'Mold Tooling']) expect(processes.has(p)).toBe(true);
    // Every route that prices a mold carries its tooling run.
    for (const [name, ls] of routes) {
      if (/insert molding|multi-shot|every secondary|Cost Guide|hot runner/.test(name)) expect({ name, tooling: ls.some((l) => l.process === 'Mold Tooling') }).toEqual({ name, tooling: true });
    }
    const groups = new Set(lines.flatMap((l) => (l.calculationTrace ?? []).map((t) => (t as { group?: string }).group).filter(Boolean)));
    for (const g of ['Material Drying', 'Slide Movement']) expect(groups.has(g)).toBe(true);
    expect(lines.some((l) => (l.calculationTrace ?? []).some((t) => t.fieldName === 'Table Press'))).toBe(true);
    expect(lines.some((l) => (l.calculationTrace ?? []).some((t) => t.fieldName === 'Tool Index Time'))).toBe(true);
  });
});

describe('what the plastic eyes open', () => {
  const lines = im();
  const step = (process: string, field: string) => {
    const s = lines.find((l) => l.process === process)!.calculationTrace!.find((t) => t.kind === 'input' && t.fieldName === field);
    if (!s) throw new Error(`no input ${field} on ${process}`);
    return s;
  };

  it('a reference package value opens its file, the row it was read from outlined', () => {
    expect(step('Gate Trimming', 'Gate Width Constant').ref).toEqual({ kind: 'lookup', domain: 'plastic_reference_package', table: 'gate-sizing-reference.csv', column: 'n', row: { material_family: 'Other' } });
    expect(step('Injection Molding', 'Material Drying · Drying Temperature').ref).toEqual({
      kind: 'lookup', domain: 'plastic_reference_package', table: 'material-drying-reference.csv', column: 'drying_temp_c_max', row: { material: 'ABS', material_grade: expect.any(String) },
    });
    expect(step('Injection Molding', 'Material Drying · Dryer Power').ref).toMatchObject({ table: 'dryer-models-reference.csv', column: 'rated_kw', row: { model: expect.any(String) } });
    expect(step('Injection Molding', 'Material Drying · Equipment Life').ref).toEqual({ kind: 'lookup', domain: 'plastic_reference_package', table: 'equipment-economics-reference.csv', column: 'value', row: { parameter: 'life' } });
    expect(step('Weight Check', 'Time Per Check').ref).toMatchObject({ table: 'quality-inspection-reference.csv', row: { operation: 'weight_check', parameter: 'time_per_check' } });
  });

  it('the electricity price opens the location\'s row of location_electricity_prices', () => {
    expect(step('Injection Molding', 'Material Drying · Electricity Price').ref).toEqual({ kind: 'lookup', domain: 'costing_tables', table: 'location_electricity_prices', column: 'price_per_kwh', row: { location: 'USA' } });
  });

  it('the shot melt volume and the resin per part are the calculations they are, from the CAD volume, the density and the cavities', () => {
    const shot = step('Injection Molding', 'Shot Melt Volume').ref as Extract<SourceRef, { kind: 'calculation' }>;
    expect(shot).toMatchObject({ kind: 'calculation', evidence: 'part_volume' });
    expect(shot.steps.find((s) => s.fieldName === 'Part volume')!.ref).toEqual({ kind: 'cad', evidence: 'part_volume' });
    expect(shot.steps.find((s) => s.fieldName === 'Melt Density')!.ref).toEqual({ kind: 'material', materialId: ABS.id, materialName: ABS.name, column: 'im_density_of_melt_kg_m3' });
    expect(shot.steps.at(-1)!.value).toBeCloseTo(Number(step('Injection Molding', 'Shot Melt Volume').value), 0);
    const resin = step('Injection Molding', 'Material Drying · Resin Per Part').ref as Extract<SourceRef, { kind: 'calculation' }>;
    expect(resin.steps.at(-1)).toMatchObject({ fieldName: 'Shot Weight per Part', kind: 'calculated' });
  });

  it('the cavity count opens how it was chosen: the cheapest layout, the Cost Guide\'s count, or the reference default', () => {
    // Priced on the press (costMoldOnPresses, as the insert routes are): every reference layout, the cheapest per part with the mold kept.
    const priced = insertRoutes[0]!.summary.processLines.find((l) => l.process === 'Insert Injection Molding')!.calculationTrace!;
    expect(priced.find((t) => t.fieldName === 'Slide Movement · Cavities per Mold')!.ref).toMatchObject({ kind: 'calculation', name: 'Cavities per Mold: the layout of the lowest cost per part' });
    const set = computeInjectionMoldedCostSummary(part({ cavityCountOverride: 2 })).processLines[0]!.calculationTrace!.find((t) => t.fieldName === 'Slide Movement · Cavities per Mold')!;
    expect(set.ref).toMatchObject({ kind: 'calculation', name: 'Cavities per Mold: set in the Cost Guide' });
    expect(step('Injection Molding', 'Slide Movement · Cavities per Mold').ref).toEqual({ kind: 'variable', domain: 'injection_molding', name: 'defaultNumCavities' });
  });

  it('the parting line lights its PartingLine feature; the batch opens the costing inputs', () => {
    expect(step('Deflashing', 'Parting Line Length').ref).toEqual({ kind: 'features', label: 'parting line', features: [{ featureId: 'parting-line' }] });
    expect(step('Insert Pull Test', 'Batch Size').ref).toEqual({ kind: 'costingInput', field: 'batchSize' });
    expect(step('Insert Pull Test', 'Sample Size').ref).toMatchObject({ kind: 'lookup', domain: 'secondary_process', table: 'CMMInspection', column: 'Sample Size' });
  });

  it('a grade with no cure time opens the material record\'s empty cure time and the 0 it gives, never a typical value', () => {
    const rim = routes.find(([n]) => n === 'reaction injection')![1][0]!.calculationTrace!;
    const cure = rim.find((t) => t.fieldName === 'Material Cure Time')!;
    expect(cure.value).toBe(0);
    expect(cure.ref).toMatchObject({ kind: 'calculation', name: 'Material Cure Time: none on file' });
    expect((cure.ref as Extract<SourceRef, { kind: 'calculation' }>).steps[0]!.ref).toEqual({ kind: 'material', materialId: 'rm-pu', materialName: 'PU', column: 'cure_time_min' });
  });

  it('the mold tooling: the scenario opens the costing inputs, the component data its variables, the steel its treatment row, a sum its calculation', () => {
    const tool = (field: string, ls = lines) => ls.find((l) => l.process === 'Mold Tooling')!.calculationTrace!.find((t) => t.kind === 'input' && t.fieldName === field)!;
    expect(tool('Annual Volume').ref).toEqual({ kind: 'costingInput', field: 'annualVolume' });
    expect(tool('Production Life').ref).toEqual({ kind: 'costingInput', field: 'productionLifeYears' });
    expect(tool('Baffle Spacing').ref).toEqual({ kind: 'variable', domain: 'assembly_plastic_molding', name: 'baffleSpacing' });
    expect(tool('Hardening Applies').ref).toMatchObject({ kind: 'lookup', domain: 'plastic_reference_package', table: 'mold-steel-treatment-reference.csv', column: 'heat_treatment_required' });
    const components = tool('Purchased Components Cost').ref as Extract<SourceRef, { kind: 'calculation' }>;
    expect(components.steps.find((s) => s.fieldName === 'Side Locks unit cost')!.ref).toEqual({ kind: 'variable', domain: 'assembly_plastic_molding', name: 'sideLocksCost' });
    expect(tool('Hot Drops').ref).toMatchObject({ kind: 'calculation', name: 'Hot Drops: a cold runner has none' });
    const hot = routes.find(([n]) => n.includes('hot runner'))![1];
    expect(tool('Hot Drops', hot).ref).toMatchObject({ kind: 'calculation', name: 'Hot Drops: one per gate of every cavity' });
    expect(tool('Slide Block Volume', hot).ref).toEqual({ kind: 'features', label: 'slide bundles', features: [{ featureId: 'slide-bundle-1' }, { featureId: 'slide-bundle-2' }] });
    expect(tool('Rib Inserts', hot).ref).toMatchObject({ kind: 'calculation', name: 'Rib Inserts: the ribs too tall to machine, by size class' });
  });

  it('a value the engineer set on the part opens that, and the value it replaces with its own source', () => {
    const hot = routes.find(([n]) => n.includes('hot runner'))![1];
    const factor = hot.find((l) => l.process === 'Injection Molding')!.calculationTrace!.find((t) => t.fieldName === 'Cycle Time Adjustment Factor')!;
    expect(factor.value).toBe(1.1);
    const ref = factor.ref as Extract<SourceRef, { kind: 'calculation' }>;
    expect(ref).toMatchObject({ kind: 'calculation', name: 'Cycle Time Adjustment Factor: set by the engineer on this part' });
    expect(ref.steps[0]).toMatchObject({ fieldName: 'Set for this part', value: 1.1, source: expect.stringContaining('plant trial') });
    expect(ref.steps[1]!.ref).toEqual({ kind: 'variable', domain: 'injection_molding', name: 'cycleTimeAdjustmentFactor' });
  });

  it('the insert press\'s shot: its table opens the press record, its load the loader\'s run x the cavities', () => {
    const molding = insertRoutes[0]!.summary.processLines.find((l) => l.process === 'Insert Injection Molding')!.calculationTrace!;
    expect(molding.find((t) => t.fieldName === 'Table Press')!.ref).toMatchObject({ kind: 'machine', machineId: INSERT_PRESS.id, column: 'table_configuration' });
    const load = molding.find((t) => t.fieldName === 'Load Time')!.ref as Extract<SourceRef, { kind: 'calculation' }>;
    expect(load.steps[0]!.ref).toMatchObject({ kind: 'calculation' });
    const loader = insertRoutes[0]!.summary.processLines.find((l) => l.process === 'Insert Pick and Place')!.calculationTrace!;
    expect(loader.find((t) => t.fieldName === 'Manual Load')!.ref).toMatchObject({ kind: 'machine', column: 'loading' });
  });
});
