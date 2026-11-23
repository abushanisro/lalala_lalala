import { Injectable } from '@nestjs/common';

import { loadStockMachiningCalculatorSpec } from './calculators/stock-machining-calculator-spec';
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
  resolveScenarioStockAllowanceMm, resolveScenarioStockForm, resolveScenarioStockRemnantMm, resolveScenarioStockScrapCredit, resolveScenarioStockSnap,
} from '../shared/physics/scenario-overrides';
import { stockPartOf, type StockFaces, type StockPartInput } from '../stock/stock-part';
import { stockReference, type StockReference } from '../stock/stock-reference';
import { BAR_END_REMNANT_MM, BAR_END_REMNANT_SOURCE } from '../stock/stock-research';
import { isStockOption, selectStock, STOCK_FORM_LABEL, type StockForm, type StockPart, type StockSelection } from '../stock/stock-selection';
import { unitSystemFor, type UnitSystem } from '../stock/stock-sizing';

import type { DbClient } from '../../../../common/db/postgrest-client';
import type { ProcessLineCost } from '../../dto/cost-breakdown.dto';
import type { CostContext } from '../casting/casting-finishing';
import type { SandMachine } from '../casting/sand/sand-machines';
import type { SandReference } from '../casting/sand/sand-reference';
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
}

export function stockMachiningSettings(overrides: Record<string, unknown> | null | undefined): StockMachiningSettings {
  return {
    form: resolveScenarioStockForm(overrides),
    allowanceMm: resolveScenarioStockAllowanceMm(overrides),
    snap: resolveScenarioStockSnap(overrides),
    remnantMm: resolveScenarioStockRemnantMm(overrides),
    scrapCredit: resolveScenarioStockScrapCredit(overrides),
  };
}

/** The stock chosen for a machined part, for each way its piece is cut off. It rests on the part and the reference data alone: no material, no machine. */
export interface StockMachiningChoice {
  ref: SandReference;
  stock: StockReference;
  part: StockPart;
  faces: StockFaces;
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
      ref: input.ref, stock: input.stock, part, faces, unitSystem, remnant, scrapCredit: settings.scrapCredit ?? input.stock.scrapCredit, settings,
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
   * the piece off or the saw is not costed).
   */
  materialCost: number | null;
  sawCost: number | null;
  chosen: boolean;
}

/** A part's stock priced for one way of cutting its piece off. */
export interface PricedStock {
  cutOff: StockCutOff;
  selection: StockSelection;
  /** The chosen stock's quote, in USD (the units of HR Rates and the reference data); null when no form holds the part. */
  quote: StockMachiningQuote | null;
  /** The Band Saw line in the location's currency; none when a bar-fed lathe parts the piece off, or the saw is not costed. */
  lines: ProcessLineCost[];
  /** The stock bought per part, less the scrap credit when it is on, and that credit, in the location's currency. */
  materialCost: number | null;
  scrapCredit: number;
  /** Every form priced beside the chosen one. */
  options: StockOptionCost[];
}

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
  const priced = (cutOff: StockCutOff): PricedStock => {
    const selection = choice.selection[cutOff];
    let chosen: StockMachiningQuote | null = null;
    const options = selection.options.map((o): StockOptionCost => {
      if (!isStockOption(o)) return { form: o.form, sizeLabel: null, unavailable: o.unavailable, materialCost: null, sawCost: null, chosen: false };
      const quote = quoteOf(cutOff, o);
      const isChosen = o === selection.chosen;
      if (isChosen) chosen = quote;
      const saw = quote.lines[0];
      return {
        form: o.form, sizeLabel: o.sizeLabel, unavailable: null, materialCost: local(quote.material.costUsd),
        sawCost: saw && !saw.physicsGap ? local(saw.totalCost) : null, chosen: isChosen,
      };
    });
    const quote = chosen as StockMachiningQuote | null;
    return {
      cutOff, selection, quote,
      lines: (quote?.lines ?? []).map((l) => (usdToLocal === 1 ? l : lineToLocal(l, usdToLocal))),
      materialCost: local(quote?.material.costUsd ?? null), scrapCredit: (quote?.material.creditUsd ?? 0) * usdToLocal, options,
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
    const absent = loadStockMachiningCalculatorSpec().calculators.filter((c) => !(c.name in calculators)).map((c) => c.name);
    if (absent.length) {
      return {
        stock: null, material: facts, warnings: [],
        missing: [`the Stock Machining calculators are not in the database (run migration 1116): ${absent.slice(0, 3).join(', ')}${absent.length > 3 ? ', ...' : ''}`],
      };
    }
    const warnings: string[] = [];
    if (req.sawCosted && saws.length === 0) warnings.push(`HR Rates has no band saws (class ${STOCK_MACHINING_CLASS.saw}) for ${req.location}: the Band Saw is not costed.`);
    const stock = priceStockMachining({
      choice, calculators, sawCosted: req.sawCosted, saws, location: req.location, batchSize: req.batchSize, usdToLocal: req.usdToLocal, costContext: req.costContext,
      material: { name: req.material.name, densityKgM3: req.material.densityKgM3, pricePerKgUsd: req.material.pricePerKgUsd, ...facts },
    });
    return { stock, material: facts, missing: [], warnings };
  }
}
