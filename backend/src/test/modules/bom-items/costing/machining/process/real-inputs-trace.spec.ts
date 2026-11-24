import {
  computeDrillCycle,
  computeTurningCostSummary,
  type MachiningCostInput,
  type MachineClassId,
} from '../../../../../../modules/bom-items/costing/machining/process/cost-machining-engine';
import { specAsCalculators } from '../../../../../../modules/bom-items/costing/machining/calculators/machining-calculator-spec';

const CALCS = specAsCalculators();
import { resolvePartoffParams } from '../../../../../../modules/bom-items/costing/machining/lookup/partoff-table';
import type { MHRRateInput } from '../../../../../../modules/bom-items/costing/shared/core/cost-engine';
import { findRouteDataGaps } from '../../../../../../modules/bom-items/costing/shared/core/engine-kernel';
import { stockReference } from '../../../../../../modules/bom-items/costing/stock/stock-reference';
import { stockBlankResult } from '../../../../../../modules/bom-items/costing/stock-machining/stock-machining-cost-summary';
import { chooseStockMachining } from '../../../../../../modules/bom-items/costing/stock-machining/stock-machining-cost.service';
import { realHobbingReference, realPartoffTable } from '../real-reference-tables';
import { realStockMachiningReference } from '../../stock/stock-test-data';
import { workbookFixture } from '../workbook-fixture';

// Machining cycle times from real inputs only — CAD geometry and the real
// machining_reference_data tables (read here from the same source CSVs the
// migrations staged). Every number below is either measured, looked up, or
// derived from those by the formula the trace states.

const mc = (s: string) => s as MachineClassId;
const rate = (r: number, extra: Partial<MHRRateInput> = {}): MHRRateInput =>
  ({ rate: r, source: 'mhr_database', machineClass: 'x', machineName: 'M', commodityCode: null, ...extra } as MHRRateInput);

// Drilling, as the machining workbook's Drilling sheet times it (calculator of migration 1139): a Ø4 hole in aluminium is in the
// 4-6 mm band of its drilling table (feed 0.13 mm/rev, 75-110 m/min, 92.5 at the middle); n = 92 500 / (pi x 4) = 7360.9 rpm on a
// 10 000 rpm machine; (3.029 + 10) / (0.13 x 7360.9) = 0.013615 min = 0.817 s -> 1 s.
const MILL_10K = { 'Max Spindle Speed': { value: 10000, source: 'Machine: test spindle_speed_rpm' } };
describe('computeDrillCycle — the workbook\'s drilling data, gaps instead of guesses', () => {
  it('without a CAD depth the hole is not priced and the missing input is named', () => {
    const c = computeDrillCycle(4, 'AL6061-T6', undefined, workbookFixture(), CALCS, 1, undefined, MILL_10K);
    expect(c.sec).toBeNull();
    expect(c.missing).toContain('Drilling: Hole Depth');
  });

  it('without the workbook\'s tables the hole is not priced', () => {
    const c = computeDrillCycle(4, 'AL6061-T6', 3.029, null, CALCS, 1, undefined, MILL_10K);
    expect(c.sec).toBeNull();
    expect(c.missing.join(' ')).toContain('tblDrillReamData (machining_reference_data) could not be read');
  });

  it('without a machine there is no spindle limit: planned, not timed', () => {
    const c = computeDrillCycle(4, 'AL6061-T6', 3.029, workbookFixture(), CALCS);
    expect(c.sec).toBeNull();
    expect(c.missing.join(' ')).toContain('Max Spindle Speed');
    expect(c.plan?.operation).toBe('Drilling');
  });

  it('times the hole from its CAD depth + 10 mm, whole seconds, and every trace input names its source', () => {
    const c = computeDrillCycle(4, 'AL6061-T6', 3.029, workbookFixture(), CALCS, 1, undefined, MILL_10K);
    expect(c.sec).toBe(1);
    const step = (name: string) => c.trace.find((s) => s.fieldName === name);
    expect(step('Feed')).toMatchObject({ value: 0.13, source: expect.stringContaining('tblDrillReamData: ALUMINUM ALLOY CAST AND WROUGHT, Hole Diameter 4 in 4-6') });
    expect(step('Cutting Speed')).toMatchObject({ value: 92.5 });
    expect(step('Spindle Speed')).toMatchObject({ value: 7360.92 });
    expect(c.calculatorId).toBe('Machining - Drilling');
    // The drill's wear: Rs 624.80 over 600 parts.
    expect(step('Tool Cost per Part')).toMatchObject({ value: 1.0413 });
  });
});

