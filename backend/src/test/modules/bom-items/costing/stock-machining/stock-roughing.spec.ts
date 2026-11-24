// A plate part's three roughing techniques as the stock front end prices them (stock-machining-cost.service.ts priceStockMachining) and lays
// them on a mill's quote (stock-machining-cost-summary.ts): All Bulk Milling (the data's default, unchanged), Perimeter Milling with
// Drop-off and Plate Cutting with Drop-off, each priced beside the quoted one. On memory/Stock Maching's own values and materials; the plate
// cutting prices are given, as the costing service gets them from the Sheet Metal engines. Expected values are worked out by hand.
//
// The part is STIFFNER 2 (R_M-0230-039), 159.5 x 42 x 8 mm, 15 208.37 mm³, forced to plate: 2.1 mm a side, a 1/2 in (12.7 mm) plate.
//   The standard plate: 914.4 x 457.2 x 12.7 mm = 5 309 408.736 mm³ = 14.335404 kg of aluminium (2700 kg/m³).
//   All Bulk Milling:   163.7 x 46.2 mm blanks a 0.889 mm kerf apart, 45 per plate; the blank 96 049.338 mm³.
//   Perimeter Milling:  159.5 x 42 mm outlines, 10 mm apart and from the edge, 40 per plate; the piece 5058.6 x 12.7 = 64 244.22 mm³.
//   Plate Cutting:      163.7 x 46.2 mm cut blanks; laser 13 mm apart 35 per plate, waterjet 5.08 mm apart 45; the piece 75 029.76 mm³.
import { bandSaws, realStockMachiningReference, stockMaterial } from '../stock/stock-test-data';
import { specAsCalculators } from '../../../../../modules/bom-items/costing/machining/calculators/machining-calculator-spec';
import { stockReference } from '../../../../../modules/bom-items/costing/stock/stock-reference';
import { stockMachiningCalculatorsByName } from '../../../../../modules/bom-items/costing/stock-machining/calculators/stock-machining-calculator-spec';
import { PERIMETER_CUT_CALC, slottingRuleOf, type PerimeterCutter } from '../../../../../modules/bom-items/costing/stock-machining/perimeter-cut';
import { plateCutRequests, type PlateCutPrice } from '../../../../../modules/bom-items/costing/stock-machining/plate-cutting';
import {
  DROPOFF_RULES_DISCLOSED, PLATE_NOT_SAWN, SAW_NOT_COSTED, STOCK_RULES_DISCLOSED, stockBlankResult, stockEngineInput, stockMachiningBreakdown, withStockMachining,
  type StockMachiningPlan,
} from '../../../../../modules/bom-items/costing/stock-machining/stock-machining-cost-summary';
import {
  chooseStockMachining, priceStockMachining, stockMachiningSettings, type RoughingPricing, type StockMachiningChoice, type StockMachiningMaterialInput,
} from '../../../../../modules/bom-items/costing/stock-machining/stock-machining-cost.service';

import type { CostSummaryDto, ProcessLineCost } from '../../../../../modules/bom-items/dto/cost-breakdown.dto';
import type { StockPartInput } from '../../../../../modules/bom-items/costing/stock/stock-part';

const REF = realStockMachiningReference();
const STOCK = stockReference(REF).reference!;
const ZERO = { qairPerHr: 0, inspTimeMin: 0, samplingRate: 0, yieldPct: 1, netMatCost: 0, netWeightKg: 0, scrapPricePerKg: 0 };
const CALCS = stockMachiningCalculatorsByName();

const OUTLINE = { perimeter_mm: 397.81, area_mm2: 5058.6, rect: { length_mm: 159.5, width_mm: 42, angle_deg: 0 }, openings: { count: 0, perimeter_mm: 0, area_mm2: 0 } };
const measured = (plate: unknown) => ({
  extractionVersion: 'stk_v1', axis: [1, 0, 0], axisSource: 'box', lengthMm: 159.5, round: { od_mm: 42.76 }, rect: { width_mm: 42, height_mm: 8, angle_deg: 0 },
  hex: null, bore: null, endFaces: { min: [1], max: [2] }, stockSurface: { round: [], rect: [], hex: [] }, ...(plate === undefined ? {} : { plate }),
});
const STIFFNER: StockPartInput = {
  machiningStock: measured({ version: 'plt_v1', normal: [0, 0, 1], thickness_mm: 8, outline: OUTLINE }),
  family: 'milled', box: { length: 159.5, width: 42, height: 8 }, volumeMm3: 15208.37,
};
/** The same part analysed before the plate outline was measured: its stock measurement has no plate block. */
const NO_OUTLINE: StockPartInput = { ...STIFFNER, machiningStock: measured(undefined) };

const PRICE = stockMaterial('Aluminum, ANSI 6061', 'Plate Cost Per KG (USD / kg)').pricePerKgUsd!;
const AL: StockMachiningMaterialInput = { name: 'Aluminum, ANSI 6061', cutCode: 30.11, densityKgM3: 2700, scrapCostPercent: 9, pricePerKgUsd: { plate: PRICE, rectangular_bar: PRICE } };
const PLATE_KG = (914.4 * 457.2 * 12.7 * 2700) / 1e9; // 14.335404 kg

