// A plate part's drop-off roughing techniques (plate-roughing.ts) on memory/Stock Maching's own values: the plate a mill takes, each cutting
// process's lead-in and the spacing between cut parts (tblPartSpacing). The part is STIFFNER 2 (R_M-0230-039): 159.5 x 42 x 8 mm, 15 208.37
// mm³, its outline 397.81 mm round and 5 058.6 mm² inside. Expected values are worked out by hand in the comments.
import { realStockMachiningReference } from './stock-test-data';
import { plateOutlineOf, type PlateOutline } from '../../../../../modules/bom-items/costing/stock/plate-outline';
import {
  isDropoffStock, partSpacingMm, perimeterMilledStock, PLATE_CUT_PROCESSES, plateCutStock, ROUGHING_TECHNIQUES, roughedOption, roughingReference, roughingTechniqueOf,
  type DropoffStock,
} from '../../../../../modules/bom-items/costing/stock/plate-roughing';
import { stockReference } from '../../../../../modules/bom-items/costing/stock/stock-reference';
import { isStockOption, stockOption, type StockOption, type StockPart, type StockSettings } from '../../../../../modules/bom-items/costing/stock/stock-selection';
import { resolveSandReference } from '../../../../../modules/bom-items/costing/casting/sand/sand-reference';

const REF = realStockMachiningReference();
const STOCK = stockReference(REF).reference!;
const ROUGHING = roughingReference(REF).reference!;
const US: StockSettings = { unitSystem: 'US', cutOff: 'saw', remnantMm: 152.4, allowanceMm: null, snap: null };

const STIFFNER: StockPart = { source: 'measured', family: 'milled', lengthMm: 159.5, roundOdMm: 42.76, widthMm: 42, heightMm: 8, hexAcrossFlatsMm: null, boreMm: null, volumeMm3: 15208.37 };
const OUTLINE: PlateOutline = plateOutlineOf({
  extractionVersion: 'stk_v1',
  plate: { version: 'plt_v1', normal: [0, 0, 1], thickness_mm: 8, outline: { perimeter_mm: 397.81, area_mm2: 5058.6, rect: { length_mm: 159.5, width_mm: 42, angle_deg: 0 }, openings: { count: 0, perimeter_mm: 0, area_mm2: 0 } } },
})!;
const plateOf = (part: StockPart, settings: StockSettings = US, form: 'plate' | 'billet' = 'plate'): StockOption => {
  const o = stockOption(form, part, STOCK, settings);
  if (!isStockOption(o)) throw new Error(o.unavailable);
  return o;
};
// The stock model's plate for the part: 5 % of its 42 mm width is 2.1 mm a side (between 0.79375 and 3.175), so it needs 8 + 4.2 = 12.2 mm
// and is bought 1/2 in (12.7 mm) thick.
const PLATE = plateOf(STIFFNER);
const dropoff = (d: ReturnType<typeof perimeterMilledStock>): DropoffStock => {
  if (!isDropoffStock(d)) throw new Error(d.unavailable);
  return d;
};

describe('the roughing techniques the data names', () => {
  it('reads a technique from the data\'s text, whatever its case and hyphens', () => {
    expect(roughingTechniqueOf('All Bulk Milling')).toBe('all_bulk_milling');
    expect(roughingTechniqueOf('Perimeter Milling with Dropoff')).toBe('perimeter_milling_dropoff');
    expect(roughingTechniqueOf('plate cutting with drop-off')).toBe('plate_cutting_dropoff');
    expect(roughingTechniqueOf('Something Else')).toBeNull();
    expect(roughingTechniqueOf('')).toBeNull();
    expect(roughingTechniqueOf(null)).toBeNull();
  });

  it('the staged default is one of the three', () => {
    expect(ROUGHING_TECHNIQUES).toContain(roughingTechniqueOf(STOCK.roughingTechnique));
    expect(roughingTechniqueOf(STOCK.roughingTechnique)).toBe('all_bulk_milling');
  });
});

