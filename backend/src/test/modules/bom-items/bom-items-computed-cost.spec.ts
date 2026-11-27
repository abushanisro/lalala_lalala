import { BOMItemsService } from '../../../modules/bom-items/bom-items.service';
import type { DatabaseService } from '../../../common/database/database.service';
import type { MaterialResolutionService } from '../../../modules/bom-items/services/material-resolution.service';

type Rows = Record<string, unknown>[];

/** A PostgREST client that answers bom_items with `items` and bom_item_costs with `costs` (or an error). */
function service(items: Rows, costs: Rows | { error: string }) {
  const answer = (table: string) => {
    const result = table === 'bom_items'
      ? { data: items, error: null, count: items.length }
      : 'error' in costs ? { data: null, error: { message: costs.error } } : { data: costs, error: null };
    const chain: Record<string, unknown> = { then: (resolve: (r: unknown) => unknown) => resolve(result) };
    for (const method of ['select', 'order', 'eq', 'or', 'range', 'in']) chain[method] = () => chain;
    return chain;
  };
  const db = { getUserClient: () => ({ from: answer }) } as unknown as DatabaseService;
  return new BOMItemsService(db, {} as MaterialResolutionService);
}

const row = (id: string, unitCost: number) => ({ id, bom_id: 'b1', name: id, part_number: id, item_type: 'child_part', quantity: 1, annual_volume: 10000, unit_cost: unitCost });

describe('BOMItemsService.findAll computedCost', () => {
  it("carries each item's snapshot cost beside its own unit cost, which stays the bought price", async () => {
    const list = await service([row('asm', 0), row('part', 0), row('bought', 5)], [
      { bom_item_id: 'asm', total_cost: '2620.53', currency_code: 'USD' },
      { bom_item_id: 'part', total_cost: '145.12', currency_code: 'INR' },
    ]).findAll('b1');
    expect(list.items.map((i) => [i.partNumber, i.unitCost, i.computedCost, i.computedCostCurrency])).toEqual([
      ['asm', 0, 2620.53, 'USD'],
      ['part', 0, 145.12, 'INR'],
      ['bought', 5, undefined, undefined],
    ]);
  });

  it('still lists the items when the costs cannot be read', async () => {
    const list = await service([row('part', 0)], { error: 'permission denied' }).findAll('b1');
    expect(list.items).toHaveLength(1);
    expect(list.items[0]!.computedCost).toBeUndefined();
  });
});