const CUTTER: PerimeterCutter = {
  matClass: 'aluminum', finishing: { toolDiameterMm: 10, teeth: 3, cuttingSpeedMPerMin: 183, feedPerToothPerDiameter: 0.008 }, machinabilityFactor: 1,
  slotting: slottingRuleOf(specAsCalculators()), sequenced: true,
};
const cutLine = (process: string, machineClass: string, totalCost: number, cycleTimeMin: number): ProcessLineCost => ({
  process, processGroup: 'Sheet Metal', processRoute: process, operation: process, setupCost: 0.1, runCost: totalCost - 0.1, totalCost, cycleTimeMin, setupTimeMin: 30,
  setupTimeSource: 'machine', hourlyRate: 40, rateSource: 'mhr_database', machineClass, machineName: `${process} machine`, commodityCode: null, labourRate: 20,
});
const priced = (process: PlateCutPrice['process'], machineClass: string, cost: number, cycleTimeMin = 0.5): PlateCutPrice =>
  ({ process, lines: [cutLine(process === 'Laser Cut' ? 'Laser Cutting' : process, machineClass, cost, cycleTimeMin)], cost, machineClass, machineName: `${process} machine`, unavailable: null, warnings: [] });
const listed = (process: PlateCutPrice['process'], unavailable: string): PlateCutPrice => ({ process, lines: [], cost: null, machineClass: null, machineName: null, unavailable, warnings: [] });
// As the Sheet Metal engines price aluminium plate: the laser and the waterjet cut it, plasma and oxyfuel have no feed data for it.
const CUTS: PlateCutPrice[] = [
  priced('Laser Cut', 'fiber_laser', 1.2), listed('Plasma Cut', 'sm_reference_data nestingCutRate PlasmaCut holds no feed data for Aluminum, ANSI 6061'),
  listed('Oxyfuel Cut', 'sm_reference_data nestingCutRate OxyFuelCut holds no feed data for Aluminum, ANSI 6061'), priced('Waterjet Cut', 'waterjet', 2.5, 1.5),
];
const ROUGHING: RoughingPricing = { cutter: CUTTER, cuts: CUTS };

const choose = (overrides: Record<string, unknown> = {}, part: StockPartInput = STIFFNER): StockMachiningChoice => {
  const { choice, missing } = chooseStockMachining({ ref: REF, stock: STOCK, location: 'USA', part, overrides: { stockForm: 'plate', ...overrides } });
  if (!choice) throw new Error(missing.join('; '));
  return choice;
};
function plan(
  overrides: Record<string, unknown> = {},
  over: { part?: StockPartInput; sawCosted?: boolean; roughing?: RoughingPricing | null; usdToLocal?: number; calculators?: typeof CALCS } = {},
): StockMachiningPlan {
  const choice = choose(overrides, over.part);
  const sawCosted = over.sawCosted ?? false;
  const stock = priceStockMachining({
    choice, calculators: over.calculators ?? CALCS, sawCosted, saws: sawCosted ? bandSaws('USA') : [], material: AL, location: 'USA', batchSize: 100,
    usdToLocal: over.usdToLocal ?? 1, costContext: ZERO, ...(over.roughing === null ? {} : { roughing: over.roughing ?? ROUGHING }),
  });
  return { sawCosted, choice, priced: stock, scrapCostPercent: 9, missing: [], warnings: [] };
}
const roughingOf = (p: StockMachiningPlan) => p.priced!.saw.roughing!;
const option = (p: StockMachiningPlan, technique: string) => roughingOf(p).options.find((o) => o.technique === technique)!;

describe('the Cost Guide\'s roughing technique', () => {
  it('is read from the scenario key stockRoughingTechnique; any other value is unset', () => {
    expect(stockMachiningSettings({ stockRoughingTechnique: 'perimeter_milling_dropoff' }).roughingTechnique).toBe('perimeter_milling_dropoff');
    expect(stockMachiningSettings({ stockRoughingTechnique: 'plate_cutting_dropoff' }).roughingTechnique).toBe('plate_cutting_dropoff');
    expect(stockMachiningSettings({ stockRoughingTechnique: 'all_bulk_milling' }).roughingTechnique).toBe('all_bulk_milling');
    expect(stockMachiningSettings({ stockRoughingTechnique: 'Perimeter Milling with Dropoff' }).roughingTechnique).toBeNull();
    expect(stockMachiningSettings({ stockRoughingTechnique: 7 }).roughingTechnique).toBeNull();
    expect(stockMachiningSettings({}).roughingTechnique).toBeNull();
    expect(stockMachiningSettings(null).roughingTechnique).toBeNull();
  });

  it('the part\'s outline is read with its stock, and is null for an analysis made before it', () => {
    expect(choose().outline).toMatchObject({ thicknessMm: 8, perimeterMm: 397.81, areaMm2: 5058.6, rect: { lengthMm: 159.5, widthMm: 42 } });
    expect(choose({}, NO_OUTLINE).outline).toBeNull();
  });
});