describe('roughingReference', () => {
  it('reads the plate a mill takes, each process\'s lead-in and the part spacings', () => {
    expect(ROUGHING.nestedMilledPlate).toEqual({ lengthMm: 914.4, widthMm: 457.2 });
    expect(ROUGHING.perimeterAllowanceMm).toEqual({ 'Laser Cut': 10, 'Plasma Cut': 3.175, 'Oxyfuel Cut': 25, 'Waterjet Cut': 5 });
    expect(ROUGHING.partSpacing).toHaveLength(199);
    for (const process of PLATE_CUT_PROCESSES) expect(ROUGHING.partSpacing.some((r) => r.process === process)).toBe(true);
  });

  it('names what the staged data lacks, and gives no reference then', () => {
    const lacking = resolveSandReference({ variables: [{ key: 'defaultLaserPerimeterAllowance', value: '10', unit_type: 'Length' }], lookups: [] });
    const { reference, missing } = roughingReference(lacking);
    expect(reference).toBeNull();
    expect(missing).toEqual([
      'Stock Machining variable maxPlateLengthForNestedMilledParts', 'Stock Machining variable maxPlateWidthForNestedMilledParts',
      'Stock Machining variable defaultPlasmaPerimeterAllowance', 'Stock Machining variable defaultOxyFuelPerimeterAllowance',
      'Stock Machining variable defaultWaterjetPerimeterAllowance', 'Stock Machining lookup tblPartSpacing (migration 1114)',
    ]);
  });
});

describe('partSpacingMm', () => {
  it('is the first row of the process at or above the thickness', () => {
    // 12.7 mm plate: the 13 mm rows. Laser 1 x thickness, plasma 2 x, oxyfuel 3 x; waterjet a flat 5.08.
    expect(partSpacingMm(ROUGHING.partSpacing, 'Laser Cut', 12.7)).toBe(13);
    expect(partSpacingMm(ROUGHING.partSpacing, 'Plasma Cut', 12.7)).toBe(26);
    expect(partSpacingMm(ROUGHING.partSpacing, 'Oxyfuel Cut', 12.7)).toBe(39);
    expect(partSpacingMm(ROUGHING.partSpacing, 'Waterjet Cut', 12.7)).toBe(5.08);
    // A thickness the table lists takes its own row: 12 mm plasma is 24, not 26.
    expect(partSpacingMm(ROUGHING.partSpacing, 'Plasma Cut', 12)).toBe(24);
    // 25.4 mm plate: the 26 mm rows.
    expect(partSpacingMm(ROUGHING.partSpacing, 'Laser Cut', 25.4)).toBe(26);
    expect(partSpacingMm(ROUGHING.partSpacing, 'Oxyfuel Cut', 25.4)).toBe(78);
  });

  it('is the process\'s largest spacing for a plate thicker than its numbered rows: the table\'s catch-all row', () => {
    expect(partSpacingMm(ROUGHING.partSpacing, 'Laser Cut', 80)).toBe(50);
    expect(partSpacingMm(ROUGHING.partSpacing, 'Plasma Cut', 80)).toBe(100);
    expect(partSpacingMm(ROUGHING.partSpacing, 'Oxyfuel Cut', 80)).toBe(225);
  });

  it('has none beyond the process\'s last row, and for a process the table does not list', () => {
    const rows = [{ process: 'Laser Cut', thicknessMm: 10, spacingMm: 10 }, { process: 'Laser Cut', thicknessMm: 20, spacingMm: 20 }];
    expect(partSpacingMm(rows, 'Laser Cut', 20)).toBe(20);
    expect(partSpacingMm(rows, 'Laser Cut', 20.5)).toBeNull();
    expect(partSpacingMm(rows, 'Plasma Cut', 5)).toBeNull();
    expect(partSpacingMm([], 'Laser Cut', 5)).toBeNull();
  });
});

