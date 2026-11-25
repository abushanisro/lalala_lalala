// Every calculator input on a Multi-Spindle Machining line says where its value came from (SourceRef), so the eye beside it opens that
// source: this guard runs the 6-spindle, 8-spindle and twin-spindle routes on the Ø14 x 32 part of the route tests (its turning split along
// the stations, a deep hole split) and lists any input with no ref, or a ref that opens nothing (source-ref-guard.ts).
import { multiSpindleMachinesFromMemory, splitRulesFromMemory, stockReferenceFromMemory } from './multi-spindle-fixtures';
import { loadMultiSpindleCalculatorSpec, multiSpindleCalculatorsByName } from '../../../../../modules/bom-items/costing/multi-spindle/calculators/multi-spindle-calculator-spec';
import { barStock } from '../../../../../modules/bom-items/costing/multi-spindle/multi-spindle-quote';
import { buildMultiSpindleRoutes, type MultiSpindleWork } from '../../../../../modules/bom-items/costing/multi-spindle/multi-spindle-route';
import { multiSpindleStockReference, selectBar } from '../../../../../modules/bom-items/costing/multi-spindle/multi-spindle-stock';
import { runsAsLines, sourceGaps } from '../source-ref-guard';

const ZERO_CONTEXT = { qairPerHr: 0, inspTimeMin: 0, samplingRate: 0, yieldPct: 1, netMatCost: 0, netWeightKg: 0, scrapPricePerKg: 0 };
const WORK: MultiSpindleWork = {
  ops: [
    { name: 'Rough Turning', seconds: 30, slide: 'od', splitBy: { feature: 'Ring', operation: 'Rough Turning', ratio: 0.9, what: 'ring removed volume / total removed volume' } },
    { name: 'Finish Turning', seconds: 12, slide: 'od' },
    { name: 'Parting', seconds: 6, slide: 'od', parting: true },
    { name: 'Drilling Ø6 mm x 1', seconds: 15, slide: 'end', splitBy: { feature: 'SimpleHole', operation: 'Drilling', ratio: 30 / 32, what: 'hole length 30 mm / part length 32 mm' } },
  ],
  barCircumscribedMm: 15.875,
  lengthPerPartMm: 35.29375,
};

describe('every Multi-Spindle Machining calculator input says where its value came from', () => {
  it('the 6-spindle, 8-spindle and twin-spindle routes', () => {
    const routes = buildMultiSpindleRoutes({
      ref: stockReferenceFromMemory(), spec: loadMultiSpindleCalculatorSpec(), calculators: multiSpindleCalculatorsByName(),
      machines: multiSpindleMachinesFromMemory(), workFor: () => WORK, rules: splitRulesFromMemory(), batchSize: 1000, costContext: ZERO_CONTEXT,
    });
    expect(routes.length).toBe(3);
    expect(sourceGaps(routes.map((r) => r.line))).toEqual({ withoutRef: [], openingNothing: [] });
  });

  it('the bar stock run (the cost summary\'s calculatorRuns): a Ø14 x 32 steel part on US and metric bar', () => {
    const runs = (['US', 'metric'] as const).map((system) => {
      const bar = selectBar({ outsideMm: 14, form: 'round', lengthMm: 32 }, multiSpindleStockReference(stockReferenceFromMemory()).reference!, system);
      if ('missing' in bar) throw new Error(bar.missing);
      const { run } = barStock({
        ref: stockReferenceFromMemory(), spec: loadMultiSpindleCalculatorSpec(), calculators: multiSpindleCalculatorsByName(), bar,
        part: { lengthMm: 32, volumeMm3: (Math.PI / 4) * 14 ** 2 * 32 },
        material: { id: 'm1', name: 'AISI 1006', densityKgM3: 7850, pricePerKgUsd: 1.473, priceSource: 'AISI 1006: its round bar price at USA (Raw Materials)' },
      });
      expect(run).not.toBeNull();
      return run;
    });
    expect(sourceGaps(runsAsLines({ 'bar stock US': runs[0], 'bar stock metric': runs[1] }))).toEqual({ withoutRef: [], openingNothing: [] });
  });
});