describe('All Bulk Milling: the data\'s default, unchanged', () => {
  it('unset, the quoted stock is exactly what it is with no techniques priced at all', () => {
    for (const sawCosted of [false, true]) {
      const before = plan({}, { sawCosted, roughing: null }).priced!;
      const after = plan({}, { sawCosted }).priced!;
      const { roughing, ...saw } = after.saw;
      expect(before.saw.roughing).toBeNull();
      expect(saw).toEqual({ ...before.saw, roughing: undefined });
      expect(after.parting).toEqual(before.parting);
      expect(JSON.stringify({ ...saw, roughing: null })).toBe(JSON.stringify(before.saw));
      expect(roughing).toMatchObject({ technique: 'all_bulk_milling', source: 'default', defaultTechnique: 'all_bulk_milling', fallback: null, millOps: [], warnings: [] });
    }
  });

  it('set to All Bulk Milling in the Cost Guide, the same stock is quoted', () => {
    const unset = plan({}, { sawCosted: true }).priced!.saw;
    const set = plan({ stockRoughingTechnique: 'all_bulk_milling' }, { sawCosted: true }).priced!.saw;
    expect(set.roughing).toMatchObject({ technique: 'all_bulk_milling', source: 'cost_guide' });
    expect({ ...set, roughing: null }).toEqual({ ...unset, roughing: null });
    expect(set.lines.map((l) => l.process)).toEqual(['Band Saw']);
  });

  it('the route\'s quote says what it said: the sawing note and the stock rules', () => {
    const cost = withStockMachining(engineCost(), plan(), 'saw');
    expect(cost.warnings).toContain(SAW_NOT_COSTED);
    expect(cost.warnings).toContain(STOCK_RULES_DISCLOSED);
    expect(cost.warnings).not.toContain(DROPOFF_RULES_DISCLOSED);
    expect(cost.warnings.some((w) => w.includes('kerf multipliers'))).toBe(false);
    expect(withStockMachining(engineCost(), plan({}, { roughing: null }), 'saw')).toEqual(cost);
  });

  it('bar stock has one technique: no choice is offered', () => {
    expect(plan({ stockForm: 'rectangular_bar', stockRoughingTechnique: 'perimeter_milling_dropoff' }).priced!.saw.roughing).toBeNull();
    expect(plateCutRequests(choose({ stockForm: 'rectangular_bar' }))).toEqual([]);
  });

  it('a route no mill makes prices no technique: its plate is sawn', () => {
    const lathe = plan({ stockRoughingTechnique: 'perimeter_milling_dropoff' }, { roughing: null, sawCosted: true }).priced!.saw;
    expect(lathe.roughing).toBeNull();
    expect(lathe.selection.chosen!.roughing).toBeUndefined();
    expect(lathe.lines.map((l) => l.process)).toEqual(['Band Saw']);
  });
});

