// Every calculator input on a composites line says where its value came from (SourceRef), so the eye beside it opens that source: this
// guard runs every route on the laminates of the route tests (a plate, a ply drop-off, a sandwich) and lists any input with no ref, or a
// ref that opens nothing (source-ref-guard.ts).
import { compositesCalculatorsByName, loadCompositesCalculatorSpec } from '../../../../../modules/bom-items/costing/composites/calculators/composites-calculator-spec';
import { buildCompositesRoutes, type CompositePart, type CompositesRouteInput } from '../../../../../modules/bom-items/costing/composites/composites-route';
import { runsAsLines, sourceGaps } from '../source-ref-guard';
import { allCompositesMachines, compositeMaterial, realCompositesReference } from './composites-test-data';

const ZERO = { qairPerHr: 0, inspTimeMin: 0, samplingRate: 0, yieldPct: 1, netMatCost: 0, netWeightKg: 0, scrapPricePerKg: 0 };
const PLATE: CompositePart = {
  toolAreaMm2: 60000, bagAreaMm2: 60000, levels: [{ thicknessMm: 3, regionAreaMm2: 60000, regionPerimeterMm: 1000, faceIds: [5] }],
  outerAreaMm2: 60000, trimLengthMm: 1000, openingsAreaMm2: 0, footprintMm: [300, 200], heightMm: 3, curvaturePerM: 0, holeCount: 0,
};
const DROP: CompositePart = {
  ...PLATE, holeCount: 4, openingsAreaMm2: 800,
  levels: [{ thicknessMm: 2, regionAreaMm2: 60000, regionPerimeterMm: 1000, faceIds: [5] }, { thicknessMm: 3, regionAreaMm2: 10000, regionPerimeterMm: 400, faceIds: [7] }],
};
const SANDWICH: CompositePart = {
  ...PLATE, heightMm: 17, curvaturePerM: 2,
  levels: [{ thicknessMm: 2, regionAreaMm2: 60000, regionPerimeterMm: 1000, faceIds: [5] }, { thicknessMm: 17, regionAreaMm2: 15000, regionPerimeterMm: 500, faceIds: [7] }],
};
const input = (part: CompositePart, batchSize: number): CompositesRouteInput => ({
  ref: realCompositesReference(), spec: loadCompositesCalculatorSpec(), calculators: compositesCalculatorsByName(),
  material: compositeMaterial('Generic Ply Material'), coreMaterial: compositeMaterial('Generic Core Material'),
  part, machinesByClass: allCompositesMachines(), scenario: { batchSize, route: null }, costContext: ZERO,
});

const CASES: [string, CompositesRouteInput][] = [
  ['a plate, a batch of 10', input(PLATE, 10)],
  ['a ply drop-off with holes, a batch of 500', input(DROP, 500)],
  ['a curved sandwich, a batch of 10', input(SANDWICH, 10)],
];

describe('every composites calculator input says where its value came from', () => {
  it.each(CASES)('%s', (_name, routeInput) => {
    const { routes } = buildCompositesRoutes(routeInput);
    expect(routes.length).toBeGreaterThan(0);
    expect(sourceGaps(routes.flatMap((r) => [...r.lines, ...runsAsLines(r.material.runs)]))).toEqual({ withoutRef: [], openingNothing: [] });
  });
});
