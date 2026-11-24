import { machiningLookupSeeds } from '../../../../../../modules/bom-items/costing/machining/calculators/machining-lookup-seeds';
import { loadMachiningCalculatorSpec } from '../../../../../../modules/bom-items/costing/machining/calculators/machining-calculator-spec';
import { isWorkbookField } from '../../../../../../modules/bom-items/costing/machining/calculators/machining-lookup-seeds';
import { realKeywayBroachReference, realPartoffTable } from '../real-reference-tables';
import { workbookFixture } from '../workbook-fixture';

// The lookup inputs of a machining calculator come from ONE resolver, shared
// by the cost engine and the Edit Process Cost dialog endpoint. These run it
// against the real reference tables (parsed from memory/machining CSVs).

const spec = loadMachiningCalculatorSpec();
/** The lookups an operation's own resolver fills: every lookup but the machining workbook's (specLookupSeeds reads those). */
const lookupFieldsOf = (operation: string): Set<string> => {
  const calc = spec.calculators.find((c) => c.operation === operation)!;
  return new Set(calc.fields.filter((f) => f.source === 'lookup' && !isWorkbookField(f)).map((f) => f.name));
};

describe('machiningLookupSeeds', () => {
  const ctx = { matClass: 'aluminum' as const, workbook: workbookFixture(), partoffTable: realPartoffTable() };

  it('Drilling, Reaming and Tapping read only the machining workbook\'s tables: no resolver of their own (specLookupSeeds fills them)', () => {
    for (const op of ['Drilling', 'Reaming', 'Tapping']) {
      expect(machiningLookupSeeds(op, ctx, { 'Hole Diameter': 6 })).toBeNull();
      expect(lookupFieldsOf(op).size).toBe(0);
    }
  });

  it('fills Parting from the real part-off insert that reaches the bar radius', () => {
    const r = machiningLookupSeeds('Parting', ctx, { 'Bar Diameter': 20 })!;
    expect(r.missing).toEqual([]);
    expect(Object.keys(r.seeds).sort()).toEqual([...lookupFieldsOf('Parting')].sort());
    expect(r.seeds['Feed']!.match?.table).toBe('tblVirtualPartoffInsertCutData');
  });

  it('reports the table, not a value, when its data is not available', () => {
    // (The turning and hole-making calculators read only the workbook's tables: specLookupSeeds names their gaps, spec-lookup-seeds.spec.ts.)
    for (const op of ['Keyway Broaching', 'Wire EDM', 'Deburring', 'Secondary Setup (Rechuck)']) {
      const r = machiningLookupSeeds(op, { matClass: 'aluminum' }, { 'Hole Diameter': 6 })!;
      expect(r.missing.length).toBeGreaterThan(0);
    }
  });

  it('only ever produces lookup inputs the calculator actually has', () => {
    const full = {
      ...ctx,
      turningParams: { roughCutDepthMm: 2, roughCuttingSpeedMPerMin: 300, roughFeedMmPerRev: 0.3, finishCutDepthMm: 0.5, finishCuttingSpeedMPerMin: 400, finishFeedMmPerRev: 0.1, dataFound: true },
      grindingParams: { workSpeedMMin: 20, roughInfeedMm: 0.02, finishInfeedMm: 0.005, roughAxialFeedRevMm: 10, finishAxialFeedRevMm: 5, dataFound: true },
      keywayBroach: realKeywayBroachReference(),
      workbook: workbookFixture(),
      wireEdmParams: { roughFeedRateMmPerMin: 3, finishFeedRateMmPerMin: 6, dataFound: true },
      deburrParams: { linearSpeedMmPerSec: 20, dataFound: true },
      workholderTable: [{ Name: '3 Jaw Chuck', 'Install And Remove Time (min)': 10 }],
    };
    for (const calc of spec.calculators) {
      const r = machiningLookupSeeds(calc.operation, full, { 'Hole Diameter': 6, 'Bar Diameter': 20, 'Thread Pitch': 1, 'Keyway Width': 6, 'Keyway Length': 40 });
      if (!r) continue;
      const allowed = lookupFieldsOf(calc.operation);
      for (const field of Object.keys(r.seeds)) expect({ op: calc.operation, field, ok: allowed.has(field) }).toEqual({ op: calc.operation, field, ok: true });
    }
  });
});
