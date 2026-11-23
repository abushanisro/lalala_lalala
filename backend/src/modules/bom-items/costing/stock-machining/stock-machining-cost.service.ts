import { Injectable } from '@nestjs/common';

import { loadStockMachiningCalculatorSpec } from './calculators/stock-machining-calculator-spec';
import { PERIMETER_MILLING, perimeterCutOperation, perimeterCutterMissing, type PerimeterCutter } from './perimeter-cut';
import { plateCutRequests, plateCutStocks, type PlateCutPrice, type PlateCutRequest } from './plate-cutting';
import {
  buildStockMachiningQuote, STOCK_MACHINING_CLASS, STOCK_MACHINING_PROCESS_GROUP, type StockCutOff, type StockMachiningQuote,
} from './stock-machining-route';
import { DatabaseService } from '../../../../common/database/database.service';
import { escapeLikePattern, quoteFilterValue } from '../../../../common/db/postgrest-filter';
import { CalculatorCatalogService } from '../../services/calculator-catalog.service';
import { lineToLocal } from '../casting/sand/sand-cost';
import { SandMachineService } from '../casting/sand/sand-machine.service';
import { readStagedReference } from '../casting/sand/sand-reference.service';
import { stockPriceFormOf, type StockPriceForm } from '../machining/stock-price';
import { preferredCutCode } from '../shared/core/cut-code';
import {
  resolveScenarioStockAllowanceMm, resolveScenarioStockForm, resolveScenarioStockRemnantMm, resolveScenarioStockRoughingTechnique, resolveScenarioStockScrapCredit,
  resolveScenarioStockSnap,
} from '../shared/physics/scenario-overrides';
import { PLATE_OUTLINE_MISSING, plateOutlineOf, type PlateOutline } from '../stock/plate-outline';
import {
  isDropoffStock, perimeterMilledStock, PLATE_CUT_PROCESSES, ROUGHING_TECHNIQUE_LABEL, ROUGHING_TECHNIQUES, roughedOption, roughingReference, roughingTechniqueOf,
  type DropoffStock, type DropoffStockResult, type PlateCutProcess, type RoughingTechnique,
} from '../stock/plate-roughing';
import { stockPartOf, type StockFaces, type StockPartInput } from '../stock/stock-part';
import { stockReference, type StockReference } from '../stock/stock-reference';
import { BAR_END_REMNANT_MM, BAR_END_REMNANT_SOURCE } from '../stock/stock-research';
import { isStockOption, selectStock, STOCK_FORM_LABEL, type StockForm, type StockOption, type StockPart, type StockSelection } from '../stock/stock-selection';
import { unitSystemFor, type UnitSystem } from '../stock/stock-sizing';

import type { DbClient } from '../../../../common/db/postgrest-client';
import type { ProcessLineCost } from '../../dto/cost-breakdown.dto';
import type { CostContext } from '../casting/casting-finishing';
import type { SandMachine } from '../casting/sand/sand-machines';
import type { SandReference } from '../casting/sand/sand-reference';
import type { OperationLine } from '../machining/operation/operation-sequencer';
import type { ReferenceCalculatorDef } from '../shared/calculators/reference-calculator';

export const STOCK_MACHINING_SOURCE_VERSION = '2026-Stock-Machining';
/** The staged lookup of the group's materials (memory/Stock Maching materials: migration 816), for a material's cut code and Scrap Cost Percent. */
const MATERIALS_LOOKUP = 'materialsBandSaw';

/** The Cost Guide's stock settings of a part (scenario_overrides), each null when not set: the rule, or the engine's stated value, then applies. */
export interface StockMachiningSettings {
  form: StockForm | null;
  allowanceMm: number | null;
  snap: boolean | null;
  remnantMm: number | null;
  scrapCredit: boolean | null;
  /** How a part cut from plate is roughed out; null for the data's defaultRoughingTechnique. */
  roughingTechnique: RoughingTechnique | null;
}

