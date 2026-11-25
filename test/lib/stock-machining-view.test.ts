import { describe, expect, it } from 'vitest';

import {
  allowanceLine, batchLine, bundleLine, facesHighlight, flagOf, flagValue, isPlateStock, isStockMachiningItem, lossLine, materialStockFeatures, neededLine,
  optionCostLine, parseNonNegative, pieceLine, plateCutLine, quotedDropoff, roughingCostLine, roughingTechniqueLabel, roughingYieldLine, sawTimesLine,
  stockMachiningOverridesOf, yieldLine,
} from '@/lib/costing/stock-machining-view';
import { isStockStep } from '@/lib/features/process-tree-family';

import {
  SHAFT_INDIA, SHAFT_INDIA_SAW, SHAFT_INDIA_STOCK, SHAFT_USA_AS_SUPPLIED, SHAFT_USA_STOCK, STIFFNER_NO_OUTLINE, STIFFNER_PERIMETER_MILLED, STIFFNER_PLATE,
  STIFFNER_PLATE_CUT, STIFFNER_PLATE_ROUGHING, STIFFNER_PLATE_STOCK, STIFFNER_TUBE_ASKED, optionOf, techniqueOf,
} from '../fixtures/stock-machining-quotes';

const BULK = techniqueOf(STIFFNER_PLATE_ROUGHING, 'all_bulk_milling');
const MILLED = techniqueOf(STIFFNER_PLATE_ROUGHING, 'perimeter_milling_dropoff');
const CUT = techniqueOf(STIFFNER_PLATE_ROUGHING, 'plate_cutting_dropoff');

