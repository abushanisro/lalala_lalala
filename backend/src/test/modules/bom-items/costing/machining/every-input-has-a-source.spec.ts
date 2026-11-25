// Every calculator input on a machining line, and on the Inspection, Deburring and Tapping lines every part carries, says where its value
// came from (SourceRef), so the calculator dialog's eye beside it opens that source: the reference-table row, the machine or material
// record, the CAD faces or features it was measured on, the calculation it was worked out by, the part's costing inputs, or the
// calculator's own table of input defaults with the source of each (calculatorField). An input with no ref has no eye: this guard runs the
// machining engines on rich fixtures and lists every input step that has none.
import { splitExternalThreads } from '../../../../../modules/bom-items/costing/machining/external-threads';
import { specAsCalculators } from '../../../../../modules/bom-items/costing/machining/calculators/machining-calculator-spec';
import { buildOperationSequence, type MillingFinishingRow } from '../../../../../modules/bom-items/costing/machining/operation/operation-sequencer';
import { featureRemovedVolumeMm3, stockExcess } from '../../../../../modules/bom-items/costing/machining/operation/stock-excess';
import {
  computeMillingCostSummary,
  computeTurningCostSummary,
  type MachineClassId,
  type MachiningCostInput,
} from '../../../../../modules/bom-items/costing/machining/process/cost-machining-engine';
import type { MHRRateInput } from '../../../../../modules/bom-items/costing/shared/core/cost-engine';
import type { CalculationTraceStep, ProcessLineCost, SourceRef } from '../../../../../modules/bom-items/dto/cost-breakdown.dto';
import { stockReference } from '../../../../../modules/bom-items/costing/stock/stock-reference';
import { selectStock, type StockPart } from '../../../../../modules/bom-items/costing/stock/stock-selection';
import { stockMachiningCalculatorsByName } from '../../../../../modules/bom-items/costing/stock-machining/calculators/stock-machining-calculator-spec';
import { stockBlankResult } from '../../../../../modules/bom-items/costing/stock-machining/stock-machining-cost-summary';
import { buildStockMachiningQuote } from '../../../../../modules/bom-items/costing/stock-machining/stock-machining-route';
import { bandSaws, realStockMachiningReference, stockMaterial } from '../stock/stock-test-data';
import { realCapabilityRules, realGroovingTable, realPartoffTable } from './real-reference-tables';
import { workbookFixture } from './workbook-fixture';

const CALCS = specAsCalculators();
const ALUMINIUM: MillingFinishingRow = { toolDiameterMm: 10, teeth: 3, cuttingSpeedMPerMin: 183, feedPerToothPerDiameter: 0.008 };
const rate = (r: number, extra: Partial<MHRRateInput> = {}): MHRRateInput =>
  ({ rate: r, source: 'mhr_database', machineClass: 'x', machineName: 'M', commodityCode: null, mhrRecordId: 'mhr-1', ...extra } as MHRRateInput);