describe('Perimeter Milling with Drop-off', () => {
  const milled = dropoff(perimeterMilledStock({ option: PLATE, part: STIFFNER, outline: OUTLINE, stock: STOCK, reference: ROUGHING, cutterDiameterMm: 10 }));

  it('nests the outline\'s rectangle on the plate a mill takes, the cutter\'s width between two parts and to the edge', () => {
    // floor((914.4 - 10) / (159.5 + 10)) = 5 along, floor((457.2 - 10) / (42 + 10)) = 8 across: 40. Turned: 17 x 2 = 34.
    expect(milled.plate).toEqual({ lengthMm: 914.4, widthMm: 457.2, virtual: false });
    expect(milled.nest).toEqual({ partsPerPlate: 40, along: 5, across: 8, rotated: false, gapMm: 10, edgeMm: 10 });
    expect(milled.technique).toBe('perimeter_milling_dropoff');
    expect(milled.process).toBeNull();
  });

  it('leaves the outline through the plate\'s thickness for the mill, and buys a fortieth of the plate', () => {
    // The plate is the stock's 12.7 mm, not the part's 8 mm: 5058.6 x 12.7 = 64 244.22 mm³.
    expect(milled.piece.thicknessMm).toBe(12.7);
    expect(milled.piece.volumeMm3).toBeCloseTo(64244.22, 6);
    expect(milled.piece.perimeterMm).toBe(397.81);
    expect(milled.piece.rect).toEqual({ lengthMm: 159.5, widthMm: 42 });
    // 914.4 x 457.2 x 12.7 / 40 = 5 309 408.736 / 40 = 132 735.2184 mm³; the part is 15 208.37 of it: 11.4577 %.
    expect(milled.purchasedVolumeMm3).toBeCloseTo(132735.2184, 4);
    expect(milled.utilizationPct).toBeCloseTo(11.4577, 3);
    // One pass of the cut: the outline and one cutter diameter of lead.
    expect(milled.cut).toEqual({ lengthMm: 407.81, pierces: 1 });
  });

  it('says the plate is loaded whole and the nest is a grid of rectangles', () => {
    expect(milled.notes[0]).toContain('the 914.4 x 457.2 mm plate is loaded on the mill whole');
    expect(milled.notes[0]).toContain('nothing is sawn');
    expect(milled.notes[0]).toContain('40 per plate');
    expect(milled.notes[1]).toContain('COMPUTED utilisation');
    expect(milled.notes[1]).toContain('nesting the true outlines into each other is not built');
  });

  it('is limited by the plate a mill takes, whatever the standard plate is', () => {
    const small = { ...ROUGHING, nestedMilledPlate: { lengthMm: 400, widthMm: 300 } };
    // floor(390 / 169.5) = 2 along, floor(290 / 52) = 5 across: 10. Turned: floor(390 / 52) = 7, floor(290 / 169.5) = 1: 7.
    const d = dropoff(perimeterMilledStock({ option: PLATE, part: STIFFNER, outline: OUTLINE, stock: STOCK, reference: small, cutterDiameterMm: 10 }));
    expect(d.plate).toEqual({ lengthMm: 400, widthMm: 300, virtual: false });
    expect(d.nest.partsPerPlate).toBe(10);
  });

  it('cannot be used for a part whose outline does not fit that plate: the plate is not made larger', () => {
    const long: StockPart = { ...STIFFNER, lengthMm: 900, volumeMm3: 90000 };
    const outline = { ...OUTLINE, perimeterMm: 1884, areaMm2: 37800, rect: { lengthMm: 900, widthMm: 42 } };
    // 900 + 2 x 10 = 920 mm is longer than the 914.4 mm plate.
    const d = perimeterMilledStock({ option: plateOf(long), part: long, outline, stock: STOCK, reference: ROUGHING, cutterDiameterMm: 10 });
    expect(d).toEqual({
      unavailable: 'the part\'s 900 x 42 mm outline with a 10 mm cut round it does not fit the 914.4 x 457.2 mm plate a mill takes '
        + '(maxPlateLengthForNestedMilledParts x maxPlateWidthForNestedMilledParts)',
    });
    // A plate cutting process cuts the same part from a plate of its own size.
    expect(isDropoffStock(plateCutStock({ option: plateOf(long), part: long, outline, stock: STOCK, reference: ROUGHING, process: 'Waterjet Cut' }))).toBe(true);
  });

  it('cannot use an outline measured across another side of the part than the plate\'s thickness', () => {
    // A disc: 20 mm long along its axis, its section 60 x 50. The stock model lays it in the plate on its 50 mm side; the cad-engine
    // measures the outline across its thinnest direction, the 20 mm.
    const disc: StockPart = { ...STIFFNER, lengthMm: 20, widthMm: 60, heightMm: 50 };
    const d = perimeterMilledStock({ option: plateOf(disc), part: disc, outline: { ...OUTLINE, thicknessMm: 20 }, stock: STOCK, reference: ROUGHING, cutterDiameterMm: 10 });
    expect(isDropoffStock(d)).toBe(false);
    expect((d as { unavailable: string }).unavailable).toContain('measured across the part\'s 20 mm thickness');
    expect((d as { unavailable: string }).unavailable).toContain('on its 50 mm side');
  });

  it('is not a technique of bar stock', () => {
    const bar = stockOption('rectangular_bar', STIFFNER, STOCK, US) as StockOption;
    expect(perimeterMilledStock({ option: bar, part: STIFFNER, outline: OUTLINE, stock: STOCK, reference: ROUGHING, cutterDiameterMm: 10 })).toEqual({ unavailable: 'the stock is not plate' });
  });
});

