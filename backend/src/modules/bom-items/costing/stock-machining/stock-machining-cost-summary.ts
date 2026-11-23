// A machined part's stock front end on a machining route's quote: the stock model's choice as the blank the machining engines start from,
// the stock's material cost on the route, a Stock Machining part's Band Saw line, and the Cost Summary's section. Pure: the cost service
// chooses and prices the stock (stock-machining-cost.service.ts); the machining engines price the cutting of the part.
//
// One stock model for every machined part (user decision 2026-11-22): a part whose Process is Machining buys the stock a Stock Machining
// part buys, at the same price. Sawing it to pieces is what the Stock Machining Process adds, so only its quote has the Band Saw line
// (StockMachiningPlan.sawCosted); any other quote says the sawing is not costed.
//
// What cannot be chosen or priced never stops the quote (the user's decision 2026-11-20: Apply never fails): it is a named, uncosted line,
// which Apply writes as a $0 No Cost Feature with its reason. Nothing is estimated in its place.
//
// A part cut from plate has three roughing techniques on a mill's route (stock/plate-roughing.ts; user decision 2026-11-22). The quoted
// one is data of the priced stock (PricedStock.selection.chosen and .roughing): the piece the engines start from, the lines before the
// machining, the mill's perimeter cut and the summary's section are all read from there, as the stock form is.
import { PERIMETER_MILLING } from './perimeter-cut';
import { STOCK_MACHINING_CALC, STOCK_MACHINING_CLASS, STOCK_MACHINING_PROCESS_GROUP, type StockCutOff } from './stock-machining-route';
import { runView } from '../casting/casting-calculator-seeds';
import { stockExcess } from '../machining/operation/stock-excess';
import { stockPriceFormOf, type StockPriceForm } from '../machining/stock-price';
import { ROUGHING_TECHNIQUE_LABEL } from '../stock/plate-roughing';
import { asSuppliedFaces } from '../stock/stock-part';

import type { PricedStock, StockMachiningChoice } from './stock-machining-cost.service';
import type { CostSummaryDto, ProcessLineCost, StockMachiningBreakdown } from '../../dto/cost-breakdown.dto';
import type { BlankResult } from '../sheet-metal/machine/blank-stock-candidates';
import type { StockOption } from '../stock/stock-selection';

const r2 = (n: number) => Math.round(n * 100) / 100;
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const isPlate = (o: StockOption) => o.form === 'plate' || o.form === 'billet';

/** What chose the stock, for the source of a calculation that reads its size. */
export const STOCK_SIZE_SOURCE = 'Stock Machining stock (tblPreferredSizes)';

/** Said on a route whose lathe parts the piece off the bar. */
export const PARTED_OFF = 'A bar-fed lathe takes the whole bar and parts each piece off: no band saw cuts it.';

/** Said on a route that starts from a sawn piece whose sawing the part's Process does not cost. A note, not a gap: the route is complete. */
export const SAW_NOT_COSTED = 'Sawing the stock to pieces is not costed: the machine is loaded with a piece cut to length. Set the part\'s Process to '
  + 'Stock Machining to cost the band saw.';

/** Said on a route whose part a drop-off technique cuts out of the plate: there is no blank to saw, whatever the part's Process. */
export const PLATE_NOT_SAWN: Readonly<Record<'perimeter_milling_dropoff' | 'plate_cutting_dropoff', string>> = {
  perimeter_milling_dropoff: 'The plate is loaded on the mill whole and the mill cuts each part out of it: no band saw cuts it.',
  plate_cutting_dropoff: 'A plate cutting process cuts each part out of the plate: no band saw cuts it.',
};

/** The engine's own rules of the drop-off techniques, which the reference data does not state, said once on a quote that uses one. */
export const DROPOFF_RULES_DISCLOSED = 'Disclosed (the engine\'s rules, agreed 2026-11-22; the data names the roughing techniques and has no formula for '
  + 'them): the parts are nested as their outlines\' rectangles in a grid; the mill\'s perimeter cut is a slot through the plate in passes of the keyway\'s '
  + 'slotting depth, each pass the outline plus one cutter diameter; a plate cutting process cuts the outline grown by the stock allowance (perimeter + 2πa, '
  + 'area + perimeter x a + πa²) from one pierce; the mill then removes what is left inside the cut round the part.';

