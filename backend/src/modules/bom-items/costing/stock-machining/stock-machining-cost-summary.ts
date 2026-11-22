// A Stock Machining part's stock front end on a machining route's quote: the stock model's choice as the blank the machining engines start
// from, the Band Saw line and the stock's material cost on the route, and the Cost Summary's section. Pure: the cost service chooses and
// prices the stock (stock-machining-cost.service.ts); the machining engines price the cutting of the part.
//
// What cannot be chosen or priced never stops the quote (the user's decision 2026-11-20: Apply never fails): it is a named, uncosted line,
// which Apply writes as a $0 No Cost Feature with its reason.
import { STOCK_MACHINING_CALC, STOCK_MACHINING_CLASS, STOCK_MACHINING_PROCESS_GROUP, type StockCutOff } from './stock-machining-route';
import { runView } from '../casting/casting-calculator-seeds';
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

/** The engine's own rules, which the reference data does not state, said once on the quote. */
export const STOCK_RULES_DISCLOSED = 'Disclosed (the engine\'s rules, agreed 2026-11-22; the data states the allowance, snapping and plate rules and has none for '
  + 'these): the ends are faced (the piece is the part\'s length plus the allowance on each end); a bar makes floor((bar length - bar end) / (piece + cut '
  + 'width)) parts and each part carries its share of the whole bar; plate blanks are cut in a grid on the standard plate, a kerf apart; the saw\'s cut '
  + 'time is the area cut over the cutting rate, a bundle cut as one section.';

/** A Stock Machining part's stock as its quote needs it: the choice, its pricing, and what kept either from being made. */
export interface StockMachiningPlan {
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
 * The stock model's choice as the blank the machining engines start from: the piece cut for one part (what is machined away, and the bar a
 * lathe turns down from: the circle round a bar's corners), with the stock bought per part beside it (what the material is priced on).
 * Null when no form holds the part.
 */
export function stockBlankResult(choice: StockMachiningChoice, cutOff: StockCutOff): BlankResult | null {
  const selection = choice.selection[cutOff];
  const o = selection.chosen;
  if (!o) return null;
  return {
    form: o.form, sizeLabel: o.sizeLabel, billetVolMm3: o.blank.volumeMm3, utilizationPct: o.utilizationPct,
    ...(o.circumscribedMm != null ? { barDiameterMm: o.circumscribedMm } : {}),
    purchasedVolMm3: o.purchasedVolumeMm3, sizeSource: STOCK_SIZE_SOURCE, stock: selection,
    ...(selection.fallback && choice.settings.form ? { requestedFormUnavailable: { requested: choice.settings.form, reason: selection.fallback } } : {}),
  };
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

/** The lines the stock puts before a route's machining: the Band Saw (none when the lathe parts the piece off), or what is not costed. */
function frontLines(plan: StockMachiningPlan, cutOff: StockCutOff): ProcessLineCost[] {
  const why = plan.missing.join('; ');
  if (!plan.choice) return [uncosted('Material Stock', `The stock is not chosen by the Stock Machining rules: ${why || 'no stock model'}. The material is priced on the Machining blank.`)];
  const priced = plan.priced?.[cutOff];
  if (priced?.quote) return priced.lines;
  if (cutOff === 'parting') return [];
  return [uncosted('Band Saw', `The band saw is not costed: ${why || 'no stock form holds the part'}.`)];
}

/**
 * A machining route's quote with its stock front end: the Band Saw line before the machining lines, and the stock bought per part (less the
 * scrap credit when it is on) as the material cost. The route's own material cost stands when the stock is not priced. `cutOff` is the
 * route's machine's (stockCutOffOf).
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
  const warnings = [
    ...cost.warnings, ...plan.warnings, ...(plan.choice?.notes ?? []),
    ...(plan.missing.length ? [`Stock Machining: ${plan.missing.join('; ')}.`] : []),
    ...(priced?.selection.fallback ? [priced.selection.fallback] : []),
    ...(quote?.warnings ?? []),
    ...(quote?.missing.length ? [`The stock is not priced: ${quote.missing.join('; ')}.`] : []),
    ...(quote && cutOff === 'parting' ? [PARTED_OFF] : []),
    ...(quote ? [STOCK_RULES_DISCLOSED] : []),
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

/** The stock as the material record names it: 5/8" round bar, 33.59 mm piece, 172 per 6096 mm bar. */
export function stockLabelOf(o: StockOption): string {
  if (!isPlate(o)) return `${o.sizeLabel}, ${r2(o.blank.lengthMm)} mm piece, ${o.stock.partsPerStock} per ${r2(o.stock.lengthMm)} mm bar`;
  return o.stock.virtual
    ? `${o.sizeLabel}, cut from a plate of its own size`
    : `${o.sizeLabel}, ${o.stock.partsPerStock} per ${r2(o.stock.lengthMm)} x ${r2(o.stock.widthMm ?? 0)} mm plate`;
}

/** The Cost Summary's Stock Machining section for the quoted route's cut-off; undefined when no stock was chosen. Money in the location's currency. */
export function stockMachiningBreakdown(plan: StockMachiningPlan, cutOff: StockCutOff, batchSize: number): StockMachiningBreakdown | undefined {
  const { choice } = plan;
  if (!choice) return undefined;
  const selection = choice.selection[cutOff];
  const o = selection.chosen;
  const priced = plan.priced?.[cutOff] ?? null;
  const quote = priced?.quote ?? null;
  const kg = (v: number | null | undefined) => (v == null ? null : Math.round(v * 1e6) / 1e6);
  const sawGap = priced?.lines[0]?.physicsGap;
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
      ?? selection.options.map((x) => ({ form: x.form, sizeLabel: 'sizeLabel' in x ? x.sizeLabel : null, unavailable: 'unavailable' in x ? x.unavailable : null, materialCost: null, sawCost: null, chosen: x === o })),
    saw: quote?.saw ? {
      machineName: quote.saw.machine, bundleBars: quote.saw.bundle.bars, bundleBasis: quote.saw.bundle.basis, cuttingRateMm2Min: quote.saw.cuttingRateMm2Min,
      cutSec: r3(quote.saw.cutS), feedSec: r3(quote.saw.feedS), loadSec: r3(quote.saw.loadPerPartS), unloadSec: r3(quote.saw.unloadS), cycleSec: r3(quote.saw.cycleS),
    } : null,
    sawMissing: quote?.saw ? null
      : cutOff === 'parting' ? PARTED_OFF
        : sawGap && 'reason' in sawGap ? sawGap.reason
          : plan.missing.join('; ') || 'no stock form holds the part',
    scrapCredit: { enabled: choice.scrapCredit, percent: plan.scrapCostPercent, credit: priced?.scrapCredit ?? 0 },
    partSource: choice.part.source,
    asSuppliedFaceIds: o ? asSuppliedFaces(o, choice.part, choice.faces) : { curvedWall: [], planarFace: [] },
    endFaceIds: choice.faces.endFaceIds,
    stockLabel: o ? stockLabelOf(o) : null,
    notes: [...choice.notes, ...(o?.notes ?? []), choice.remnant.source],
  };
}
