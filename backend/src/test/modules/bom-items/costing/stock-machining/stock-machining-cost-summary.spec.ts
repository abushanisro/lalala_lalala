// A machined part's stock front end as the costing service puts it on a machining route: the stock chosen from the staged rules and the
// Cost Guide (stock-machining-cost.service.ts chooseStockMachining), priced for each cut-off with every other form beside it
// (priceStockMachining), and laid on a machining route's quote (stock-machining-cost-summary.ts): with the Band Saw line for a Stock
// Machining part, without it for any other machined part (one stock model, user decision 2026-11-22). On memory/Stock Maching's own
// tables, saws and materials; expected values are worked out by hand in the comments from the files' numbers.
import { bandSaws, realStockMachiningReference, stockMaterial } from '../stock/stock-test-data';
import { findRouteDataGaps } from '../../../../../modules/bom-items/costing/shared/core/engine-kernel';
import { stockReference } from '../../../../../modules/bom-items/costing/stock/stock-reference';
import { BAR_END_REMNANT_SOURCE } from '../../../../../modules/bom-items/costing/stock/stock-research';
import { stockMachiningCalculatorsByName } from '../../../../../modules/bom-items/costing/stock-machining/calculators/stock-machining-calculator-spec';
import {
  PARTED_OFF, SAW_NOT_COSTED, STOCK_SIZE_SOURCE, stockBlankResult, stockLabelOf, stockMachiningBreakdown, withStockMachining, type StockMachiningPlan,
} from '../../../../../modules/bom-items/costing/stock-machining/stock-machining-cost-summary';
import {
  chooseStockMachining, priceStockMachining, stockMachiningSettings, stockMaterialRow, type StockMachiningChoice, type StockMachiningMaterialInput,
} from '../../../../../modules/bom-items/costing/stock-machining/stock-machining-cost.service';
import { BAR_FED_LATHE_CLASSES, stockCutOffOf } from '../../../../../modules/bom-items/costing/stock-machining/stock-machining-route';

import type { CostSummaryDto, ProcessLineCost } from '../../../../../modules/bom-items/dto/cost-breakdown.dto';
import type { StockPartInput } from '../../../../../modules/bom-items/costing/stock/stock-part';

const REF = realStockMachiningReference();
const STOCK = stockReference(REF).reference!;
const ZERO = { qairPerHr: 0, inspTimeMin: 0, samplingRate: 0, yieldPct: 1, netMatCost: 0, netWeightKg: 0, scrapPricePerKg: 0 };
const r2 = (n: number) => Math.round(n * 100) / 100;

// The Lead Screw side shaft as the cad-engine measures it: Ø14 at its largest, 32 long, 2646 mm³.
const SHAFT: StockPartInput = {
  machiningStock: {
    extractionVersion: 'stk_v1', axis: [0, 1, 0], axisSource: 'turned', lengthMm: 32, round: { od_mm: 14 }, rect: { width_mm: 14, height_mm: 14, angle_deg: 158.886 },
    hex: null, bore: null, endFaces: { min: [5], max: [22] }, stockSurface: { round: [{ face_id: 9, kind: 'CurvedWall', area_mm2: 334.876 }], rect: [], hex: [] },
  },
  family: 'mill_turn', box: { length: 32.0018, width: 14.0364, height: 14.0019 }, volumeMm3: 2646, turned: { diameterMm: 14, lengthMm: 32.0018 },
};
// memory/Stock Maching materials, Aluminum, ANSI 6061: cut code 30.11, 2700 kg/m³, Scrap Cost Percent 9; USD/kg by form.
const price = (column: string) => stockMaterial('Aluminum, ANSI 6061', column).pricePerKgUsd!;
const AL: StockMachiningMaterialInput = {
  name: 'Aluminum, ANSI 6061', cutCode: 30.11, densityKgM3: 2700, scrapCostPercent: 9,
  pricePerKgUsd: {
    round_bar: price('Round Bar Unit Cost (USD / kg)'), hex_bar: price('Hex Bar Unit Cost (USD / kg)'), rectangular_bar: price('Rectangular Bar Unit Cost (USD / kg)'),
    square_bar: price('Square Bar Unit Cost (USD / kg)'), plate: price('Plate Cost Per KG (USD / kg)'), round_tube: price('Round Tube Unit Cost (USD / kg)'),
  },
};
const AREA = (Math.PI / 4) * 15.875 ** 2; // the 5/8 in bar's section: 197.93 mm²
const BAR_KG = (6096 * AREA * 2700) / 1e9; // the 6096 mm bar: 3.2578 kg