/** The engine's own rules, which the reference data does not state, said once on the quote. */
export const STOCK_RULES_DISCLOSED = 'Disclosed (the engine\'s rules, agreed 2026-11-22; the data states the allowance, snapping and plate rules and has none for '
  + 'these): the ends are faced (the piece is the part\'s length plus the allowance on each end); a bar makes floor((bar length - bar end) / (piece + cut '
  + 'width)) parts and each part carries its share of the whole bar; plate blanks are cut in a grid on the standard plate, a kerf apart; the saw\'s cut '
  + 'time is the area cut over the cutting rate, a bundle cut as one section.';

/** A machined part's stock as its quote needs it: the choice, its pricing, and what kept either from being made. */
export interface StockMachiningPlan {
  /** Whether the quote costs the band saw: only a Stock Machining part's does. Every other machined part buys the same stock with no Band Saw line. */
  sawCosted: boolean;
  /** Null when the stock could not be chosen (the reference is not staged, the part has no size). */
  choice: StockMachiningChoice | null;
  /** Null when the chosen stock could not be priced (the calculators are not in the database). */
  priced: Readonly<Record<StockCutOff, PricedStock>> | null;
  /** The material's Scrap Cost Percent as the reference lists it. */
  scrapCostPercent: number | null;
  missing: string[];
  warnings: string[];
}

/**
 * The stock the quote prices for a cut-off: the priced stock's (a plate under a drop-off technique is that technique's), else the stock
 * model's own choice when nothing is priced.
 */
export function quotedStock(choice: StockMachiningChoice, cutOff: StockCutOff, priced?: Readonly<Record<StockCutOff, PricedStock>> | null): StockOption | null {
  return (priced?.[cutOff].selection ?? choice.selection[cutOff]).chosen;
}

/**
 * The stock model's choice as the blank the machining engines start from: the piece cut for one part (what is machined away, and the bar a
 * lathe turns down from: the circle round a bar's corners), with the stock bought per part beside it (what the material is priced on).
 * `priced` gives the roughing technique's piece for a plate part. Null when no form holds the part.
 */
export function stockBlankResult(choice: StockMachiningChoice, cutOff: StockCutOff, priced?: Readonly<Record<StockCutOff, PricedStock>> | null): BlankResult | null {
  const selection = choice.selection[cutOff];
  const o = quotedStock(choice, cutOff, priced);
  if (!o) return null;
  return {
    form: o.form, sizeLabel: o.sizeLabel, billetVolMm3: o.blank.volumeMm3, utilizationPct: o.utilizationPct,
    ...(o.circumscribedMm != null ? { barDiameterMm: o.circumscribedMm } : {}),
    purchasedVolMm3: o.purchasedVolumeMm3, sizeSource: STOCK_SIZE_SOURCE,
    ...(selection.fallback && choice.settings.form ? { requestedFormUnavailable: { requested: choice.settings.form, reason: selection.fallback } } : {}),
  };
}

/**
 * What a route's machining engine takes from the part's stock: the piece it starts from, what cut it off (a lathe loaded with a piece cut
 * to length prices no Parting; a bar-fed lathe parts it off the bar) and the price per kg of the stock's form, in the currency the route
 * is priced in. Empty when no stock is chosen: the engine then has no stock to price or cut, and the quote names the gap.
 */
export function stockEngineInput(
  choice: StockMachiningChoice | null, cutOff: StockCutOff, pricesPerKg: Partial<Record<StockPriceForm, number>>,
  priced?: Readonly<Record<StockCutOff, PricedStock>> | null,
): { blankResult?: BlankResult; stockCutOff?: StockCutOff; materialCostPerKg?: number } {
  const blank = choice ? stockBlankResult(choice, cutOff, priced) : null;
  if (!blank) return {};
  const priceForm = stockPriceFormOf(blank.form);
  const perKg = priceForm ? pricesPerKg[priceForm] : undefined;
  return { blankResult: blank, stockCutOff: cutOff, ...(perKg != null ? { materialCostPerKg: perKg } : {}) };
}

