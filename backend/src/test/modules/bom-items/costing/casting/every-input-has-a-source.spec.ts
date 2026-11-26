// Every calculator input on a casting line (sand, investment, high pressure and gravity die casting, the die-cast finishing lines and the
// gravity die's sand cores) says where its value came from (SourceRef), so the calculator dialog's eye beside it opens that source: the
// staged variable or lookup row, the machine or alloy record, the CAD faces, the calculation that worked it out, the part's costing inputs,
// the location's electricity price, or the calculator's own table of defaults. This guard runs the casting routes on the real memory/ data
// and lists every input step that has no ref, and every ref that opens nothing, on the cost summary's lines and on its calculator runs.
import { join } from 'path';
import { loadSandCastingCalculatorSpec, sandCastingCalculatorsByName } from '../../../../../modules/bom-items/costing/casting/sand/calculators/sand-casting-calculator-spec';
import { buildSandRoute, MOULDING_PROCESSES, type SandRouteInput, type SandScenario } from '../../../../../modules/bom-items/costing/casting/sand/sand-route';
import { energyPrice } from '../../../../../modules/bom-items/costing/casting/sand/sand-cost';
import { CORE_PROCESSES } from '../../../../../modules/bom-items/costing/casting/sand/sand-cores';
import type { RefractorySettings } from '../../../../../modules/bom-items/costing/casting/sand/sand-refractory';
import { buildInvestmentRoute, type InvestmentRouteInput } from '../../../../../modules/bom-items/costing/casting/investment/investment-route';
import { investmentCastingCalculatorsByName, loadInvestmentCastingCalculatorSpec } from '../../../../../modules/bom-items/costing/casting/investment/calculators/investment-casting-calculator-spec';
import { CASTING_LOOKUP_KEYS, resolveCastingMaterial, resolveCastingReference, type CastingReferenceRows } from '../../../../../modules/bom-items/costing/casting/casting-reference';
import type { HpdcMachine } from '../../../../../modules/bom-items/costing/casting/hpdc-machine';
import { computeHpdc } from '../../../../../modules/bom-items/costing/casting/hpdc-engine';
import { computeGdc } from '../../../../../modules/bom-items/costing/casting/gdc-engine';
import { cleaningLine, meltingLine, partingLineGrindingLine, trimLine, visualInspectionLine, type FinishingMachine } from '../../../../../modules/bom-items/costing/casting/casting-finishing';
import { CORE_LOOKUP_KEYS, priceCoreRoute, resolveCoreReference } from '../../../../../modules/bom-items/costing/casting/coremaking';
import { dieCastingSpecAsCalculators } from '../../../../../modules/bom-items/costing/casting/calculators/die-casting-calculator-spec';
import { castingSeed } from '../../../../../modules/bom-items/costing/casting/casting-calculator-seeds';
import { runReferenceCalculator } from '../../../../../modules/bom-items/costing/shared/calculators/reference-calculator';
import { DIE_TOOLING_LOOKUP_KEYS, computeDieTooling, pressDieBorders, permanentMoldBorders, resolveDieToolingReference } from '../../../../../modules/bom-items/costing/casting/die-tooling';
import { buildCastingCostSummary } from '../../../../../modules/bom-items/costing/casting/casting-cost-summary';
import type { CostSummaryDto, ProcessLineCost } from '../../../../../modules/bom-items/dto/cost-breakdown.dto';
import { sourceGaps } from '../source-ref-guard';
import { allSandMachines, realSandReference, sandMaterial, HOT_BOX } from './sand-test-data';
import { allInvestmentMachines, investmentMaterial, realInvestmentReference } from './investment-test-data';

