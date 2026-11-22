// The stock bought for a Stock Machining part and the band saw that cuts it (stock-machining-route.ts), on memory/Stock Maching's own
// tables, saws and materials. Expected values are worked out by hand in the comments from the files' numbers.
import { readFileSync } from 'fs';
import { join } from 'path';

import { bandSaws, realStockMachiningReference, stockMaterial } from '../stock/stock-test-data';
import { sawBundle, sawFit, sawHandlingRow, sawRateRow } from '../../../../../modules/bom-items/costing/stock/band-saw';
import { stockReference } from '../../../../../modules/bom-items/costing/stock/stock-reference';
import { selectStock, type StockForm, type StockPart, type StockSettings } from '../../../../../modules/bom-items/costing/stock/stock-selection';
import { loadStockMachiningCalculatorSpec, stockMachiningCalculatorsByName } from '../../../../../modules/bom-items/costing/stock-machining/calculators/stock-machining-calculator-spec';
import { buildStockMachiningCalculatorsMigrationSql } from '../../../../../modules/bom-items/costing/stock-machining/calculators/stock-machining-calculators-migration';
import {
  buildStockMachiningQuote, STOCK_MACHINING_PROCESS_GROUP, type StockMachiningInput, type StockMachiningMaterial,
} from '../../../../../modules/bom-items/costing/stock-machining/stock-machining-route';

const REF = realStockMachiningReference();
const STOCK = stockReference(REF).reference!;
const ZERO = { qairPerHr: 0, inspTimeMin: 0, samplingRate: 0, yieldPct: 1, netMatCost: 0, netWeightKg: 0, scrapPricePerKg: 0 };
const USA: StockSettings = { unitSystem: 'US', cutOff: 'saw', remnantMm: 152.4, allowanceMm: null, snap: null };
const SHAFT: StockPart = { source: 'measured', family: 'mill_turn', lengthMm: 32, roundOdMm: 14, widthMm: 14, heightMm: 14, hexAcrossFlatsMm: null, boreMm: null, volumeMm3: 2646 };
const WIDE: StockPart = { source: 'measured', family: 'milled', lengthMm: 300, roundOdMm: Math.hypot(200, 20), widthMm: 200, heightMm: 20, hexAcrossFlatsMm: null, boreMm: null, volumeMm3: 900000 };
// memory/Stock Maching materials: 6061 is cut code 30.11 (family 30), 2700 kg/m³, round bar 5.875 USD/kg; 1018 cold worked is 1.2 (family 1), 7900 kg/m³.
const AL = stockMaterial('Aluminum, ANSI 6061', 'Round Bar Unit Cost (USD / kg)');
const STEEL = stockMaterial('Steel, Cold Worked, AISI 1018', 'Round Bar Unit Cost (USD / kg)');
const STEEL_PLATE = stockMaterial('Steel, Cold Worked, AISI 1018', 'Plate Cost Per KG (USD / kg)');

function quote(part: StockPart, material: StockMachiningMaterial, over: Partial<StockMachiningInput> & { form?: StockForm; settings?: Partial<StockSettings> } = {}) {
  const settings = { ...USA, ...(over.settings ?? {}), ...(over.cutOff ? { cutOff: over.cutOff } : {}) };
  const option = selectStock(part, STOCK, settings, over.form ?? null).chosen!;
  const { form: _form, settings: _settings, ...rest } = over;
  return {
    option,
    q: buildStockMachiningQuote({
      ref: REF, stock: STOCK, calculators: stockMachiningCalculatorsByName(), saws: bandSaws('USA'), part, option, material, cutOff: settings.cutOff,
      remnant: { mm: settings.remnantMm, source: 'the end of a bar that makes no part' }, scrapCredit: false, batchSize: 25, costContext: ZERO, endFaceIds: [3, 9], ...rest,
    }),
  };
}
const AREA = (Math.PI / 4) * 15.875 ** 2; // the 5/8 in bar's section: 197.93 mm²
const gapReason = (line: { physicsGap?: unknown }) => (line.physicsGap as { reason?: string } | undefined)?.reason;

