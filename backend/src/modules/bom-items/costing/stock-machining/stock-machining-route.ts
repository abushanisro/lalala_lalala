// The stock front end of a Stock Machining part (memory/Stock Maching): the stock bought for it (Material Stock, as supplied) and the band
// saw that cuts it to pieces, before the Machining route cuts the part. Every figure comes from a calculator (stock-machining-
// calculators.json) seeded from the staged reference (2026-Stock-Machining), the stock chosen for the part (stock/stock-selection.ts) and
// the saw (HR Rates class band_saw, migration 815). Pure: the caller loads the data and converts the currency.
//
// A bar-fed lathe takes the whole bar and parts each piece off, so its route has no Band Saw line (the reference's catalog gives Parting
// to the bar-fed lathes only, and the saw's Stock Trim to every other machine).
import { loadStockMachiningCalculatorSpec } from './calculators/stock-machining-calculator-spec';
import { machineValue, type SandMachine } from '../casting/sand/sand-machines';
import { fail, routeKit } from '../shared/calculators/route-kit';
import { sawBundle, sawFit, sawHandlingRow, sawRateRow, type SawBundle, type SawStock } from '../stock/band-saw';
import { BAND_SAW_CUT_SOURCE } from '../stock/stock-research';

import type { ProcessLineCost } from '../../dto/cost-breakdown.dto';
import type { CostContext } from '../casting/casting-finishing';
import type { SandReference } from '../casting/sand/sand-reference';
import type { CalcSeed, ReferenceCalcRun, ReferenceCalculatorDef } from '../shared/calculators/reference-calculator';
import type { StockReference } from '../stock/stock-reference';
import type { StockOption, StockPart } from '../stock/stock-selection';

export const STOCK_MACHINING_PROCESS_GROUP = 'Stock Machining';
/** The reference domain of its variables and lookups, for a calculator input's source. */
export const STOCK_MACHINING_DOMAIN = 'stock_machining';
/** The HR Rates machine class of each process (migrations 815 and 1114). */
export const STOCK_MACHINING_CLASS = { saw: 'band_saw', stock: 'stock_machining_material_stock' } as const;
export const STOCK_MACHINING_CALC = {
  stock: 'Stock Machining - Material Stock', size: 'Stock Machining - Stock Size', bar: 'Stock Machining - Bar Stock', plate: 'Stock Machining - Plate Stock',
  saw: 'Stock Machining - Band Saw', scrap: 'Stock Machining - Scrap Credit',
} as const;

/** The part's material as the stock is priced and sawn. */
export interface StockMachiningMaterial {
  name: string;
  /** Its cut code (raw_materials, or memory's materials of the group): the family the saw's cutting rate is listed under. */
  cutCode: number | null;
  densityKgM3: number | null;
  /** The chosen stock form's price (USD/kg), and where it was read. */
  pricePerKgUsd: number | null;
  priceSource: string;
  /** memory's Scrap Cost Percent of the material (what the chips sell for, of the stock's price); null when it lists none. */
  scrapCostPercent: number | null;
}

export interface StockMachiningInput {
  ref: SandReference;
  stock: StockReference;
  calculators: Readonly<Record<string, ReferenceCalculatorDef>>;
  /** The location's machines of class band_saw. */
  saws: readonly SandMachine[];
  part: StockPart;
  option: StockOption;
  material: StockMachiningMaterial;
  /** What cuts the piece off: the band saw, or a bar-fed lathe's parting tool (then no Band Saw line). */
  cutOff: 'saw' | 'parting';
  /** The bar end the stock was yielded with (mm), and where the value came from. */
  remnant: { mm: number; source: string };
  /** Whether the chips are sold back (enableScrapMaterialCredit, or the Cost Guide's). */
  scrapCredit: boolean;
  batchSize: number;
  costContext: CostContext;
  /** The faces of the part's two ends, where the saw's cuts lie, for the line's highlight. */
  endFaceIds: readonly number[];
}