describe('Plate Cutting with Drop-off', () => {
  const cut = (process: (typeof PLATE_CUT_PROCESSES)[number], option = PLATE, part = STIFFNER, outline = OUTLINE) =>
    dropoff(plateCutStock({ option, part, outline, stock: STOCK, reference: ROUGHING, process }));

  it('cuts the outline grown by the stock allowance, from one pierce, with the process\'s lead-in', () => {
    // Grown by 2.1 mm: 397.81 + 2π x 2.1 = 411.0047 mm round, 5058.6 + 397.81 x 2.1 + π x 2.1² = 5907.8554 mm² inside, 163.7 x 46.2 mm.
    const laser = cut('Laser Cut');
    expect(laser.piece.perimeterMm).toBeCloseTo(411.0047, 4);
    expect(laser.piece.areaMm2).toBeCloseTo(5907.8554, 4);
    expect(laser.piece.rect.lengthMm).toBeCloseTo(163.7, 9);
    expect(laser.piece.rect.widthMm).toBeCloseTo(46.2, 9);
    // The piece the mill starts from: 5907.8554 x 12.7 = 75 029.76 mm³.
    expect(laser.piece.volumeMm3).toBeCloseTo(75029.76, 1);
    // The cut: the grown outline plus the lead-in and lead-out. Laser 10, plasma 3.175, oxyfuel 25, waterjet 5 mm.
    expect(laser.cut.lengthMm).toBeCloseTo(421.0047, 4);
    expect(cut('Plasma Cut').cut.lengthMm).toBeCloseTo(414.1797, 4);
    expect(cut('Oxyfuel Cut').cut.lengthMm).toBeCloseTo(436.0047, 4);
    expect(cut('Waterjet Cut').cut.lengthMm).toBeCloseTo(416.0047, 4);
    for (const process of PLATE_CUT_PROCESSES) expect(cut(process).cut.pierces).toBe(1);
  });

  it('nests the grown rectangle on the standard plate, the process\'s spacing apart, with no margin at the edge', () => {
    // 163.7 x 46.2 mm on 914.4 x 457.2 mm, 12.7 mm plate:
    //   Laser 13 mm:      floor(927.4 / 176.7) = 5, floor(470.2 / 59.2) = 7  -> 35       (turned 15 x 2 = 30)
    //   Plasma 26 mm:     floor(940.4 / 189.7) = 4, floor(483.2 / 72.2) = 6  -> 24;      turned floor(940.4 / 72.2) = 13, 2 -> 26
    //   Oxyfuel 39 mm:    floor(953.4 / 202.7) = 4, floor(496.2 / 85.2) = 5  -> 20;      turned floor(953.4 / 85.2) = 11, 2 -> 22
    //   Waterjet 5.08 mm: floor(919.48 / 168.78) = 5, floor(462.28 / 51.28) = 9 -> 45    (turned 17 x 2 = 34)
    expect(cut('Laser Cut').nest).toEqual({ partsPerPlate: 35, along: 5, across: 7, rotated: false, gapMm: 13, edgeMm: 0 });
    expect(cut('Plasma Cut').nest).toEqual({ partsPerPlate: 26, along: 13, across: 2, rotated: true, gapMm: 26, edgeMm: 0 });
    expect(cut('Oxyfuel Cut').nest).toEqual({ partsPerPlate: 22, along: 11, across: 2, rotated: true, gapMm: 39, edgeMm: 0 });
    expect(cut('Waterjet Cut').nest).toEqual({ partsPerPlate: 45, along: 5, across: 9, rotated: false, gapMm: 5.08, edgeMm: 0 });
    // The plate bought per part: 5 309 408.736 mm³ over the parts.
    expect(cut('Laser Cut').purchasedVolumeMm3).toBeCloseTo(5309408.736 / 35, 4);
    expect(cut('Plasma Cut').purchasedVolumeMm3).toBeCloseTo(5309408.736 / 26, 4);
  });

  it('cuts a blank the standard plate cannot hold from a plate of its own size, as a sawn blank is', () => {
    const long: StockPart = { ...STIFFNER, lengthMm: 950, volumeMm3: 90000 };
    const outline = { ...OUTLINE, perimeterMm: 1984, areaMm2: 39900, rect: { lengthMm: 950, widthMm: 42 } };
    const d = cut('Plasma Cut', plateOf(long), long, outline);
    // Grown by 2.1 mm: 954.2 x 46.2 mm, longer than the 914.4 mm plate.
    expect(d.plate.virtual).toBe(true);
    expect(d.plate.lengthMm).toBeCloseTo(954.2, 9);
    expect(d.plate.widthMm).toBeCloseTo(46.2, 9);
    expect(d.nest.partsPerPlate).toBe(1);
    expect(d.purchasedVolumeMm3).toBeCloseTo(954.2 * 46.2 * 12.7, 4);
    expect(d.notes[0]).toContain('is larger than the standard 914.4 x 457.2 mm plate: priced as a plate cut to the blank');
  });

  it('with no allowance cuts the outline itself', () => {
    const exact = plateOf(STIFFNER, { ...US, allowanceMm: 0, snap: false });
    const d = cut('Laser Cut', exact);
    expect(d.piece.perimeterMm).toBe(397.81);
    expect(d.piece.areaMm2).toBe(5058.6);
    expect(d.piece.thicknessMm).toBe(8);
    // 8 mm plate: the 8 mm laser row.
    expect(d.nest.gapMm).toBe(8);
  });

  it('cannot be cut by a process the spacing table does not list at the plate\'s thickness', () => {
    const reference = { ...ROUGHING, partSpacing: ROUGHING.partSpacing.filter((r) => !(r.process === 'Laser Cut' && r.thicknessMm > 12)) };
    expect(plateCutStock({ option: PLATE, part: STIFFNER, outline: OUTLINE, stock: STOCK, reference, process: 'Laser Cut' }))
      .toEqual({ unavailable: 'tblPartSpacing lists no Laser Cut spacing for 12.7 mm plate' });
  });

  it('says what cuts it, how it is nested, and that the kerf variables are not used', () => {
    const d = cut('Plasma Cut');
    expect(d.notes[0]).toContain('Plasma Cut cuts the part\'s outline, with the 2.1 mm stock allowance left on it, out of the 12.7 mm plate');
    expect(d.notes[0]).toContain('26 per 914.4 x 457.2 mm plate, 26 mm between two parts (tblPartSpacing)');
    expect(d.notes[0]).toContain('plus 3.175 mm of lead-in and lead-out (defaultPlasmaPerimeterAllowance), from one pierce');
    expect(d.notes[0]).toContain('the openings through the part are left for the mill');
    expect(d.notes.some((n) => n.includes('COMPUTED utilisation'))).toBe(true);
    expect(d.notes.some((n) => n.includes('kerf multipliers') && n.includes('are not used') && n.includes('tblPartSpacing states the gap'))).toBe(true);
  });
});

