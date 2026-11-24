// One stock model for every machined part (user decision 2026-11-22): a part whose Process is Machining is costed as a Stock Machining
// part, less the Band Saw. Each route's quote is put together here as the costing service puts it together (stockMachiningRoutes): the
// stock chosen by memory/Stock Maching's rules, handed to the real machining engine as the piece it starts from (stockEngineInput), and
// laid on the engine's quote (withStockMachining). On the data's own tables, saws and materials.
import { bandSaws, realStockMachiningReference, stockMaterial } from '../stock/stock-test-data';
import { realPartoffTable } from '../machining/real-reference-tables';
import { resolveSandReference } from '../../../../../modules/bom-items/costing/casting/sand/sand-reference';
import { specAsCalculators } from '../../../../../modules/bom-items/costing/machining/calculators/machining-calculator-spec';
import {
  computeMillingCostSummary, computeTurningCostSummary, NO_STOCK_WARNING, type MachineClassId, type MachiningCostInput,
} from '../../../../../modules/bom-items/costing/machining/process/cost-machining-engine';
import { findRouteDataGaps } from '../../../../../modules/bom-items/costing/shared/core/engine-kernel';
import { stockReference } from '../../../../../modules/bom-items/costing/stock/stock-reference';
import { BAND_SAW_CUT_SOURCE } from '../../../../../modules/bom-items/costing/stock/stock-research';
import { stockMachiningCalculatorsByName } from '../../../../../modules/bom-items/costing/stock-machining/calculators/stock-machining-calculator-spec';
import {
  PARTED_OFF, SAW_NOT_COSTED, stockEngineInput, stockMachiningBreakdown, withStockMachining, type StockMachiningPlan,
} from '../../../../../modules/bom-items/costing/stock-machining/stock-machining-cost-summary';
import { chooseStockMachining, priceStockMachining, type StockMachiningMaterialInput } from '../../../../../modules/bom-items/costing/stock-machining/stock-machining-cost.service';
import { BAR_FED_LATHE_CLASSES, stockCutOffOf } from '../../../../../modules/bom-items/costing/stock-machining/stock-machining-route';

import type { MHRRateInput } from '../../../../../modules/bom-items/costing/shared/core/cost-engine';
import type { StockPartInput } from '../../../../../modules/bom-items/costing/stock/stock-part';
import type { CostSummaryDto } from '../../../../../modules/bom-items/dto/cost-breakdown.dto';
import { workbookFixture } from '../machining/workbook-fixture';

const REF = realStockMachiningReference();
const STOCK = stockReference(REF).reference!;
const CALCS = specAsCalculators();
const ZERO = { qairPerHr: 0, inspTimeMin: 0, samplingRate: 0, yieldPct: 1, netMatCost: 0, netWeightKg: 0, scrapPricePerKg: 0 };
const rate = (r: number, machineClass: string): MHRRateInput =>
  ({ rate: r, source: 'mhr_database', machineClass, machineName: 'M', commodityCode: null, setupTimeHr: 0.5 } as MHRRateInput);

// memory/Stock Maching materials, Aluminum, ANSI 6061: 2700 kg/m³, Scrap Cost Percent 9; USD/kg by form.
const price = (column: string) => stockMaterial('Aluminum, ANSI 6061', column).pricePerKgUsd!;
const AL: StockMachiningMaterialInput = {
  name: 'Aluminum, ANSI 6061', cutCode: 30.11, densityKgM3: 2700, scrapCostPercent: 9,
  pricePerKgUsd: {
    round_bar: price('Round Bar Unit Cost (USD / kg)'), hex_bar: price('Hex Bar Unit Cost (USD / kg)'), rectangular_bar: price('Rectangular Bar Unit Cost (USD / kg)'),
    square_bar: price('Square Bar Unit Cost (USD / kg)'), plate: price('Plate Cost Per KG (USD / kg)'), round_tube: price('Round Tube Unit Cost (USD / kg)'),
  },
};