describe('every technique is priced beside the quoted one', () => {
  it('All Bulk Milling: 45 blanks a plate, sawn', () => {
    const o = option(plan({}, { sawCosted: true }), 'all_bulk_milling');
    expect(o).toMatchObject({ label: 'All Bulk Milling', chosen: true, unavailable: null, partsPerPlate: 45, processes: [] });
    // 14.335404 kg / 45 = 0.318565 kg of plate a part.
    expect(o.materialCost).toBeCloseTo((PLATE_KG / 45) * PRICE, 9);
    expect(o.pieceVolumeMm3).toBeCloseTo(163.7 * 46.2 * 12.7, 6);
    expect(o.separation!.process).toBe('Band Saw');
    expect(o.separation!.cost).toBeGreaterThan(0);
    expect(o.separation!.timeSec).toBeGreaterThan(0);
    // A part whose Process costs no sawing: the saw is named, not costed.
    expect(option(plan(), 'all_bulk_milling').separation).toEqual({ process: 'Band Saw', machineClass: 'band_saw', machineName: null, cost: null, timeSec: null });
  });

  it('Perimeter Milling with Drop-off: 40 outlines a plate, cut out by the mill in 122.52 s', () => {
    const o = option(plan(), 'perimeter_milling_dropoff');
    expect(o).toMatchObject({ label: 'Perimeter Milling with Drop-off', chosen: false, unavailable: null, partsPerPlate: 40, processes: [] });
    // 14.335404 kg / 40 = 0.358385 kg a part: the 10 mm cut between parts makes fewer of them than the saw's 0.889 mm kerf.
    expect(o.materialCost).toBeCloseTo((PLATE_KG / 40) * PRICE, 9);
    expect(o.pieceVolumeMm3).toBeCloseTo(64244.22, 6);
    // The mill's own operation: its time here, its cost at the rate of the mill that makes the part.
    expect(o.separation!.process).toBe('Perimeter Milling');
    expect(o.separation!.cost).toBeNull();
    expect(o.separation!.timeSec).toBeCloseTo(122.516, 2);
  });

  it('Plate Cutting with Drop-off: the cheapest part of the processes that are priced, the others listed with why', () => {
    const o = option(plan(), 'plate_cutting_dropoff');
    expect(o).toMatchObject({ label: 'Plate Cutting with Drop-off', chosen: false, unavailable: null });
    // Laser: 35 a plate, 14.335404 / 35 x price + 1.20. Waterjet: 45 a plate, 14.335404 / 45 x price + 2.50. The laser's part is cheaper.
    const laser = (PLATE_KG / 35) * PRICE + 1.2;
    const waterjet = (PLATE_KG / 45) * PRICE + 2.5;
    expect(laser).toBeLessThan(waterjet);
    expect(o.partsPerPlate).toBe(35);
    expect(o.materialCost).toBeCloseTo((PLATE_KG / 35) * PRICE, 9);
    expect(o.pieceVolumeMm3).toBeCloseTo(75029.76, 1);
    expect(o.separation).toEqual({ process: 'Laser Cut', machineClass: 'fiber_laser', machineName: 'Laser Cut machine', cost: 1.2, timeSec: 30 });
    expect(o.processes.map((p) => [p.process, p.chosen, p.partsPerPlate, p.cutCost, p.unavailable])).toEqual([
      ['Laser Cut', true, 35, 1.2, null],
      ['Plasma Cut', false, null, null, 'sm_reference_data nestingCutRate PlasmaCut holds no feed data for Aluminum, ANSI 6061'],
      ['Oxyfuel Cut', false, null, null, 'sm_reference_data nestingCutRate OxyFuelCut holds no feed data for Aluminum, ANSI 6061'],
      ['Waterjet Cut', false, 45, 2.5, null],
    ]);
    expect(o.processes[3]!.materialCost).toBeCloseTo((PLATE_KG / 45) * PRICE, 9);
  });

  it('the cheapest is by the plate and the cut together: a dearer cut on a tighter nest can win', () => {
    // The waterjet's cut at 1.30 is dearer than the laser's 1.20, but it nests 45 a plate against 35.
    const cuts = CUTS.map((c) => (c.process === 'Waterjet Cut' ? priced('Waterjet Cut', 'waterjet', 1.3, 1.5) : c));
    expect((PLATE_KG / 45) * PRICE + 1.3).toBeLessThan((PLATE_KG / 35) * PRICE + 1.2);
    const o = option(plan({}, { roughing: { cutter: CUTTER, cuts } }), 'plate_cutting_dropoff');
    expect(o.separation).toMatchObject({ process: 'Waterjet Cut', cost: 1.3, timeSec: 90 });
    expect(o.partsPerPlate).toBe(45);
    expect(o.processes.filter((p) => p.chosen).map((p) => p.process)).toEqual(['Waterjet Cut']);
  });

  it('asks each process for its own cut: the grown outline plus its lead-in, one pierce, in the stock\'s plate', () => {
    const requests = plateCutRequests(choose());
    expect(requests.map((r) => r.process)).toEqual(['Laser Cut', 'Plasma Cut', 'Oxyfuel Cut', 'Waterjet Cut']);
    // 411.0047 mm grown outline + 10 / 3.175 / 25 / 5 mm.
    expect(requests.map((r) => Math.round(r.cutLengthMm * 1e4) / 1e4)).toEqual([421.0047, 414.1797, 436.0047, 416.0047]);
    for (const r of requests) {
      expect(r.thicknessMm).toBe(12.7);
      expect(r.pierceCount).toBe(1);
      expect(r.blank.lengthMm).toBeCloseTo(163.7, 9);
      expect(r.blank.widthMm).toBeCloseTo(46.2, 9);
    }
  });

  it('money is in the location\'s currency', () => {
    const usd = plan({ stockRoughingTechnique: 'perimeter_milling_dropoff' });
    const inr = plan({ stockRoughingTechnique: 'perimeter_milling_dropoff' }, { usdToLocal: 80 });
    expect(option(inr, 'all_bulk_milling').materialCost).toBeCloseTo(option(usd, 'all_bulk_milling').materialCost! * 80, 6);
    expect(option(inr, 'perimeter_milling_dropoff').materialCost).toBeCloseTo(option(usd, 'perimeter_milling_dropoff').materialCost! * 80, 6);
    expect(inr.priced!.saw.materialCost).toBeCloseTo(usd.priced!.saw.materialCost! * 80, 6);
    // A plate cutting price is given in the location's currency already (its engine's): it is not converted again.
    expect(option(inr, 'plate_cutting_dropoff').processes.map((x) => x.cutCost)).toEqual([1.2, null, null, 2.5]);
    expect(option(inr, 'plate_cutting_dropoff').processes[0]!.materialCost).toBeCloseTo((PLATE_KG / 35) * PRICE * 80, 6);
  });
});