describe('roughedOption', () => {
  const sizes = STOCK.preferredSizes.US;

  it('is the plate option with the technique\'s piece, plate and yield', () => {
    const d = dropoff(perimeterMilledStock({ option: PLATE, part: STIFFNER, outline: OUTLINE, stock: STOCK, reference: ROUGHING, cutterDiameterMm: 10 }));
    const o = roughedOption(PLATE, d, STOCK, sizes);
    expect(o.form).toBe('plate');
    expect(o.aMm).toBe(12.7);
    expect(o.allowancePerSideMm).toBe(PLATE.allowancePerSideMm);
    expect(o.sizeLabel).toBe('1/2" plate, 159.5 x 42 mm outline');
    expect(o.blank).toEqual({ lengthMm: 159.5, widthMm: 42, thicknessMm: 12.7, volumeMm3: d.piece.volumeMm3 });
    expect(o.cutWidthMm).toBe(10);
    expect(o.stock).toEqual({ lengthMm: 914.4, widthMm: 457.2, partsPerStock: 40, virtual: false });
    expect(o.purchasedVolumeMm3).toBe(d.purchasedVolumeMm3);
    expect(o.utilizationPct).toBe(d.utilizationPct);
    expect(o.roughing).toBe(d);
    expect(o.notes).toEqual(d.notes);
    // The plate option itself is not changed.
    expect(PLATE.roughing).toBeUndefined();
    expect(PLATE.sizeLabel).toBe('1/2" plate, 163.7 x 46.2 mm blank');
  });

  it('names a cut blank, and a plate of the part\'s own thickness by its millimetres', () => {
    const d = dropoff(plateCutStock({ option: PLATE, part: STIFFNER, outline: OUTLINE, stock: STOCK, reference: ROUGHING, process: 'Laser Cut' }));
    expect(roughedOption(PLATE, d, STOCK, sizes).sizeLabel).toBe('1/2" plate, 163.7 x 46.2 mm cut blank');
    const billet = plateOf(STIFFNER, US, 'billet');
    const b = dropoff(plateCutStock({ option: billet, part: STIFFNER, outline: OUTLINE, stock: STOCK, reference: ROUGHING, process: 'Laser Cut' }));
    expect(roughedOption(billet, b, STOCK, sizes).sizeLabel).toBe('12.2 mm plate, 163.7 x 46.2 mm cut blank');
  });

  it('drops what the plate option said of its sawn blank on a plate of its own size, and keeps the Cost Guide\'s notes', () => {
    const long: StockPart = { ...STIFFNER, lengthMm: 950, volumeMm3: 90000 };
    const outline = { ...OUTLINE, perimeterMm: 1984, areaMm2: 39900, rect: { lengthMm: 950, widthMm: 42 } };
    const option = plateOf(long, { ...US, allowanceMm: 3 });
    expect(option.notes).toEqual([
      'Stock on each side set in the Cost Guide: 3 mm.',
      'The 956 x 48 mm blank is larger than the standard 914.4 x 457.2 mm plate: priced as a plate cut to the blank.',
    ]);
    const d = dropoff(plateCutStock({ option, part: long, outline, stock: STOCK, reference: ROUGHING, process: 'Waterjet Cut' }));
    const o = roughedOption(option, d, STOCK, sizes);
    expect(o.notes[0]).toBe('Stock on each side set in the Cost Guide: 3 mm.');
    expect(o.notes.filter((n) => n.includes('priced as a plate cut to the blank'))).toHaveLength(1);
    expect(o.notes[1]).toContain('Waterjet Cut cuts the part\'s outline');
    expect(o.stock.virtual).toBe(true);
  });
});