describe('part-off insert selection (tblVirtualPartoffInsertCutData)', () => {
  const rows = realPartoffTable();

  it('picks the narrowest insert whose reach covers the cut', () => {
    const p = resolvePartoffParams(rows, 10, 'aluminum')!;
    const sameMaterial = rows.filter((r) => r.MaterialCutCodeName === p.materialCutCode && r.Hardness === p.hardnessHb);
    const reaching = sameMaterial.filter((r) => r.DepthMaxMm >= 10);
    expect(p.insertWidthMm).toBe(Math.min(...reaching.map((r) => r.LengthMm)));
    expect(p.depthMaxMm).toBeGreaterThanOrEqual(10);
  });

  it('has no parameters for a cut deeper than any real insert reaches', () => {
    const deepest = Math.max(...rows.map((r) => r.DepthMaxMm));
    expect(resolvePartoffParams(rows, deepest + 1, 'aluminum')).toBeNull();
  });
});

describe('turned part costed from CAD geometry (a Ø17.6 × 3.0 mm gear blank)', () => {
  // The reported part: bounding box 17.6 × 17.6 × 3.0 mm; the cad-engine
  // recognised its turned OD as a Ø17.6 mm Ring, 3.0 mm along the axis.
  const input = (overrides: Partial<MachiningCostInput> = {}): MachiningCostInput => ({
    volume: 552.64, surfaceArea: 704.7, maxLength: 17.6, maxWidth: 17.6, maxHeight: 3,
    holeCount: 1, holeGroups: [{ diameter_mm: 4, count: 1, depth_mm: 3.029 }], pocketCount: 0,
    materialGrade: 'Aluminum, ANSI 6061', materialCostPerKg: 5.875, materialDensityKgM3: 2700,
    materialSource: 'db', threads: [], tightestToleranceMm: null, gdtFeatureCount: 0,
    batchSize: 250, family: 'turned', finishedWeightKg: 0.0015,
    // The Haas DS-30's own 4000 rpm spindle (memory/machining/machine, migration 1136).
    mhrRate: rate(2841.505, { machineClass: '2_axis_bar_feed_lathe_with_sub_spindle', setupTimeHr: 0.25, maxSpindleRpm: 4000 }),
    tappingRate: rate(900, { machineClass: 'tapping' }),
    deburrRate: rate(300, { machineClass: 'manual_deburr' }),
    inspectionRate: rate(450, { machineClass: 'machining_inspection' }),
    surfaceTreatment: null,
    machiningCalculators: CALCS,
    turnedGeometry: {
      diameterMm: 17.6, lengthMm: 3,
      diameterSource: 'CAD: largest turned outer diameter (Ring feature)',
      lengthSource: 'CAD: bounding-box extent along the turning axis',
    },
    blankResult: { form: 'round_bar', sizeLabel: 'Ø20 round bar', billetVolMm3: Math.PI * 10 ** 2 * 8, utilizationPct: 50, barDiameterMm: 20, endAllowanceMm: 0.5 },
    workbook: workbookFixture(),
    partoffTable: realPartoffTable(),
    ...overrides,
  });

  const result = computeTurningCostSummary(input(), mc('2_axis_bar_feed_lathe_with_sub_spindle'));
  const line = (name: string) => result.processLines.find((l) => l.process === name)!;

  it('turns over the CAD axial length (3.0 mm), not the bounding-box long side (17.6 mm)', () => {
    const trace = line('Finish Turning').calculationTrace!;
    expect(trace.find((s) => s.fieldName === 'Turned Length')).toMatchObject({ value: 3, source: expect.stringContaining('turning axis') });
    expect(line('Finish Turning').calculatorId).toBe('Machining - Finish Turning');
  });

  // The workbook's Turning cutting conditions for aluminium on carbide, at the middle of each range: rough (2 mm deep) 270 m/min and
  // 0.25 mm/rev, finish (0.5 mm deep) 375 m/min and 0.125 mm/rev; the spindle capped at the lathe's 4000 rpm.
  it('the Ø20 bar leaves 0.7 mm above the finish cut: one whole rough pass, rounded up to whole seconds', () => {
    // Radial stock (20 - 17.6) / 2 = 1.2 mm: the 0.5 mm finish cut, and 0.7 mm for roughing: ceil(1.4 / 4) = 1 pass. From the bar:
    // min(4000, 270 * 1000 / (pi * 20) = 4297.18) = 4000 rpm, 1000 mm/min; (3 + 10) / 1000 = 0.78 s -> 1 s.
    const rough = line('Rough Turning');
    expect(rough.calculationTrace!.find((s) => s.fieldName === 'Finish Start Diameter')).toMatchObject({ value: 18.6, unit: 'mm' });
    expect(rough.calculationTrace!.find((s) => s.fieldName === 'Rough Passes')).toMatchObject({ value: 1 });
    expect(rough.calculationTrace!.find((s) => s.fieldName === 'Spindle Speed')).toMatchObject({ value: 4000 });
    expect(rough.cycleTimeMin * 60).toBeCloseTo(1, 2);
    expect(findRouteDataGaps(result.processLines).filter((g) => g.process.includes('Turning'))).toEqual([]);
  });

  it('a bar that leaves no more than the finish cut is not roughed: no Rough Turning line, and that is not a data gap', () => {
    // Ø18.6 bar: radial stock 0.5 mm, the finish depth of cut: the finish cut starts at the bar and takes it all.
    const snug = computeTurningCostSummary(
      input({ blankResult: { form: 'round_bar', sizeLabel: 'Ø18.6 round bar', billetVolMm3: Math.PI * 9.3 ** 2 * 8, utilizationPct: 55, barDiameterMm: 18.6, endAllowanceMm: 0.5 } }),
      mc('2_axis_bar_feed_lathe_with_sub_spindle'),
    );
    expect(snug.processLines.find((l) => l.process === 'Rough Turning')).toBeUndefined();
    const finish = snug.processLines.find((l) => l.process === 'Finish Turning')!;
    expect(finish.calculationTrace!.find((s) => s.fieldName === 'Finish Start Diameter')).toMatchObject({ value: 18.6 });
    // min(4000, 375 * 1000 / (pi * 18.6) = 6417.5) = 4000 rpm; 500 mm/min; (3 + 10) / 500 = 1.56 s -> 2 s.
    expect(finish.cycleTimeMin * 60).toBeCloseTo(2, 2);
    expect(findRouteDataGaps(snug.processLines).filter((g) => g.process.includes('Turning'))).toEqual([]);
  });

  it('a larger bar is rough turned from its own diameter, by the database calculator', () => {
    // Ø25 bar: the finish cut starts at 17.6 + 1 = 18.6 mm; roughing takes ceil((25 - 18.6) / 4) = 2 passes from the bar.
    const larger = computeTurningCostSummary(
      input({ blankResult: { form: 'round_bar', sizeLabel: 'Ø25 round bar', billetVolMm3: Math.PI * 12.5 ** 2 * 8, utilizationPct: 30, barDiameterMm: 25, endAllowanceMm: 0.5 } }),
      mc('2_axis_bar_feed_lathe_with_sub_spindle'),
    );
    const rough = larger.processLines.find((l) => l.process === 'Rough Turning')!;
    expect(rough.calculationTrace!.find((s) => s.fieldName === 'Bar Diameter')).toMatchObject({ value: 25, source: expect.stringContaining('Ø25 round bar') });
    expect(rough.calculationTrace!.find((s) => s.fieldName === 'Rough Passes')).toMatchObject({ value: 2 });
    // The spindle speed is the bar's, under the machine's limit: 270 * 1000 / (pi * 25) = 3437.75 rpm.
    expect(rough.calculationTrace!.find((s) => s.fieldName === 'Spindle Speed')).toMatchObject({ value: 3437.75, unit: 'rpm' });
    // (3 + 10) / (0.25 x 3437.75) x 2 = 0.03025 min = 1.82 s -> 2 s.
    expect(rough.cycleTimeMin * 60).toBeCloseTo(2, 2);
    expect(rough.calculatorId).toBe('Machining - Rough Turning');
  });

  it('drills the Ø4 hole to its real 3.029 mm CAD depth', () => {
    const drilling = line('Drilling');
    // Derived: its 10 mm approach (the workbook's Drilling sheet) is a stated allowance.
    expect(drilling.confidence).toBe('derived');
    expect(drilling.calculationTrace!.find((s) => s.fieldName === 'Hole Depth')).toMatchObject({ value: 3.029, source: 'CAD: hole depth' });
    expect(drilling.cycleTimeMin * 60).toBeCloseTo(computeDrillCycle(4, 'Aluminum, ANSI 6061', 3.029, workbookFixture(), CALCS, 1, undefined, { 'Max Spindle Speed': { value: 4000, source: 'test' } }).sec!, 1);
  });

  it('parts off through the bar radius with a real insert', () => {
    const parting = line('Parting');
    // Derived: its 10 mm approach (the workbook's Cutoff sheet) is a stated allowance, not a measurement.
    expect(parting.confidence).toBe('derived');
    expect(parting.calculationTrace!.find((s) => s.fieldName === 'Cut Depth')).toMatchObject({ value: 10 });
    expect(parting.cycleTimeMin).toBeGreaterThan(0);
  });

  it('the setup folded into the lathe\'s first cut (End Machining, the facing) names the machine record it came from', () => {
    const trace = line('End Machining').calculationTrace!;
    expect(trace.find((s) => s.fieldName === 'Setup time')).toMatchObject({ value: 15, source: expect.stringContaining('setup_time_hr') });
    expect(result.processLines.filter((l) => l.setupTimeSource === 'machine').map((l) => l.process)).toEqual(['End Machining']);
  });

  it('a part analysed before edge measurement shows the deburring gap, not an estimate', () => {
    const deburr = line('Deburring');
    expect(deburr.cycleTimeMin).toBe(0);
    expect(deburr.physicsGap).toMatchObject({ reason: expect.stringContaining('CAD sharp-edge length') });
  });
});