// A part with one of every feature the sequencer plans an operation for, each with its feature_graph_v2 id and faces.
const occ = (face: number, extra: Record<string, unknown>) => ({ face_ids: [face, face + 1], ...extra });
const FEATURES = [
  { id: 'PocketV2-default_c2', feature_type: 'PocketV2', variant: 'default', occurrences: [occ(1, { extents_mm: [30, 20, 0], depth_mm: 5, material_removed_mm3: 3000 }), occ(3, { extents_mm: [30, 4, 0], depth_mm: 5, material_removed_mm3: 600 })] },
  { id: 'SimpleHole-through_d6.0_c4', feature_type: 'SimpleHole', variant: 'through', diameter_mm: 6, occurrences: [10, 12, 14, 16].map((f) => occ(f, { depth_mm: 10, material_removed_mm3: 282.74 })) },
  { id: 'SimpleHole-through_d40.0_c1', feature_type: 'SimpleHole', variant: 'through', diameter_mm: 40, occurrences: [occ(18, { depth_mm: 10, material_removed_mm3: 12566 })] },
  { id: 'SimpleHole-threaded_d5.0_c2', feature_type: 'SimpleHole', variant: 'threaded', diameter_mm: 5, occurrences: [20, 22].map((f) => occ(f, { depth_mm: 8, spec: 'M5', pitch_mm: 0.8 })) },
  { id: 'SimpleHole-pcd_d4.0_c1', feature_type: 'SimpleHole', variant: 'pcd_pattern', diameter_mm: 4, occurrences: [occ(24, { depth_mm: 6, hole_count: 6 })] },
  { id: 'MultiStepHole-stepped_c1', feature_type: 'MultiStepHole', variant: 'stepped', occurrences: [occ(26, { steps: [{ diameter_mm: 8, depth_mm: 4 }, { diameter_mm: 5, depth_mm: 6 }, { diameter_mm: 3, depth_mm: 4 }] })] },
  { id: 'MultiStepHole-counterbore_d10.0_c2', feature_type: 'MultiStepHole', variant: 'counterbore', diameter_mm: 10, occurrences: [28, 30].map((f) => occ(f, { depth_mm: 5 })) },
  { id: 'Edge-countersink_d10.0_c2', feature_type: 'Edge', variant: 'countersink', diameter_mm: 10, occurrences: [occ(10, {}), occ(32, {})] },
  { id: 'Edge-chamfer_c2', feature_type: 'Edge', variant: 'chamfer', occurrences: [occ(34, { extents_mm: [40, 1, 1] }), occ(36, { extents_mm: [20, 1, 1] })] },
  { id: 'Edge-round_d20.0_c2', feature_type: 'Edge', variant: 'round', diameter_mm: 20, occurrences: [occ(38, { radius_mm: 1, path_length_mm: 31.4 }), occ(40, { radius_mm: 2, concave: true, path_length_mm: 20, sweep_deg: 90 })] },
  { id: 'Slot-groove_d30.0_c1', feature_type: 'Slot', variant: 'groove', diameter_mm: 30, occurrences: [occ(42, { radius_mm: 1.5 })] },
  { id: 'PlanarFace-default_c2', feature_type: 'PlanarFace', variant: 'default', occurrences: [occ(44, { area_mm2: 2000 }), occ(46, { area_mm2: 500 })] },
  { id: 'CurvedWall-default_c1', feature_type: 'CurvedWall', variant: 'default', occurrences: [occ(48, { area_mm2: 800 })] },
  { id: 'CurvedSurface-default_c1', feature_type: 'CurvedSurface', variant: 'default', occurrences: [occ(50, { area_mm2: 300 })] },
  { id: 'Cutout-default_c1', feature_type: 'Cutout', variant: 'default', occurrences: [occ(52, { area_mm2: 600 })] },
  { id: 'Slot-straight_c1', feature_type: 'Slot', variant: 'straight', occurrences: [occ(54, { extents_mm: [20, 6, 0], depth_mm: 4, material_removed_mm3: 480 }), occ(56, { extents_mm: [20, 6, 0], material_removed_mm3: 480 })] },
  { id: 'Keyway-default_c1', feature_type: 'Keyway', variant: 'default', occurrences: [occ(58, { length_mm: 12, width_mm: 4, depth_mm: 2.5 })] },
  { id: 'Flat-default_c1', feature_type: 'Flat', variant: 'default', occurrences: [occ(60, { length_mm: 15, width_mm: 8, depth_mm: 1 })] },
  { id: 'Boss-default_c1', feature_type: 'Boss', variant: 'default', occurrences: [occ(62, { material_removed_mm3: 900 })] },
];
const PIECE_MM3 = 100 * 80 * 40;
const PART_MM3 = 200_000;
const FACING = { faces: 2, lengthMm: 100, widthMm: 80, depthMm: 2, volumeMm3: 32000, basis: 'the 4" x 3-1/4" rectangular bar piece\'s top and bottom, 100 x 80 mm, 2 mm each' };
const AROUND = stockExcess({ pieceMm3: PIECE_MM3, partMm3: PART_MM3, featureRemovedMm3: featureRemovedVolumeMm3(FEATURES), facedMm3: FACING.volumeMm3 });