/** A step of the stock front end that is not costed, named with why. */
function uncosted(process: 'Material Stock' | 'Band Saw', reason: string): ProcessLineCost {
  const machineClass = process === 'Band Saw' ? STOCK_MACHINING_CLASS.saw : STOCK_MACHINING_CLASS.stock;
  return {
    process, processGroup: STOCK_MACHINING_PROCESS_GROUP, processRoute: process, operation: process,
    setupCost: 0, runCost: 0, totalCost: 0, cycleTimeMin: 0, hourlyRate: 0, rateSource: 'no_db_rate',
    machineClass, machineName: null, commodityCode: null, labourRate: null,
    physicsGap: { gapType: 'unsupported_operation', process, machineClass, reason },
  };
}

/**
 * The lines the stock puts before a route's machining: the Band Saw of a Stock Machining part (none when the lathe parts the piece off),
 * the plate cutting of a part a drop-off technique cuts out of the plate, or what is not costed. A part with no stock has no material
 * either: nothing is estimated in the stock's place.
 */
function frontLines(plan: StockMachiningPlan, cutOff: StockCutOff): ProcessLineCost[] {
  const why = plan.missing.join('; ');
  if (!plan.choice?.selection[cutOff].chosen) {
    const reason = why || (plan.choice ? 'no stock form holds the part' : 'no stock model');
    return [uncosted('Material Stock', `The stock is not chosen: ${reason}. Its material is not costed, and nothing is estimated in its place.`)];
  }
  const priced = plan.priced?.[cutOff];
  if (priced?.quote) return priced.lines;
  if (cutOff === 'parting' || !plan.sawCosted) return [];
  return [uncosted('Band Saw', `The band saw is not costed: ${why || 'the stock is not priced'}.`)];
}

/**
 * A machining route's quote with its stock front end: a Stock Machining part's Band Saw line before the machining lines, and the stock
 * bought per part (less the scrap credit when it is on) as the material cost. The route's own material cost (the engine's, on the same
 * stock) stands when the stock's calculators did not price it. `cutOff` is the route's machine's (stockCutOffOf).
 */
export function withStockMachining<T extends CostSummaryDto>(cost: T, plan: StockMachiningPlan, cutOff: StockCutOff): T {
  const priced = plan.priced?.[cutOff] ?? null;
  const quote = priced?.quote ?? null;
  const processLines = [...frontLines(plan, cutOff), ...cost.processLines];
  const materialCost = priced?.materialCost != null ? r2(priced.materialCost) : cost.materialCost;
  const totalProcessCost = r2(processLines.reduce((s, l) => s + l.totalCost, 0));
  const runs = quote ? {
    ...(quote.material.sizeRun ? { 'Stock Machining stock size': runView(STOCK_MACHINING_CALC.size, 'Required Size', quote.material.sizeRun) } : {}),
    ...(quote.material.run ? { 'Stock Machining stock': runView(isPlate(priced!.selection.chosen!) ? STOCK_MACHINING_CALC.plate : STOCK_MACHINING_CALC.bar, 'Material Cost', quote.material.run) } : {}),
    ...(quote.material.creditRun ? { 'Stock Machining scrap credit': runView(STOCK_MACHINING_CALC.scrap, 'Scrap Credit', quote.material.creditRun) } : {}),
  } : {};
  // A drop-off technique's stock: nothing is sawn, so the saw notes give way to the technique's own.
  const dropoff = priced?.selection.chosen?.roughing ?? null;
  const warnings = [
    ...cost.warnings, ...plan.warnings, ...(plan.choice?.notes ?? []),
    ...(plan.missing.length ? [`Stock: ${plan.missing.join('; ')}.`] : []),
    ...(priced?.selection.fallback ? [priced.selection.fallback] : []),
    ...(priced?.roughing?.fallback ? [priced.roughing.fallback] : []),
    ...(quote?.warnings ?? []),
    ...(priced?.roughing?.warnings ?? []),
    ...(quote?.missing.length ? [`The stock is not priced: ${quote.missing.join('; ')}.`] : []),
    ...(quote && cutOff === 'parting' ? [PARTED_OFF] : []),
    ...(quote && cutOff === 'saw' && !plan.sawCosted && !dropoff ? [SAW_NOT_COSTED] : []),
    ...(quote ? [dropoff ? DROPOFF_RULES_DISCLOSED : STOCK_RULES_DISCLOSED] : []),
  ];
  return {
    ...cost,
    processLines, materialCost, totalProcessCost,
    totalCost: r2(materialCost + totalProcessCost),
    grossWeightKg: quote?.material.purchasedKg != null ? r3(quote.material.purchasedKg) : cost.grossWeightKg,
    cycleTimes: { ...cost.cycleTimes, totalMin: r2(processLines.reduce((s, l) => s + l.cycleTimeMin, 0)) },
    warnings: warnings.filter((w, i) => w && warnings.indexOf(w) === i),
    ...(Object.keys(runs).length ? { calculatorRuns: { ...(cost.calculatorRuns ?? {}), ...runs } } : {}),
  };
}