describe('Perimeter Milling with Drop-off, quoted', () => {
  const p = plan({ stockRoughingTechnique: 'perimeter_milling_dropoff' }, { sawCosted: true });
  const saw = p.priced!.saw;

  it('quotes the technique\'s stock: the outline through the plate, 40 a plate', () => {
    expect(saw.roughing).toMatchObject({ technique: 'perimeter_milling_dropoff', source: 'cost_guide', defaultTechnique: 'all_bulk_milling', fallback: null });
    expect(saw.roughing!.options.map((o) => o.chosen)).toEqual([false, true, false]);
    const chosen = saw.selection.chosen!;
    expect(chosen.roughing!.technique).toBe('perimeter_milling_dropoff');
    expect(chosen.sizeLabel).toBe('1/2" plate, 159.5 x 42 mm outline');
    expect(chosen.stock.partsPerStock).toBe(40);
    expect(saw.materialCost).toBeCloseTo((PLATE_KG / 40) * PRICE, 9);
    expect(saw.quote!.material.pieceKg).toBeCloseTo((64244.22 * 2700) / 1e9, 9);
    // The stock forms list names the quoted plate as it is quoted, with no saw.
    expect(saw.options.find((o) => o.chosen)).toMatchObject({ form: 'plate', sizeLabel: '1/2" plate, 159.5 x 42 mm outline', sawCost: null });
    expect(saw.options.find((o) => o.chosen)!.materialCost).toBeCloseTo((PLATE_KG / 40) * PRICE, 9);
  });

  it('has no Band Saw line, also for a Stock Machining part: the plate is loaded whole', () => {
    expect(saw.lines).toEqual([]);
    expect(saw.quote!.saw).toBeNull();
    const cost = withStockMachining(engineCost(), p, 'saw');
    expect(cost.processLines.map((l) => l.process)).toEqual(['3 Axis Mill', 'Inspection']);
    expect(cost.warnings.some((w) => w.includes('the 914.4 x 457.2 mm plate is loaded on the mill whole'))).toBe(true);
    expect(cost.warnings).toContain(DROPOFF_RULES_DISCLOSED);
    expect(cost.warnings).not.toContain(STOCK_RULES_DISCLOSED);
    expect(cost.warnings).not.toContain(SAW_NOT_COSTED);
    // The plate over its 40 parts, not rounded to cents.
    expect(cost.materialCost).toBeCloseTo((PLATE_KG / 40) * PRICE, 10);
  });

  it('gives the mill its perimeter cut, and the piece inside it as the blank', () => {
    expect(saw.roughing!.millOps).toHaveLength(1);
    expect(saw.roughing!.millOps[0]).toMatchObject({ name: 'Perimeter Milling', source: 'stock', cadFeatureType: 'Perimeter' });
    expect(saw.roughing!.millOps[0]!.timeSec).toBeCloseTo(122.516, 2);
    const blank = stockBlankResult(p.choice!, 'saw', p.priced)!;
    expect(blank.billetVolMm3).toBeCloseTo(64244.22, 6);
    expect(blank.purchasedVolMm3).toBeCloseTo(5309408.736 / 40, 4);
    expect(blank.sizeLabel).toBe('1/2" plate, 159.5 x 42 mm outline');
    expect(stockEngineInput(p.choice, 'saw', { plate: PRICE }, p.priced)).toMatchObject({ blankResult: blank, stockCutOff: 'saw', materialCostPerKg: PRICE });
    // With nothing priced the engines start from the stock as the model chose it: the sawn blank.
    expect(stockBlankResult(p.choice!, 'saw')!.billetVolMm3).toBeCloseTo(163.7 * 46.2 * 12.7, 6);
  });

  it('the material calculation names the technique\'s nest', () => {
    const steps = saw.quote!.material.run!.trace;
    const source = (field: string) => steps.find((s) => s.fieldName === field)!.source;
    expect(source('Parts per Plate')).toBe('the outlines\' rectangles in a grid, the 10 mm cutter\'s width between two parts and to the plate\'s edge');
    expect(source('Plate Length')).toBe('the plate a mill takes: standardPlateLength, within maxPlateLengthForNestedMilledParts');
    expect(source('Blank Length')).toContain('the rectangle round the part\'s outline');
    expect(steps.find((s) => s.fieldName === 'Parts per Plate')!.value).toBe(40);
  });
});