describe('the Stock Machining calculators', () => {
  it('are the six of the spec: the stock as supplied, its size, bar and plate yield, the band saw and the scrap credit', () => {
    const spec = loadStockMachiningCalculatorSpec();
    expect(spec.processGroup).toBe(STOCK_MACHINING_PROCESS_GROUP);
    expect(spec.calculators.map((c) => c.name)).toEqual(['Stock Machining - Material Stock', 'Stock Machining - Stock Size', 'Stock Machining - Bar Stock',
      'Stock Machining - Plate Stock', 'Stock Machining - Band Saw', 'Stock Machining - Scrap Credit']);
    // The two catalog processes of memory/Stock Maching each have their calculator; the rest are helpers.
    expect(spec.calculators.flatMap((c) => c.operations)).toEqual(['Material Stock', 'Band Saw']);
  });

  it('are what migration 1116 creates (regenerate it after editing the spec)', () => {
    expect(readFileSync(join(__dirname, '../../../../../../migrations/1116_stock_machining_calculators.sql'), 'utf8')).toBe(buildStockMachiningCalculatorsMigrationSql());
  });

  it('read only variables the staged data holds', () => {
    const variables = loadStockMachiningCalculatorSpec().calculators.flatMap((c) => c.fields.flatMap((f) => (f.source && 'variable' in f.source ? [f.source.variable] : [])));
    expect([...new Set(variables)].sort()).toEqual(['cycleTimeAdjustmentFactor', 'standardStockLength']);
    for (const v of variables) expect(REF.number(v)).not.toBeNull();
  });
});

describe('the band saw\'s tables', () => {
  it('the cutting rate is the cut-code family\'s row at the width in the cut, the widest row for a wider cut', () => {
    const rows = REF.table('bandSawCutting');
    // Steel 1.2 is family 1 (never the thermosets' 52 or family 10): 6452 mm²/min up to 50 mm, 4516 at 300, 3548 at 500 and beyond.
    const rate = (code: number, width: number) => { const r = sawRateRow(rows, code, width); return 'row' in r ? [r.family, Number(r.row['Cutting Rate (mm^2 / min)'])] : r.why; };
    expect(rate(1.2, 15.875)).toEqual(['1', 6451.6]);
    expect(rate(1.2, 285.75)).toEqual(['1', 4516.12]);
    expect(rate(1.2, 800)).toEqual(['1', 3548.38]);
    expect(rate(30.11, 285.75)).toEqual(['30', 8064.5]);
    expect(rate(5.21, 40)).toEqual(['5', 2903.22]);
    expect(rate(99, 40)).toBe('bandSawCutting lists no cut-code family for the material (cut code 99)');
  });

  it('the handling row is the first at or above the weight; a bundle is what the vise holds, within the data\'s limit and the bars the batch needs', () => {
    const rows = REF.table('bandSawHandling');
    expect(sawHandlingRow(rows, 0.02)).toMatchObject({ 'Load Time (s)': 15, 'Unload Time (s)': 5 });
    expect(sawHandlingRow(rows, 3.26)).toMatchObject({ 'Weight (kg)': 5, 'Load Time (s)': 20 });
    expect(sawHandlingRow(rows, 500)).toMatchObject({ 'Load Time (s)': 60, 'Unload Time (s)': 30 });
    const bar = { widthMm: 15.875, heightMm: 15.875, diameterMm: 15.875, plate: false };
    const vise = { maxWidthMm: 900, maxHeightMm: 330, maxDiameterMm: 330 };
    // 56 across by 20 up fit the vise; the data allows 18; a batch of 25 at 172 a bar needs one bar.
    expect(sawBundle(bar, vise, 18, 25, 172)).toMatchObject({ bars: 1, fits: 1120, barsForBatch: 1, widthMm: 15.875 });
    expect(sawBundle(bar, vise, 18, 100000, 172)).toMatchObject({ bars: 18, barsForBatch: 582, widthMm: 18 * 15.875 });
    expect(sawBundle({ ...bar, widthMm: 200, heightMm: 200, diameterMm: 200 }, vise, 18, 100000, 10)).toMatchObject({ bars: 4, fits: 4, widthMm: 800 });
    expect(sawBundle({ widthMm: 306.35, heightMm: 31.75, diameterMm: null, plate: true }, vise, 18, 100000, 4)).toMatchObject({ bars: 1 });
    expect(sawFit(bar, vise)).toBeNull();
    expect(sawFit({ ...bar, diameterMm: 400, widthMm: 400, heightMm: 400 }, vise)).toBe('cuts round stock up to 330 mm, the bar is Ø400');
  });
});