const ZERO = { qairPerHr: 0, inspTimeMin: 0, samplingRate: 0, yieldPct: 1, netMatCost: 0, netWeightKg: 0, scrapPricePerKg: 0 };
const USA_POWER = { pricePerKwh: 0.0851, currency: 'USD', basis: 'U.S. EIA Electric Power Monthly, Table 5.3', location: 'USA' };
const FRANCE_POWER = { pricePerKwh: 0.175, currency: 'EUR', basis: 'HR Rates export of 2026-07-22', location: 'France' };
const priced = (override: number | null, row: typeof USA_POWER | null) => {
  const e = energyPrice(override, row?.location, row, (v, c) => (c === 'EUR' ? v * 1.08 : null), []);
  return { energyPricePerKwh: e?.usdPerKwh ?? null, energyPriceSource: e?.source ?? null, energyPriceRef: e?.ref ?? null };
};

// ── Sand: a gray iron casting with one core, every moulding process, every core process, every refractory choice, priced energy ──
const iron = sandMaterial('ASTM Grade 20 Gray Iron');
const sandMachines = allSandMachines();
const sandInput = (scenario: Partial<SandScenario> = {}): SandRouteInput => ({
  ref: realSandReference(), spec: loadSandCastingCalculatorSpec(), calculators: sandCastingCalculatorsByName(), material: iron,
  part: {
    volumeMm3: (8 / iron.columns['density_kg_m3']!) * 1e9, surfaceAreaMm2: 250000, dimsMm: [300, 200, 100], wallNominalMm: 12,
    partingLineMm: 900, abovePartingMm: 50, cores: [{ volumeMm3: 1.2e6, areaMm2: 64000, sizeMm: [200, 100, 60] }],
  },
  machinesByClass: sandMachines,
  scenario: { batchSize: 250, cavities: null, mouldingClass: null, chosenCoreProcess: null, hotBox: HOT_BOX, lifetimeVolume: 10000, ...priced(null, USA_POWER), ...scenario },
  costContext: ZERO,
});
type Line = Pick<ProcessLineCost, 'process' | 'calculationTrace'>;

/** A cost summary's process lines and its calculator runs (shown with the same eye by the Cost panel), each run as "calculatorRuns.<name>". */
const linesAndRuns = (s: CostSummaryDto): Line[] => [
  ...s.processLines,
  ...Object.entries(s.calculatorRuns ?? {}).map(([name, run]) => ({ process: `calculatorRuns.${name}`, calculationTrace: run.trace })),
];
const summaryBase = { family: 'cast', materialGrade: 'x', materialCostPerKg: 1, materialDensityKgM3: 7000, materialSource: 'db' as const, partVolumeMm3: 1e6, warnings: [], ratesSource: 'test' };

const sandLines = (scenario: Partial<SandScenario> = {}): Line[] => {
  const input = sandInput(scenario);
  const { route, missing } = buildSandRoute(input);
  if (!route) throw new Error(`no sand route: ${missing.join('; ')}`);
  return linesAndRuns(buildCastingCostSummary({ ...summaryBase, process: 'sand_casting', hpdc: null, batchSize: input.scenario.batchSize, sand: { route, missing: [] } }));
};
const BOTH_AIR: RefractorySettings = { coat: 'both', dryMethod: 'air', dryMinutes: null, pricePerKg: 4.5 };
const BOTH_OVEN: RefractorySettings = { coat: 'both', dryMethod: 'oven', dryMinutes: 30, pricePerKg: null };

// ── Investment: a stainless 304 casting ──
const investmentInput = (scenario: Partial<InvestmentRouteInput['scenario']> = {}): InvestmentRouteInput => ({
  ref: realInvestmentReference(), spec: loadInvestmentCastingCalculatorSpec(), calculators: investmentCastingCalculatorsByName(),
  material: investmentMaterial('Stainless Steel, AISI 304'), priceSource: 'cost_usa (USA price)',
  part: { volumeMm3: 60_000, surfaceAreaMm2: 30_000, dimsMm: [120, 80, 40], wallMm: 4, slides: 0 },
  machinesByClass: allInvestmentMachines(),
  scenario: { batchSize: 500, cavities: null, lifetimeVolume: 50_000, ...priced(null, USA_POWER), ...scenario },
  costContext: ZERO,
});
const investmentLines = (scenario: Partial<InvestmentRouteInput['scenario']> = {}): Line[] => {
  const input = investmentInput(scenario);
  const { route, missing } = buildInvestmentRoute(input);
  if (!route) throw new Error(`no investment route: ${missing.join('; ')}`);
  return linesAndRuns(buildCastingCostSummary({ ...summaryBase, process: 'investment_casting', hpdc: null, batchSize: input.scenario.batchSize, investment: { route, missing: [] } }));
};