const choose = (overrides: Record<string, unknown> = {}, location = 'USA', part: StockPartInput = SHAFT): StockMachiningChoice => {
  const { choice, missing } = chooseStockMachining({ ref: REF, stock: STOCK, location, part, overrides });
  if (!choice) throw new Error(missing.join('; '));
  return choice;
};
/** The shaft's stock chosen and priced. `sawCosted`: a Stock Machining part's quote (the default here); false is any other machined part's. */
function plan(
  overrides: Record<string, unknown> = {},
  over: { usdToLocal?: number; batchSize?: number; location?: string; material?: Partial<StockMachiningMaterialInput>; sawCosted?: boolean } = {},
): StockMachiningPlan {
  const choice = choose(overrides, over.location);
  const material = { ...AL, ...(over.material ?? {}) };
  const sawCosted = over.sawCosted ?? true;
  const priced = priceStockMachining({
    choice, calculators: stockMachiningCalculatorsByName(), sawCosted, saws: sawCosted ? bandSaws('USA') : [], material, location: over.location ?? 'USA',
    batchSize: over.batchSize ?? 25, usdToLocal: over.usdToLocal ?? 1, costContext: ZERO,
  });
  return { sawCosted, choice, priced, scrapCostPercent: material.scrapCostPercent, missing: [], warnings: [] };
}
/** The stock of a part whose Process is Machining: the same stock, its sawing not costed. */
const machiningPlan = (overrides: Record<string, unknown> = {}) => plan(overrides, { sawCosted: false });

/** A lathe route's quote as the turning engine returns it: two lines at 1.00 and 0.50, the material the engine priced on the stock bought. */
const line = (process: string, totalCost: number, cycleTimeMin: number): ProcessLineCost => ({
  process, processGroup: 'Machining', processRoute: process, operation: process, setupCost: 0, runCost: totalCost, totalCost, cycleTimeMin, setupTimeMin: 0,
  setupTimeSource: 'none', hourlyRate: 60, rateSource: 'mhr_database', machineClass: '2_axis_lathe', machineName: 'Lathe', commodityCode: null, labourRate: null,
});
const engineCost = (): CostSummaryDto => ({
  materialCost: 0.11, materialGrade: 'Aluminum, ANSI 6061', grossWeightKg: 0.019, materialCostPerKg: 5.875, materialSource: 'db',
  processLines: [line('Rough Turning', 1, 1), line('Inspection', 0.5, 0.5)], totalProcessCost: 1.5, totalCost: 1.61,
  cycleTimes: { laserMin: 1, pressBrakeMin: 0, tappingMin: 0, deburrMin: 0, totalMin: 1.5 }, batchSize: 25, family: 'mill_turn',
  warnings: ['a machining warning'], ratesSource: 'test',
} as unknown as CostSummaryDto);

describe('what cuts the piece off its stock', () => {
  it('a bar-fed lathe parts it off the bar; every other machine is loaded with a sawn piece', () => {
    expect([...BAR_FED_LATHE_CLASSES]).toEqual(['2_axis_bar_feed_lathe_with_sub_spindle', '3_axis_bar_feed_lathe_with_sub_spindle']);
    expect(stockCutOffOf('2_axis_bar_feed_lathe_with_sub_spindle')).toBe('parting');
    expect(stockCutOffOf('3_axis_bar_feed_lathe_with_sub_spindle')).toBe('parting');
    for (const cls of ['2_axis_lathe', '3_axis_lathe', 'machining_millturn', 'simultaneous_turning', '3_axis_mill', '4_axis_mill', '5_axis_mill']) expect(stockCutOffOf(cls)).toBe('saw');
  });
});