describe('the shaft on 5/8 in aluminium bar, a batch of 25', () => {
  const { q, option } = quote(SHAFT, AL);

  it('the stock bought per part: a 6096 mm bar over its 172 pieces, at the round bar price', () => {
    expect(option.stock.partsPerStock).toBe(172);
    // The bar: 6096 x 197.93 mm² x 2700 kg/m³ = 3.2578 kg; a part's share 0.018941 kg; at 5.875 USD/kg: 0.1113 USD.
    const barKg = (6096 * AREA * 2700) / 1e9;
    expect(q.material.purchasedKg).toBeCloseTo(barKg / 172, 9);
    expect(q.material.costUsd).toBeCloseTo((barKg / 172) * 5.875, 9);
    expect(q.material.pieceKg).toBeCloseTo((33.5875 * AREA * 2700) / 1e9, 9);
    expect(q.material.run!.outputs).toMatchObject({ 'Parts per Bar': 172 });
    expect(q.material.run!.outputs['Piece Length']).toBeCloseTo(33.5875, 9);
    // The size calculator shows the rule: 5 % of 14 is under the least, 0.79375: 14 + 1.5875.
    expect(q.material.sizeRun!.outputs.Allowance).toBeCloseTo(0.79375, 9);
    expect(q.material.sizeRun!.value).toBeCloseTo(15.5875, 9);
    expect(q.missing).toEqual([]);
  });

  it('the band saw: the section at aluminium\'s rate, the feed, the bar\'s load shared by its pieces, the piece unloaded', () => {
    expect(q.lines).toHaveLength(1);
    const line = q.lines[0];
    expect(line).toMatchObject({ process: 'Band Saw', processGroup: 'Stock Machining' });
    expect(line.physicsGap).toBeUndefined();
    // Cut 197.93 / 8064.5 x 60 = 1.4726 s. Feed (33.5875 + 0.889) / 75 = 0.4597 s. The 3.26 kg bar loads in 20 s (the 5 kg row), over 172
    // pieces 0.1163 s. The 18 g piece unloads in 5 s (the 1 kg row). One bar a cut: the batch needs one.
    const cut = (AREA / 8064.5) * 60;
    const feed = (33.5875 + 0.889) / 75;
    expect(q.saw).toMatchObject({ cuttingRateMm2Min: 8064.5, cutCodeFamily: '30', unloadS: 5 });
    expect(q.saw!.bundle).toMatchObject({ bars: 1, barsForBatch: 1 });
    expect(q.saw!.cutS).toBeCloseTo(cut, 9);
    expect(q.saw!.feedS).toBeCloseTo(feed, 9);
    expect(q.saw!.loadPerPartS).toBeCloseTo(20 / 172, 9);
    expect(q.saw!.cycleS).toBeCloseTo(cut + feed + 20 / 172 + 5, 9);
    // The line keeps its cycle in minutes to three places.
    expect(line.cycleTimeMin * 60).toBeCloseTo(q.saw!.cycleS, 1);
    // The cheapest saw that holds the bar: the small vertical saw (1.61 + 14.88 USD/hr).
    expect(line.machineName).toBe('DoAll 3613-1 Vert');
    expect(line.calculationTrace?.length).toBeGreaterThan(0);
  });

  it('the line names memory\'s catalog row and carries the part\'s end faces for the highlight', () => {
    expect(q.lines[0].featureBreakdown).toEqual([{ name: 'Band Saw // StockTrim', timeSec: Math.round(q.saw!.cycleS * 100) / 100, featureType: 'StockTrim', count: 1, faceIds: [3, 9] }]);
  });
});

describe('bundles', () => {
  it('a large batch is cut 18 bars at once: the feed is shared, the cut is not, and steel cuts slower across the wider bundle', () => {
    const one = quote(SHAFT, STEEL).q.saw!;
    const many = quote(SHAFT, STEEL, { batchSize: 100000 }).q.saw!;
    expect(many.bundle).toMatchObject({ bars: 18, barsForBatch: 582 });
    // One bar: 15.875 wide, the 50 mm row, 6451.6 mm²/min. Eighteen side by side: 285.75 wide, the 300 mm row, 4516.12.
    expect(one.cuttingRateMm2Min).toBe(6451.6);
    expect(many.cuttingRateMm2Min).toBe(4516.12);
    expect(one.cutS).toBeCloseTo((AREA / 6451.6) * 60, 9);
    expect(many.cutS).toBeCloseTo((AREA / 4516.12) * 60, 9);
    expect(many.feedS).toBeCloseTo(one.feedS / 18, 9);
  });
});