const featureOps = buildOperationSequence(FEATURES, {
  matClass: 'aluminum', machinabilityFactor: 1, materialGrade: 'Aluminum, ANSI 6061', workbook: workbookFixture(), calculators: CALCS,
  removalRateMm3PerMin: 60000, finishing: ALUMINIUM, stockAround: AROUND, facing: FACING,
});

const LOAD_TABLE = [
  { equipment: 'None', weight_kg: 5, part_size_mm: 300, load_time_s: 10, unload_time_s: 8, reorientation_time_s: 12 },
  { equipment: 'Hoist', weight_kg: 50, part_size_mm: 1000, load_time_s: 60, unload_time_s: 45, reorientation_time_s: 90 },
];

function milled(over: Partial<MachiningCostInput> = {}): MachiningCostInput {
  return {
    volume: PART_MM3, surfaceArea: 30000, maxLength: 96, maxWidth: 76, maxHeight: 36,
    holeCount: 4, holeGroups: [{ diameter_mm: 6, count: 4, depth_mm: 10, occurrences: [{ featureId: 'SimpleHole-through_d6.0_c4', occurrenceIndex: 0 }] }], pocketCount: 2,
    materialGrade: 'Aluminum, ANSI 6061', materialCostPerKg: 5.875, materialDensityKgM3: 2700, materialSource: 'db',
    threads: [{ size: 'M5', count: 2, pitchMm: 0.8, depthMm: 8, occurrences: [{ featureId: 'SimpleHole-threaded_d5.0_c2', occurrenceIndex: 0 }] }],
    tightestToleranceMm: 0.02, gdtFeatureCount: 1, batchSize: 100, family: 'milled', finishedWeightKg: 0.54,
    mhrRate: rate(900, { machineClass: '3_axis_mill', machineName: 'Haas VF-2', setupTimeHr: 0.5, maxSpindleRpm: 8000, rapidTraverseMmPerMin: 30000 }),
    tappingRate: rate(900, { machineClass: 'tapping', machineName: 'Haas VF-2', setupTimeHr: 0.25, maxSpindleRpm: 8000 }),
    deburrRate: rate(300, { machineClass: 'manual_deburr', machineName: 'Default Manual Deburr', setupTimeHr: 0.1 }),
    inspectionRate: rate(450, { machineClass: 'machining_inspection', machineName: 'Default', setupTimeHr: 0.1 }),
    surfaceTreatment: null, machiningCalculators: CALCS, capabilityRules: realCapabilityRules(), location: 'USA',
    workbook: workbookFixture(), millingRemovalRateMm3PerMin: 60000, rapidTransferDistanceFactor: 0.5,
    blankResult: { form: 'rectangular_bar', sizeLabel: '4" x 3-1/4" rectangular bar', billetVolMm3: PIECE_MM3, utilizationPct: 60, sizeSource: 'Stock Machining stock (tblPreferredSizes): 4" x 3-1/4" rectangular bar' },
    featureOps,
    partSetup: { loadTable: LOAD_TABLE, adjustmentFactor: 1, repetitions: 1, setups: null },
    sharpEdgeLengthMm: 600, sharpEdgeFaceIds: [3, 5, 8], deburrLinearSpeedMmPerSec: 22.7,
    deburrMatch: { table: 'tblDeburring', row: { material_cut_code_name: '1.0', deburr_type: 'Edge', tool_series: 'Virtual Debuiring Wire Wheel Brush' } },
    inspectedFeatures: [{ featureId: 'SimpleHole-through_d6.0_c4', occurrenceIndex: 0 }],
    ...over,
  };
}