export interface StockMachiningQuote {
  /** The Band Saw line (a named gap when no saw can cut the stock); empty when a bar-fed lathe parts the piece off. */
  lines: ProcessLineCost[];
  material: {
    /** The stock bought per part at the form's price, less the scrap credit when it is on (USD); null when a figure is missing. */
    costUsd: number | null;
    creditUsd: number;
    /** The stock bought per part, the piece the machine starts from, and the finished part (kg); null without a density. */
    purchasedKg: number | null;
    pieceKg: number | null;
    partKg: number | null;
    run: ReferenceCalcRun | null;
    sizeRun: ReferenceCalcRun | null;
    creditRun: ReferenceCalcRun | null;
  };
  saw: {
    machine: string; bundle: SawBundle; cutAreaMm2: number; cuttingRateMm2Min: number; cutCodeFamily: string;
    cutS: number; feedS: number; loadPerPartS: number; unloadS: number; cycleS: number;
  } | null;
  /** What keeps the stock from being priced, each named. */
  missing: string[];
  warnings: string[];
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const isGap = (l: ProcessLineCost) => l.physicsGap != null;
const isPlate = (o: StockOption) => o.form === 'plate' || o.form === 'billet';

/** The stock as the saw's vise holds it. */
export function sawStockOf(option: StockOption): SawStock {
  return {
    widthMm: option.saw.widthMm, heightMm: option.saw.heightMm,
    diameterMm: option.form === 'round_bar' || option.form === 'round_tube' ? option.aMm : null, plate: isPlate(option),
  };
}

/** The outside size the stock's allowance is a percent of, and the rule's numbers, as the Stock Size calculator shows them. */
function sizeSeeds(inp: StockMachiningInput): Record<string, CalcSeed> {
  const { option, part, stock } = inp;
  const hex = option.form === 'hex_bar';
  const round = option.form === 'round_bar' || option.form === 'round_tube';
  const outside = hex ? part.hexAcrossFlatsMm ?? part.roundOdMm : round ? part.roundOdMm : Math.max(part.widthMm, part.heightMm);
  const rule = hex ? stock.hexAllowance : stock.allowance;
  // An allowance set in the Cost Guide is the result itself: least and most both it, no percent.
  const ruled = Math.min(rule.maxMm, Math.max(rule.minMm, (rule.percent / 100) * outside));
  const set = Math.abs(option.allowancePerSideMm - ruled) > 1e-9;
  const seed = (value: number, source: string): CalcSeed => ({ value, source });
  return {
    outside_size_mm: seed(outside, hex ? "the part's width across flats (mm)" : round ? "the part's largest diameter (mm)" : "the larger side of the part's section (mm)"),
    allowance_percent: seed(set ? 0 : rule.percent, set ? 'set in the Cost Guide' : hex ? 'Stock Machining variable hexPercentStockAllowance' : 'Stock Machining variable percentStockAllowance'),
    allowance_min_mm: seed(set ? option.allowancePerSideMm : rule.minMm, set ? 'the stock on each side set in the Cost Guide (mm)' : hex ? 'Stock Machining variable hexMinStockWidthAllowance' : 'Stock Machining variable minStockAllowance'),
    allowance_max_mm: seed(set ? option.allowancePerSideMm : rule.maxMm, set ? 'the stock on each side set in the Cost Guide (mm)' : 'Stock Machining variable maxStockAllowance'),
  };
}

/** Prices the stock bought for the part and its sawing to pieces. */
export function buildStockMachiningQuote(inp: StockMachiningInput): StockMachiningQuote {
  const { ref, stock, option, part, material } = inp;
  const kit = routeKit({
    ref, spec: loadStockMachiningCalculatorSpec(), calculators: inp.calculators, machinesByClass: { [STOCK_MACHINING_CLASS.saw]: inp.saws },
    batchSize: inp.batchSize, costContext: inp.costContext, domain: STOCK_MACHINING_DOMAIN, domainLabel: 'Stock Machining',
    processGroup: STOCK_MACHINING_PROCESS_GROUP, processClass: { 'Band Saw': STOCK_MACHINING_CLASS.saw, 'Material Stock': STOCK_MACHINING_CLASS.stock }, partName: 'part',
  });
  const { seed } = kit;
  const missing: string[] = [];
  const warnings: string[] = [...option.notes];
  const density = material.densityKgM3 != null && material.densityKgM3 > 0 ? material.densityKgM3 : null;
  const price = material.pricePerKgUsd != null && material.pricePerKgUsd > 0 ? material.pricePerKgUsd : null;
  if (density == null) missing.push(`${material.name}: its density`);
  if (price == null) missing.push(`${material.name}: a price per kg for ${option.form.replace('_', ' ')} stock`);
  const kg = (volumeMm3: number) => (density != null ? (volumeMm3 * density) / 1e9 : null);

  // ── The stock's size and the stock bought per part ───────────────────────────────────────────────────────────────────────────────────
  const size = kit.run(STOCK_MACHINING_CALC.size, null, sizeSeeds(inp));
  const priceSeed = seed(price ?? 0, `${material.priceSource} (USD/kg)`);
  const densitySeed = seed(density ?? 0, `${material.name}: density (kg/m³)`);
  const bought = density == null || price == null ? null : isPlate(option)
    ? kit.run(STOCK_MACHINING_CALC.plate, null, {
      blank_length_mm: seed(option.blank.lengthMm, "the part's length plus the stock on each end (mm)"),
      blank_width_mm: seed(option.blank.widthMm ?? 0, "the part's width plus the stock on each side (mm)"),
      thickness_mm: seed(option.blank.thicknessMm ?? 0, option.snapped ? `the plate: ${option.sizeLabel}` : "the part's height plus the stock on each face (mm)"),
      plate_length_mm: seed(option.stock.lengthMm, option.stock.virtual ? 'a plate cut to the blank (it is larger than the standard plate)' : 'Stock Machining variable standardPlateLength'),
      plate_width_mm: seed(option.stock.widthMm ?? 0, option.stock.virtual ? 'a plate cut to the blank (it is larger than the standard plate)' : 'Stock Machining variable standardPlateWidth'),
      parts_per_plate: seed(option.stock.partsPerStock, `the blanks of the grid, a ${stock.kerfMm} mm kerf apart (bandSawKerf)`),
      density_kg_m3: densitySeed, price_per_kg: priceSeed,
    })
    : kit.run(STOCK_MACHINING_CALC.bar, null, {
      part_length_mm: seed(part.lengthMm, `the part's length along the stock (mm; ${part.source})`),
      end_allowance_mm: seed(option.endAllowanceMm, 'the stock faced off each end (mm)'),
      cut_width_mm: seed(option.cutWidthMm, inp.cutOff === 'saw' ? 'Stock Machining variable bandSawKerf (mm)' : `tblPartingRingWidth at the bar's Ø${r2(option.circumscribedMm ?? 0)} mm (a bar-fed lathe parts the piece off)`),
      section_area_mm2: seed(option.sectionAreaMm2 ?? 0, `the section of the ${option.sizeLabel} (mm²)`),
      bar_end_mm: seed(inp.remnant.mm, inp.remnant.source),
      density_kg_m3: densitySeed, price_per_kg: priceSeed,
    });
  if (bought && 'reasons' in bought) missing.push(...bought.reasons);
  const run = bought && 'run' in bought ? bought.run : null;
  const purchasedKg = kg(option.purchasedVolumeMm3);
  const partKg = kg(part.volumeMm3);

  // ── The chips sold back, when the credit is on ───────────────────────────────────────────────────────────────────────────────────────
  let creditRun: ReferenceCalcRun | null = null;
  let creditUsd = 0;
  if (inp.scrapCredit && run && purchasedKg != null && partKg != null) {
    if (material.scrapCostPercent == null) {
      warnings.push(`The scrap credit is on, but memory lists no Scrap Cost Percent for ${material.name}: no credit is taken.`);
    } else {
      const credit = kit.run(STOCK_MACHINING_CALC.scrap, null, {
        mass_per_part_kg: seed(purchasedKg, 'the stock bought per part (kg)'), part_mass_kg: seed(partKg, 'the finished part (kg)'), price_per_kg: priceSeed,
        scrap_cost_percent: seed(material.scrapCostPercent, `${material.name}: Scrap Cost Percent (memory/Stock Maching materials)`),
      });
      if ('run' in credit) { creditRun = credit.run; creditUsd = Math.max(0, credit.sec); }
    }
  }

  // ── The band saw ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  const lines: ProcessLineCost[] = [];
  let saw: StockMachiningQuote['saw'] = null;
  if (inp.cutOff === 'saw') {
    const sawStock = sawStockOf(option);
    const plans = new Map<string, { bundle: SawBundle; rate: number; family: string; unloadS: number }>();
    const step = kit.step('Band Saw', (m: SandMachine) => {
      const limits = { maxWidthMm: machineValue(m, 'max_stock_width_mm'), maxHeightMm: machineValue(m, 'max_stock_height_mm'), maxDiameterMm: machineValue(m, 'max_stock_diameter_mm') };
      const unfit = sawFit(sawStock, limits);
      if (unfit) return fail(unfit);
      if (density == null) return fail(`${material.name}: its density (the stock's weight sets the load and unload times)`);
      const bundle = sawBundle(sawStock, limits, stock.maxBundle, inp.batchSize, option.stock.partsPerStock);
      const rate = sawRateRow(ref.table('bandSawCutting'), material.cutCode, bundle.widthMm);
      if ('why' in rate) return fail(`${rate.why}: ${material.name}`);
      const stockKg = ((option.stock.lengthMm * (isPlate(option) ? (option.stock.widthMm ?? 0) * (option.blank.thicknessMm ?? 0) : option.sectionAreaMm2 ?? 0)) * density) / 1e9;
      const pieceKg = (option.blank.volumeMm3 * density) / 1e9;
      const load = sawHandlingRow(ref.table('bandSawHandling'), stockKg);
      const unload = sawHandlingRow(ref.table('bandSawHandling'), pieceKg);
      if (!load || !unload) return fail('bandSawHandling has no row for the stock\'s weight');
      plans.set(m.id, { bundle, rate: Number(rate.row['Cutting Rate (mm^2 / min)']), family: rate.family, unloadS: Number(unload['Unload Time (s)']) });
      return kit.timed('Band Saw', m, {
        cut_area_mm2: seed(option.saw.cutAreaMm2, isPlate(option) ? "the blank's two cut edges through the plate (mm²)" : `the section of the ${option.sizeLabel} (mm²)`),
        feed_length_mm: seed(option.blank.lengthMm + option.cutWidthMm, `the ${r2(option.blank.lengthMm)} mm piece and the ${option.cutWidthMm} mm kerf`),
        bars_per_bundle: seed(bundle.bars, bundle.basis),
        parts_per_stock: seed(option.stock.partsPerStock, isPlate(option) ? 'the blanks one plate makes' : 'the pieces one bar makes'),
      }, {
        'bandSawCutting.Cutting Rate (mm^2 / min)': kit.lookupSeed('bandSawCutting', rate.row, 'Cutting Rate (mm^2 / min)', ['Material Cut Code Family', 'Material Type', 'Material Width (mm)']),
        'bandSawHandling.Load Time (s)': kit.lookupSeed('bandSawHandling', load, 'Load Time (s)', ['Weight (kg)']),
        'bandSawHandling.Unload Time (s)': kit.lookupSeed('bandSawHandling', unload, 'Unload Time (s)', ['Weight (kg)']),
      }, { notes: [BAND_SAW_CUT_SOURCE] });
    }, ['The stock fits its width, height and diameter', 'bandSawCutting lists the material at the width in the cut', 'Cheapest per part with its bundle']);
    warnings.push(...step.warnings);
    const result = (name: string) => step.outcome?.run.outputs[name] ?? 0;
    const plan = step.machine ? plans.get(step.machine.id) : undefined;
    if (!isGap(step.line) && step.machine && step.outcome && plan) {
      saw = {
        machine: step.machine.name, bundle: plan.bundle, cutAreaMm2: option.saw.cutAreaMm2, cuttingRateMm2Min: plan.rate, cutCodeFamily: plan.family,
        cutS: result('Cut Time'), feedS: result('Feed Time'), loadPerPartS: result('Load per Part'), unloadS: plan.unloadS, cycleS: step.outcome.sec,
      };
    }
    lines.push({
      ...step.line,
      // memory's catalog row of the step: the saw trims the stock to the piece, at the part's two ends.
      featureBreakdown: [{ name: 'Band Saw // StockTrim', timeSec: r2(step.outcome?.sec ?? 0), featureType: 'StockTrim', count: 1, ...(inp.endFaceIds.length ? { faceIds: [...inp.endFaceIds] } : {}) }],
    });
  }

  return {
    lines,
    material: {
      costUsd: run && bought && 'sec' in bought ? Math.max(0, bought.sec - creditUsd) : null, creditUsd,
      purchasedKg, pieceKg: kg(option.blank.volumeMm3), partKg, run, sizeRun: 'run' in size ? size.run : null, creditRun,
    },
    saw, missing, warnings,
  };
}