describe('the Cost Guide\'s stock settings', () => {
  it('none set: the data\'s rules, the engine\'s 6 in bar end, no scrap credit (enableScrapMaterialCredit false)', () => {
    expect(stockMachiningSettings({ processGroup: 'Stock Machining' })).toEqual({ form: null, allowanceMm: null, snap: null, remnantMm: null, scrapCredit: null, roughingTechnique: null });
    const c = choose();
    expect(c).toMatchObject({ unitSystem: 'US', remnant: { mm: 152.4, source: BAR_END_REMNANT_SOURCE }, scrapCredit: false, notes: [] });
    expect(c.part).toMatchObject({ source: 'measured', lengthMm: 32, roundOdMm: 14 });
    expect(c.faces.endFaceIds).toEqual([5, 22]);
    // Sawn: floor((6096 - 152.4) / (33.5875 + 0.889)) = 172 a bar. Parted off a 5/8 in bar (the 25 mm ring row, 2.5 mm): floor(5943.6 / 36.0875) = 164.
    expect(c.selection.saw.chosen).toMatchObject({ form: 'round_bar', sizeLabel: '5/8" round bar', cutWidthMm: 0.889, stock: { partsPerStock: 172 } });
    expect(c.selection.parting.chosen).toMatchObject({ form: 'round_bar', cutWidthMm: 2.5, stock: { partsPerStock: 164 } });
  });

  it('each one replaces its rule: the form, the stock on each side, snapping, the bar end, the scrap credit', () => {
    const c = choose({ stockForm: 'hex_bar', stockAllowanceMm: 1, stockSnap: false, stockRemnantMm: 100, stockScrapCredit: true });
    expect(c.settings).toEqual({ form: 'hex_bar', allowanceMm: 1, snap: false, remnantMm: 100, scrapCredit: true, roughingTechnique: null });
    expect(c).toMatchObject({ remnant: { mm: 100, source: 'the bar end set in the Cost Guide (mm)' }, scrapCredit: true });
    // Hex bar round the Ø14: 14 + 2 x 1 = 16 across flats, not snapped; the piece 32 + 2 x 1 = 34; floor((6096 - 100) / 34.889) = 171.
    expect(c.selection.saw.chosen).toMatchObject({ form: 'hex_bar', aMm: 16, allowancePerSideMm: 1, endAllowanceMm: 1, snapped: false, blank: { lengthMm: 34 }, stock: { partsPerStock: 171 } });
    // A bar end of 0 is a choice: floor(6096 / (33.5875 + 0.889)) = 176.
    expect(choose({ stockRemnantMm: 0 }).selection.saw.chosen!.stock.partsPerStock).toBe(176);
  });

  it('metric stock outside the USA: the Ø14 shaft takes 16 mm bar', () => {
    const c = choose({}, 'India');
    expect(c.unitSystem).toBe('metric');
    expect(c.selection.saw.chosen).toMatchObject({ sizeLabel: '16 mm round bar', aMm: 16 });
  });

  it('a part with no measurement is read off its bounding box, and the quote says to refresh the analysis', () => {
    const c = choose({}, 'USA', { ...SHAFT, machiningStock: undefined });
    expect(c.part).toMatchObject({ source: 'bounding box', lengthMm: 32.0018, roundOdMm: 14 });
    expect(c.notes).toEqual([expect.stringContaining('press Refresh analysis')]);
    expect(c.selection.saw.chosen!.sizeLabel).toBe('5/8" round bar');
  });

  it('a part with no size has no stock, and says why', () => {
    expect(chooseStockMachining({ ref: REF, stock: STOCK, location: 'USA', overrides: {}, part: { ...SHAFT, machiningStock: undefined, box: { length: 0, width: 0, height: 0 } } }))
      .toEqual({ choice: null, missing: [expect.stringContaining('the part\'s size')] });
  });
});

describe('the group\'s own row of a material', () => {
  const rows = [{ Name: 'Aluminum, ANSI 6061', 'Source Name': 'Generic Aluminum, ANSI 6061', 'Cut Code': 30.11, 'Scrap Cost Percent (%)': 9 }, { Name: 'ABS, Hi Impact', 'Source Name': 'Generic ABS, Hi Impact', 'Cut Code': 51.31, 'Scrap Cost Percent (%)': 1 }];
  it('is found by its name or the name it was taken from, in any case; none for a material the group does not list', () => {
    expect(stockMaterialRow(rows, ['aluminum, ansi 6061'])).toBe(rows[0]);
    expect(stockMaterialRow(rows, [null, 'Generic ABS, Hi Impact'])).toBe(rows[1]);
    expect(stockMaterialRow(rows, ['Aluminum, AA 7003', undefined, ''])).toBeNull();
  });
});