describe('a bar-fed lathe parts the piece off', () => {
  it('no Band Saw line; the bar is yielded with the parting ring\'s width', () => {
    const { q, option } = quote(SHAFT, AL, { cutOff: 'parting' });
    expect(q.lines).toEqual([]);
    expect(q.saw).toBeNull();
    expect(option.cutWidthMm).toBe(2.5);
    expect(q.material.run!.outputs['Parts per Bar']).toBe(164);
    expect(q.material.costUsd).toBeCloseTo(((6096 * AREA * 2700) / 1e9 / 164) * 5.875, 9);
  });
});

describe('a plate part', () => {
  it('the plate over its four blanks at the plate price; the saw cuts two edges of the blank through the plate', () => {
    const { q, option } = quote(WIDE, STEEL_PLATE);
    expect(option).toMatchObject({ form: 'plate', aMm: 31.75 });
    // The plate 914.4 x 457.2 x 31.75 at 7900 kg/m³ = 104.86 kg, a quarter each: 26.21 kg at 2.137 USD/kg.
    const plateKg = (914.4 * 457.2 * 31.75 * 7900) / 1e9;
    expect(q.material.purchasedKg).toBeCloseTo(plateKg / 4, 9);
    expect(q.material.costUsd).toBeCloseTo((plateKg / 4) * 2.137, 9);
    // 31.75 x (306.35 + 206.35) = 16278 mm² a blank; the saw crosses the plate's 457.2 mm width: the 500 mm row of family 1, 3548.38 mm²/min.
    expect(q.saw).toMatchObject({ cuttingRateMm2Min: 3548.38 });
    expect(q.saw!.bundle.bars).toBe(1);
    expect(q.saw!.cutS).toBeCloseTo(((31.75 * (306.35 + 206.35)) / 3548.38) * 60, 9);
    // The 104.9 kg plate loads in 60 s (the last row), a quarter of it to each part; the 15.9 kg blank unloads in 19 s (the 27 kg row).
    expect(q.saw!.loadPerPartS).toBeCloseTo(60 / 4, 9);
    expect(q.saw!.unloadS).toBe(19);
  });
});

describe('what cannot be priced is named', () => {
  it('a material with no density or no price for the stock form', () => {
    const { q } = quote(SHAFT, { ...AL, densityKgM3: null, pricePerKgUsd: null });
    expect(q.missing).toEqual(['Aluminum, ANSI 6061: its density', 'Aluminum, ANSI 6061: a price per kg for round bar stock']);
    expect(q.material.costUsd).toBeNull();
    expect(gapReason(q.lines[0])).toContain('its density');
  });

  it('a material whose cut code the saw table does not list, and stock no saw holds', () => {
    expect(gapReason(quote(SHAFT, { ...AL, cutCode: 99 }).q.lines[0])).toContain('bandSawCutting lists no cut-code family for the material (cut code 99)');
    const huge = quote({ ...SHAFT, roundOdMm: 2400, widthMm: 2400, heightMm: 2400, lengthMm: 100 }, STEEL).q.lines[0];
    expect(gapReason(huge)).toContain('no Band Saw machine fits');
    expect(huge.totalCost).toBe(0);
  });
});

describe('the scrap credit', () => {
  it('is off as the data has it; on, the chips sell at the material\'s Scrap Cost Percent of the stock\'s price', () => {
    const off = quote(SHAFT, AL).q;
    expect(off.material.creditUsd).toBe(0);
    const on = quote(SHAFT, AL, { scrapCredit: true }).q;
    // Aluminum, ANSI 6061: Scrap Cost Percent 9. (0.018941 - 0.007144 kg) x 5.875 x 9 % = 0.00624 USD.
    const credit = (on.material.purchasedKg! - (2646 * 2700) / 1e9) * 5.875 * 0.09;
    expect(on.material.creditUsd).toBeCloseTo(credit, 9);
    expect(on.material.costUsd).toBeCloseTo(off.material.costUsd! - credit, 9);
    const none = quote(SHAFT, { ...AL, scrapCostPercent: null }, { scrapCredit: true }).q;
    expect(none.material.creditUsd).toBe(0);
    expect(none.warnings.join(' ')).toContain('memory lists no Scrap Cost Percent');
  });
});