// ── Die casting: an AA 380.0 housing on the real memory/Die Casting data, as bom-item-costing.service.ts prices it ──
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { readCsv } = require('../../../../../../migrations/scripts/lib/memory-machine-seed.js');
const MEM = join(__dirname, '../../../../../../../memory');
const csv = (rel: string): Array<Record<string, any>> => readCsv(join(MEM, rel)).rows;
const DC = (rel: string) => csv(`Die Casting/${rel}`);
const calculators = dieCastingSpecAsCalculators();
const refRows: CastingReferenceRows = {
  variables: DC('Die casting_variables.csv').map((r) => ({ key: String(r['Variable Name']), value: r['String Value'] })),
  lookups: Object.fromEntries(CASTING_LOOKUP_KEYS.map((k) => [k, DC(`Lookup/${k}.csv`)])),
};
const ref = resolveCastingReference(refRows).reference!;
const toolingRef = resolveDieToolingReference({
  variables: refRows.variables,
  lookups: Object.fromEntries(DIE_TOOLING_LOOKUP_KEYS.map((k) => [k, DC(`Lookup/${k}.csv`)])),
  toolShop: {
    digital_factory_settings_usa: csv('plastic modeling/process/digital_factory_settings_usa.csv'),
    digital_factory_tool_materials_usa: csv('plastic modeling/process/digital_factory_tool_materials_usa.csv'),
  },
}).reference!;
const coreRef = resolveCoreReference({ variables: refRows.variables, lookups: Object.fromEntries(CORE_LOOKUP_KEYS.map((k) => [k, DC(`Lookup/${k}.csv`)])) }).reference!;
const PROPS: Record<string, string> = {
  chamber_type: 'Chamber Type', clamping_pressure: 'Clamping Pressure (MPa)', cooling_factor: 'Cooling Factor (s/mm)',
  injection_temp: 'Injection Temp (C)', liquidus_temp: 'Liquidus Temp (C)', solidus_temp: 'Solidus Temp (C)',
  mold_temp: 'Mold Temp (C)', die_life: 'Die Life (cycles)', yield_loss_factor: 'Yield Loss Factor', shear_strength: 'Shear Strength (MPa)',
};
const alloyRow = DC('Raw Material/materials_master.csv').find((m) => m['Name'] === 'Aluminum, AA 380.0')!;
const alloy = resolveCastingMaterial({
  row: { id: 'alloy-380', name: alloyRow['Name'], material_type: alloyRow['Material Type'], density_kg_m3: alloyRow['Density (kg/m^3)'], cost_usa: alloyRow['Unit Cost (USD/kg)'], cut_code: alloyRow['Cut Code'] },
  properties: Object.fromEntries(Object.entries(PROPS).map(([k, h]) => [k, alloyRow[h] === '' ? null : Number(alloyRow[h])])),
});
const crew = (r: Record<string, any>) => ({
  machineRatePerHr: Number(r['Direct Overhead Rate (USD/hr)']) + Number(r['Indirect Overhead Rate (USD/hr)']),
  labourRatePerHr: Number(r['Labor Rate (USD/hr)']), operators: Number(r['Number of Operators']), setupTimeHr: Number(r['Setup Time (hr)']),
});
const hpdcMachines: HpdcMachine[] = DC('Machine/high_pressure_die_casting_machines.csv').map((r, i) => ({
  id: `h${i}`, name: String(r['Name']), ...crew(r), clampingForceKn: Number(r['Clamping Force (kN)']),
  tieBarHorMm: Number(r['Tie Bar Distance Hor (mm)']), tieBarVertMm: Number(r['Tie Bar Distance Vert (mm)']),
  maxMoldHeightMm: Number(r['Max Mold Height (mm)']), dryCycleTimeS: Number(r['Dry Cycle Time (s)']),
}));
const gdcMachines: HpdcMachine[] = DC('Machine/gravity_die_casting_machines.csv').map((r, i) => ({
  id: `g${i}`, name: String(r['Name']), ...crew(r), clampingForceKn: null,
  tieBarHorMm: Number(r['Tie Bar Distance Hor (mm)']), tieBarVertMm: Number(r['Tie Bar Distance Vert (mm)']),
  maxMoldHeightMm: Number(r['Max Mold Height (mm)']), dryCycleTimeS: Number(r['Dry Cycle Time (s)']), moldEfficiency: Number(r['Mold Efficiency']),
}));
const fin = (file: string, specs: (r: Record<string, any>) => Record<string, unknown>): FinishingMachine[] =>
  DC(`Machine/${file}`).map((r, i) => ({ id: `${file}${i}`, name: String(r['Name']), ...crew(r), specs: specs(r) }));
