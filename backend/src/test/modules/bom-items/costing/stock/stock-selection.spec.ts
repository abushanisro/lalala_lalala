// The stock a machined part is cut from (stock-selection.ts) on memory/Stock Maching's own rules and tables. Sizes are the next size of
// tblPreferredSizes at or above what the part needs, read from the table by hand; yields are worked out by hand in the comments.
import { realStockMachiningReference } from './stock-test-data';
import { stockReference, type StockReference } from '../../../../../modules/bom-items/costing/stock/stock-reference';
import {
  autoStockForm, isStockOption, selectStock, stockOption, type StockOption, type StockPart, type StockSettings,
} from '../../../../../modules/bom-items/costing/stock/stock-selection';

const reference = (replace: Record<string, string> = {}): StockReference => {
  const { reference: r, missing } = stockReference(realStockMachiningReference(replace));
  if (!r) throw new Error(missing.join('; '));
  return r;
};
const ref = reference();
const USA: StockSettings = { unitSystem: 'US', cutOff: 'saw', remnantMm: 152.4, allowanceMm: null, snap: null };
const INDIA: StockSettings = { ...USA, unitSystem: 'metric' };
const option = (o: ReturnType<typeof stockOption>): StockOption => {
  if (!isStockOption(o)) throw new Error(o.unavailable);
  return o;
};
const cyl = (d: number, l: number) => (Math.PI / 4) * d * d * l;

// The Lead Screw side shaft: Ø14 at its largest, 32 long (its measured envelope).
const SHAFT: StockPart = { source: 'measured', family: 'mill_turn', lengthMm: 32, roundOdMm: 14, widthMm: 14, heightMm: 14, hexAcrossFlatsMm: null, boreMm: null, volumeMm3: 2646 };
// R_M-0230-039 STIFFNER 2: a 159.5 x 42 plate, 8 high with its bosses.
const STIFFENER: StockPart = { source: 'measured', family: 'milled', lengthMm: 159.5, roundOdMm: Math.hypot(42, 8), widthMm: 42, heightMm: 8, hexAcrossFlatsMm: null, boreMm: null, volumeMm3: 15209 };
const WIDE: StockPart = { source: 'measured', family: 'milled', lengthMm: 300, roundOdMm: Math.hypot(200, 20), widthMm: 200, heightMm: 20, hexAcrossFlatsMm: null, boreMm: null, volumeMm3: 900000 };
const HEX: StockPart = { source: 'measured', family: 'milled', lengthMm: 40, roundOdMm: 48 / Math.sqrt(3), widthMm: 48 / Math.sqrt(3), heightMm: 24, hexAcrossFlatsMm: 24, boreMm: null, volumeMm3: 18000 };
const BUSHING: StockPart = { source: 'measured', family: 'turned', lengthMm: 50, roundOdMm: 40, widthMm: 40, heightMm: 40, hexAcrossFlatsMm: null, boreMm: 20, volumeMm3: cyl(40, 50) - cyl(20, 50) };

describe('the stock rules of memory/Stock Maching', () => {
  it('are read from its variables and tables', () => {
    expect(ref.allowance).toEqual({ percent: 5, minMm: 0.79375, maxMm: 3.175 });
    expect(ref.hexAllowance).toEqual({ percent: 0, minMm: 0, maxMm: 3.175 });
    expect(ref).toMatchObject({ idTrimAllowanceMm: 0, snap: true, hexSnap: false, barLengthMm: 6096, kerfMm: 0.889, maxBundle: 18, scrapCredit: false, roughingTechnique: 'All Bulk Milling' });
    expect(ref.plate).toEqual({ lengthMm: 914.4, widthMm: 457.2, triggerWidthMm: 152.4, triggerHeightOverWidth: 0.25 });
    // The whole preferred sizes table, each unit system its own series.
    expect(ref.preferredSizes.US).toHaveLength(321);
    expect(ref.preferredSizes.metric).toHaveLength(86);
    expect(ref.preferredSizes.US.find((s) => s.sizeMm === 15.875)?.label).toBe('5/8"');
    expect(ref.partingRings).toEqual([{ diameterMm: 25, ringWidthMm: 2.5 }, { diameterMm: 50, ringWidthMm: 5 }, { diameterMm: 110, ringWidthMm: 8 }]);
  });

  it('names what the data lacks', () => {
    const { reference: none, missing } = stockReference(realStockMachiningReference({ bandSawKerf: '', snapStockSize: 'maybe' }));
    expect(none).toBeNull();
    expect(missing).toEqual(['Stock Machining variable bandSawKerf', 'Stock Machining variable snapStockSize (true or false)']);
  });
});