// A stepped shaft from round bar: turned diameters, a groove, a thread, a cross hole, parted off.
function turned(over: Partial<MachiningCostInput> = {}): MachiningCostInput {
  return {
    ...milled(),
    volume: 4000, surfaceArea: 1500, maxLength: 32, maxWidth: 14, maxHeight: 14, family: 'turned', pocketCount: 0, featureOps: undefined,
    holeGroups: [{ diameter_mm: 4, count: 1, depth_mm: 14, occurrences: [{ featureId: 'SimpleHole-cross_d4.0_c1', occurrenceIndex: 0 }] }], holeCount: 1,
    mhrRate: rate(900, { machineClass: '3_axis_bar_feed_lathe_with_sub_spindle', machineName: 'Haas DS-30Y', setupTimeHr: 0.5, maxSpindleRpm: 4000, liveToolingMaxRpm: 10000 }),
    turnedGeometry: {
      diameterMm: 14, lengthMm: 32, diameterSource: 'CAD: largest turned outer diameter (Ring feature)', lengthSource: 'CAD: bounding-box extent along the turning axis',
      rings: [{ id: 'od_0', diameterMm: 14, lengthMm: 8, faceIds: [9] }, { id: 'od_1', diameterMm: 12, lengthMm: 18, faceIds: [17] }],
    },
    turnedGrooves: [{ diameterMm: 10, widthMm: 2, depthMm: 1, grooves: 1, faceIds: [30], featureIds: ['Ring-groove_d10.0_c1'], lacks: [] }],
    groovingTable: realGroovingTable(),
    blankResult: {
      form: 'round_bar', sizeLabel: '5/8" round bar', billetVolMm3: Math.PI * 8 ** 2 * 36, utilizationPct: 60, barDiameterMm: 15.875, endAllowanceMm: 0.5,
      sizeSource: 'Stock Machining stock (tblPreferredSizes): 5/8" round bar',
    },
    partoffTable: realPartoffTable(),
    ...over,
  };
}

// The stock model's round bar for a Ø14 x 32 shaft (memory/Stock Maching, inch sizes): its blank carries how the bar's diameter and end
// allowance were arrived at, as the engines take it.
const STOCK_REF = realStockMachiningReference();
const STOCK = stockReference(STOCK_REF).reference!;
const SHAFT_PART: StockPart = { source: 'measured', family: 'mill_turn', lengthMm: 32, roundOdMm: 14, widthMm: 14, heightMm: 14, hexAcrossFlatsMm: null, boreMm: null, volumeMm3: 4000 };
const SETTINGS = { unitSystem: 'US' as const, cutOff: 'saw' as const, remnantMm: 152.4, allowanceMm: null, snap: null };
const BAR = selectStock(SHAFT_PART, STOCK, SETTINGS, 'round_bar').chosen!;
const ZERO = { qairPerHr: 0, inspTimeMin: 0, samplingRate: 0, yieldPct: 1, netMatCost: 0, netWeightKg: 0, scrapPricePerKg: 0 };
const bandSaw = buildStockMachiningQuote({
  ref: STOCK_REF, stock: STOCK, calculators: stockMachiningCalculatorsByName(), saws: bandSaws('USA'), part: SHAFT_PART, option: BAR,
  material: stockMaterial('Aluminum, ANSI 6061', 'Round Bar Unit Cost (USD / kg)'), cutOff: 'saw', sawCosted: true,
  remnant: { mm: 152.4, source: 'the end of a bar that makes no part' }, scrapCredit: false,
  scrapRecovery: { percent: 100, source: 'No scrap recovery staged for USA: the whole scrap weight is credited' }, batchSize: 25, costContext: ZERO, endFaceIds: [3, 9],
}).lines;
const stockChoice = { selection: { saw: { chosen: BAR }, parting: { chosen: BAR } }, part: SHAFT_PART, settings: SETTINGS } as never;

// A drawing's M12 x 1.75 thread on the Ø12 journal (turned), and an M5 the CAD did not find tapped (tapped at its engagement depth).
const EXTERNAL = splitExternalThreads([{ size: 'M12', count: 1, pitchMm: 1.75 }], [{ id: 'od_1', diameterMm: 12, lengthMm: 18, faceIds: [17] }], []).external;