const cleaners = fin('cleaning_machines_shot_blast.csv', (r) => ({ time_per_load_min: r['Time per Load (min)'], weight_capacity_kg: r['Weight Capacity (kg)'], max_height_mm: r['Max Height (mm)'], max_width_mm: r['Max Width (mm)'], max_batch_size: r['Max Batch Size'] }));
const trimPresses = fin('trim_presses.csv', (r) => ({ cycle_time_s: r['Cycle Time (s)'], press_force_kn: r['Press Force (kN)'] }));
const grinders = fin('finishing_machines.csv', (r) => ({ grinding_speed_parting_line_mm3_per_s: r['Grinding Speed Parting Line (mm^3/s)'], grinding_speed_gating_mm3_per_s: r['Grinding Speed Gating (mm^3/s)'], max_weight_kg: r['Max Weight (kg)'] }));
const inspectors = fin('visual_inspection.csv', () => ({}));
const furnaces = DC('Machine/melting_furnaces.csv').map((r, i): FinishingMachine => ({
  id: `f${i}`, name: String(r['Name']), machineRatePerHr: null, labourRatePerHr: Number(r['Labor Rate (USD/hr)']), operators: Number(r['Number of Operators']),
  setupTimeHr: Number(r['Setup Time (hr)']), specs: { furnace_capacity_m3: r['Furnace Capacity (m^3)'], max_temperature_c: r['Max Temperature (C)'] },
}));
const diConversion = Number(csv('Casting/Machine/pmmelting_machines.csv').find((r) => r['Name'] === 'Induction - DI')!['Conversion Cost (USD/kg)']);
const snake = (h: string) => h.replace(/\s*\(.*?\)\s*/g, ' ').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_');
const coreMachines = (file: string): FinishingMachine[] => DC(`Machine/${file}`).map((r, i) => {
  const units: Record<string, string> = {};
  for (const [h, val] of Object.entries(r)) units[`${snake(h)}${/\(mm\)/.test(h) ? '_mm' : /\(s\)/.test(h) ? '_s' : ''}`] = val;
  return { id: `${file}${i}`, name: String(r['Name']), ...crew(r), specs: units };
});

const part = { volumeMm3: 120_000, surfaceAreaMm2: 60_000, perimeterMm: 520, wallMaxMm: 8, lengthMm: 160 };
const geometry = {
  projectedAreaMm2: 14_000, footprintMm: [160, 110] as [number, number], wallNominalMm: 3, wallMaxMm: part.wallMaxMm,
  partVolumeMm3: part.volumeMm3, partLengthMm: part.lengthMm,
};