// The Lead Screw side shaft: Ø14 at its largest with a Ø12 step at each end, 32 long, 2646 mm³. Its stock in the USA is 5/8 in round bar.
const SHAFT: StockPartInput = {
  machiningStock: {
    extractionVersion: 'stk_v1', axis: [0, 1, 0], axisSource: 'turned', lengthMm: 32, round: { od_mm: 14 }, rect: { width_mm: 14, height_mm: 14, angle_deg: 0 },
    hex: null, bore: null, endFaces: { min: [5], max: [22] }, stockSurface: { round: [{ face_id: 9, kind: 'CurvedWall', area_mm2: 334.876 }], rect: [], hex: [] },
  },
  family: 'mill_turn', box: { length: 32, width: 14, height: 14 }, volumeMm3: 2646, turned: { diameterMm: 14, lengthMm: 32 },
};
// The stiffener: 159.5 x 42 x 8, 15208 mm³. Its stock is rectangular bar.
const STIFFENER: StockPartInput = { machiningStock: undefined, family: 'milled', box: { length: 159.5, width: 42, height: 8 }, volumeMm3: 15208 };
const AREA = (Math.PI / 4) * 15.875 ** 2; // the 5/8 in bar's section: 197.93 mm²
const BAR_KG = (6096 * AREA * 2700) / 1e9; // the 6096 mm bar: 3.2578 kg

/** The part's stock chosen and priced: `sawCosted` true is a Stock Machining part's, false any other machined part's. */
function plan(part: StockPartInput, sawCosted: boolean, overrides: Record<string, unknown> = {}): StockMachiningPlan {
  const { choice } = chooseStockMachining({ ref: REF, stock: STOCK, location: 'USA', part, overrides });
  const priced = priceStockMachining({
    choice: choice!, calculators: stockMachiningCalculatorsByName(), sawCosted, saws: sawCosted ? bandSaws('USA') : [], material: AL, location: 'USA',
    batchSize: 100, usdToLocal: 1, costContext: ZERO,
  });
  return { sawCosted, choice, priced, scrapCostPercent: AL.scrapCostPercent, missing: [], warnings: [] };
}

const base = (family: 'turned' | 'milled', box: { length: number; width: number; height: number }, volume: number): Omit<MachiningCostInput, 'mhrRate'> => ({
  volume, surfaceArea: 1500, maxLength: box.length, maxWidth: box.width, maxHeight: box.height,
  holeCount: 0, holeGroups: [], pocketCount: 0,
  // The route comparison's own price is the family's; the stock's form price replaces it on each route (stockEngineInput).
  materialGrade: 'Aluminum, ANSI 6061', materialCostPerKg: 99, materialDensityKgM3: 2700,
  materialSource: 'db', threads: [], tightestToleranceMm: null, gdtFeatureCount: 0,
  batchSize: 100, family, finishedWeightKg: (volume * 2700) / 1e9,
  tappingRate: rate(900, 'tapping'), deburrRate: rate(300, 'manual_deburr'), inspectionRate: rate(450, 'machining_inspection'),
  surfaceTreatment: null, machiningCalculators: CALCS, workbook: workbookFixture(), partoffTable: realPartoffTable(),
});

/** A lathe route's quote of the shaft, as the costing service prices it: the engine on the stock of the route's cut-off, then the stock on its quote. */
function latheRoute(p: StockMachiningPlan, cls: string): CostSummaryDto {
  const cutOff = stockCutOffOf(cls);
  const engine = computeTurningCostSummary({
    ...base('turned', SHAFT.box, SHAFT.volumeMm3),
    turnedGeometry: {
      diameterMm: 14, lengthMm: 32, diameterSource: 'CAD: largest turned outer diameter (Ring feature)', lengthSource: 'CAD: extent along the turning axis',
      rings: [{ id: 'od_0', diameterMm: 14, lengthMm: 8, faceIds: [9] }, { id: 'od_1', diameterMm: 12, lengthMm: 18, faceIds: [17] }, { id: 'od_2', diameterMm: 12, lengthMm: 5, faceIds: [24] }],
    },
    workbook: workbookFixture(),
    ...stockEngineInput(p.choice, cutOff, AL.pricePerKgUsd),
    // A lathe's own spindle limit (mhr_records.specs spindle_speed_rpm, migration 1136).
    mhrRate: { ...rate(900, cls), maxSpindleRpm: 4000 },
  }, cls as MachineClassId);
  return withStockMachining(engine, p, cutOff);
}
/** A mill's quote of the stiffener: the milling engine prices no parting, so a mill's piece is always cut to length. */
function millRoute(p: StockMachiningPlan): CostSummaryDto {
  const engine = computeMillingCostSummary({
    ...base('milled', STIFFENER.box, STIFFENER.volumeMm3),
    featureOps: [{ name: 'Rough Mill', timeSec: 120, source: 'feature' }],
    ...stockEngineInput(p.choice, 'saw', AL.pricePerKgUsd),
    mhrRate: rate(600, '3_axis_mill'),
  }, '3_axis_mill' as MachineClassId);
  return withStockMachining(engine, p, 'saw');
}