describe('the form a part\'s shape asks for', () => {
  it('a turned part and a part a circle holds tighter take round bar; a hexagon hex bar; a wide thin part plate; any other a rectangular bar', () => {
    expect(autoStockForm(SHAFT, ref).form).toBe('round_bar');
    expect(autoStockForm(BUSHING, ref).form).toBe('round_bar');
    // A milled part whose section a circle holds in less stock: 14 x 14 against Ø14.
    expect(autoStockForm({ ...SHAFT, family: 'milled' }, ref)).toMatchObject({ form: 'round_bar' });
    expect(autoStockForm(HEX, ref).form).toBe('hex_bar');
    // 200 x 20: at least minPlateTriggerWidth 152.4 wide, and 0.1 of its width thick (maxPlateTriggerHeightOverWidth 0.25).
    expect(autoStockForm(WIDE, ref).form).toBe('plate');
    expect(autoStockForm(WIDE, ref).basis).toContain('minPlateTriggerWidth 152.4');
    // 42 wide: under the plate trigger. 200 x 60: wide enough, but 0.3 of its width thick.
    expect(autoStockForm(STIFFENER, ref).form).toBe('rectangular_bar');
    expect(autoStockForm({ ...WIDE, heightMm: 60 }, ref).form).toBe('rectangular_bar');
  });
});

