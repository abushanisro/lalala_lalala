// Every calculator input on a Part Assembly line says where its value came from (SourceRef), so the eye beside it opens that source: this
// guard runs the manual and robotic routes on the welded brackets of the engine tests (fillets ground and brushed, spots, a laser seam, a
// bevelled groove) and lists any input with no ref, or a ref that opens nothing (source-ref-guard.ts).
import { componentOf } from '../../../../../modules/bom-items/costing/assembly/assembly-joints';
import { loadPartAssemblyCalculatorSpec, partAssemblyCalculatorsByName } from '../../../../../modules/bom-items/costing/part-assembly/calculators/part-assembly-calculator-spec';
import { buildPartAssemblyRoutes, type PartAssemblyRouteInput } from '../../../../../modules/bom-items/costing/part-assembly/part-assembly-route';
import { weldTable } from '../../../../../modules/bom-items/costing/part-assembly/part-assembly-welds';
import { sourceGaps } from '../source-ref-guard';
import { allPartAssemblyMachines, realPartAssemblyReference } from './part-assembly-test-data';

const ZERO = { qairPerHr: 0, inspTimeMin: 0, samplingRate: 0, yieldPct: 1, netMatCost: 0, netWeightKg: 0, scrapPricePerKg: 0 };
const BRACKET = (id: string) => componentOf({ id, name: `Bracket ${id}`, quantity: 1, weight: 1.5, maxLength: 300, maxWidth: 80, maxHeight: 3, featureGraph: null });
const COMPONENTS = [BRACKET('a'), BRACKET('b')];
const WELDS = [
  { id: 'f1', process: 'MIG Welding', operation: 'Fillet Welding', feature: 'Edge', count: 2, lengthMm: 300, grind: true, wireBrush: true },
  { id: 's1', process: 'Spot Welding', operation: 'Spot Welding', feature: 'Blank', count: 8 },
  { id: 'l1', process: 'Laser Seam Welding', operation: 'Laser Seam Welding', feature: 'Edge', lengthMm: 200 },
];
const GROOVES = [
  { id: 'g', process: 'MIG Welding', operation: 'V-Groove Welding', feature: 'Edge', count: 1, lengthMm: 500, bevel: true },
  { id: 'j', process: 'MIG Welding', operation: 'J-Groove Welding', feature: 'Edge', count: 1, lengthMm: 100, bevel: true, areaMm2: 60 },
];
const input = (welds: unknown[], thicknessMm: number): PartAssemblyRouteInput => ({
  ref: realPartAssemblyReference(), spec: loadPartAssemblyCalculatorSpec(), calculators: partAssemblyCalculatorsByName(), components: COMPONENTS,
  welds: weldTable(welds).welds, weldment: { massKg: 3 }, thickness: { mm: thicknessMm, source: `the components' sheet thickness, ${thicknessMm} mm` },
  material: { name: 'Steel, Cold Worked, AISI 1020', cutCodeFamily: '1' }, machinesByClass: allPartAssemblyMachines(), batchSize: 25, costContext: ZERO,
});

const CASES: [string, PartAssemblyRouteInput][] = [
  ['fillets ground and brushed, spots and a laser seam', input(WELDS, 3)],
  ['bevelled grooves in 10 mm plate', input(GROOVES, 10)],
];

describe('every Part Assembly calculator input says where its value came from', () => {
  it.each(CASES)('%s', (_name, routeInput) => {
    const { routes } = buildPartAssemblyRoutes(routeInput);
    expect(routes.length).toBeGreaterThan(0);
    expect(sourceGaps(routes.flatMap((r) => r.lines))).toEqual({ withoutRef: [], openingNothing: [] });
  });
});