describe('the shaft\'s stock priced, a batch of 25', () => {
  const p = plan();
  const saw = p.priced!.saw;
  const parting = p.priced!.parting;

  it('sawn: the bar over its 172 pieces at the round bar price, and the Band Saw line', () => {
    // 3.2578 kg / 172 = 0.018941 kg at 5.875 USD/kg = 0.11128 USD.
    expect(saw.materialCost).toBeCloseTo((BAR_KG / 172) * 5.875, 9);
    expect(saw.materialCost).toBeCloseTo(0.11128, 5);
    expect(saw.scrapCredit).toBe(0);
    expect(saw.lines).toHaveLength(1);
    expect(saw.lines[0]).toMatchObject({ process: 'Band Saw', processGroup: 'Stock Machining', machineName: 'DoAll 3613-1 Vert' });
    // The saw's line states its own setup and carries its calculator run: it is no gap, so its route can be recommended and applied.
    expect(findRouteDataGaps(saw.lines)).toEqual([]);
    expect(saw.lines[0].calculationTrace!.length).toBeGreaterThan(0);
    expect(saw.lines[0].calculatorId).toBe('Stock Machining - Band Saw');
  });

  it('parted off: no Band Saw line, and the bar over its 164 pieces (the parting tool is wider than the saw\'s kerf)', () => {
    expect(parting.lines).toEqual([]);
    expect(parting.materialCost).toBeCloseTo((BAR_KG / 164) * 5.875, 9);
    expect(parting.options.every((o) => o.sawCost === null)).toBe(true);
  });

  it('every other form that holds the part is priced beside it, each at its own form\'s price; a tube is not offered (no bore)', () => {
    expect(saw.options.map((o) => [o.form, o.chosen, o.unavailable === null])).toEqual([
      ['round_bar', true, true], ['hex_bar', false, true], ['rectangular_bar', false, true], ['square_bar', false, true], ['plate', false, true],
      ['round_tube', false, false], ['billet', false, true],
    ]);
    const of = (form: string) => saw.options.find((o) => o.form === form)!;
    expect(of('round_bar').materialCost).toBe(saw.materialCost);
    expect(of('round_bar').sawCost).toBe(saw.lines[0].totalCost);
    // Square bar: the 14 x 14 section with 0.79375 a side takes a 5/8 in side: 15.875² x 6096 mm over 172 pieces at 6.845 USD/kg.
    expect(of('square_bar')).toMatchObject({ sizeLabel: '5/8" x 5/8" square bar', unavailable: null });
    expect(of('square_bar').materialCost).toBeCloseTo(((15.875 ** 2 * 6096 * 2700) / 1e9 / 172) * 6.845, 9);
    expect(of('round_tube')).toMatchObject({ sizeLabel: null, materialCost: null, sawCost: null, unavailable: expect.stringContaining('this part has none') });
    // A billet is priced as the plate it is sawn from (7.438 USD/kg): a 33.5875 x 15.5875 x 15.5875 block, 55 x 13 = 715 of them a kerf apart
    // on the 914.4 x 457.2 plate (the other way round 26 x 27 = 702).
    expect(of('billet').materialCost).toBeCloseTo(((914.4 * 457.2 * 15.5875 * 2700) / 1e9 / 715) * 7.438, 9);
  });

  it('in another currency: the stock and the saw line at the location\'s rate', () => {
    const inr = plan({}, { usdToLocal: 83 }).priced!.saw;
    expect(inr.materialCost).toBeCloseTo(saw.materialCost! * 83, 9);
    expect(inr.lines[0].totalCost).toBeCloseTo(saw.lines[0].totalCost * 83, 1);
    expect(inr.lines[0].hourlyRate).toBeCloseTo(saw.lines[0].hourlyRate * 83, 1);
    expect(inr.options[0].sawCost).toBeCloseTo(saw.options[0].sawCost! * 83, 9);
  });

  it('the scrap credit, when the Cost Guide turns it on: the chips at 9 % of the bar\'s price', () => {
    const credited = plan({ stockScrapCredit: true }).priced!.saw;
    // (0.018941 - 0.007144 kg) x 5.875 x 9 % = 0.00624 USD.
    const credit = (BAR_KG / 172 - (2646 * 2700) / 1e9) * 5.875 * 0.09;
    expect(credited.scrapCredit).toBeCloseTo(credit, 9);
    expect(credited.materialCost).toBeCloseTo(saw.materialCost! - credit, 9);
  });
});

describe('the stock as the blank the machining engines start from', () => {
  it('the piece is what the machine cuts (and the bar a lathe turns down from); the stock bought per part is what the material is priced on', () => {
    const blank = stockBlankResult(choose(), 'saw')!;
    expect(blank).toMatchObject({ form: 'round_bar', sizeLabel: '5/8" round bar', barDiameterMm: 15.875, sizeSource: STOCK_SIZE_SOURCE });
    expect(blank.billetVolMm3).toBeCloseTo(AREA * 33.5875, 6);
    expect(blank.purchasedVolMm3).toBeCloseTo((AREA * 6096) / 172, 6);
    expect(blank.utilizationPct).toBeCloseTo((2646 / ((AREA * 6096) / 172)) * 100, 9);
    expect(stockBlankResult(choose(), 'parting')!.purchasedVolMm3).toBeCloseTo((AREA * 6096) / 164, 6);
  });

  it('a hex bar is turned down from the circle round its corners; a plate has no bar to turn from', () => {
    const hex = stockBlankResult(choose({ stockForm: 'hex_bar' }), 'saw')!;
    // The Ø14 in a hexagon of 14 across flats (no allowance, not snapped): 2 x 14 / sqrt(3) = 16.166 across corners.
    expect(hex.barDiameterMm).toBeCloseTo(28 / Math.sqrt(3), 9);
    expect(stockBlankResult(choose({ stockForm: 'plate' }), 'saw')!.barDiameterMm).toBeUndefined();
  });

  it('a Cost Guide form that cannot hold the part falls back to a billet, and the blank says so', () => {
    const tube = stockBlankResult(choose({ stockForm: 'round_tube' }), 'saw')!;
    expect(tube.form).toBe('billet');
    expect(tube.requestedFormUnavailable).toEqual({ requested: 'round_tube', reason: expect.stringContaining('The Cost Guide\'s round tube is not available') });
  });
});