/** The stock as the material record names it: 5/8" round bar, 33.59 mm piece, 172 per 6096 mm bar. A drop-off technique's plate names what cuts it. */
export function stockLabelOf(o: StockOption): string {
  if (!isPlate(o)) return `${o.sizeLabel}, ${r2(o.blank.lengthMm)} mm piece, ${o.stock.partsPerStock} per ${r2(o.stock.lengthMm)} mm bar`;
  const plate = o.stock.virtual
    ? `${o.sizeLabel}, cut from a plate of its own size`
    : `${o.sizeLabel}, ${o.stock.partsPerStock} per ${r2(o.stock.lengthMm)} x ${r2(o.stock.widthMm ?? 0)} mm plate`;
  return o.roughing ? `${plate}, ${o.roughing.process ?? 'perimeter milled'}` : plate;
}

/** What a plate part's roughing techniques are stated with on the quoted mill, beyond the stock's own pricing. */
export interface RoughingOnMill {
  /** The part's volume and what its features remove (mm³): the bulk a technique leaves is its piece less both (stock-excess.ts). */
  partMm3: number;
  featureRemovedMm3: number;
  /** What a milling operation of this many seconds costs on the quoted mill, in the location's currency; null when it cannot be priced. */
  operationCost: (seconds: number) => number | null;
}

/**
 * The Cost Summary's stock section (stockMachining) for the quoted route's cut-off; undefined when no stock was chosen. Money in the
 * location's currency. `mill` is the quoted mill, for a plate part's roughing techniques (the bulk each leaves, and what the perimeter cut
 * costs at that mill's rate).
 */
