// The cut of Plate Cutting with Drop-off (stock/plate-roughing.ts): what each plate cutting process is asked to cut for one part, and what
// it costs. The cut is priced by the Sheet Metal cutting engines, lookups and machines of the process (the costing service's
// plateCutPrices: one cutting model for a sheet part's blank and a plate part's); nothing is priced here. Pure.
import { PLATE_OUTLINE_MISSING } from '../stock/plate-outline';
import { isDropoffStock, PLATE_CUT_PROCESSES, plateCutStock, roughingReference, type DropoffStockResult, type PlateCutProcess } from '../stock/plate-roughing';

import type { StockMachiningChoice } from './stock-machining-cost.service';
import type { ProcessLineCost } from '../../dto/cost-breakdown.dto';

/** One part's cut by a process: what a cutting engine is given. */
export interface PlateCutRequest {
  process: PlateCutProcess;
  /** The plate's thickness (the stock's, not the part's). */
  thicknessMm: number;
  /** The grown outline plus the process's lead-in and lead-out. */
  cutLengthMm: number;
  pierceCount: number;
  /** The rectangle round the cut blank: what the machine's bed must take. */
  blank: { lengthMm: number; widthMm: number };
}

/** A process's cut as its Sheet Metal engine priced it, in the location's currency; or why it cannot be priced. */
export interface PlateCutPrice {
  process: PlateCutProcess;
  /** The cutting line with its own process, machine, time, rate and calculation (and a waterjet's consumables as their own lines). */
  lines: ProcessLineCost[];
  /** The lines' total; null when the process cannot be priced. */
  cost: number | null;
  /** The machine that cuts it and its HR Rates class (a laser is fiber_laser or co2_laser); null when the process is not priced. */
  machineClass: string | null;
  machineName: string | null;
  /** Why the process is not priced for this plate (no machine, no feed data for the material or the thickness); null when it is. */
  unavailable: string | null;
  /** What the cutting engine says of its line. */
  warnings: string[];
}

/** A plate part's stock under Plate Cutting with Drop-off, process by process; `reason` when the technique has no cut at all (no outline, no data). */
export function plateCutStocks(choice: StockMachiningChoice): { byProcess: Partial<Record<PlateCutProcess, DropoffStockResult>>; reason: string | null } {
  const option = choice.selection.saw.chosen;
  if (!option || (option.form !== 'plate' && option.form !== 'billet')) return { byProcess: {}, reason: 'the stock is not plate' };
  if (!choice.outline) return { byProcess: {}, reason: PLATE_OUTLINE_MISSING };
  const { reference, missing } = roughingReference(choice.ref);
  if (!reference) return { byProcess: {}, reason: `the staged Stock Machining data lacks ${missing.join(', ')}` };
  return {
    byProcess: Object.fromEntries(PLATE_CUT_PROCESSES.map((process) => [
      process, plateCutStock({ option, part: choice.part, outline: choice.outline!, stock: choice.stock, reference, process }),
    ])),
    reason: null,
  };
}

/** The cuts to price: one for each process that can nest and cut the part's blank. None for bar stock, or a part with no outline. */
export function plateCutRequests(choice: StockMachiningChoice): PlateCutRequest[] {
  const thicknessMm = choice.selection.saw.chosen?.aMm ?? 0;
  return Object.values(plateCutStocks(choice).byProcess).filter(isDropoffStock).map((d) => ({
    process: d.process!, thicknessMm, cutLengthMm: d.cut.lengthMm, pierceCount: d.cut.pierces, blank: d.piece.rect,
  }));
}