const SHARED = new Set(['Inspection', 'Deburring', 'Tapping']);
/** Every input step of these lines that carries no ref: "process | field | source". */
function withoutRef(lines: readonly ProcessLineCost[]): string[] {
  const out: string[] = [];
  for (const l of lines) {
    for (const s of (l.calculationTrace ?? []) as CalculationTraceStep[]) {
      if (s.kind !== 'input' || s.ref) continue;
      out.push(`${l.process} | ${s.fieldName} | ${s.source ?? ''}`);
    }
  }
  return [...new Set(out)];
}

/**
 * Every ref that opens nothing (no eye may open an empty panel): a features or faces ref with none to light, a calculation with no step, a
 * calculator's defaults table without the field, a lookup with no table or column. Each step of a calculation is checked the same way.
 */
function emptyRefs(lines: readonly ProcessLineCost[]): string[] {
  const out: string[] = [];
  const check = (where: string, ref: SourceRef): void => {
    const bad = (why: string) => out.push(`${where}: ${ref.kind} ${why}`);
    if (ref.kind === 'features' && ref.features.length === 0) bad('lights no feature');
    if (ref.kind === 'faces' && ref.faceIds.length === 0) bad('lights no face');
    if (ref.kind === 'calculation') {
      if (ref.steps.length === 0) bad('has no step');
      for (const st of ref.steps) if (st.ref) check(`${where} > ${st.fieldName}`, st.ref);
    }
    if (ref.kind === 'calculatorField' && !ref.defaults.some((d) => d.field === ref.field)) bad(`does not list ${ref.field}`);
    if ((ref.kind === 'lookup' || ref.kind === 'smTable') && (!ref.table || !ref.column)) bad('names no table or column');
    if (ref.kind === 'machine' && (!ref.machineId || !ref.column)) bad('names no machine record or column');
    if (ref.kind === 'variable' && (!ref.domain || !ref.name)) bad('names no variable');
  };
  for (const l of lines) {
    for (const st of (l.calculationTrace ?? []) as CalculationTraceStep[]) if (st.kind === 'input' && st.ref) check(`${l.process} | ${st.fieldName}`, st.ref);
  }
  return [...new Set(out)];
}

describe('every machining calculator input says where its value came from', () => {
  const routes: Array<[string, ProcessLineCost[]]> = [
    ['3-axis mill, every feature', computeMillingCostSummary(milled(), '3_axis_mill' as MachineClassId).processLines],
    ['3-axis mill, no feature graph', computeMillingCostSummary(milled({ featureOps: undefined }), '3_axis_mill' as MachineClassId).processLines],
    ['bar-fed lathe, stepped shaft', computeTurningCostSummary(turned(), '3_axis_bar_feed_lathe_with_sub_spindle' as MachineClassId).processLines],
    ['bar-fed lathe, the stock model\'s bar, a turned thread, a drawing thread', computeTurningCostSummary(turned({
      blankResult: stockBlankResult(stockChoice, 'parting')!, externalThreads: EXTERNAL, threads: [{ size: 'M5', count: 2 }],
    }), '3_axis_bar_feed_lathe_with_sub_spindle' as MachineClassId).processLines],
    ['bar-fed lathe, a part analysed without turned diameters', computeTurningCostSummary(turned({
      turnedGeometry: { diameterMm: 14, lengthMm: 32, diameterSource: 'CAD: bounding-box cross-section (no turned-diameter feature recognised)', lengthSource: 'CAD: bounding-box length (no turned-diameter feature recognised)', rings: [] },
      turnedGrooves: [], holeGroups: [], holeCount: 0,
    }), '3_axis_bar_feed_lathe_with_sub_spindle' as MachineClassId).processLines],
    ['5-axis mill, every feature', computeMillingCostSummary(milled({ mhrRate: rate(1500, { machineClass: '5_axis_mill', machineName: 'DMU 50', setupTimeHr: 1, maxSpindleRpm: 12000, rapidTraverseMmPerMin: 40000 }) }), '5_axis_mill' as MachineClassId).processLines],
    ['Band Saw (Stock Machining)', bandSaw],
  ];

  it.each(routes)('%s', (_name, lines) => {
    expect(lines.length).toBeGreaterThan(0);
    expect(withoutRef(lines)).toEqual([]);
    expect(emptyRefs(lines)).toEqual([]);
  });

  it('covers the shared lines', () => {
    const processes = new Set(routes.flatMap(([, lines]) => lines.map((l) => l.process)));
    for (const p of SHARED) expect(processes.has(p)).toBe(true);
  });
});