export function stockMachiningSettings(overrides: Record<string, unknown> | null | undefined): StockMachiningSettings {
  return {
    form: resolveScenarioStockForm(overrides),
    allowanceMm: resolveScenarioStockAllowanceMm(overrides),
    snap: resolveScenarioStockSnap(overrides),
    remnantMm: resolveScenarioStockRemnantMm(overrides),
    scrapCredit: resolveScenarioStockScrapCredit(overrides),
    roughingTechnique: resolveScenarioStockRoughingTechnique(overrides),
  };
}

/** The stock chosen for a machined part, for each way its piece is cut off. It rests on the part and the reference data alone: no material, no machine. */
export interface StockMachiningChoice {
  ref: SandReference;
  stock: StockReference;
  part: StockPart;
  faces: StockFaces;
  /** The part's outline seen through the plate (the analysis's plate outline); null when the analysis holds none. The drop-off techniques cut round it. */
  outline: PlateOutline | null;
  unitSystem: UnitSystem;
  /** The bar end the stock is yielded with, and where the value came from. */
  remnant: { mm: number; source: string };
  /** Whether the chips are sold back: the Cost Guide's, else the data's enableScrapMaterialCredit. */
  scrapCredit: boolean;
  settings: StockMachiningSettings;
  /** The stock when a band saw cuts the piece, and when a bar-fed lathe parts it off the bar (the parting tool's width replaces the kerf). */
  selection: Readonly<Record<StockCutOff, StockSelection>>;
  /** What the quote says of the part's envelope (a part read off its bounding box). */
  notes: string[];
}

/** Chooses a part's stock by the staged rules; `missing` names what keeps it from being chosen. */
export function chooseStockMachining(input: {
  ref: SandReference;
  stock: StockReference;
  location: string;
  part: StockPartInput;
  overrides: Record<string, unknown> | null | undefined;
}): { choice: StockMachiningChoice | null; missing: string[] } {
  const { part, faces, note } = stockPartOf(input.part);
  if (!part) return { choice: null, missing: ['the part\'s size (its bounding box: press Refresh analysis so the part is measured)'] };
  const settings = stockMachiningSettings(input.overrides);
  const unitSystem = unitSystemFor(input.location);
  const remnant = settings.remnantMm != null
    ? { mm: settings.remnantMm, source: 'the bar end set in the Cost Guide (mm)' }
    : { mm: BAR_END_REMNANT_MM, source: BAR_END_REMNANT_SOURCE };
  const select = (cutOff: StockCutOff) => selectStock(part, input.stock, { unitSystem, cutOff, remnantMm: remnant.mm, allowanceMm: settings.allowanceMm, snap: settings.snap }, settings.form);
  return {
    choice: {
      ref: input.ref, stock: input.stock, part, faces, outline: plateOutlineOf(input.part.machiningStock), unitSystem, remnant, scrapCredit: settings.scrapCredit ?? input.stock.scrapCredit, settings,
      selection: { saw: select('saw'), parting: select('parting') },
      notes: note ? [note] : [],
    },
    missing: [],
  };
}

/** The part's material as its stock is priced: one density and cut code, and a price per kg for each stock form. */
export interface StockMachiningMaterialInput {
  name: string;
  cutCode: number | null;
  densityKgM3: number | null;
  scrapCostPercent: number | null;
  /** USD per kg of each stock form at the location (the form's stock price, else the material's own). */
  pricePerKgUsd: Partial<Record<StockPriceForm, number>>;
}

export interface StockOptionCost {
  form: StockForm;
  sizeLabel: string | null;
  unavailable: string | null;
  /**
   * The stock bought per part and its sawing, in the location's currency; null where a figure is missing (and for the saw, when a lathe parts
   * the piece off, the saw is not costed, or a drop-off technique cuts the part out of the plate).
   */
  materialCost: number | null;
  sawCost: number | null;
  chosen: boolean;
}