const processes = (q: CostSummaryDto) => q.processLines.map((l) => l.process);
const stockGaps = (q: CostSummaryDto) => findRouteDataGaps(q.processLines).filter((g) => /Material Stock|Band Saw|Turning|Parting/.test(g.process));
const LATHES = ['2_axis_lathe', '3_axis_lathe', 'machining_millturn', '2_axis_bar_feed_lathe_with_sub_spindle', '3_axis_bar_feed_lathe_with_sub_spindle'];

describe('a Machining part on a lathe: the stock model\'s stock, no Band Saw, and Parting only where the lathe is fed the bar', () => {
  const machining = plan(SHAFT, false);

  it.each(LATHES.filter((cls) => !BAR_FED_LATHE_CLASSES.has(cls)))('%s is loaded with a piece cut to length: no Band Saw line, no Parting line, the kerf in the bar\'s yield', (cls) => {
    const q = latheRoute(machining, cls);
    expect(processes(q)).not.toContain('Band Saw');
    expect(processes(q)).not.toContain('Parting');
    expect(processes(q)).toEqual(expect.arrayContaining(['Rough Turning', 'Finish Turning']));
    // The 5/8 in bar over its 172 sawn pieces at the round bar price (5.875 USD/kg), never the family's own price: 0.11128, not rounded to cents.
    expect(q.materialCost).toBeCloseTo((BAR_KG / 172) * 5.875, 10);
    expect(q.grossWeightKg).toBeCloseTo(BAR_KG / 172, 3);
    // The note, once; nothing of the stock or the turning is a gap.
    expect(q.warnings.filter((w) => w === SAW_NOT_COSTED)).toHaveLength(1);
    expect(q.warnings).not.toContain(PARTED_OFF);
    expect(stockGaps(q)).toEqual([]);
    expect(q.totalCost).toBe(q.materialCost + q.totalProcessCost);
  });

  it.each([...BAR_FED_LATHE_CLASSES])('%s parts the piece off the bar: its Parting line, the parting width in the yield, and no word of a saw', (cls) => {
    const q = latheRoute(machining, cls);
    expect(processes(q)).not.toContain('Band Saw');
    expect(processes(q)).toContain('Parting');
    // The parting tool is wider than the saw's kerf: 164 pieces a bar. 3.2578 kg / 164 x 5.875 = 0.1167, not rounded to cents.
    expect(q.materialCost).toBeCloseTo((BAR_KG / 164) * 5.875, 10);
    expect(q.warnings).toContain(PARTED_OFF);
    expect(q.warnings).not.toContain(SAW_NOT_COSTED);
    expect(stockGaps(q)).toEqual([]);
  });

  it('the bar it is turned down from is the stock model\'s: each step is roughed from the 5/8 in bar, and the source says what chose it', () => {
    const rough = latheRoute(machining, '2_axis_lathe').processLines.find((l) => l.process === 'Rough Turning')!;
    const bars = rough.calculationTrace!.filter((s) => s.fieldName.endsWith('Bar Diameter'));
    expect(bars.length).toBeGreaterThan(0);
    for (const bar of bars) expect(bar).toMatchObject({ value: 15.875, source: 'Stock Machining stock (tblPreferredSizes): 5/8" round bar' });
  });
});

describe('the same part as Stock Machining: the same quote, with the Band Saw line', () => {
  const machining = plan(SHAFT, false);
  const stockMachining = plan(SHAFT, true);

  it.each(LATHES)('%s: the Machining quote is the Stock Machining quote less its Band Saw line', (cls) => {
    const sm = latheRoute(stockMachining, cls);
    const m = latheRoute(machining, cls);
    const saw = sm.processLines.filter((l) => l.process === 'Band Saw');
    // Only a lathe loaded with a sawn piece has the line; a bar-fed lathe's two quotes are one quote.
    expect(saw).toHaveLength(BAR_FED_LATHE_CLASSES.has(cls) ? 0 : 1);
    expect(sm.processLines.filter((l) => l.process !== 'Band Saw')).toEqual(m.processLines);
    expect(m.materialCost).toBe(sm.materialCost);
    expect(m.grossWeightKg).toBe(sm.grossWeightKg);
    expect(sm.totalProcessCost - m.totalProcessCost).toBeCloseTo(saw.reduce((s, l) => s + l.totalCost, 0), 10);
    // The two quotes say the same, but for the saw: its own note on one, that it is not costed on the other.
    expect(m.warnings.filter((w) => w !== SAW_NOT_COSTED)).toEqual(sm.warnings.filter((w) => w !== BAND_SAW_CUT_SOURCE));
  });

  it('a Stock Machining quote keeps its Band Saw line in front, on the saw the data picks', () => {
    const q = latheRoute(stockMachining, '2_axis_lathe');
    expect(processes(q)[0]).toBe('Band Saw');
    expect(q.processLines[0]).toMatchObject({ processGroup: 'Stock Machining', machineName: 'DoAll 3613-1 Vert' });
    expect(q.processLines[0].totalCost).toBeGreaterThan(0);
    expect(q.warnings).not.toContain(SAW_NOT_COSTED);
  });
});