function dieCastLines(process: 'hpdc' | 'gdc'): Line[] {
  const batchSize = 1000;
  const common = { processGroup: 'Die Casting', costContext: ZERO, batchSize, calculators };
  const line = process === 'hpdc'
    ? computeHpdc({ reference: ref, referenceMissing: [], calculators, material: alloy, materialGrade: alloy.name, geometry, machines: hpdcMachines, batchSize, costContext: ZERO })
    : computeGdc({ reference: ref, referenceMissing: [], calculators, material: alloy, materialGrade: alloy.name, geometry, machines: gdcMachines, batchSize, coreCount: 1, costContext: ZERO });
  const netRun = runReferenceCalculator(calculators, 'Net Material Usage', {
    'Part Volume': castingSeed.cad(part.volumeMm3, 'part volume (mm³)', 'part_volume'), Density: castingSeed.alloy(alloy, 'density_kg_m3', 'Density (kg/m^3)', alloy.densityKgM3!),
  }, 'Net Usage');
  const net = netRun.value!;
  const cleaning = cleaningLine({ ...common, machines: cleaners, partWeight: castingSeed.calculator(net, 'Net Material Usage', netRun, 'part_volume'), partDimsMm: [160, 110, 40], machineClass: 'die_casting_cleaning' });
  const inspection = visualInspectionLine({ ...common, machines: inspectors, rows: ref.visualInspection, partMassKg: net, surfaceAreaMm2: part.surfaceAreaMm2, machineClass: 'die_casting_visual_inspection' });
  const trim = trimLine({
    ...common, machines: trimPresses, alloy, partsPerStroke: ref.variables.defaultNumberOfTrimmedParts, partingPerimeterMm: part.perimeterMm,
    partMassKg: net, dimensions: ref.grindingDimensions, shearStrengthMpa: alloy.shearStrengthMpa, machineClass: 'die_casting_trim',
  });
  const grinding = partingLineGrindingLine({
    ...common, machines: grinders, partMassKg: net, cutCode: alloy.cutCode, partingPerimeterMm: part.perimeterMm, dimensions: ref.grindingDimensions,
    speedFactor: ref.grindingSpeedFactorByCutCode.get(alloy.cutCode!) ?? null, speedFactorNote: 'no factor',
    gates: process === 'hpdc' ? { ground: true } : { ground: false, reason: 'gravity gates and risers are not sized: memory gives the 1:2:5 gating ratio but no sprue area' },
    wallMaxMm: part.wallMaxMm, partLengthMm: part.lengthMm,
    variables: ref.variables, machineClass: 'die_casting_finishing',
  });
  const melting = meltingLine({
    furnaces, calculators, ductileIron: { id: 'induction-di', name: 'Induction - DI', costPerKg: diConversion }, regionConvFactor: ref.variables.regionConvFactor,
    furnaceCapacitySafetyFactor: ref.variables.furnaceCapacitySafetyFactor, shotVolumeMm3: line.shotVolumeMm3, shotVolumeRun: line.shotVolumeRun, cavities: line.cavities?.count ?? null, cavitiesRef: line.cavities?.ref ?? null,
    alloy, densityKgM3: alloy.densityKgM3, injectionTempC: alloy.injectionTempC, batchSize, processGroup: 'Die Casting', machineClass: 'die_casting_melting',
  });
  const cores = process === 'gdc'
    ? priceCoreRoute({
      reference: coreRef, calculators, cores: [{ volumeMm3: 6000, boxMm: [60, 10, 10], areaMm2: 2600 }],
      coremakers: coreMachines('core_making_machines.csv'), coaters: coreMachines('core_refractory_coat.csv'),
      airDryers: coreMachines('refractory_coat_air_dry.csv'), ovens: coreMachines('refractory_coat_oven_dry.csv'),
      batchSize, usdToLocal: 1, annualVolume: 100_000, productionLifeYears: 5, costContext: ZERO,
    })
    : null;
  // The die on the machine the line is priced on, as the service builds it.
  const borders = process === 'gdc' ? permanentMoldBorders(toolingRef) : pressDieBorders(toolingRef, line.machine!.clampingForceKn!);
  const dieTooling = 'borders' in borders
    ? computeDieTooling({
      reference: toolingRef, calculators, borders: borders.borders, pressForceKn: process === 'gdc' ? null : line.machine!.clampingForceKn, cavities: line.cavities!,
      footprintMm: geometry.footprintMm, pullExtentMm: 40, projectedAreaMm2: geometry.projectedAreaMm2, surfaceAreaMm2: part.surfaceAreaMm2, featureCount: 300,
      slideCount: 1, slideWidthsMm: [30], materialType: alloy.materialType, annualVolume: 50_000, productionLifeYears: 5, location: 'USA',
    })
    : null;
  const summary = buildCastingCostSummary({
    family: 'die_cast', process: 'die_casting', hpdc: line, materialGrade: alloy.name, materialCostPerKg: 5.5, materialDensityKgM3: alloy.densityKgM3!,
    materialSource: 'db', partVolumeMm3: part.volumeMm3, batchSize, warnings: [], ratesSource: 'test',
    finishing: { melting: melting.line, trim: trim.line, grinding: grinding.line, cleaning: cleaning.line, inspection: inspection.line, warnings: [] },
    dieTooling, cores, calculators, alloy: { id: alloy.id, name: alloy.name, densityKgM3: alloy.densityKgM3, yieldLossFactor: alloy.yieldLossFactor },
    meltedKg: melting.meltedKg, calculatorRuns: trim.forceRun ? { 'Trim Force': trim.forceRun } : {},
  });
  expect(summary.calculatorRuns?.['Die Size']).toBeDefined();
  if (process === 'gdc') expect(summary.calculatorRuns?.['Corebox']).toBeDefined();
  return linesAndRuns(summary);
}