/** A plate cutting process beside the quoted one: its nest and what it costs a part (location's currency), or why it is not priced. */
export interface PlateCutOptionCost {
  process: PlateCutProcess;
  chosen: boolean;
  unavailable: string | null;
  machineClass: string | null;
  machineName: string | null;
  partsPerPlate: number | null;
  /** The plate bought per part by the process's own nest, and its cut. */
  materialCost: number | null;
  cutCost: number | null;
}

/** One roughing technique of a plate part, priced beside the quoted one. */
export interface RoughingOptionCost {
  technique: RoughingTechnique;
  label: string;
  chosen: boolean;
  /** Why the technique cannot be used for the part; null when it can. */
  unavailable: string | null;
  partsPerPlate: number | null;
  /** The plate bought per part (location's currency). */
  materialCost: number | null;
  /** The piece the mill removes the bulk from (mm³): the sawn blank, the outline through the plate, or the cut blank. */
  pieceVolumeMm3: number | null;
  /**
   * What separates the part from the plate: the Band Saw, the mill's Perimeter Milling, or a plate cutting process, with the machine
   * (and its HR Rates class) it runs on; the mill's own cut names none, it runs on whichever mill makes the part. `cost` (location's
   * currency) is null where it is not costed here: a saw the part's Process does not cost, and the mill's perimeter cut, which costs its
   * time at the rate of the mill that makes the part (the quote's summary states it for the quoted mill).
   */
  separation: { process: string; machineClass: string | null; machineName: string | null; cost: number | null; timeSec: number | null } | null;
  /** Plate Cutting with Drop-off: every cutting process, each priced or with why it is not. Empty for the other techniques. */
  processes: PlateCutOptionCost[];
}

/** A plate part's roughing techniques, the quoted one and every other beside it. */
export interface PricedRoughing {
  /** The technique the quote prices. */
  technique: RoughingTechnique;
  /** Whether the Cost Guide set it, or it is the data's default (defaultRoughingTechnique). */
  source: 'cost_guide' | 'default';
  defaultTechnique: RoughingTechnique;
  /** Why the technique asked for is not the quoted one, when it is not. */
  fallback: string | null;
  options: RoughingOptionCost[];
  /** The operations the quoted technique adds to the mill's own sequence: the perimeter cut of Perimeter Milling with Drop-off. */
  millOps: OperationLine[];
  /** What the quoted cutting process's engine says of its line. */
  warnings: string[];
}

/** What a plate part's drop-off techniques are priced from, beyond the stock itself. */
export interface RoughingPricing {
  /** The cutter a mill cuts round the outline with (Perimeter Milling with Drop-off). */
  cutter: PerimeterCutter;
  /** Each plate cutting process's price for its cut (plateCutRequests), from the Sheet Metal cutting engines, in the location's currency. */
  cuts: readonly PlateCutPrice[];
}

/** A part's stock priced for one way of cutting its piece off. */
export interface PricedStock {
  cutOff: StockCutOff;
  /** The selection with the stock the quote prices as its chosen: a plate under a drop-off technique is that technique's (stock/plate-roughing.ts roughedOption). */
  selection: StockSelection;
  /** The chosen stock's quote, in USD (the units of HR Rates and the reference data); null when no form holds the part. */
  quote: StockMachiningQuote | null;
  /**
   * The lines the stock puts before the machining, in the location's currency: the Band Saw, or a drop-off technique's plate cutting. None
   * when a bar-fed lathe parts the piece off, the saw is not costed, or the mill itself cuts the part out of the plate.
   */
  lines: ProcessLineCost[];
  /** The stock bought per part, less the scrap credit when it is on, and that credit, in the location's currency. */
  materialCost: number | null;
  scrapCredit: number;
  /** Every form priced beside the chosen one. */
  options: StockOptionCost[];
  /** A plate part's roughing techniques on a mill's route; null for bar stock, and for a route no mill makes. */
  roughing: PricedRoughing | null;
}

const isPlateForm = (o: StockOption) => o.form === 'plate' || o.form === 'billet';

