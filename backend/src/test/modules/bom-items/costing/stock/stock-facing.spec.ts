// What a mill faces off the stock piece before the part's features (stock-facing.ts), on the stock model's own pieces (stock-selection.ts,
// memory/Stock Maching's rules): a block's top and bottom with the piece's thickness less the part's height between them, a bar's two sawn
// ends with the end allowance. The workbook's Face Milling sheet times each face from these; Bulk Milling takes only what is left.
import { realStockMachiningReference } from './stock-test-data';
import { stockReference } from '../../../../../modules/bom-items/costing/stock/stock-reference';
import { isStockOption, stockOption, type StockForm, type StockOption, type StockPart, type StockSettings } from '../../../../../modules/bom-items/costing/stock/stock-selection';
import { stockFacing } from '../../../../../modules/bom-items/costing/stock/stock-facing';

const { reference: ref } = stockReference(realStockMachiningReference());
const USA: StockSettings = { unitSystem: 'US', cutOff: 'saw', remnantMm: 152.4, allowanceMm: null, snap: null };
const option = (form: StockForm, part: StockPart): StockOption => {
  const o = stockOption(form, part, ref!, USA);
  if (!isStockOption(o)) throw new Error(o.unavailable);
  return o;
};

// R_M-0230-039 STIFFNER 2: a 159.5 x 42 plate, 8 high with its bosses.
const STIFFENER: StockPart = { source: 'measured', family: 'milled', lengthMm: 159.5, roundOdMm: Math.hypot(42, 8), widthMm: 42, heightMm: 8, hexAcrossFlatsMm: null, boreMm: null, volumeMm3: 15209 };
// The Lead Screw side shaft: Ø14 at its largest, 32 long.
const SHAFT: StockPart = { source: 'measured', family: 'mill_turn', lengthMm: 32, roundOdMm: 14, widthMm: 14, heightMm: 14, hexAcrossFlatsMm: null, boreMm: null, volumeMm3: 2646 };

describe('the facing of a block: its top and bottom', () => {
  it.each(['plate', 'billet'] as const)('a %s blank: its length x width, the thickness less the part\'s height split between the two faces', (form) => {
    const o = option(form, STIFFENER);
    const facing = stockFacing(o, STIFFENER)!;
    const thickness = o.blank.thicknessMm!;
    expect(facing).toMatchObject({ faces: 2, lengthMm: o.blank.lengthMm, widthMm: o.blank.widthMm });
    expect(facing.depthMm).toBeCloseTo((thickness - 8) / 2, 9);
    expect(facing.volumeMm3).toBeCloseTo(o.blank.lengthMm * o.blank.widthMm! * (thickness - 8), 6);
    // It is inside the stock around the part: never more than the piece less the part.
    expect(facing.volumeMm3).toBeLessThan(o.blank.volumeMm3 - STIFFENER.volumeMm3);
    expect(facing.basis).toContain('top and bottom');
  });

  it('a rectangular bar: its width (a) along its sawn length, its height (b) less the part\'s', () => {
    const o = option('rectangular_bar', STIFFENER);
    const facing = stockFacing(o, STIFFENER)!;
    expect(facing).toMatchObject({ faces: 2, lengthMm: o.blank.lengthMm, widthMm: o.aMm });
    expect(facing.depthMm).toBeCloseTo((o.bMm! - 8) / 2, 9);
    expect(facing.volumeMm3).toBeCloseTo(o.blank.lengthMm * o.aMm * (o.bMm! - 8), 6);
  });

  it('a drop-off piece: the outline\'s own area, not its bounding rectangle', () => {
    const o = option('plate', STIFFENER);
    const outline = { perimeterMm: 397.81, areaMm2: 5058.6, rect: { lengthMm: 159.5, widthMm: 42 }, thicknessMm: o.blank.thicknessMm!, volumeMm3: 5058.6 * o.blank.thicknessMm! };
    const roughed = { ...o, blank: { lengthMm: 159.5, widthMm: 42, thicknessMm: o.blank.thicknessMm, volumeMm3: outline.volumeMm3 }, roughing: { piece: outline } } as unknown as StockOption;
    const facing = stockFacing(roughed, STIFFENER)!;
    expect(facing).toMatchObject({ faces: 2, lengthMm: 159.5, widthMm: 42 });
    expect(facing.volumeMm3).toBeCloseTo(5058.6 * (o.blank.thicknessMm! - 8), 6);
  });

  it('a block with no stock on its faces (as thick as the part) is not faced', () => {
    const o = option('billet', STIFFENER);
    expect(stockFacing({ ...o, blank: { ...o.blank, thicknessMm: 8 } }, STIFFENER)).toBeNull();
  });
});

describe('the facing of a round bar: its two sawn ends', () => {
  it('across the bar, with the stock model\'s end allowance on each end', () => {
    const o = option('round_bar', SHAFT);
    const facing = stockFacing(o, SHAFT)!;
    expect(facing).toMatchObject({ faces: 2, lengthMm: o.circumscribedMm, widthMm: o.circumscribedMm, depthMm: o.endAllowanceMm });
    expect(facing.volumeMm3).toBeCloseTo(2 * o.sectionAreaMm2! * o.endAllowanceMm, 6);
    expect(facing.basis).toContain('sawn ends');
  });

  it('with no end allowance it is not faced', () => {
    expect(stockFacing({ ...option('round_bar', SHAFT), endAllowanceMm: 0 }, SHAFT)).toBeNull();
  });
});