describe('Plate Cutting with Drop-off, quoted', () => {
  const p = plan({ stockRoughingTechnique: 'plate_cutting_dropoff' }, { sawCosted: true });
  const saw = p.priced!.saw;

  it('quotes the cheapest process\'s stock and its cutting line, with no Band Saw', () => {
    expect(saw.roughing).toMatchObject({ technique: 'plate_cutting_dropoff', source: 'cost_guide', fallback: null, millOps: [] });
    const chosen = saw.selection.chosen!;
    expect(chosen.roughing).toMatchObject({ technique: 'plate_cutting_dropoff', process: 'Laser Cut' });
    expect(chosen.sizeLabel).toBe('1/2" plate, 163.7 x 46.2 mm cut blank');
    expect(saw.materialCost).toBeCloseTo((PLATE_KG / 35) * PRICE, 9);
    // The line is the cutting engine's own: its process, its group, machine, time and rate. It is marked as a step of the stock.
    expect(saw.lines).toEqual(CUTS[0]!.lines.map((l) => ({ ...l, stockStep: true })));
    expect(saw.lines[0]).toMatchObject({ processGroup: 'Sheet Metal', stockStep: true });
    expect(saw.lines[0]).toMatchObject({ process: 'Laser Cutting', machineClass: 'fiber_laser', machineName: 'Laser Cutting machine', totalCost: 1.2, hourlyRate: 40 });
  });

  it('puts the cutting line before the machining, and says what is and is not used', () => {
    const cost = withStockMachining(engineCost(), p, 'saw');
    expect(cost.processLines.map((l) => l.process)).toEqual(['Laser Cutting', '3 Axis Mill', 'Inspection']);
    expect(cost.totalProcessCost).toBe(2.7);
    expect(cost.cycleTimes.totalMin).toBe(2);
    expect(cost.warnings.some((w) => w.includes('Laser Cut cuts the part\'s outline, with the 2.1 mm stock allowance left on it'))).toBe(true);
    expect(cost.warnings.some((w) => w.includes('kerf multipliers') && w.includes('are not used'))).toBe(true);
    expect(cost.warnings).toContain(DROPOFF_RULES_DISCLOSED);
    expect(cost.warnings).not.toContain(SAW_NOT_COSTED);
  });

  it('carries what the cutting engine says of its line', () => {
    const cuts = CUTS.map((c) => (c.process === 'Laser Cut' ? { ...c, warnings: ['Laser Cutting: setup time not on file'] } : c));
    const warned = plan({ stockRoughingTechnique: 'plate_cutting_dropoff' }, { roughing: { cutter: CUTTER, cuts } });
    expect(withStockMachining(engineCost(), warned, 'saw').warnings).toContain('Laser Cutting: setup time not on file');
  });

  it('the mill starts from the cut blank', () => {
    expect(stockBlankResult(p.choice!, 'saw', p.priced)!.billetVolMm3).toBeCloseTo(75029.76, 1);
  });
});