/** Prices the chosen stock of each cut-off, and every other form that holds the part beside it. Pure. */
export function priceStockMachining(input: {
  choice: StockMachiningChoice;
  calculators: Readonly<Record<string, ReferenceCalculatorDef>>;
  /** Whether the band saw is costed (a Stock Machining part's is), and the location's saws to cost it on. */
  sawCosted: boolean;
  saws: readonly SandMachine[];
  material: StockMachiningMaterialInput;
  location: string;
  batchSize: number;
  /** USD -> the location's currency. */
  usdToLocal: number;
  costContext: CostContext;
  /**
   * What a plate part's drop-off techniques are priced from, on a route a mill makes. Absent for any other route (a lathe's): its plate is
   * sawn to a blank, the one technique a lathe has.
   */
  roughing?: RoughingPricing | null;
}): Record<StockCutOff, PricedStock> {
  const { choice, material, usdToLocal } = input;
  const local = (usd: number | null) => (usd == null ? null : usd * usdToLocal);
  const quoteOf = (cutOff: StockCutOff, option: Parameters<typeof buildStockMachiningQuote>[0]['option']) => {
    const priceForm = stockPriceFormOf(option.form);
    return buildStockMachiningQuote({
      ref: choice.ref, stock: choice.stock, calculators: input.calculators, saws: input.saws, part: choice.part, option, cutOff, sawCosted: input.sawCosted,
      material: {
        name: material.name, cutCode: material.cutCode, densityKgM3: material.densityKgM3, scrapCostPercent: material.scrapCostPercent,
        pricePerKgUsd: priceForm ? material.pricePerKgUsd[priceForm] ?? null : null,
        priceSource: `${material.name}: its ${STOCK_FORM_LABEL[priceForm ?? option.form]} price at ${input.location} (Raw Materials)`,
      },
      remnant: choice.remnant, scrapCredit: choice.scrapCredit, batchSize: input.batchSize, costContext: input.costContext, endFaceIds: choice.faces.endFaceIds,
    });
  };
  const sawLines = (quote: StockMachiningQuote) => quote.lines.map((l) => (usdToLocal === 1 ? l : lineToLocal(l, usdToLocal)));

  /** A plate's three roughing techniques, each priced, and the one the quote takes: the Cost Guide's, else the data's default. */
  const roughingOf = (base: StockOption, pricing: RoughingPricing): { quoted: StockOption; quote: StockMachiningQuote; lines: ProcessLineCost[]; roughing: PricedRoughing } => {
    const sizes = choice.stock.preferredSizes[choice.unitSystem];
    const as = (d: DropoffStock) => roughedOption(base, d, choice.stock, sizes);
    const option = (technique: RoughingTechnique, rest: Partial<RoughingOptionCost>): RoughingOptionCost => ({
      technique, label: ROUGHING_TECHNIQUE_LABEL[technique], chosen: false, unavailable: null, partsPerPlate: null, materialCost: null, pieceVolumeMm3: null,
      separation: null, processes: [], ...rest,
    });

    // All Bulk Milling: the plate option as the stock model chose it, sawn to a blank.
    const bulkQuote = quoteOf('saw', base);
    const saw = bulkQuote.lines[0];
    const bulk = option('all_bulk_milling', {
      partsPerPlate: base.stock.partsPerStock, materialCost: local(bulkQuote.material.costUsd), pieceVolumeMm3: base.blank.volumeMm3,
      separation: {
        process: 'Band Saw', machineClass: STOCK_MACHINING_CLASS.saw, machineName: bulkQuote.saw?.machine ?? null,
        cost: saw && !saw.physicsGap ? local(saw.totalCost) : null, timeSec: bulkQuote.saw?.cycleS ?? null,
      },
    });

    // Perimeter Milling with Drop-off: the mill cuts round the outline. Its cut is an operation of the mill's own line.
    const { reference, missing } = roughingReference(choice.ref);
    const noData = reference ? null : `the staged Stock Machining data lacks ${missing.join(', ')}`;
    const cutter = pricing.cutter;
    const cutterMissing = perimeterCutterMissing(cutter, input.calculators);
    const milledStock: DropoffStockResult = !choice.outline ? { unavailable: PLATE_OUTLINE_MISSING }
      : !reference ? { unavailable: noData! }
        : cutterMissing ? { unavailable: cutterMissing }
          : perimeterMilledStock({ option: base, part: choice.part, outline: choice.outline, stock: choice.stock, reference, cutterDiameterMm: cutter.finishing!.toolDiameterMm });
    const perimeterCut = isDropoffStock(milledStock) ? perimeterCutOperation({
      calculators: input.calculators, outlinePerimeterMm: milledStock.piece.perimeterMm, plateThicknessMm: milledStock.piece.thicknessMm,
      finishing: cutter.finishing!, matClass: cutter.matClass, machinabilityFactor: cutter.machinabilityFactor, slotting: cutter.slotting!,
    }) : null;
    const milledQuote = isDropoffStock(milledStock) && !perimeterCut?.missing ? quoteOf('saw', as(milledStock)) : null;
    const milled = isDropoffStock(milledStock) && milledQuote
      ? option('perimeter_milling_dropoff', {
        partsPerPlate: milledStock.nest.partsPerPlate, materialCost: local(milledQuote.material.costUsd), pieceVolumeMm3: milledStock.piece.volumeMm3,
        separation: { process: PERIMETER_MILLING, machineClass: null, machineName: null, cost: null, timeSec: perimeterCut!.timeSec },
      })
      : option('perimeter_milling_dropoff', { unavailable: isDropoffStock(milledStock) ? `the perimeter cut is not timed: ${perimeterCut!.missing}` : milledStock.unavailable });

    // Plate Cutting with Drop-off: each process on its own nest, priced by its Sheet Metal engine; the cheapest part (plate and cut) is quoted.
    const cutStocks = plateCutStocks(choice);
    const cutQuotes = new Map<PlateCutProcess, { stock: DropoffStock; quote: StockMachiningQuote; price: PlateCutPrice }>();
    const processes = PLATE_CUT_PROCESSES.map((process): PlateCutOptionCost => {
      const stock = cutStocks.byProcess[process];
      const price = pricing.cuts.find((c) => c.process === process);
      const none = (unavailable: string): PlateCutOptionCost => ({ process, chosen: false, unavailable, machineClass: null, machineName: null, partsPerPlate: null, materialCost: null, cutCost: null });
      if (!stock) return none(cutStocks.reason ?? 'not priced');
      if (!isDropoffStock(stock)) return none(stock.unavailable);
      if (!price || price.cost == null) return none(price?.unavailable ?? 'no cutting engine priced it');
      const quote = quoteOf('saw', as(stock));
      cutQuotes.set(process, { stock, quote, price });
      return {
        process, chosen: false, unavailable: null, machineClass: price.machineClass, machineName: price.machineName, partsPerPlate: stock.nest.partsPerPlate,
        materialCost: local(quote.material.costUsd), cutCost: price.cost,
      };
    });
    const partCost = (p: PlateCutOptionCost) => (p.materialCost ?? 0) + (p.cutCost ?? 0);
    const cheapest = processes.filter((p) => p.unavailable == null).reduce<PlateCutOptionCost | null>((best, p) => (best == null || partCost(p) < partCost(best) ? p : best), null);
    const cut = cheapest ? cutQuotes.get(cheapest.process)! : null;
    const cutOption = cheapest && cut
      ? option('plate_cutting_dropoff', {
        partsPerPlate: cheapest.partsPerPlate, materialCost: cheapest.materialCost, pieceVolumeMm3: cut.stock.piece.volumeMm3,
        separation: {
          process: cheapest.process, machineClass: cheapest.machineClass, machineName: cheapest.machineName, cost: cheapest.cutCost,
          timeSec: cut.price.lines.reduce((sec, l) => sec + l.cycleTimeMin * 60, 0),
        },
        processes: processes.map((p) => (p === cheapest ? { ...p, chosen: true } : p)),
      })
      : option('plate_cutting_dropoff', {
        unavailable: cutStocks.reason ?? `no plate cutting process can be priced (${processes.map((p) => `${p.process}: ${p.unavailable}`).join('; ')})`,
        processes: cutStocks.reason ? [] : processes,
      });

    // The technique quoted: the Cost Guide's, else the data's default; All Bulk Milling when that one cannot be used, and the quote says why.
    const fromData = roughingTechniqueOf(choice.stock.roughingTechnique);
    const defaultTechnique = fromData ?? 'all_bulk_milling';
    const wanted = choice.settings.roughingTechnique ?? defaultTechnique;
    const source = choice.settings.roughingTechnique ? 'cost_guide' as const : 'default' as const;
    const all = { all_bulk_milling: bulk, perimeter_milling_dropoff: milled, plate_cutting_dropoff: cutOption };
    const technique = all[wanted].unavailable == null ? wanted : 'all_bulk_milling';
    const fallback = technique !== wanted
      ? `${source === 'cost_guide' ? 'The Cost Guide\'s' : 'The data\'s default'} roughing technique, ${ROUGHING_TECHNIQUE_LABEL[wanted]}, is not available: ${all[wanted].unavailable}. `
        + `${ROUGHING_TECHNIQUE_LABEL.all_bulk_milling} is quoted.`
      : !fromData && !choice.settings.roughingTechnique
        ? `The data's defaultRoughingTechnique is not a technique the engine prices: ${ROUGHING_TECHNIQUE_LABEL.all_bulk_milling} is quoted.`
        : null;
    const quotedStock = technique === 'perimeter_milling_dropoff' ? (milledStock as DropoffStock) : technique === 'plate_cutting_dropoff' ? cut!.stock : null;
    const quote = technique === 'perimeter_milling_dropoff' ? milledQuote! : technique === 'plate_cutting_dropoff' ? cut!.quote : bulkQuote;
    return {
      quoted: quotedStock ? as(quotedStock) : base, quote,
      // The Band Saw of a sawn blank; a drop-off's plate cutting line as its engine priced it (already in the location's currency), marked
      // as a step of the stock: it keeps its own process group, and is not the part's first machine.
      lines: technique === 'plate_cutting_dropoff' ? cut!.price.lines.map((l) => ({ ...l, stockStep: true })) : sawLines(quote),
      roughing: {
        technique, source, defaultTechnique, fallback,
        options: ROUGHING_TECHNIQUES.map((t) => ({ ...all[t], chosen: t === technique })),
        millOps: technique === 'perimeter_milling_dropoff' ? [perimeterCut!] : [],
        warnings: technique === 'plate_cutting_dropoff' ? cut!.price.warnings : [],
      },
    };
  };

  const priced = (cutOff: StockCutOff): PricedStock => {
    const selection = choice.selection[cutOff];
    const base = selection.chosen;
    // A sawn piece of plate on a mill's route has the three techniques; a bar, and a plate on a lathe, is sawn (or parted off) as chosen.
    const techniques = cutOff === 'saw' && input.roughing && base && isPlateForm(base) ? roughingOf(base, input.roughing) : null;
    let chosen: StockMachiningQuote | null = techniques?.quote ?? null;
    const options = selection.options.map((o): StockOptionCost => {
      if (!isStockOption(o)) return { form: o.form, sizeLabel: null, unavailable: o.unavailable, materialCost: null, sawCost: null, chosen: false };
      const isChosen = o === base;
      const quote = isChosen && techniques ? techniques.quote : quoteOf(cutOff, o);
      if (isChosen) chosen = quote;
      const saw = quote.lines[0];
      return {
        form: o.form, sizeLabel: isChosen && techniques ? techniques.quoted.sizeLabel : o.sizeLabel, unavailable: null, materialCost: local(quote.material.costUsd),
        sawCost: saw && !saw.physicsGap ? local(saw.totalCost) : null, chosen: isChosen,
      };
    });
    const quote = chosen as StockMachiningQuote | null;
    return {
      cutOff, selection: techniques ? { ...selection, chosen: techniques.quoted } : selection, quote,
      lines: techniques ? techniques.lines : quote ? sawLines(quote) : [],
      materialCost: local(quote?.material.costUsd ?? null), scrapCredit: (quote?.material.creditUsd ?? 0) * usdToLocal, options,
      roughing: techniques?.roughing ?? null,
    };
  };
  return { saw: priced('saw'), parting: priced('parting') };
}