describe('every casting calculator input says where its value came from', () => {
  const routes: Array<[string, () => Line[]]> = [
    ['sand: the cheapest route, the location\'s electricity', () => sandLines()],
    ...MOULDING_PROCESSES.map((m): [string, () => Line[]] => [`sand: ${m.process}`, () => sandLines({ mouldingClass: m.machineClass })]),
    ...CORE_PROCESSES.map((c): [string, () => Line[]] => [`sand: ${c.process} cores`, () => sandLines({ chosenCoreProcess: c.process })]),
    ['sand: mould and cores coated, air dried, coating priced', () => sandLines({ refractory: BOTH_AIR })],
    ['sand: mould and cores coated, oven dried for the Cost Guide\'s time', () => sandLines({ refractory: BOTH_OVEN })],
    ['sand: the Cost Guide\'s energy price and cavities', () => sandLines({ ...priced(0.12, USA_POWER), cavities: 2 })],
    ['sand: a location priced in euros', () => sandLines(priced(null, FRANCE_POWER))],
    ['sand: no energy price', () => sandLines(priced(null, null))],
    ['investment: the location\'s electricity', () => investmentLines()],
    ['investment: the Cost Guide\'s energy price and cavities', () => investmentLines({ ...priced(0.12, null), cavities: 2 })],
    ['investment: no energy price', () => investmentLines(priced(null, null))],
    ['high pressure die casting and its finishing', () => dieCastLines('hpdc')],
    ['gravity die casting, its sand core and its finishing', () => dieCastLines('gdc')],
  ];

  it.each(routes)('%s', (_name, lines) => {
    const got = lines();
    expect(got.length).toBeGreaterThan(0);
    // The summary's calculator runs are checked with its lines.
    expect(got.some((l) => l.process.startsWith('calculatorRuns.'))).toBe(true);
    expect(sourceGaps(got)).toEqual({ withoutRef: [], openingNothing: [] });
  });
});