describe('a technique that cannot be used is listed with why, and All Bulk Milling is quoted', () => {
  it('no plate outline in the analysis: both drop-off techniques wait for Refresh analysis', () => {
    const p = plan({ stockRoughingTechnique: 'perimeter_milling_dropoff' }, { part: NO_OUTLINE, sawCosted: true });
    const why = 'the part\'s analysis holds no plate outline: press Refresh analysis to measure the plate outline';
    expect(option(p, 'perimeter_milling_dropoff')).toMatchObject({ unavailable: why, partsPerPlate: null, materialCost: null, separation: null });
    expect(option(p, 'plate_cutting_dropoff')).toMatchObject({ unavailable: why, processes: [] });
    expect(roughingOf(p)).toMatchObject({ technique: 'all_bulk_milling', source: 'cost_guide' });
    expect(roughingOf(p).fallback).toBe(`The Cost Guide's roughing technique, Perimeter Milling with Drop-off, is not available: ${why}. All Bulk Milling is quoted.`);
    // The quote is the sawn blank's, and says why.
    expect(p.priced!.saw.lines.map((l) => l.process)).toEqual(['Band Saw']);
    expect(p.priced!.saw.selection.chosen!.roughing).toBeUndefined();
    expect(withStockMachining(engineCost(), p, 'saw').warnings).toContain(roughingOf(p).fallback);
    // No cut is asked of the cutting engines for a part with no outline.
    expect(plateCutRequests(choose({}, NO_OUTLINE))).toEqual([]);
    // Unset, the same part is quoted as before, with no note.
    expect(roughingOf(plan({}, { part: NO_OUTLINE })).fallback).toBeNull();
  });

  it('a plate block the cad-engine could not measure (plate: null) is no outline either', () => {
    const p = plan({}, { part: { ...STIFFNER, machiningStock: measured(null) } });
    expect(option(p, 'perimeter_milling_dropoff').unavailable).toContain('press Refresh analysis to measure the plate outline');
  });

  it('Perimeter Milling: no cutter for the material, no slotting rule, no calculator, no sequence', () => {
    const with_ = (cutter: Partial<PerimeterCutter>, calculators = CALCS) =>
      option(plan({}, { roughing: { cutter: { ...CUTTER, ...cutter }, cuts: CUTS }, calculators }), 'perimeter_milling_dropoff').unavailable;
    expect(with_({ finishing: null })).toContain('tblMillingFinishing lists no cutter for aluminum');
    expect(with_({ slotting: null })).toContain('Machining - Obround Slot Milling, migration 1118');
    expect(with_({ sequenced: false })).toContain('no feature graph');
    const { [PERIMETER_CUT_CALC]: _cut, ...without } = CALCS;
    expect(with_({}, without)).toContain('Stock Machining - Perimeter Cut, migration 1119');
    // The stock itself is priced without that calculator: only the technique waits for it.
    expect(plan({}, { calculators: without }).priced!.saw.materialCost).toBeCloseTo((PLATE_KG / 45) * PRICE, 9);
  });

  it('Plate Cutting: no process priced, each with its reason', () => {
    const cuts = CUTS.map((c) => listed(c.process, `no ${c.process} machine`));
    const p = plan({ stockRoughingTechnique: 'plate_cutting_dropoff' }, { roughing: { cutter: CUTTER, cuts } });
    const o = option(p, 'plate_cutting_dropoff');
    expect(o.unavailable).toBe('no plate cutting process can be priced (Laser Cut: no Laser Cut machine; Plasma Cut: no Plasma Cut machine; Oxyfuel Cut: no Oxyfuel Cut machine; Waterjet Cut: no Waterjet Cut machine)');
    expect(o.processes.map((x) => x.unavailable)).toEqual(['no Laser Cut machine', 'no Plasma Cut machine', 'no Oxyfuel Cut machine', 'no Waterjet Cut machine']);
    expect(roughingOf(p).technique).toBe('all_bulk_milling');
    expect(roughingOf(p).fallback).toContain('Plate Cutting with Drop-off, is not available: no plate cutting process can be priced');
  });

  it('the data\'s default, when it is a drop-off technique, is quoted with no Cost Guide setting', () => {
    const ref = realStockMachiningReference({ defaultRoughingTechnique: 'Perimeter Milling with Dropoff' });
    const { choice } = chooseStockMachining({ ref, stock: stockReference(ref).reference!, location: 'USA', part: STIFFNER, overrides: { stockForm: 'plate' } });
    const stock = priceStockMachining({ choice: choice!, calculators: CALCS, sawCosted: false, saws: [], material: AL, location: 'USA', batchSize: 100, usdToLocal: 1, costContext: ZERO, roughing: ROUGHING });
    expect(stock.saw.roughing).toMatchObject({ technique: 'perimeter_milling_dropoff', source: 'default', defaultTechnique: 'perimeter_milling_dropoff', fallback: null });
    // With no outline it falls back, and says the data's default could not be used.
    const { choice: noOutline } = chooseStockMachining({ ref, stock: stockReference(ref).reference!, location: 'USA', part: NO_OUTLINE, overrides: { stockForm: 'plate' } });
    const fallen = priceStockMachining({ choice: noOutline!, calculators: CALCS, sawCosted: false, saws: [], material: AL, location: 'USA', batchSize: 100, usdToLocal: 1, costContext: ZERO, roughing: ROUGHING });
    expect(fallen.saw.roughing!.technique).toBe('all_bulk_milling');
    expect(fallen.saw.roughing!.fallback).toContain('The data\'s default roughing technique, Perimeter Milling with Drop-off, is not available');
  });
});