describe('the Stock Machining Cost Guide', () => {
  it('is the panel of a part whose Process is Stock Machining, not of a plain Machining part', () => {
    expect(isStockMachiningItem({ scenarioOverrides: { processGroup: 'Stock Machining' } })).toBe(true);
    expect(isStockMachiningItem({ scenarioOverrides: { processGroup: 'Machining' } })).toBe(false);
    expect(isStockMachiningItem(null)).toBe(false);
  });

  it('reads the settings as the engine does: a known form, numbers of 0 or more, true or false; anything else is unset', () => {
    expect(stockMachiningOverridesOf({ stockForm: 'plate', stockAllowanceMm: 0, stockSnap: false, stockRemnantMm: 50, stockScrapCredit: true, stockRoughingTechnique: 'plate_cutting_dropoff' }))
      .toEqual({ form: 'plate', allowanceMm: 0, snap: false, barEndMm: 50, scrapCredit: true, roughingTechnique: 'plate_cutting_dropoff' });
    expect(stockMachiningOverridesOf({ stockForm: 'sheet', stockAllowanceMm: -1, stockSnap: 'yes', stockRemnantMm: '50', stockScrapCredit: 1, stockRoughingTechnique: 'Plate Cutting' }))
      .toEqual({ form: null, allowanceMm: null, snap: null, barEndMm: null, scrapCredit: null, roughingTechnique: null });
    expect(stockMachiningOverridesOf(undefined)).toEqual({ form: null, allowanceMm: null, snap: null, barEndMm: null, scrapCredit: null, roughingTechnique: null });
  });

  it('takes 0 as a number field\'s value, an empty field as clearing it, and refuses a negative or a word', () => {
    expect(parseNonNegative('0')).toBe(0);
    expect(parseNonNegative(' 1.5 ')).toBe(1.5);
    expect(parseNonNegative('')).toBeNull();
    expect(parseNonNegative('-1')).toBe('invalid');
    expect(parseNonNegative('abc')).toBe('invalid');
  });

  it('turns a yes / no rule into a select value and back, with unset as its own value', () => {
    expect([flagValue(null), flagValue(true), flagValue(false)]).toEqual(['', 'on', 'off']);
    expect([flagOf(''), flagOf('on'), flagOf('off')]).toEqual([null, true, false]);
  });

  it('states a sawn round bar as an engineer reads it', () => {
    const stock = SHAFT_INDIA_STOCK;
    expect(isPlateStock(stock)).toBe(false);
    expect(neededLine(stock)).toBe('needs Ø15.59 mm');
    expect(allowanceLine(stock)).toBe('0.79 mm a side · 0.79 mm each end');
    expect(pieceLine(stock)).toBe('33.59 mm long');
    expect(yieldLine(stock)).toBe('172 pieces per 6096 mm bar');
    expect(lossLine(stock)).toBe('0.89 mm saw kerf between pieces · 152.4 mm bar end');
    expect(batchLine(stock)).toBe('1 bar for the batch');
    expect(sawTimesLine(SHAFT_INDIA_SAW)).toBe('cut 1.5 s · feed 0.46 s · load 0.12 s · unload 5 s = 7.07 s a piece');
    expect(bundleLine(SHAFT_INDIA_SAW, stock)).toBe('1 bar a cut');
    expect(bundleLine({ ...SHAFT_INDIA_SAW, bundleBars: 3 }, stock)).toBe('3 bars a cut');
  });

  it('says a bar bought at the part\'s own size is not snapped, and that a bar-fed lathe parts it off', () => {
    const stock = SHAFT_USA_STOCK;
    expect(neededLine(stock)).toBe('needs Ø14 mm, bought at that size');
    expect(lossLine(stock)).toBe('2.5 mm parting cut between pieces · 152.4 mm bar end');
  });

  it('states a rectangular bar by its two sides and a plate by its thickness, blank and plate', () => {
    expect(neededLine({ ...SHAFT_INDIA_STOCK, form: 'rectangular_bar', requiredAMm: 26.95, requiredBMm: 23.45 })).toBe('needs 26.95 × 23.45 mm');
    expect(neededLine({ ...SHAFT_INDIA_STOCK, form: 'hex_bar', requiredAMm: 14 })).toBe('needs 14 mm across flats');
    expect(neededLine({ ...SHAFT_INDIA_STOCK, form: 'round_tube', requiredAMm: 15.588, requiredBMm: 6 })).toBe('needs Ø15.59 mm over a 6 mm bore');
    const plate = STIFFNER_PLATE_STOCK;
    expect(isPlateStock(plate)).toBe(true);
    expect(neededLine(plate)).toBe('needs 12.2 mm thick');
    expect(pieceLine(plate)).toBe('163.7 × 46.2 × 12.7 mm');
    expect(yieldLine(plate)).toBe('45 blanks per 914.4 × 457.2 mm plate');
    expect(lossLine(plate)).toBe('0.89 mm saw kerf between pieces');
    expect(batchLine(plate)).toBe('3 plates for the batch');
    expect(bundleLine(SHAFT_INDIA_SAW, plate)).toBe('one plate at a time');
    expect(yieldLine({ ...plate, virtualPlate: true, partsPerStock: 1 })).toBe('A plate cut to the blank (larger than the standard plate)');
  });

  it('prices a form as its stock plus its sawing, and gives no price to a form that is not offered', () => {
    expect(optionCostLine(optionOf(STIFFNER_PLATE, 'round_bar'), '$')).toBe('$4.98 + $0.37 saw');
    expect(optionCostLine(optionOf(SHAFT_USA_AS_SUPPLIED, 'round_bar'), '$')).toBe('$0.09');
    expect(optionCostLine(optionOf(STIFFNER_TUBE_ASKED, 'round_tube'), '$')).toBeNull();
  });

  it('prices a roughing technique as its plate plus what separates the part from it', () => {
    expect(roughingCostLine(BULK, '$')).toBe('$2.37 plate + $0.44 Band Saw');
    expect(roughingCostLine(MILLED, '$')).toBe('$2.67 plate + $2.85 Perimeter Milling');
    expect(roughingCostLine(CUT, '$')).toBe('$2.37 plate + $1.46 Waterjet Cut');
    // A saw the part's Process does not cost is left out, not shown at 0.
    expect(roughingCostLine({ ...BULK, separation: { process: 'Band Saw', machineClass: 'band_saw', machineName: null, cost: null, timeSec: null } }, '$')).toBe('$2.37 plate');
    // A technique that cannot be used has no price.
    expect(roughingCostLine(techniqueOf(STIFFNER_NO_OUTLINE, 'perimeter_milling_dropoff'), '$')).toBeNull();
  });

  it('states what a technique makes of a plate and what it leaves the mill', () => {
    expect(roughingYieldLine(BULK)).toBe('45 per plate · 56,074.51 mm³ left for the mill');
    expect(roughingYieldLine(MILLED)).toBe('40 per plate · 24,268.95 mm³ left for the mill');
    expect(roughingYieldLine({ ...MILLED, bulkVolumeMm3: null })).toBe('40 per plate');
    expect(roughingYieldLine(techniqueOf(STIFFNER_NO_OUTLINE, 'perimeter_milling_dropoff'))).toBeNull();
  });

  it('lists each plate cutting process with its nest and cost, or why it is not priced', () => {
    const lines = CUT.processes.map((p) => plateCutLine(p, '$'));
    expect(lines).toEqual([
      'Laser Cut · 35 per plate · $3.05 plate + $1.64 cut',
      'Plasma Cut: sm_reference_data nestingCutRate PlasmaCut holds no feed data for Aluminum, ANSI 6061',
      'Oxyfuel Cut: sm_reference_data nestingCutRate OxyFuelCut holds no feed data for Aluminum, ANSI 6061',
      'Waterjet Cut (quoted) · 45 per plate · $2.37 plate + $1.46 cut',
    ]);
  });

  it('names the techniques, and tells a quoted drop-off from a sawn blank', () => {
    expect(roughingTechniqueLabel('perimeter_milling_dropoff')).toBe('Perimeter Milling with Drop-off');
    expect(roughingTechniqueLabel('something_new')).toBe('something_new');
    expect(quotedDropoff(SHAFT_INDIA)).toBeNull();
    expect(quotedDropoff(STIFFNER_PLATE_ROUGHING)).toBeNull();
    expect(quotedDropoff(STIFFNER_PERIMETER_MILLED)).toBe('perimeter_milling_dropoff');
    expect(quotedDropoff(STIFFNER_PLATE_CUT)).toBe('plate_cutting_dropoff');
  });

  it('states a plate a drop-off technique cuts the part out of: outlines or cut blanks, and what lies between two of them', () => {
    const milled = { ...STIFFNER_PLATE_STOCK, ...STIFFNER_PERIMETER_MILLED.stock };
    expect(pieceLine(milled)).toBe('159.5 × 42 × 12.7 mm');
    expect(yieldLine(milled, 'perimeter_milling_dropoff')).toBe('40 outlines per 914.4 × 457.2 mm plate');
    expect(lossLine(milled, 'perimeter_milling_dropoff')).toBe("10 mm cutter width between parts and to the plate's edge");
    const cut = { ...STIFFNER_PLATE_STOCK, ...STIFFNER_PLATE_CUT.stock };
    expect(yieldLine(cut, 'plate_cutting_dropoff')).toBe('45 cut blanks per 914.4 × 457.2 mm plate');
    expect(lossLine(cut, 'plate_cutting_dropoff')).toBe('5.08 mm between cut parts');
    // A sawn blank reads as it did, with or without the technique named.
    expect(yieldLine(STIFFNER_PLATE_STOCK, null)).toBe(yieldLine(STIFFNER_PLATE_STOCK));
    expect(lossLine(STIFFNER_PLATE_STOCK, null)).toBe('0.89 mm saw kerf between pieces');
  });

  it('a step of the stock is the Band Saw, or a line the engine marks as the stock\'s own (a plate cutting line)', () => {
    expect(isStockStep({ processGroup: 'Stock Machining' })).toBe(true);
    expect(isStockStep({ processGroup: 'Sheet Metal', stockStep: true })).toBe(true);
    expect(isStockStep({ processGroup: 'Sheet Metal' })).toBe(false);
    expect(isStockStep({ processGroup: 'Machining' })).toBe(false);
    expect(isStockStep(undefined)).toBe(false);
  });

  it('lists the Material Stock features the catalog names, only those the part has', () => {
    expect(materialStockFeatures(SHAFT_INDIA)).toEqual([]);
    expect(materialStockFeatures(SHAFT_USA_AS_SUPPLIED)).toEqual([{ key: 'curved', label: 'As Supplied // CurvedWall', featureType: 'CurvedWall', faceIds: [9] }]);
    expect(materialStockFeatures({ asSuppliedFaceIds: { curvedWall: [], planarFace: [1, 42] } }).map((f) => f.label)).toEqual(['As Supplied // PlanarFace']);
  });

  it('highlights faces by their ids, leaving their position to the viewer; no faces is no highlight', () => {
    expect(facesHighlight('stock-trim', 'StockTrim', [5, 22])).toEqual({
      id: 'stock-trim', feature_type: 'StockTrim', occurrences: [{ centroid: [0, 0, 0], face_ids: [5, 22] }], centroidFromFaces: true,
    });
    expect(facesHighlight('stock-trim', 'StockTrim', [])).toBeNull();
  });
});