describe('a machining route\'s quote with its stock', () => {
  it('a sawn piece: the Band Saw line before the machining lines, the stock bought as the material, the totals of both', () => {
    const p = plan();
    const sawLine = p.priced!.saw.lines[0];
    const quote = withStockMachining(engineCost(), p, 'saw');
    expect(quote.processLines.map((l) => l.process)).toEqual(['Band Saw', 'Rough Turning', 'Inspection']);
    // Material 0.11128, not rounded to cents. Process 1.00 + 0.50 + the saw.
    expect(quote.materialCost).toBeCloseTo((BAR_KG / 172) * 5.875, 10);
    expect(quote.totalProcessCost).toBeCloseTo(1.5 + sawLine.totalCost, 10);
    expect(quote.totalCost).toBe(quote.materialCost + quote.totalProcessCost);
    expect(quote.grossWeightKg).toBe(0.019);
    expect(quote.cycleTimes.totalMin).toBe(r2(1.5 + sawLine.cycleTimeMin));
    expect(findRouteDataGaps(quote.processLines)).toEqual([]);
    expect(quote.warnings[0]).toBe('a machining warning');
    expect(quote.warnings.join(' ')).toContain('Disclosed (the engine\'s rules');
    // The stock's own calculators beside the lines: its size, and the bar bought per part.
    expect(quote.calculatorRuns!['Stock Machining stock size'].value).toBeCloseTo(15.5875, 9);
    expect(quote.calculatorRuns!['Stock Machining stock']).toMatchObject({ name: 'Stock Machining - Bar Stock', output: 'Material Cost' });
    expect(quote.calculatorRuns!['Stock Machining stock'].value).toBeCloseTo((BAR_KG / 172) * 5.875, 9);
    expect(quote.calculatorRuns!['Stock Machining scrap credit']).toBeUndefined();
  });

  it('a bar-fed lathe: no Band Saw line; the material is the bar over its 164 parted pieces', () => {
    const quote = withStockMachining(engineCost(), plan(), 'parting');
    expect(quote.processLines.map((l) => l.process)).toEqual(['Rough Turning', 'Inspection']);
    // 3.2578 kg / 164 x 5.875 = 0.1167, not rounded to cents.
    expect(quote.materialCost).toBeCloseTo((BAR_KG / 164) * 5.875, 10);
    expect(quote.totalProcessCost).toBe(1.5);
    expect(quote.totalCost).toBeCloseTo((BAR_KG / 164) * 5.875 + 1.5, 10);
    expect(quote.warnings).toContain(PARTED_OFF);
  });

  it('a stock that could not be chosen is a named Material Stock gap on the route, and no material is costed: never a refusal', () => {
    // With no stock the machining engine prices no material (it estimates none), and that stands.
    const noStock = { ...engineCost(), materialCost: 0, grossWeightKg: 0, totalCost: 1.5 };
    const unchosen = { choice: null, priced: null, scrapCostPercent: null, missing: ['Stock Machining reference data is not staged (source version 2026-Stock-Machining, migration 1114)'], warnings: [] };
    for (const sawCosted of [true, false]) {
      const quote = withStockMachining(noStock, { sawCosted, ...unchosen }, 'saw');
      expect(quote.processLines.map((l) => l.process)).toEqual(['Material Stock', 'Rough Turning', 'Inspection']);
      expect(quote.processLines[0]).toMatchObject({ process: 'Material Stock', processGroup: 'Stock Machining', totalCost: 0, physicsGap: { reason: expect.stringContaining('is not staged') } });
      expect((quote.processLines[0].physicsGap as { reason: string }).reason).toContain('nothing is estimated in its place');
      expect(quote.materialCost).toBe(0);
      expect(quote.totalCost).toBe(1.5);
      expect(findRouteDataGaps(quote.processLines).map((g) => g.process)).toEqual(['Material Stock']);
      expect(quote.warnings).toContain('Stock: Stock Machining reference data is not staged (source version 2026-Stock-Machining, migration 1114).');
      expect(quote.warnings).not.toContain(SAW_NOT_COSTED);
    }
  });

  it('a stock chosen but not priced (its calculators are missing): a named Band Saw gap on a sawn route, nothing added on a parted one', () => {
    const unpriced: StockMachiningPlan = { sawCosted: true, choice: choose(), priced: null, scrapCostPercent: null, missing: ['the Stock Machining calculators are not in the database (run migration 1116): Stock Machining - Material Stock'], warnings: [] };
    const sawn = withStockMachining(engineCost(), unpriced, 'saw');
    expect(sawn.processLines[0]).toMatchObject({ process: 'Band Saw', totalCost: 0, physicsGap: { reason: expect.stringContaining('run migration 1116') } });
    expect(sawn.materialCost).toBe(0.11);
    expect(withStockMachining(engineCost(), unpriced, 'parting').processLines.map((l) => l.process)).toEqual(['Rough Turning', 'Inspection']);
  });

  it('a material with no density: the saw is a named gap (its load times are by weight) and the stock is not priced', () => {
    const p = plan({}, { material: { densityKgM3: null } });
    const quote = withStockMachining(engineCost(), p, 'saw');
    expect(quote.processLines[0]).toMatchObject({ process: 'Band Saw', totalCost: 0, physicsGap: { reason: expect.stringContaining('its density') } });
    expect(quote.materialCost).toBe(0.11);
    expect(quote.warnings).toContain('The stock is not priced: Aluminum, ANSI 6061: its density.');
  });
});