describe('what the eyes open', () => {
  const lathe = computeTurningCostSummary(turned({ blankResult: stockBlankResult(stockChoice, 'parting')! }), '3_axis_bar_feed_lathe_with_sub_spindle' as MachineClassId).processLines;
  const input = (process: string, field: string) => lathe.find((l) => l.process === process)!.calculationTrace!.find((st) => st.kind === 'input' && st.fieldName === field)!;

  it('a calculator default: its source is the spec\'s note (never "Assumption: ... default value (database)"), and it opens the calculator\'s defaults', () => {
    const depth = input('End Machining', 'Depth of Cut');
    expect(depth.source).toMatch(/Facing and Internal Boring sheets: depth of cut 0\.5 mm/);
    expect(depth.ref).toMatchObject({ kind: 'calculatorField', calculator: 'Machining - End Facing', field: 'Depth of Cut' });
    const defaults = (depth.ref as Extract<SourceRef, { kind: 'calculatorField' }>).defaults;
    expect(defaults.find((d) => d.field === 'Approach Length')).toMatchObject({ value: 10, unit: 'mm', source: expect.stringMatching(/Facing sheet: the length of cut plus 10 mm/) });
    expect(defaults.find((d) => d.field === 'Faces')).toMatchObject({ value: 2, source: expect.stringMatching(/No of uses 2, both ends of the part/) });
    for (const l of lathe) for (const st of l.calculationTrace ?? []) expect(st.source ?? '').not.toMatch(/default value \(database\)/);
  });

  it('the bar a lathe turns from: how the stock model chose it, down to its tblPreferredSizes row', () => {
    const bar = input('End Machining', 'Bar Diameter').ref as Extract<SourceRef, { kind: 'calculation' }>;
    expect(bar).toMatchObject({ kind: 'calculation', name: 'Bar Diameter: the stock chosen for the part' });
    expect(bar.steps.find((st) => st.fieldName === 'Stock allowance on each side')!.ref).toEqual({ kind: 'variable', domain: 'stock_machining', name: 'percentStockAllowance' });
    expect(bar.steps.find((st) => st.fieldName === 'Stock size')!.ref).toEqual({ kind: 'lookup', domain: 'stock_machining', table: 'tblPreferredSizes', column: 'sizeMm', row: { sizeMm: BAR.aMm } });
    expect(bar.steps.at(-1)).toMatchObject({ kind: 'calculated', value: BAR.circumscribedMm });
  });

  it('the batch opens the part\'s costing inputs; a setup time the machine\'s HR Rates record at setup_time_hr', () => {
    expect(input('End Machining', 'Batch size').ref).toEqual({ kind: 'costingInput', field: 'batchSize' });
    expect(input('End Machining', 'Setup time').ref).toMatchObject({ kind: 'machine', machineId: 'mhr-1', machineName: 'Haas DS-30Y', column: 'setup_time_hr' });
  });

  it('a milled pocket\'s CAD values light exactly the pockets of its size', () => {
    const mill = computeMillingCostSummary(milled(), '3_axis_mill' as MachineClassId).processLines.find((l) => l.process === '3 Axis Mill')!;
    const cut = mill.calculationTrace!.filter((st) => st.fieldName.endsWith('Cut Length'));
    expect(cut.map((st) => st.ref)).toEqual(expect.arrayContaining([
      { kind: 'features', label: '1 pocket', features: [{ featureId: 'PocketV2-default_c2', occurrenceIndex: 0 }] },
      { kind: 'features', label: '1 pocket', features: [{ featureId: 'PocketV2-default_c2', occurrenceIndex: 1 }] },
    ]));
  });
});
