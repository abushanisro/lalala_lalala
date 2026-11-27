import { Injectable } from '@nestjs/common';

import { summariseCosts, type AnalyticsAmount, type CostAnalytics } from './cost-analytics';
import { DatabaseService } from '../../common/database/database.service';
import { ExchangeRateService } from '../../common/exchange-rate/exchange-rate.service';
import { readAllRows } from '../boms/bom-totals';

import type { RollupInputKind } from '../bom-items/services/bom-item-rollup';

const ID_BATCH_SIZE = 200;

/** The five tables a part's own cost is saved in, as the BOM rollup reads them, with the columns the groupings use. */
const SOURCES: readonly { table: string; kind: RollupInputKind; amount: string; extra: string }[] = [
  { table: 'raw_material_cost_records', kind: 'raw_material', amount: 'total_cost',
    extra: ', material_name, gross_usage, net_usage, uom, unit_cost, gross_material_cost, reclaim_value, scrap_adjustment, overhead_cost' },
  { table: 'process_cost_records', kind: 'process', amount: 'total_cost_per_part',
    extra: ', process_group, machine_name, cycle_time, setup_cost_per_part, total_cycle_cost_per_part, scrap_adjustment, machine_rate, labor_rate' },
  { table: 'tooling_cost_records', kind: 'tooling', amount: 'total_cost', extra: '' },
  { table: 'packaging_logistics_cost_records', kind: 'packaging_logistics', amount: 'total_cost', extra: '' },
  { table: 'procured_parts_cost_records', kind: 'procured_parts', amount: 'total_cost', extra: '' },
];

const number = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

// The column lists are built at run time, which the client's column parser cannot type: `as '*'` types the rows as untyped records.
/** Reads an organization's saved cost records and hands them to summariseCosts. It reads only: nothing is recalculated or written. */
@Injectable()
export class CostAnalyticsService {
  constructor(private readonly database: DatabaseService, private readonly exchangeRates: ExchangeRateService) {}

  async summary(organizationId: string, accessToken: string): Promise<CostAnalytics> {
    const client = this.database.getUserClient(accessToken);
    const page = <T>(table: string, columns: string) => readAllRows<T>((from, to) => client.from(table)
      .select(columns as '*', { count: 'exact' }).eq('organization_id', organizationId).order('id').range(from, to));
    const [projects, boms, items, rates] = await Promise.all([
      page<{ id: string; name: string; target_bom_cost: number | string | null; target_bom_cost_currency: string | null }>(
        'projects', 'id, name, target_bom_cost, target_bom_cost_currency'),
      page<{ id: string; name: string; project_id: string | null }>('boms', 'id, name, project_id'),
      page<Record<string, unknown>>('bom_items', 'id, bom_id, name, part_number, annual_volume, weight, scenario_overrides'),
      this.exchangeRates.getSnapshot(accessToken, organizationId),
    ]);

    const amounts: AnalyticsAmount[] = [];
    const itemIds = items.map(item => String(item.id));
    for (const source of SOURCES) {
      for (let start = 0; start < itemIds.length; start += ID_BATCH_SIZE) {
        const rows = await readAllRows<Record<string, unknown>>((from, to) => client.from(source.table)
          .select(`id, bom_item_id, ${source.amount}, currency, cost_currency_basis, created_at${source.extra}` as '*', { count: 'exact' })
          .in('bom_item_id', itemIds.slice(start, start + ID_BATCH_SIZE)).eq('is_active', true).order('id').range(from, to));
        for (const row of rows) {
          const inKg = text(row.uom)?.toUpperCase() === 'KG';
          amounts.push({
            itemId: String(row.bom_item_id), ref: String(row.id), kind: source.kind, amount: number(row[source.amount]) ?? 0,
            currency: text(row.currency), basis: (text(row.cost_currency_basis) as AnalyticsAmount['basis']) ?? null,
            createdAt: text(row.created_at), processGroup: text(row.process_group), machine: text(row.machine_name),
            cycleTimeS: number(row.cycle_time), material: text(row.material_name),
            grossKg: inKg ? number(row.gross_usage) : null, netKg: inKg ? number(row.net_usage) : null,
            setupCost: number(row.setup_cost_per_part), cycleCost: number(row.total_cycle_cost_per_part), scrapCost: number(row.scrap_adjustment),
            machineRate: number(row.machine_rate), labourRate: number(row.labor_rate),
            unitPrice: number(row.unit_cost), grossUsage: number(row.gross_usage), netUsage: number(row.net_usage),
            grossCost: number(row.gross_material_cost), reclaimValue: number(row.reclaim_value), overheadCost: number(row.overhead_cost),
          });
        }
      }
    }

    const projectName = new Map(projects.map(p => [p.id, p.name]));
    return summariseCosts({
      items: items.map(item => ({
        id: String(item.id), bomId: String(item.bom_id), name: text(item.name) ?? '', partNumber: text(item.part_number),
        annualVolume: number(item.annual_volume), weightKg: number(item.weight),
        scenarioOverrides: (item.scenario_overrides as Record<string, unknown> | null) ?? null,
      })),
      boms: boms.map(b => ({ id: b.id, name: b.name, projectId: b.project_id, projectName: b.project_id ? projectName.get(b.project_id) ?? null : null })),
      amounts,
      rate: (from, to) => rates.convertOptional(from, to),
      targetCurrencies: projects.filter(p => (number(p.target_bom_cost) ?? 0) > 0).map(p => p.target_bom_cost_currency),
    });
  }
}