// One stock model (user decision 2026-11-22): a part whose Process is Machining is costed as a Stock Machining part, less the Band Saw.
describe('a Machining part\'s quote: the Stock Machining stock, and no band saw', () => {
  it('a sawn piece: the same stock bought as the material, no Band Saw line, and the quote says once that the sawing is not costed', () => {
    const stockMachining = withStockMachining(engineCost(), plan(), 'saw');
    const machining = withStockMachining(engineCost(), machiningPlan(), 'saw');
    expect(machining.processLines.map((l) => l.process)).toEqual(['Rough Turning', 'Inspection']);
    // The bar over its 172 sawn pieces at the round bar price, as the Stock Machining quote: 0.11128, not rounded to cents.
    expect(machining.materialCost).toBe(stockMachining.materialCost);
    expect(machining.materialCost).toBeCloseTo((BAR_KG / 172) * 5.875, 10);
    expect(machining.grossWeightKg).toBe(stockMachining.grossWeightKg);
    expect(machining.totalProcessCost).toBe(1.5);
    expect(machining.totalCost).toBeCloseTo((BAR_KG / 172) * 5.875 + 1.5, 10);
    expect(machining.cycleTimes.totalMin).toBe(1.5);
    // The difference between the two quotes is the Band Saw line, and nothing else.
    expect(stockMachining.totalCost - machining.totalCost).toBeCloseTo(stockMachining.processLines[0].totalCost, 10);
    // A note, not a gap: the route is complete, and is recommended and applied as it stands.
    expect(findRouteDataGaps(machining.processLines)).toEqual([]);
    expect(machining.warnings.filter((w) => w === SAW_NOT_COSTED)).toHaveLength(1);
    expect(machining.warnings).not.toContain(PARTED_OFF);
    expect(stockMachining.warnings).not.toContain(SAW_NOT_COSTED);
    expect(machining.calculatorRuns).toEqual(stockMachining.calculatorRuns);
  });

  it('a bar-fed lathe parts the piece off the same bar: the quote is the Stock Machining quote', () => {
    expect(withStockMachining(engineCost(), machiningPlan(), 'parting')).toEqual(withStockMachining(engineCost(), plan(), 'parting'));
  });

  it('the Cost Guide\'s settings change its stock as they change a Stock Machining part\'s', () => {
    for (const overrides of [{ stockForm: 'hex_bar' }, { stockAllowanceMm: 0, stockSnap: false }, { stockRemnantMm: 500 }, { stockScrapCredit: true }]) {
      const stockMachining = plan(overrides).priced!.saw;
      const machining = machiningPlan(overrides).priced!.saw;
      expect(machining.selection).toEqual(stockMachining.selection);
      expect(machining.materialCost).toBe(stockMachining.materialCost);
      expect(machining.scrapCredit).toBe(stockMachining.scrapCredit);
    }
    // And each does change it: a hex bar, the stock at the part's own size, a longer bar end, the chips sold back.
    const base = machiningPlan().priced!.saw;
    expect(machiningPlan({ stockForm: 'hex_bar' }).priced!.saw.selection.chosen!.form).toBe('hex_bar');
    expect(machiningPlan({ stockAllowanceMm: 0, stockSnap: false }).priced!.saw.selection.chosen).toMatchObject({ aMm: 14, allowancePerSideMm: 0, snapped: false });
    // floor((6096 - 500) / (33.5875 + 0.889)) = 162 pieces a bar.
    expect(machiningPlan({ stockRemnantMm: 500 }).priced!.saw.selection.chosen!.stock.partsPerStock).toBe(162);
    expect(machiningPlan({ stockScrapCredit: true }).priced!.saw.materialCost).toBeLessThan(base.materialCost!);
  });

  it('its section of the Cost Summary: the same stock and forms, no saw, and why', () => {
    const stockMachining = stockMachiningBreakdown(plan(), 'saw', 25)!;
    const machining = stockMachiningBreakdown(machiningPlan(), 'saw', 25)!;
    expect(machining.stock).toEqual(stockMachining.stock);
    expect(machining.stock).toMatchObject({ sizeLabel: '5/8" round bar', cutOff: 'saw', cutWidthMm: 0.889, partsPerStock: 172 });
    expect(machining.saw).toBeNull();
    expect(machining.sawMissing).toBe(SAW_NOT_COSTED);
    // Every form is priced as on the Stock Machining quote; none carries a saw cost.
    expect(machining.options.map((o) => o.materialCost)).toEqual(stockMachining.options.map((o) => o.materialCost));
    expect(machining.options.every((o) => o.sawCost === null)).toBe(true);
    expect(machining.stockLabel).toBe('5/8" round bar, 33.59 mm piece, 172 per 6096 mm bar');
    expect({ ...machining, saw: null, sawMissing: null, options: [] }).toEqual({ ...stockMachining, saw: null, sawMissing: null, options: [] });
    // On a bar-fed lathe's route the section is the Stock Machining one: the lathe parts the piece off.
    expect(stockMachiningBreakdown(machiningPlan(), 'parting', 25)).toEqual(stockMachiningBreakdown(plan(), 'parting', 25));
  });

  it('a stock chosen but not priced (its calculators are missing): no line is added, the engine\'s material on the same stock stands, and the quote says why', () => {
    const unpriced: StockMachiningPlan = { sawCosted: false, choice: choose(), priced: null, scrapCostPercent: null, missing: ['the Stock Machining calculators are not in the database (run migration 1116)'], warnings: [] };
    const quote = withStockMachining(engineCost(), unpriced, 'saw');
    expect(quote.processLines.map((l) => l.process)).toEqual(['Rough Turning', 'Inspection']);
    expect(quote.materialCost).toBe(0.11);
    expect(quote.warnings).toContain('Stock: the Stock Machining calculators are not in the database (run migration 1116).');
    expect(stockMachiningBreakdown(unpriced, 'saw', 25)!.sawMissing).toBe(SAW_NOT_COSTED);
  });
});