export function stockMachiningBreakdown(plan: StockMachiningPlan, cutOff: StockCutOff, batchSize: number, mill?: RoughingOnMill): StockMachiningBreakdown | undefined {
  const { choice } = plan;
  if (!choice) return undefined;
  const selection = choice.selection[cutOff];
  const priced = plan.priced?.[cutOff] ?? null;
  // The stock the quote prices; and the stock as the model chose it, whose own allowance says which faces are left as supplied.
  const o = quotedStock(choice, cutOff, plan.priced);
  const base = selection.chosen;
  const quote = priced?.quote ?? null;
  const kg = (v: number | null | undefined) => (v == null ? null : Math.round(v * 1e6) / 1e6);
  const sawGap = priced?.lines[0]?.physicsGap;
  const roughing = priced?.roughing ?? null;
  return {
    rule: selection.rule,
    stock: o ? {
      form: o.form, sizeLabel: o.sizeLabel,
      boughtAMm: r3(o.aMm), boughtBMm: o.bMm != null ? r3(o.bMm) : null, requiredAMm: r3(o.requiredAMm), requiredBMm: o.requiredBMm != null ? r3(o.requiredBMm) : null,
      allowancePerSideMm: r3(o.allowancePerSideMm), endAllowanceMm: r3(o.endAllowanceMm), snapped: o.snapped, unitSystem: choice.unitSystem,
      piece: { lengthMm: r3(o.blank.lengthMm), widthMm: o.blank.widthMm != null ? r3(o.blank.widthMm) : null, thicknessMm: o.blank.thicknessMm != null ? r3(o.blank.thicknessMm) : null },
      cutWidthMm: o.cutWidthMm, cutOff,
      partsPerStock: o.stock.partsPerStock, stocksForBatch: Math.max(1, Math.ceil(batchSize / Math.max(1, o.stock.partsPerStock))),
      stockLengthMm: r3(o.stock.lengthMm), stockWidthMm: o.stock.widthMm != null ? r3(o.stock.widthMm) : null, virtualPlate: o.stock.virtual,
      barEndMm: isPlate(o) ? null : choice.remnant.mm,
      utilizationPct: Math.round(o.utilizationPct * 10) / 10,
      purchasedKg: kg(quote?.material.purchasedKg), pieceKg: kg(quote?.material.pieceKg), partKg: kg(quote?.material.partKg),
    } : null,
    fallback: selection.fallback,
    options: priced?.options
      ?? selection.options.map((x) => ({ form: x.form, sizeLabel: 'sizeLabel' in x ? x.sizeLabel : null, unavailable: 'unavailable' in x ? x.unavailable : null, materialCost: null, sawCost: null, chosen: x === base })),
    // A plate part's roughing techniques, the quoted one and every other beside it. Absent for bar stock, which has one.
    ...(roughing ? {
      roughing: {
        technique: roughing.technique, label: ROUGHING_TECHNIQUE_LABEL[roughing.technique], source: roughing.source, defaultTechnique: roughing.defaultTechnique,
        fallback: roughing.fallback,
        options: roughing.options.map((x) => ({
          technique: x.technique, label: x.label, chosen: x.chosen, unavailable: x.unavailable, partsPerPlate: x.partsPerPlate, materialCost: x.materialCost,
          // The mill's own perimeter cut costs its time at the quoted mill's rate; the saw and a plate cutting process are priced on their own machines.
          separation: x.separation && x.separation.process === PERIMETER_MILLING && x.separation.timeSec != null
            ? { ...x.separation, timeSec: r3(x.separation.timeSec), cost: mill?.operationCost(x.separation.timeSec) ?? null }
            : x.separation ? { ...x.separation, timeSec: x.separation.timeSec != null ? r3(x.separation.timeSec) : null } : null,
          bulkVolumeMm3: x.pieceVolumeMm3 != null && mill
            ? r2(stockExcess({ pieceMm3: x.pieceVolumeMm3, partMm3: mill.partMm3, featureRemovedMm3: mill.featureRemovedMm3 }).excessMm3)
            : null,
          processes: x.processes,
        })),
      },
    } : {}),
    saw: quote?.saw ? {
      machineName: quote.saw.machine, bundleBars: quote.saw.bundle.bars, bundleBasis: quote.saw.bundle.basis, cuttingRateMm2Min: quote.saw.cuttingRateMm2Min,
      cutSec: r3(quote.saw.cutS), feedSec: r3(quote.saw.feedS), loadSec: r3(quote.saw.loadPerPartS), unloadSec: r3(quote.saw.unloadS), cycleSec: r3(quote.saw.cycleS),
    } : null,
    sawMissing: quote?.saw ? null
      : o?.roughing ? PLATE_NOT_SAWN[o.roughing.technique]
        : cutOff === 'parting' ? PARTED_OFF
          : !plan.sawCosted ? SAW_NOT_COSTED
            : sawGap && 'reason' in sawGap ? sawGap.reason
              : plan.missing.join('; ') || 'no stock form holds the part',
    scrapCredit: { enabled: choice.scrapCredit, percent: plan.scrapCostPercent, credit: priced?.scrapCredit ?? 0 },
    partSource: choice.part.source,
    asSuppliedFaceIds: base ? asSuppliedFaces(base, choice.part, choice.faces) : { curvedWall: [], planarFace: [] },
    endFaceIds: choice.faces.endFaceIds,
    stockLabel: o ? stockLabelOf(o) : null,
    notes: [...choice.notes, ...(o?.notes ?? []), choice.remnant.source],
  };
}