describe('bar stock: the size, the piece and what a bar yields', () => {
  it('the shaft on round bar: Ø14 + 2 x 0.79375 snaps to 5/8 in in the USA and 16 mm in India; a 6096 mm bar makes 172', () => {
    const usa = selectStock(SHAFT, ref, USA);
    expect(usa.rule.form).toBe('round_bar');
    const bar = usa.chosen!;
    // 5 % of 14 is 0.7, under minStockAllowance 0.79375: the least applies. 14 + 1.5875 = 15.5875, next inch size 15.875.
    expect(bar).toMatchObject({ form: 'round_bar', sizeLabel: '5/8" round bar', aMm: 15.875, allowancePerSideMm: 0.79375, endAllowanceMm: 0.79375, snapped: true, cutWidthMm: 0.889 });
    expect(bar.requiredAMm).toBeCloseTo(15.5875, 9);
    const area = (Math.PI / 4) * 15.875 ** 2;
    expect(bar.sectionAreaMm2).toBeCloseTo(area, 9);
    // The piece: 32 + 2 x 0.79375 = 33.5875. Each takes 33.5875 + 0.889 kerf = 34.4765 of the 6096 - 152.4 = 5943.6 mm: 172 parts.
    expect(bar.blank.lengthMm).toBeCloseTo(33.5875, 9);
    expect(bar.blank.volumeMm3).toBeCloseTo(area * 33.5875, 6);
    expect(bar.stock).toEqual({ lengthMm: 6096, widthMm: null, partsPerStock: 172, virtual: false });
    expect(bar.purchasedVolumeMm3).toBeCloseTo((area * 6096) / 172, 6);
    expect(bar.utilizationPct).toBeCloseTo((2646 / ((area * 6096) / 172)) * 100, 6);
    expect(bar.saw).toEqual({ cutAreaMm2: area, widthMm: 15.875, heightMm: 15.875 });
    const india = selectStock(SHAFT, ref, INDIA).chosen!;
    expect(india).toMatchObject({ sizeLabel: '16 mm round bar', aMm: 16 });
  });

  it('the stiffener on rectangular bar: 42 x 8 + 2 x 2.1 snaps to 2 x 1/2 in; a bar makes 36', () => {
    const s = selectStock(STIFFENER, ref, USA);
    expect(s.rule).toMatchObject({ form: 'rectangular_bar' });
    // 5 % of 42 = 2.1 each side: 46.2 x 12.2, next inch sizes 50.8 and 12.7.
    expect(s.chosen).toMatchObject({ form: 'rectangular_bar', sizeLabel: '2" x 1/2" rectangular bar', aMm: 50.8, bMm: 12.7, allowancePerSideMm: 2.1 });
    // The piece 159.5 + 4.2 = 163.7; with the kerf 164.589; 5943.6 / 164.589 = 36.1: 36 parts.
    expect(s.chosen!.blank.lengthMm).toBeCloseTo(163.7, 9);
    expect(s.chosen!.stock.partsPerStock).toBe(36);
    expect(s.chosen!.purchasedVolumeMm3).toBeCloseTo((50.8 * 12.7 * 6096) / 36, 6);
    expect(s.chosen!.saw).toEqual({ cutAreaMm2: 50.8 * 12.7, widthMm: 50.8, heightMm: 12.7 });
    expect(selectStock(STIFFENER, ref, INDIA).chosen).toMatchObject({ sizeLabel: '50 mm x 16 mm rectangular bar' });
  });

  it('a rectangular bar whose two sides snap to the same size is a square bar', () => {
    // 30 x 29 + 2 x 1.5: 33 and 32 both take the 1.5 in size.
    const s = selectStock({ ...STIFFENER, widthMm: 30, heightMm: 29, roundOdMm: Math.hypot(30, 29), lengthMm: 100 }, ref, USA);
    expect(s.rule.form).toBe('square_bar');
    expect(s.chosen).toMatchObject({ form: 'square_bar', sizeLabel: '1.5" x 1.5" square bar', aMm: 38.1 });
    expect(s.chosen!.sectionAreaMm2).toBeCloseTo(38.1 ** 2, 9);
  });

  it('a hex part on hex bar: the flats as supplied (no allowance, not snapped), the ends faced', () => {
    const hex = selectStock(HEX, ref, USA).chosen!;
    expect(hex).toMatchObject({ form: 'hex_bar', sizeLabel: '24 mm A/F hex bar', aMm: 24, allowancePerSideMm: 0, snapped: false });
    expect(hex.sectionAreaMm2).toBeCloseTo((Math.sqrt(3) / 2) * 24 ** 2, 9);
    // The ends take the general allowance on the part's largest section dimension: 5 % of 27.713 = 1.3856 each end.
    expect(hex.endAllowanceMm).toBeCloseTo(0.05 * (48 / Math.sqrt(3)), 9);
    expect(hex.saw.widthMm).toBeCloseTo(48 / Math.sqrt(3), 9);
    expect(hex.saw.heightMm).toBe(24);
  });

  it('a bushing is offered tube beside its round bar: the OD snapped up, the bore snapped down inside the part\'s', () => {
    const s = selectStock(BUSHING, ref, USA);
    expect(s.chosen).toMatchObject({ form: 'round_bar', sizeLabel: '1.75" round bar' });
    // OD 40 + 2 x 2 = 44, next 44.45; bore 20 less idStockTrimAllowance 0: the largest inch size at or under 20 is 19.05.
    const tube = option(s.options.find((o) => o.form === 'round_tube')!);
    expect(tube).toMatchObject({ aMm: 44.45, bMm: 19.05, sizeLabel: '1.75" x 3/4" bore round tube' });
    expect(tube.sectionAreaMm2).toBeCloseTo((Math.PI / 4) * (44.45 ** 2 - 19.05 ** 2), 9);
    // A part with no bore through it has no tube.
    expect(selectStock(SHAFT, ref, USA).options.find((o) => o.form === 'round_tube')).toEqual({ form: 'round_tube', unavailable: expect.stringContaining('this part has none') });
  });

  it('a bar-fed lathe parts the piece off: the parting ring\'s width replaces the kerf', () => {
    // A 5/8 in bar is within the 25 mm row: a 2.5 mm ring. (33.5875 + 2.5) into 5943.6: 164 parts.
    const bar = selectStock(SHAFT, ref, { ...USA, cutOff: 'parting' }).chosen!;
    expect(bar.cutWidthMm).toBe(2.5);
    expect(bar.stock.partsPerStock).toBe(164);
  });

  it('the Cost Guide\'s allowance and snapping replace the data\'s, and say so', () => {
    const exact = selectStock(SHAFT, ref, { ...USA, allowanceMm: 0, snap: false }).chosen!;
    expect(exact).toMatchObject({ aMm: 14, allowancePerSideMm: 0, endAllowanceMm: 0, snapped: false, sizeLabel: 'Ø14 mm round bar' });
    expect(exact.blank.lengthMm).toBe(32);
    expect(exact.notes).toEqual(['Stock on each side set in the Cost Guide: 0 mm.', 'Snapping to preferred sizes set in the Cost Guide: off.']);
    // A longer bar end leaves fewer parts: 5943.6 -> 5796: 168.
    expect(selectStock(SHAFT, ref, { ...USA, remnantMm: 300 }).chosen!.stock.partsPerStock).toBe(168);
  });
});