describe('the Cost Summary\'s Stock Machining section', () => {
  it('the rule, the stock with its piece and yield, the saw, the scrap credit and the label the material record takes', () => {
    const p = plan();
    const b = stockMachiningBreakdown(p, 'saw', 25)!;
    expect(b.rule).toEqual({ form: 'round_bar', basis: 'a turned part, 14 mm at its largest diameter' });
    expect(b.stock).toEqual({
      form: 'round_bar', sizeLabel: '5/8" round bar',
      // 14 + 2 x 0.79375 = 15.5875 needed; the next inch size is 5/8 in (15.875).
      boughtAMm: 15.875, boughtBMm: null, requiredAMm: 15.588, requiredBMm: null, allowancePerSideMm: 0.794, endAllowanceMm: 0.794, snapped: true, unitSystem: 'US',
      piece: { lengthMm: 33.588, widthMm: null, thicknessMm: null }, cutWidthMm: 0.889, cutOff: 'saw',
      partsPerStock: 172, stocksForBatch: 1, stockLengthMm: 6096, stockWidthMm: null, virtualPlate: false, barEndMm: 152.4,
      utilizationPct: Math.round((2646 / ((AREA * 6096) / 172)) * 1000) / 10,
      // 3.2578 kg / 172; 33.5875 mm of bar (197.93 mm² x 33.5875 x 2700 = 0.0179498 kg); 2646 mm³ of part.
      purchasedKg: 0.018941, pieceKg: 0.01795, partKg: 0.007144,
    });
    expect(b.fallback).toBeNull();
    expect(b.options).toBe(p.priced!.saw.options);
    // Cut 197.93 / 8064.5 x 60 = 1.473 s; feed 34.4765 / 75 = 0.460 s; the 3.26 kg bar's 20 s load over 172 = 0.116 s; unload 5 s.
    expect(b.saw).toEqual({
      machineName: 'DoAll 3613-1 Vert', bundleBars: 1, bundleBasis: expect.stringContaining('the batch needs 1'), cuttingRateMm2Min: 8064.5,
      cutSec: 1.473, feedSec: 0.46, loadSec: 0.116, unloadSec: 5, cycleSec: 7.049,
    });
    expect(b.sawMissing).toBeNull();
    expect(b.scrapCredit).toEqual({ enabled: false, percent: 9, credit: 0 });
    expect(b.partSource).toBe('measured');
    expect(b.endFaceIds).toEqual([5, 22]);
    expect(b.asSuppliedFaceIds).toEqual({ curvedWall: [], planarFace: [] });
    expect(b.stockLabel).toBe('5/8" round bar, 33.59 mm piece, 172 per 6096 mm bar');
    expect(b.notes).toEqual([BAR_END_REMNANT_SOURCE]);
  });

  it('a bar-fed lathe\'s route: the parted bar, and why there is no saw', () => {
    const b = stockMachiningBreakdown(plan(), 'parting', 25)!;
    expect(b.stock).toMatchObject({ cutOff: 'parting', cutWidthMm: 2.5, partsPerStock: 164 });
    expect(b.saw).toBeNull();
    expect(b.sawMissing).toBe(PARTED_OFF);
    expect(b.stockLabel).toBe('5/8" round bar, 33.59 mm piece, 164 per 6096 mm bar');
  });

  it('a large batch states the bars it needs; the stock at the part\'s own size leaves its surface as supplied', () => {
    expect(stockMachiningBreakdown(plan({}, { batchSize: 1000 }), 'saw', 1000)!.stock!.stocksForBatch).toBe(6); // 1000 / 172 = 5.8
    const exact = stockMachiningBreakdown(plan({ stockAllowanceMm: 0, stockSnap: false }), 'saw', 25)!;
    expect(exact.stock).toMatchObject({ boughtAMm: 14, allowancePerSideMm: 0, snapped: false });
    expect(exact.asSuppliedFaceIds).toEqual({ curvedWall: [9], planarFace: [] });
    expect(exact.notes).toContain('Stock on each side set in the Cost Guide: 0 mm.');
  });

  it('a plate and a billet are labelled by the plate they are cut from', () => {
    const wide: StockPartInput = { machiningStock: undefined, family: 'milled', box: { length: 300, width: 200, height: 20 }, volumeMm3: 900000 };
    const plate = choose({}, 'USA', wide).selection.saw.chosen!;
    // 300 x 200 x 20: at least 152.4 wide and 20 / 200 = 0.1 of its width high: plate, four blanks to the 914.4 x 457.2 plate.
    expect(plate.form).toBe('plate');
    expect(stockLabelOf(plate)).toBe(`${plate.sizeLabel}, 4 per 914.4 x 457.2 mm plate`);
    const huge = choose({}, 'USA', { ...wide, box: { length: 1200, width: 200, height: 20 } }).selection.saw.chosen!;
    expect(huge.stock.virtual).toBe(true);
    expect(stockLabelOf(huge)).toBe(`${huge.sizeLabel}, cut from a plate of its own size`);
  });

  it('no stock chosen: no section; a stock chosen but not priced: its options without costs, and why the saw is missing', () => {
    expect(stockMachiningBreakdown({ sawCosted: true, choice: null, priced: null, scrapCostPercent: null, missing: ['x'], warnings: [] }, 'saw', 25)).toBeUndefined();
    const b = stockMachiningBreakdown({ sawCosted: true, choice: choose(), priced: null, scrapCostPercent: null, missing: ['the Stock Machining calculators are not in the database (run migration 1116)'], warnings: [] }, 'saw', 25)!;
    expect(b.stock).toMatchObject({ sizeLabel: '5/8" round bar', purchasedKg: null });
    expect(b.options.find((o) => o.chosen)).toEqual({ form: 'round_bar', sizeLabel: '5/8" round bar', unavailable: null, materialCost: null, sawCost: null, chosen: true });
    expect(b.saw).toBeNull();
    expect(b.sawMissing).toContain('run migration 1116');
  });
});