type MaterialRow = Readonly<Record<string, unknown>>;
const finite = (v: unknown): number | null => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const sameName = (a: unknown, b: string) => typeof a === 'string' && a.trim().toLowerCase() === b.trim().toLowerCase();

/** The group's own row of a material (the staged materials lookup: Name, or the Source Name it was taken from), by any of the names it goes by. */
export function stockMaterialRow(rows: readonly MaterialRow[], names: readonly (string | null | undefined)[]): MaterialRow | null {
  const wanted = names.filter((n): n is string => typeof n === 'string' && n.trim() !== '');
  return rows.find((r) => wanted.some((n) => sameName(r['Name'], n) || sameName(r['Source Name'], n))) ?? null;
}

export interface StockMachiningCostRequest {
  client: DbClient;
  accessToken: string;
  location: string;
  choice: StockMachiningChoice;
  /** Whether the band saw is costed: the Stock Machining Process's quote has it, no other machined part's does. */
  sawCosted: boolean;
  /** The material the quote prices: the names it goes by (Raw Materials name and grade), its density and each stock form's price (USD/kg). */
  material: { name: string; grade: string | null; densityKgM3: number | null; pricePerKgUsd: Partial<Record<StockPriceForm, number>> };
  batchSize: number;
  /** USD -> the location's currency. */
  usdToLocal: number;
  costContext: CostContext;
  /**
   * On a route a mill makes: what a plate part's drop-off techniques are priced from. The cutter a mill cuts round the outline with, and
   * the pricing of each plate cutting process's cut by its Sheet Metal engine (asked only for a part whose stock is plate and whose outline
   * is measured). Absent for a lathe's route.
   */
  roughing?: { cutter: PerimeterCutter; priceCuts: (cuts: readonly PlateCutRequest[]) => Promise<PlateCutPrice[]> };
}

