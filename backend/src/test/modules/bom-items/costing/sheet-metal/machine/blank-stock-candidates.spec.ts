import { billetFallback } from '../../../../../../modules/bom-items/costing/sheet-metal/machine/blank-stock-candidates';
import { resolveStockAllowanceRule, stockAllowancePerSideMm } from '../../../../../../modules/bom-items/costing/machining/stock-allowance';

// The reference stock-allowance rule, built from the real memory/Stock Maching
// variables.csv values (percentStockAllowance 5, minStockAllowance 0.79375,
// maxStockAllowance 3.175) through the same resolver production uses.
const STOCK_RULE = resolveStockAllowanceRule([
  { key: 'percentStockAllowance', value: '5' },
  { key: 'minStockAllowance', value: '0.79375' },
  { key: 'maxStockAllowance', value: '3.175' },
]).rule!;

// The bounding-box billet of a sheet-metal part's "machine from solid billet" alternative. A machined part's stock is the stock model's
// (costing/stock: stock-selection.spec.ts, stock-machining-cost-summary.spec.ts); the picker that once scored stock_profiles candidates
// here, and its specs, went with it (one stock model, user decision 2026-11-22).
describe('billetFallback', () => {
  it('adds the reference per-side stock allowance to every axis', () => {
    // Max cross-section 50 mm -> 5% = 2.5 mm/side (inside 0.79375..3.175).
    const bbox = { length: 100, width: 50, height: 20 };
    const result = billetFallback(bbox, 1, stockAllowancePerSideMm(STOCK_RULE, bbox));
    expect(result.sizeLabel).toBe('105×55×25 billet');
    expect(result.stockAllowancePerSideMm).toBeCloseTo(2.5, 6);
  });

  it('adds no allowance, and records that, when the rule is not staged', () => {
    const result = billetFallback({ length: 100, width: 50, height: 20 }, 1, null);
    expect(result.sizeLabel).toBe('100×50×20 billet');
    expect(result.stockAllowancePerSideMm).toBeNull();
  });

  it('is the part\'s box with the allowance on each side, and states how much of it ends in the part', () => {
    const result = billetFallback({ length: 100, width: 50, height: 20 }, 50_000, 2.5);
    expect(result).toMatchObject({ form: 'billet', billetVolMm3: 105 * 55 * 25 });
    expect(result.utilizationPct).toBeCloseTo((50_000 / (105 * 55 * 25)) * 100, 9);
  });
});