describe('gear teeth recognised by CAD (AxiGroove) are hobbed from tblHobbing / tblAnsiHobbing', () => {
  const HOBBING = realHobbingReference();
  const turned = (overrides: Record<string, unknown>) => computeTurningCostSummary({
    volume: 552.64, surfaceArea: 704.7, maxLength: 17.6, maxWidth: 17.6, maxHeight: 3,
    holeCount: 0, holeGroups: [], pocketCount: 0,
    materialGrade: 'Aluminum, ANSI 6061', materialCostPerKg: 5.875, materialDensityKgM3: 2700,
    materialSource: 'db', threads: [], tightestToleranceMm: null, gdtFeatureCount: 0,
    batchSize: 250, family: 'turned', finishedWeightKg: 0.0015,
    mhrRate: rate(2841.505, { machineClass: '2_axis_bar_feed_lathe_with_sub_spindle' }),
    tappingRate: rate(900, { machineClass: 'tapping' }),
    deburrRate: rate(300, { machineClass: 'manual_deburr' }),
    inspectionRate: rate(450, { machineClass: 'machining_inspection' }),
    surfaceTreatment: null,
    machiningCalculators: CALCS,
    hobRate: rate(1500, { machineClass: 'hob_machine' }),
    hobbing: HOBBING,
    ...overrides,
  } as any, mc('2_axis_bar_feed_lathe_with_sub_spindle'));

  it('prices a module-2 steel gear: ANSI hob, tblHobbing speed/feed at the nearest diametral pitch, face width + approach', () => {
    // 30 teeth, tip Ø64 -> module 2; root Ø55 -> tooth depth 4.5; face width 20.
    const r = turned({ materialGrade: 'AISI 1018', toothForms: [{ tooth_count: 30, tip_diameter_mm: 64, root_diameter_mm: 55, face_width_mm: 20 }] });
    const hob = r.processLines.find((l) => l.machineClass === 'hob_machine')!;
    const ansi = HOBBING.ansiRows.filter((a: any) => a.num_starts === HOBBING.defaultNumStarts)
      .reduce((b: any, a: any) => (Math.abs(a.module_mm - 2) < Math.abs(b.module_mm - 2) ? a : b));
    // Module 2 -> diametral pitch 12.7 -> the tabulated DP 11 row of code 1.0 (125 HB).
    const row = HOBBING.hobRows.find((h: any) => h['Material Cut Code Name'] === 1 && h['Diametral Pitch'] === 11)!;
    const hobRpm = (row['Cutting Speed (m / min)'] * 1000) / (Math.PI * ansi.hob_diameter_mm);
    const travel = 20 + Math.sqrt(4.5 * (ansi.hob_diameter_mm - 4.5));
    const sec = (travel * 30) / (hobRpm * HOBBING.defaultNumStarts * row['Feed (mm / rev)']) * 60;
    expect(hob.cycleTimeMin).toBeCloseTo(sec / 60, 2);
    expect(hob.calculationTrace!.find((st) => st.fieldName === 'Hob Diameter')!.source).toContain('tblAnsiHobbing: module');
    expect(hob.calculationTrace!.find((st) => st.fieldName === 'Axial Feed')!.source).toContain('diametral pitch 11');
  });

  it('shows the real 40-tooth aluminium gear (module 0.42) as a named gap: below the smallest ANSI hob and the tables have no aluminium hardness', () => {
    const r = turned({ toothForms: [{ tooth_count: 40, tip_diameter_mm: 17.6, root_diameter_mm: 15.2, face_width_mm: 3 }] });
    const hob = r.processLines.find((l) => l.machineClass === 'hob_machine')!;
    expect(hob.cycleTimeMin).toBe(0);
    const gap = JSON.stringify(hob.physicsGap ?? r.warnings);
    expect(gap).toContain('tblAnsiHobbing');
    expect(hob.calculationTrace!.find((s) => s.fieldName === 'Teeth')).toMatchObject({ value: 40, source: expect.stringContaining('CAD') });
  });
});