export interface StockMachiningCostResult {
  /** The stock priced for each cut-off, in the location's currency; null when it cannot be priced (see `missing`). */
  stock: Readonly<Record<StockCutOff, PricedStock>> | null;
  /** The material's cut code and Scrap Cost Percent as read. */
  material: { cutCode: number | null; scrapCostPercent: number | null } | null;
  missing: string[];
  warnings: string[];
}

/**
 * The stock front end of a machined part: loads the staged memory/Stock Maching reference, chooses the part's stock by its rules
 * (stock/stock-selection.ts) and prices it (stock-machining-route.ts) with the calculators (from the database), in the location's
 * currency; a Stock Machining part's sawing too, on the location's band saws. The machining of the part is the Machining route's.
 */
@Injectable()
export class StockMachiningCostService {
  constructor(
    private readonly database: DatabaseService,
    private readonly machines: SandMachineService,
    private readonly catalog: CalculatorCatalogService,
  ) {}

  private cached: { ref: SandReference; stock: StockReference } | null = null;

  /** The staged memory/Stock Maching variables and lookup tables and the stock rules read from them (read once; a read error is reported and not cached). */
  async reference(): Promise<{ reference: { ref: SandReference; stock: StockReference } | null; missing: string[] }> {
    if (this.cached) return { reference: this.cached, missing: [] };
    const read = await readStagedReference(this.database, STOCK_MACHINING_SOURCE_VERSION, STOCK_MACHINING_PROCESS_GROUP, 1114);
    if (!read.reference) return { reference: null, missing: read.missing };
    const rules = stockReference(read.reference);
    if (!rules.reference) return { reference: null, missing: rules.missing };
    this.cached = { ref: read.reference, stock: rules.reference };
    return { reference: this.cached, missing: [] };
  }