describe('a Machining part on a mill', () => {
  it('is cut from the stock model\'s bar at its form\'s price, with no Band Saw line; Stock Machining adds only that line', () => {
    const m = millRoute(plan(STIFFENER, false));
    const sm = millRoute(plan(STIFFENER, true));
    expect(processes(m)).not.toContain('Band Saw');
    expect(processes(sm)[0]).toBe('Band Saw');
    expect(sm.processLines.slice(1)).toEqual(m.processLines);
    // 42 x 8 with 2.1 mm a side takes a 2 x 1/2 in bar (50.8 x 12.7 mm), 36 pieces a bar, at the rectangular bar price.
    const barKg = (50.8 * 12.7 * 6096 * 2700) / 1e9;
    expect(m.materialCost).toBeCloseTo((barKg / 36) * AL.pricePerKgUsd.rectangular_bar!, 10);
    expect(m.materialCost).toBe(sm.materialCost);
    expect(m.warnings).toContain(SAW_NOT_COSTED);
    expect(stockMachiningBreakdown(plan(STIFFENER, false), 'saw', 100)!.stock).toMatchObject({ form: 'rectangular_bar', partsPerStock: 36 });
  });
});

describe('a stock that cannot be chosen is a named gap: nothing is estimated in its place, and the quote is never refused', () => {
  // The staged reference is absent: the cost service has no rules to choose by (stockReference names what is missing).
  const notStaged = stockReference(resolveSandReference({ variables: [], lookups: [] })).missing;
  const noSize = chooseStockMachining({ ref: REF, stock: STOCK, location: 'USA', overrides: {}, part: { ...SHAFT, machiningStock: undefined, box: { length: 0, width: 0, height: 0 } } });

  it.each([
    ['the reference is not staged', notStaged],
    ['the part has no size', noSize.missing],
  ])('%s: a Material Stock gap line, no material, the lathe\'s bar named as missing', (_why, missing) => {
    expect(missing.length).toBeGreaterThan(0);
    for (const sawCosted of [false, true]) {
      const q = latheRoute({ sawCosted, choice: null, priced: null, scrapCostPercent: null, missing, warnings: [] }, '2_axis_lathe');
      expect(processes(q)[0]).toBe('Material Stock');
      expect(processes(q)).not.toContain('Band Saw');
      expect(q.processLines[0]).toMatchObject({ totalCost: 0, physicsGap: { reason: expect.stringContaining(missing[0]) } });
      expect(q.materialCost).toBe(0);
      expect(q.grossWeightKg).toBe(0);
      expect(q.warnings).toContain(NO_STOCK_WARNING);
      // The lathe has no bar to turn down from: named on its own lines, not priced from a size of the engine's making.
      const gaps = findRouteDataGaps(q.processLines);
      expect(gaps.map((g) => g.process)).toEqual(expect.arrayContaining(['Material Stock', 'Rough Turning']));
      expect(gaps.find((g) => g.process === 'Rough Turning')!.reason).toContain('no stock is chosen');
      // Every line still has a cost of 0 or more and the total adds up: the quote is returned, and Apply writes the gaps as No Cost Features.
      expect(q.totalCost).toBe(q.materialCost + q.totalProcessCost);
    }
  });

  it('a mill with no stock: no material and the Material Stock gap; the features are still milled', () => {
    const q = millRoute({ sawCosted: false, choice: null, priced: null, scrapCostPercent: null, missing: notStaged, warnings: [] });
    expect(processes(q)[0]).toBe('Material Stock');
    expect(q.materialCost).toBe(0);
    expect(q.processLines.find((l) => l.machineClass === '3_axis_mill')!.cycleTimeMin).toBeGreaterThan(0);
    expect(stockMachiningBreakdown({ sawCosted: false, choice: null, priced: null, scrapCostPercent: null, missing: notStaged, warnings: [] }, 'saw', 100)).toBeUndefined();
  });
});
