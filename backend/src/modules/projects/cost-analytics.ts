/**
 * The workspace's should-cost in figures a dashboard can chart: what the costed parts cost, what that is made of, where it is spent
 * (process, machine, material, BOM), and how it compares with the price asked for each part.
 *
 * Pure: no database access. Every figure is a sum of saved cost records, taken through the same currency-aware rollup that writes
 * the BOM aggregates (computeCurrencyAwareRollup), so nothing here can show money that rollup would refuse. A part whose records
 * cannot be trusted is counted as unresolved and left out of every sum; a part with no cost is counted as not costed. No figure is
 * estimated, and none is partial without saying how many parts it covers.
 */
import { ROLLUP_REPORTING_CURRENCY } from '../bom-items/costing/shared/core/persisted-currency-contract';
import { resolveScenarioAskPrice } from '../bom-items/costing/shared/physics/scenario-overrides';
import { computeCurrencyAwareRollup, type RollupInputKind, type RollupSourceAmount } from '../bom-items/services/bom-item-rollup';

/** The cost elements of a part's own cost, in the order they are shown, with the rollup kind each one is. */
const ELEMENT_KIND = { rawMaterial: 'raw_material', process: 'process', tooling: 'tooling', packagingLogistics: 'packaging_logistics',
  procuredParts: 'procured_parts' } as const satisfies Record<string, RollupInputKind>;
export type CostElement = keyof typeof ELEMENT_KIND;
export const COST_ELEMENTS = Object.keys(ELEMENT_KIND) as CostElement[];

/**
 * What the money is spent on, finer than the elements: the things a cost reduction acts on. A process record splits into set-up and
 * cycle cost, and the cycle cost into machine and labour by their rates; a material record into the metal left in the part, the stock
 * removed (less its scrap credit), the scrap allowance and the overhead. A record whose parts do not add up to its amount is not split:
 * it goes whole into the "other" driver of its element, so the drivers always add up to the should-cost.
 */
export const COST_DRIVERS = ['machineTime', 'labourTime', 'setup', 'processScrap', 'processOther', 'materialInPart', 'materialRemoved',
  'materialScrap', 'materialOverhead', 'materialOther', 'tooling', 'packagingLogistics', 'procuredParts'] as const;
export type CostDriver = (typeof COST_DRIVERS)[number];

/** The most part rows returned; the totals and groupings still cover every part. */
export const PART_ROWS_MAX = 500;

export interface AnalyticsItem {
  id: string;
  bomId: string;
  name: string;
  partNumber: string | null;
  annualVolume: number | null;
  weightKg: number | null;
  scenarioOverrides: Record<string, unknown> | null;
}

/** One saved cost record of a part, with what the groupings need from it. */
export interface AnalyticsAmount extends RollupSourceAmount {
  itemId: string;
  ref: string;
  createdAt?: string | null;
  processGroup?: string | null;
  machine?: string | null;
  cycleTimeS?: number | null;
  material?: string | null;
  /** Stock bought and material left in the part, when the record states them in kg. */
  grossKg?: number | null;
  netKg?: number | null;
  /** A process record's own parts, in the record's currency: set-up, cycle and scrap cost a part, and the hourly rates the cycle cost is made of. */
  setupCost?: number | null;
  cycleCost?: number | null;
  scrapCost?: number | null;
  machineRate?: number | null;
  labourRate?: number | null;
  /** A material record's own parts: price a unit of stock, stock and part quantity in that unit, and its cost lines. */
  unitPrice?: number | null;
  grossUsage?: number | null;
  netUsage?: number | null;
  grossCost?: number | null;
  reclaimValue?: number | null;
  overheadCost?: number | null;
}

export interface AnalyticsBom { id: string; name: string; projectId: string | null; projectName: string | null }

export interface PartCostRow {
  id: string;
  name: string;
  partNumber: string | null;
  bomId: string;
  bomName: string;
  projectId: string | null;
  unitCost: number;
  elements: Record<CostElement, number>;
  annualVolume: number | null;
  annualSpend: number | null;
  weightKg: number | null;
  cycleTimeS: number;
  /** The first cost record of the part: when it was costed. */
  costedAt: string | null;
  askPrice: number | null;
  /** Ask price less should-cost, per part; positive is what the price is above the should-cost. */
  gap: number | null;
  annualGap: number | null;
}

export interface GroupCost { name: string; parts: number; records: number; unitCost: number; annualSpend: number; annualHours: number }
export interface MaterialCost { name: string; parts: number; unitCost: number; annualSpend: number; grossKg: number; netKg: number }
export interface BomCost {
  id: string; name: string; projectId: string | null; projectName: string | null;
  parts: number; costed: number; unitCost: number; annualSpend: number;
  elements: Record<CostElement, number>;
  /** Of the BOM's parts with an ask price: what is asked and what they should cost, a year. */
  askAnnual: number; askShouldCostAnnual: number;
}