  /** The part's stock for each cut-off, by the staged rules and the Cost Guide's settings. */
  async choose(req: { location: string; part: StockPartInput; overrides: Record<string, unknown> | null | undefined }): Promise<{ choice: StockMachiningChoice | null; missing: string[] }> {
    const { reference, missing } = await this.reference();
    if (!reference) return { choice: null, missing };
    return chooseStockMachining({ ...reference, location: req.location, part: req.part, overrides: req.overrides });
  }

  /**
   * A material's cut code and Scrap Cost Percent. The cut code is Raw Materials' (the rows of its name or grade; preferredCutCode across the
   * groups listing it), else the group's own row of it in the staged materials; the Scrap Cost Percent is that row's.
   */
  async materialFacts(client: DbClient, ref: SandReference, names: readonly (string | null | undefined)[]): Promise<{ cutCode: number | null; scrapCostPercent: number | null }> {
    const own = stockMaterialRow(ref.table(MATERIALS_LOOKUP), names);
    const wanted = [...new Set(names.filter((n): n is string => typeof n === 'string' && n.trim() !== '').map((n) => n.trim()))];
    let cutCode: number | null = null;
    if (wanted.length) {
      const { data, error } = await client.from('raw_materials')
        .select('cut_code, material_group')
        .or(wanted.flatMap((n) => [`name.ilike.${quoteFilterValue(escapeLikePattern(n))}`, `grade.ilike.${quoteFilterValue(escapeLikePattern(n))}`]).join(','))
        .not('cut_code', 'is', null)
        .limit(100);
      if (!error) {
        cutCode = preferredCutCode(((data ?? []) as { cut_code: unknown; material_group: unknown }[]).map((r) => ({
          cutCode: finite(r.cut_code), group: r.material_group == null ? null : String(r.material_group),
        })));
      }
    }
    return { cutCode: cutCode ?? finite(own?.['Cut Code']), scrapCostPercent: finite(own?.['Scrap Cost Percent (%)']) };
  }