describe('the Cost Summary\'s roughing section', () => {
  // The part's features are stated to remove 24 766.46 mm³; with the part's 15 208.37 mm³ that is 39 974.83 mm³ of every piece.
  const mill = { partMm3: 15208.37, featureRemovedMm3: 24766.46, operationCost: (seconds: number) => Math.round(seconds * 0.02 * 100) / 100 };

  it('is absent for bar stock and for a route no mill makes', () => {
    expect(stockMachiningBreakdown(plan({ stockForm: 'rectangular_bar' }), 'saw', 100, mill)!.roughing).toBeUndefined();
    expect('roughing' in stockMachiningBreakdown(plan({ stockForm: 'rectangular_bar' }), 'saw', 100, mill)!).toBe(false);
    expect('roughing' in stockMachiningBreakdown(plan({}, { roughing: null }), 'saw', 100)!).toBe(false);
  });

  it('unset, the rest of the section is what it was', () => {
    const before = stockMachiningBreakdown(plan({}, { roughing: null, sawCosted: true }), 'saw', 100)!;
    const { roughing, ...after } = stockMachiningBreakdown(plan({}, { sawCosted: true }), 'saw', 100, mill)!;
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
    expect(roughing).toMatchObject({ technique: 'all_bulk_milling', label: 'All Bulk Milling', source: 'default', defaultTechnique: 'all_bulk_milling', fallback: null });
  });

  it('states the bulk each technique leaves the mill: its piece less the part and what the features remove', () => {
    const section = stockMachiningBreakdown(plan(), 'saw', 100, mill)!.roughing!;
    // 163.7 x 46.2 x 12.7 = 96 049.338 - 39 974.83 = 56 074.51;  64 244.22 - 39 974.83 = 24 269.39;  75 029.76 - 39 974.83 = 35 054.93 mm³.
    expect(section.options.map((o) => [o.technique, o.partsPerPlate, o.bulkVolumeMm3])).toEqual([
      ['all_bulk_milling', 45, 56074.51], ['perimeter_milling_dropoff', 40, 24269.39], ['plate_cutting_dropoff', 35, 35054.93],
    ]);
  });

  it('prices the perimeter cut at the quoted mill\'s rate, and leaves the saw and the cutting process at their own', () => {
    const section = stockMachiningBreakdown(plan(), 'saw', 100, mill)!.roughing!;
    // 122.5165 s at the mill's 0.02 a second: 2.45.
    expect(section.options[1]!.separation).toEqual({ process: 'Perimeter Milling', machineClass: null, machineName: null, timeSec: 122.517, cost: 2.45 });
    expect(section.options[0]!.separation).toEqual({ process: 'Band Saw', machineClass: 'band_saw', machineName: null, cost: null, timeSec: null });
    expect(section.options[2]!.separation).toEqual({ process: 'Laser Cut', machineClass: 'fiber_laser', machineName: 'Laser Cut machine', cost: 1.2, timeSec: 30 });
    // With no mill given (the quoted machine is not known), neither the bulk nor the cut's cost is stated.
    const bare = stockMachiningBreakdown(plan(), 'saw', 100)!.roughing!;
    expect(bare.options.map((o) => o.bulkVolumeMm3)).toEqual([null, null, null]);
    expect(bare.options[1]!.separation!.cost).toBeNull();
  });

  it('a quoted drop-off: the stock, its label and why there is no saw are the technique\'s', () => {
    const milled = stockMachiningBreakdown(plan({ stockRoughingTechnique: 'perimeter_milling_dropoff' }, { sawCosted: true }), 'saw', 100, mill)!;
    expect(milled.stock).toMatchObject({
      form: 'plate', sizeLabel: '1/2" plate, 159.5 x 42 mm outline', piece: { lengthMm: 159.5, widthMm: 42, thicknessMm: 12.7 }, cutWidthMm: 10,
      partsPerStock: 40, stocksForBatch: 3, stockLengthMm: 914.4, stockWidthMm: 457.2, virtualPlate: false,
    });
    expect(milled.stockLabel).toBe('1/2" plate, 159.5 x 42 mm outline, 40 per 914.4 x 457.2 mm plate, perimeter milled');
    expect(milled.saw).toBeNull();
    expect(milled.sawMissing).toBe(PLATE_NOT_SAWN.perimeter_milling_dropoff);
    expect(milled.notes.some((n) => n.includes('loaded on the mill whole'))).toBe(true);
    const cut = stockMachiningBreakdown(plan({ stockRoughingTechnique: 'plate_cutting_dropoff' }), 'saw', 100, mill)!;
    expect(cut.stockLabel).toBe('1/2" plate, 163.7 x 46.2 mm cut blank, 35 per 914.4 x 457.2 mm plate, Laser Cut');
    expect(cut.sawMissing).toBe(PLATE_NOT_SAWN.plate_cutting_dropoff);
    expect(cut.notes.some((n) => n.includes('kerf multipliers') && n.includes('are not used'))).toBe(true);
    expect(cut.roughing!.options.map((o) => o.chosen)).toEqual([false, false, true]);
  });

  it('the faces left as supplied follow the stock as the model chose it, whatever cuts the part out', () => {
    const bulk = stockMachiningBreakdown(plan(), 'saw', 100, mill)!;
    const milled = stockMachiningBreakdown(plan({ stockRoughingTechnique: 'perimeter_milling_dropoff' }), 'saw', 100, mill)!;
    expect(milled.asSuppliedFaceIds).toEqual(bulk.asSuppliedFaceIds);
    expect(milled.endFaceIds).toEqual(bulk.endFaceIds);
  });
});

/** A mill route's quote as the milling engine returns it: the mill at 1.00 and the inspection at 0.50. */
function engineCost(): CostSummaryDto {
  const line = (process: string, totalCost: number, cycleTimeMin: number): ProcessLineCost => ({
    process, processGroup: 'Machining', processRoute: process, operation: process, setupCost: 0, runCost: totalCost, totalCost, cycleTimeMin, setupTimeMin: 0,
    setupTimeSource: 'none', hourlyRate: 60, rateSource: 'mhr_database', machineClass: '3_axis_mill', machineName: 'Mill', commodityCode: null, labourRate: null,
  });
  return {
    materialCost: 0.5, materialGrade: 'Aluminum, ANSI 6061', grossWeightKg: 0.3, materialCostPerKg: PRICE, materialSource: 'db',
    processLines: [line('3 Axis Mill', 1, 1), line('Inspection', 0.5, 0.5)], totalProcessCost: 1.5, totalCost: 2,
    cycleTimes: { laserMin: 1, pressBrakeMin: 0, tappingMin: 0, deburrMin: 0, totalMin: 1.5 }, batchSize: 100, family: 'milled',
    warnings: [], ratesSource: 'test',
  } as unknown as CostSummaryDto;
}