export interface CostAnalytics {
  /** Every amount below is in this currency. */
  currency: string;
  /** The exchange rates applied, as "1 unit of the key = this many of `currency`". Empty when nothing was converted. */
  fxRates: Record<string, number>;
  coverage: {
    parts: number; costed: number; notCosted: number; unresolved: number;
    /** Of the costed parts. */
    withAnnualVolume: number; withAskPrice: number;
    /** Costed parts whose ask price is in a currency with no exchange rate on file: left out of the savings. */
    askPriceUnconverted: number;
  };
  totals: {
    unitCost: number; annualSpend: number; annualHours: number; grossKg: number; netKg: number;
    elements: Record<CostElement, { unitCost: number; annualSpend: number }>;
  };
  savings: {
    parts: number;
    /** Of the parts with an ask price and an annual volume. */
    askAnnual: number; shouldCostAnnual: number;
    /** The sum of the gaps of the parts priced above their should-cost: what a negotiation can aim at. */
    opportunityAnnual: number; partsAboveShouldCost: number;
    /** Parts asked for less than their should-cost. */
    partsBelowShouldCost: number; shortfallAnnual: number;
  };
  /** The drivers that carry money, the largest first. They add up to the should-cost. */
  drivers: { key: CostDriver; unitCost: number; annualSpend: number }[];
  parts: PartCostRow[];
  partsOmitted: number;
  processGroups: GroupCost[];
  machines: GroupCost[];
  materials: MaterialCost[];
  boms: BomCost[];
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const positive = (v: unknown): number | null => (finite(v) && v > 0 ? v : null);
const isIso = (v: unknown): v is string => typeof v === 'string' && /^[A-Z]{3}$/.test(v);
const trustedBasis = (a: RollupSourceAmount) => a.basis === 'local' || a.basis === 'converted';
/** The map's value for a key, made on first use. */
function entry<K, V>(map: Map<K, V>, key: K, make: () => V): V {
  let value = map.get(key);
  if (value === undefined) { value = make(); map.set(key, value); }
  return value;
}
const emptyElements = (): Record<CostElement, number> => ({ rawMaterial: 0, process: 0, tooling: 0, packagingLogistics: 0, procuredParts: 0 });

/** Whether a record's parts add up to its amount (to a hundredth of a percent, or a hundredth of a unit for small amounts). */
const addsUp = (parts: number, amount: number) => Math.abs(parts - amount) <= Math.max(0.01, 1e-4 * Math.abs(amount));

/** A record's amount by cost driver, in the record's own currency. */
export function driversOf(record: AnalyticsAmount): Partial<Record<CostDriver, number>> {
  const { amount } = record;
  if (record.kind === 'tooling') return { tooling: amount };
  if (record.kind === 'packaging_logistics') return { packagingLogistics: amount };
  if (record.kind === 'procured_parts') return { procuredParts: amount };
  if (record.kind === 'process') {
    const setup = record.setupCost, cycle = record.cycleCost, scrap = record.scrapCost ?? 0;
    if (!finite(setup) || !finite(cycle) || !finite(scrap) || setup < 0 || cycle < 0 || !addsUp(setup + cycle + scrap, amount)) return { processOther: amount };
    const machine = record.machineRate, labour = record.labourRate;
    const rated = finite(machine) && finite(labour) && machine >= 0 && labour >= 0 && machine + labour > 0;
    return rated
      ? { setup, processScrap: scrap, machineTime: cycle * machine / (machine + labour), labourTime: cycle * labour / (machine + labour) }
      : { setup, processScrap: scrap, processOther: cycle };
  }
  if (record.kind === 'raw_material') {
    const price = record.unitPrice, gross = record.grossUsage, net = record.netUsage, grossCost = record.grossCost;
    const reclaim = record.reclaimValue ?? 0, scrap = record.scrapCost ?? 0, overhead = record.overheadCost ?? 0;
    if (!finite(price) || !finite(gross) || !finite(net) || !finite(grossCost) || !finite(reclaim) || !finite(scrap) || !finite(overhead)
        || price < 0 || net < 0 || gross < net || !addsUp(gross * price, grossCost) || !addsUp(grossCost - reclaim + scrap + overhead, amount)) {
      return { materialOther: amount };
    }
    return { materialInPart: net * price, materialRemoved: grossCost - net * price - reclaim, materialScrap: scrap, materialOverhead: overhead };
  }
  return {};
}

/**
 * The currency the workspace is reported in: the one its factories' process costs are in when they all share one (a plant in India
 * costs in INR, though its material price list is in USD); with no process cost, the one every record shares; otherwise the
 * reporting currency of the BOM rollups.
 */
export function reportingCurrencyOf(amounts: readonly RollupSourceAmount[]): string {
  const used = (kind?: RollupInputKind) => new Set(amounts
    .filter(a => (!kind || a.kind === kind) && finite(a.amount) && a.amount !== 0 && trustedBasis(a) && isIso(a.currency))
    .flatMap(a => (isIso(a.currency) ? [a.currency] : [])));
  const process = used('process');
  if (process.size === 1) return [...process][0];
  const all = used();
  return process.size === 0 && all.size === 1 ? [...all][0] : ROLLUP_REPORTING_CURRENCY;
}

export function summariseCosts(input: {
  items: readonly AnalyticsItem[];
  boms: readonly AnalyticsBom[];
  amounts: readonly AnalyticsAmount[];
  /** One exchange-rate snapshot: 1 unit of `from` in `to`, or null when no rate is on file. */
  rate: (from: string, to: string) => number | null;
}): CostAnalytics {
  const { items, boms, amounts, rate } = input;
  const currency = reportingCurrencyOf(amounts);
  const fxRates: Record<string, number> = {};
  const toReporting = (from: string) => {
    const r = from === currency ? 1 : rate(from, currency);
    if (r != null && Number.isFinite(r) && r > 0 && from !== currency) fxRates[from] = r;
    return r;
  };

  const amountsByItem = new Map<string, AnalyticsAmount[]>();
  for (const a of amounts) entry(amountsByItem, a.itemId, () => []).push(a);
  const bomById = new Map(boms.map(b => [b.id, b]));

  const newGroup = (name: string) => (): GroupCost & { ids: Set<string> } =>
    ({ name, parts: 0, records: 0, unitCost: 0, annualSpend: 0, annualHours: 0, ids: new Set() });
  const processGroups = new Map<string, GroupCost & { ids: Set<string> }>();
  const machines = new Map<string, GroupCost & { ids: Set<string> }>();
  const materials = new Map<string, MaterialCost & { ids: Set<string> }>();
  const bomCosts = new Map<string, BomCost>();
  for (const b of boms) {
    bomCosts.set(b.id, { id: b.id, name: b.name, projectId: b.projectId, projectName: b.projectName, parts: 0, costed: 0, unitCost: 0,
      annualSpend: 0, elements: emptyElements(), askAnnual: 0, askShouldCostAnnual: 0 });
  }

  const coverage = { parts: items.length, costed: 0, notCosted: 0, unresolved: 0, withAnnualVolume: 0, withAskPrice: 0, askPriceUnconverted: 0 };
  const totals = { unitCost: 0, annualSpend: 0, annualHours: 0, grossKg: 0, netKg: 0,
    elements: Object.fromEntries(COST_ELEMENTS.map(e => [e, { unitCost: 0, annualSpend: 0 }])) as CostAnalytics['totals']['elements'] };
  const savings = { parts: 0, askAnnual: 0, shouldCostAnnual: 0, opportunityAnnual: 0, partsAboveShouldCost: 0, partsBelowShouldCost: 0, shortfallAnnual: 0 };
  const parts: PartCostRow[] = [];
  const drivers = new Map<CostDriver, { unitCost: number; annualSpend: number }>();

  for (const item of items) {
    const bom = bomCosts.get(item.bomId);
    if (bom) bom.parts++;
    const own = amountsByItem.get(item.id) ?? [];
    const rollup = computeCurrencyAwareRollup({ amounts: own, reportingCurrency: currency, rateToReporting: toReporting });
    if (!rollup.trusted || !rollup.totals) { coverage.unresolved++; continue; }
    const unitCost = rollup.totals.own_cost;
    if (!(unitCost > 0)) { coverage.notCosted++; continue; }

    coverage.costed++;
    const volume = positive(item.annualVolume);
    if (volume != null) coverage.withAnnualVolume++;
    const perYear = volume ?? 0;                                   // a part with no annual volume adds nothing to the annual figures
    const elements = emptyElements();
    for (const e of COST_ELEMENTS) {
      elements[e] = rollup.totals[ELEMENT_KIND[e]];
      totals.elements[e].unitCost += elements[e];
      totals.elements[e].annualSpend += elements[e] * perYear;
      if (bom) bom.elements[e] += elements[e];
    }
    totals.unitCost += unitCost;
    totals.annualSpend += unitCost * perYear;
    if (bom) { bom.costed++; bom.unitCost += unitCost; bom.annualSpend += unitCost * perYear; }

    // The rollup's provenance holds each record's amount in the reporting currency, in the order the records were given.
    let cycleTimeS = 0;
    let costedAt: string | null = null;
    own.forEach((record, index) => {
      const converted = rollup.provenance.inputs[index].amountReporting ?? 0;
      if (record.createdAt && (costedAt == null || record.createdAt < costedAt)) costedAt = record.createdAt;
      if (record.amount !== 0 && converted !== 0) {
        for (const [key, share] of Object.entries(driversOf(record)) as [CostDriver, number][]) {
          const d = entry(drivers, key, () => ({ unitCost: 0, annualSpend: 0 }));
          d.unitCost += share * converted / record.amount;                       // in the reporting currency, at the record's own rate
          d.annualSpend += share * converted / record.amount * perYear;
        }
      }
      if (record.kind === 'process') {
        const seconds = positive(record.cycleTimeS) ?? 0;
        cycleTimeS += seconds;
        for (const [map, name] of [[processGroups, record.processGroup], [machines, record.machine]] as const) {
          if (!name) continue;
          const g = entry(map, name, newGroup(name));
          g.ids.add(item.id);
          g.records++;
          g.unitCost += converted;
          g.annualSpend += converted * perYear;
          g.annualHours += seconds * perYear / 3600;
        }
      } else if (record.kind === 'raw_material' && record.material) {
        const name = record.material;
        const m = entry(materials, name, () => ({ name, parts: 0, unitCost: 0, annualSpend: 0, grossKg: 0, netKg: 0, ids: new Set<string>() }));
        m.ids.add(item.id);
        m.unitCost += converted;
        m.annualSpend += converted * perYear;
        const gross = positive(record.grossKg), net = positive(record.netKg);
        if (gross != null && net != null) { m.grossKg += gross; m.netKg += net; totals.grossKg += gross; totals.netKg += net; }
      }
    });
    totals.annualHours += cycleTimeS * perYear / 3600;

    // The ask price, when one was entered on the part's scenario and its currency can be converted.
    const asked = resolveScenarioAskPrice(item.scenarioOverrides);
    let askPrice: number | null = null;
    if (asked) {
      const r = isIso(asked.currency) ? toReporting(asked.currency) : null;
      if (r != null && Number.isFinite(r) && r > 0) askPrice = asked.amount * r;
      else coverage.askPriceUnconverted++;
    }
    const gap = askPrice == null ? null : askPrice - unitCost;
    if (askPrice != null && gap != null) {
      coverage.withAskPrice++;
      if (volume != null) {
        savings.parts++;
        savings.askAnnual += askPrice * volume;
        savings.shouldCostAnnual += unitCost * volume;
        if (bom) { bom.askAnnual += askPrice * volume; bom.askShouldCostAnnual += unitCost * volume; }
        if (gap > 0) { savings.partsAboveShouldCost++; savings.opportunityAnnual += gap * volume; }
        if (gap < 0) { savings.partsBelowShouldCost++; savings.shortfallAnnual += -gap * volume; }
      }
    }

    parts.push({
      id: item.id, name: item.name, partNumber: item.partNumber, bomId: item.bomId, bomName: bomById.get(item.bomId)?.name ?? '',
      projectId: bomById.get(item.bomId)?.projectId ?? null, unitCost, elements, annualVolume: volume,
      annualSpend: volume == null ? null : unitCost * volume, weightKg: positive(item.weightKg), cycleTimeS, costedAt,
      askPrice, gap, annualGap: gap == null || volume == null ? null : gap * volume,
    });
  }

  const bySpend = <T extends { annualSpend: number; unitCost: number; name: string }>(a: T, b: T) =>
    b.annualSpend - a.annualSpend || b.unitCost - a.unitCost || a.name.localeCompare(b.name);
  const closed = <T extends { ids: Set<string>; parts: number }>(map: Map<string, T>) =>
    [...map.values()].map(({ ids, ...rest }) => ({ ...rest, parts: ids.size }));
  parts.sort((a, b) => (b.annualSpend ?? 0) - (a.annualSpend ?? 0) || b.unitCost - a.unitCost || a.name.localeCompare(b.name));

  return {
    currency, fxRates, coverage, totals, savings,
    drivers: COST_DRIVERS.flatMap(key => { const d = drivers.get(key); return d?.unitCost ? [{ key, ...d }] : []; })
      .sort((a, b) => b.annualSpend - a.annualSpend || b.unitCost - a.unitCost),
    parts: parts.slice(0, PART_ROWS_MAX),
    partsOmitted: Math.max(0, parts.length - PART_ROWS_MAX),
    processGroups: (closed(processGroups) as GroupCost[]).sort(bySpend),
    machines: (closed(machines) as GroupCost[]).sort((a, b) => b.annualHours - a.annualHours || bySpend(a, b)),
    materials: (closed(materials) as MaterialCost[]).sort(bySpend),
    boms: [...bomCosts.values()].filter(b => b.parts > 0).sort(bySpend),
  };
}