  async price(req: StockMachiningCostRequest): Promise<StockMachiningCostResult> {
    const { choice } = req;
    const [calculators, saws, facts] = await Promise.all([
      this.catalog.loadStockMachiningCalculators(req.accessToken),
      // The saws are read only for a quote that costs sawing.
      req.sawCosted ? this.machines.getMachinesByClass(req.client, [STOCK_MACHINING_CLASS.saw], req.location).then((byClass) => byClass[STOCK_MACHINING_CLASS.saw] ?? []) : [],
      this.materialFacts(req.client, choice.ref, [req.material.name, req.material.grade]),
    ]);
    // The calculators the stock itself is priced by (migration 1116). One a later migration adds prices a technique of its own, and its
    // absence makes only that technique unavailable (perimeter-cut.ts).
    const absent = loadStockMachiningCalculatorSpec().calculators.filter((c) => c.migration == null && !(c.name in calculators)).map((c) => c.name);
    if (absent.length) {
      return {
        stock: null, material: facts, warnings: [],
        missing: [`the Stock Machining calculators are not in the database (run migration 1116): ${absent.slice(0, 3).join(', ')}${absent.length > 3 ? ', ...' : ''}`],
      };
    }
    const warnings: string[] = [];
    if (req.sawCosted && saws.length === 0) warnings.push(`HR Rates has no band saws (class ${STOCK_MACHINING_CLASS.saw}) for ${req.location}: the Band Saw is not costed.`);
    const cuts = req.roughing ? plateCutRequests(choice) : [];
    const roughing = req.roughing ? { cutter: req.roughing.cutter, cuts: cuts.length ? await req.roughing.priceCuts(cuts) : [] } : null;
    const stock = priceStockMachining({
      choice, calculators, sawCosted: req.sawCosted, saws, location: req.location, batchSize: req.batchSize, usdToLocal: req.usdToLocal, costContext: req.costContext,
      material: { name: req.material.name, densityKgM3: req.material.densityKgM3, pricePerKgUsd: req.material.pricePerKgUsd, ...facts },
      roughing,
    });
    return { stock, material: facts, missing: [], warnings };
  }
}
