import { Injectable } from "@nestjs/common";
import { DatabaseService } from '../../../../../common/database/database.service';
import { type BoundingBox } from './blank-stock-candidates';

import {
  resolveStockAllowanceRule, stockAllowancePerSideMm, STOCK_MACHINING_SOURCE_VERSION, STOCK_ALLOWANCE_VARIABLE_KEYS,
  type StockAllowanceRule,
} from '../../machining/stock-allowance';

/**
 * The reference stock allowance of a billet cut to a part's bounding box: what a sheet-metal part's "machine from solid billet"
 * alternative is sized with (blank-stock-candidates.ts billetFallback). A machined part's stock is not chosen here: it is the stock
 * model's (costing/stock), which reads the same rule with the rest of the stock data.
 */
@Injectable()
export class BlankOptimizerService {
  constructor(private readonly database: DatabaseService) {}

  /** machining_reference_data is global and shared (no user rows): every read of it goes through this one privileged client. */
  private get referenceDb() {
    return this.database.getPrivilegedClient('reference-data: machining_reference_data, global shared');
  }

  private allowanceRule: { rule: StockAllowanceRule | null; missing: string[] } | null = null;

  /**
   * The reference stock-allowance rule (memory/Stock Maching/variables.csv, migration 816), read once per process. A read error is not
   * cached; a genuinely absent rule is.
   */
  private async loadStockAllowanceRule(): Promise<{ rule: StockAllowanceRule | null; missing: string[] }> {
    if (this.allowanceRule) return this.allowanceRule;
    const { data, error } = await this.referenceDb
      .from('machining_reference_data')
      .select('key, value')
      .eq('category', 'variable')
      .eq('source_version', STOCK_MACHINING_SOURCE_VERSION)
      .in('key', [...STOCK_ALLOWANCE_VARIABLE_KEYS]);
    if (error) return { rule: null, missing: [...STOCK_ALLOWANCE_VARIABLE_KEYS] };
    this.allowanceRule = resolveStockAllowanceRule(data ?? []);
    return this.allowanceRule;
  }

  /** Per-side allowance for a billet of this bounding box, or null (with the
   *  missing variables named) when the reference rule is not staged. */
  async stockAllowanceFor(bbox: BoundingBox): Promise<{ allowancePerSideMm: number | null; missing: string[] }> {
    const { rule, missing } = await this.loadStockAllowanceRule();
    if (!rule) return { allowancePerSideMm: null, missing };
    return { allowancePerSideMm: stockAllowancePerSideMm(rule, bbox), missing: [] };
  }
}