describe('plate stock', () => {
  it('a wide thin part: the thickness snapped, blanks in a grid on the standard plate a kerf apart', () => {
    const s = selectStock(WIDE, ref, USA);
    expect(s.rule.form).toBe('plate');
    const plate = s.chosen!;
    // 5 % of 200 is 10, over maxStockAllowance 3.175: the most applies. 20 + 6.35 = 26.35, next inch size 31.75.
    expect(plate).toMatchObject({ form: 'plate', aMm: 31.75, allowancePerSideMm: 3.175, sizeLabel: '1.25" plate, 306.35 x 206.35 mm blank', sectionAreaMm2: null });
    expect(plate.blank).toEqual({ lengthMm: 306.35, widthMm: 206.35, thicknessMm: 31.75, volumeMm3: 306.35 * 206.35 * 31.75 });
    // On 914.4 x 457.2 with a 0.889 kerf: 2 along by 2 across (915.289 / 307.239 = 2.98, 458.089 / 207.239 = 2.21): 4; turned, 4 by 1: 4.
    expect(plate.stock).toEqual({ lengthMm: 914.4, widthMm: 457.2, partsPerStock: 4, virtual: false });
    expect(plate.purchasedVolumeMm3).toBeCloseTo((914.4 * 457.2 * 31.75) / 4, 6);
    // The saw frees a blank along two of its edges, through the plate.
    expect(plate.saw.cutAreaMm2).toBeCloseTo(31.75 * (306.35 + 206.35), 9);
    expect(plate.saw.heightMm).toBe(31.75);
  });

  it('a blank the standard plate cannot hold is cut from a plate of its own size, and says so', () => {
    const big = selectStock({ ...WIDE, lengthMm: 1200, widthMm: 500, heightMm: 20, roundOdMm: Math.hypot(500, 20) }, ref, USA).chosen!;
    expect(big.stock).toMatchObject({ partsPerStock: 1, virtual: true, lengthMm: 1206.35, widthMm: 506.35 });
    expect(big.notes.join(' ')).toContain('larger than the standard 914.4 x 457.2 mm plate');
  });
});

describe('a form that cannot hold the part', () => {
  it('falls back to a billet cut from plate, with the reason; a set form that fits is used as set', () => {
    // Longer than a bar: 6100 + 2 x 0.79375 against 5943.6 to cut from.
    const long = selectStock({ ...SHAFT, lengthMm: 6100 }, ref, USA);
    expect(long.chosen).toMatchObject({ form: 'billet' });
    expect(long.fallback).toContain("The part's round bar is not available: the part takes 6101.588 mm of bar");
    expect(long.fallback).toContain('Priced as a billet cut from plate.');
    // The stiffener set to round bar in the Cost Guide: the circle round 42 x 8 is 42.76; + 2 x 2.138 = 47.03: a 2 in bar.
    const round = selectStock(STIFFENER, ref, USA, 'round_bar');
    expect(round).toMatchObject({ fallback: null, rule: { form: 'rectangular_bar' } });
    expect(round.chosen).toMatchObject({ form: 'round_bar', sizeLabel: '2" round bar' });
    // A tube set for a part with no bore.
    const tube = selectStock(SHAFT, ref, USA, 'round_tube');
    expect(tube.chosen).toMatchObject({ form: 'billet' });
    expect(tube.fallback).toMatch(/^The Cost Guide's round tube is not available: a tube is stock for a part with a bore/);
  });

  it('every form is returned, each with its stock or why it is not offered', () => {
    const s = selectStock(STIFFENER, ref, USA);
    expect(s.options.map((o) => o.form)).toEqual(['round_bar', 'hex_bar', 'rectangular_bar', 'square_bar', 'plate', 'round_tube', 'billet']);
    expect(s.options.filter(isStockOption).map((o) => o.form)).toEqual(['round_bar', 'hex_bar', 'rectangular_bar', 'square_bar', 'plate', 'billet']);
    // A billet is the part's own block, not snapped to a plate thickness: 163.7 x 46.2 x 12.2.
    expect(option(s.options.find((o) => o.form === 'billet')!)).toMatchObject({ sizeLabel: '163.7 x 46.2 x 12.2 mm billet', snapped: false });
  });
});