describe('lookup-table viewer: the row a machining input came from is identifiable in the flattened table', () => {
  it('the Drilling match outlines exactly the one row of the workbook\'s drilling table the feed and speed came from', () => {
    const { flattenMachiningLookupTable } = require('../../../../../../modules/bom-items/costing/machining/lookup/machining-lookup-tables');
    const table = workbookFixture();
    const flat = flattenMachiningLookupTable('tblDrillReamData', table.tables.tblDrillReamData);
    const c = computeDrillCycle(4, 'AL6061-T6', 3.029, table, CALCS, 1, undefined, { 'Max Spindle Speed': { value: 10000, source: 'test' } });
    const match = c.lookups['Feed']!;
    expect(match.table).toBe('tblDrillReamData');
    const outlined = flat.rows.filter((r: any) => Object.entries(match.row).every(([k, v]) => r[k] === v));
    expect(outlined).toHaveLength(1);
    expect(outlined[0]).toMatchObject({ WorkMaterial: 'ALUMINUM ALLOY CAST AND WROUGHT', Operation: 'Drilling', DiameterMinMm: 4, FeedMmPerRev: 0.13 });
  });
});

// The route comparison prices each lathe route with the same engine as the Cost tab. Its input once had no blank: the turning engine then
// had no bar diameter, so every lathe route carried a bar stock data gap, no route was data-complete, and Apply on the R_M-0230-032
// lead nut housing (30 x 24.5 x 21 mm, mill-turn) found "no route both feasible and fully costed" while the Cost tab priced it.
describe('a lathe route is priced from the bar the stock model chose (route comparison = Cost tab)', () => {
  const leadNut = (blankResult?: unknown) => computeTurningCostSummary({
    volume: 5539.5, surfaceArea: 5563.39, maxLength: 30, maxWidth: 24.5, maxHeight: 21,
    holeCount: 0, holeGroups: [], pocketCount: 0,
    materialGrade: 'Aluminum, AA 1100', materialCostPerKg: 5.981, materialDensityKgM3: 2710,
    materialSource: 'db', threads: [], tightestToleranceMm: null, gdtFeatureCount: 0,
    batchSize: 3, family: 'turned', finishedWeightKg: 0.015,
    mhrRate: rate(60, { machineClass: '3_axis_bar_feed_lathe_with_sub_spindle' }),
    tappingRate: rate(60, { machineClass: 'tapping' }),
    deburrRate: rate(40, { machineClass: 'manual_deburr' }),
    inspectionRate: rate(45, { machineClass: 'machining_inspection' }),
    surfaceTreatment: null, machiningCalculators: CALCS, partoffTable: realPartoffTable(),
    ...(blankResult ? { blankResult } : {}),
  } as any, mc('3_axis_bar_feed_lathe_with_sub_spindle'));
  const barGaps = (r: ReturnType<typeof leadNut>) =>
    findRouteDataGaps(r.processLines).filter((g) => JSON.stringify(g).includes('bar stock for this part'));

  it('without a stock, turning and parting are data gaps and no material is costed: nothing is estimated in the stock\'s place', () => {
    const r = leadNut();
    expect(barGaps(r).map((g) => g.process)).toEqual(['Rough Turning', 'Parting']);
    expect(barGaps(r).every((g) => g.reason.includes('no stock is chosen'))).toBe(true);
    expect(r.materialCost).toBe(0);
  });

  it('with the round bar the stock model chooses for this turned part, the bar gaps are gone', () => {
    const ref = realStockMachiningReference();
    const { choice } = chooseStockMachining({
      ref, stock: stockReference(ref).reference!, location: 'India', overrides: {},
      part: { machiningStock: undefined, family: 'turned', box: { length: 30, width: 24.5, height: 21 }, volumeMm3: 5539.5, turned: { diameterMm: 24.5, lengthMm: 30 } },
    });
    // The bar-fed lathe parts the piece off the bar: Ø24.5 with 5 % of it a side (1.225 mm) needs Ø26.95, the next metric size up.
    const bar = stockBlankResult(choice!, 'parting')!;
    expect(bar.form).toBe('round_bar');
    expect(bar.barDiameterMm).toBeGreaterThanOrEqual(26.95);
    const r = leadNut(bar);
    expect(barGaps(r)).toEqual([]);
    expect(r.materialCost).toBeGreaterThan(0);
  });
});
