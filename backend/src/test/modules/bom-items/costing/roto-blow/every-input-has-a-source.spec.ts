// Every calculator input on a Roto & Blow Molding line says where its value came from (SourceRef), so the eye beside it opens that source:
// this guard runs both routes on the bottle and the tank of the route tests (plain, and colored with labels and inserts set in the Cost
// Guide) and lists any input with no ref, or a ref that opens nothing (source-ref-guard.ts).
import { loadRotoBlowCalculatorSpec, rotoBlowCalculatorsByName } from '../../../../../modules/bom-items/costing/roto-blow/calculators/roto-blow-calculator-spec';
import { buildRotoBlowRoutes, type RotoBlowPart, type RotoBlowRouteInput } from '../../../../../modules/bom-items/costing/roto-blow/roto-blow-route';
import { runsAsLines, sourceGaps } from '../source-ref-guard';
import { allRotoBlowMachines, realRotoBlowReference, rotoBlowMaterial } from './roto-blow-test-data';

const ZERO = { qairPerHr: 0, inspTimeMin: 0, samplingRate: 0, yieldPct: 1, netMatCost: 0, netWeightKg: 0, scrapPricePerKg: 0 };
const BOTTLE: RotoBlowPart = {
  envelope: { lengthMm: 120, widthMm: 80, depthMm: 80 }, partVolumeMm3: 70000, surfaceAreaMm2: 35000, wallMm: 2, hollow: true, insideVolumeMm3: 435000,
  partingLineMm: 400, perimeterMm: 400,
  spouts: [{ id: 'spout-1', diameterMm: 20, lengthMm: 20 }],
  holes: [{ id: 'hole-1', type: 'SimpleHole', variant: 'through', diameterMm: 6, depthMm: 2 }, { id: 'hole-2', type: 'SimpleHole', variant: 'blind', diameterMm: 8, depthMm: 15 }],
  voids: [{ id: 'void-1', type: 'Void', variant: 'simple', volumeMm3: 4000, depthMm: 40, equivalentDiameterMm: null }],
};
const TANK: RotoBlowPart = {
  envelope: { lengthMm: 300, widthMm: 200, depthMm: 150 }, partVolumeMm3: 2 * (300 * 200 + 300 * 150 + 200 * 150) * 4, surfaceAreaMm2: 270000, wallMm: 4, hollow: true,
  insideVolumeMm3: 292 * 192 * 142, partingLineMm: 1000, perimeterMm: 1000,
  spouts: [{ id: 'spout-1', diameterMm: 50, lengthMm: 4 }], holes: [],
  voids: [{ id: 'void-1', type: 'ComplexHole', variant: 'through', volumeMm3: 14400, depthMm: 4, equivalentDiameterMm: 60 }],
};
const input = (material: string, part: RotoBlowPart, over: Partial<RotoBlowRouteInput['scenario']> = {}): RotoBlowRouteInput => ({
  ref: realRotoBlowReference(), spec: loadRotoBlowCalculatorSpec(), calculators: rotoBlowCalculatorsByName(), material: rotoBlowMaterial(material), part,
  machinesByClass: allRotoBlowMachines(), costContext: ZERO,
  scenario: { batchSize: 1000, route: null, colored: false, labels: null, inserts: 0, ovenTimeS: null, amortizationParts: 100000, ...over },
});
const HDPE = 'Polyethylene, High Density, HDPE';

const CASES: [string, RotoBlowRouteInput][] = [
  ['an HDPE bottle', input(HDPE, BOTTLE)],
  ['a PET bottle', input('PET, Blow Molding', BOTTLE)],
  ['an HDPE tank', input(HDPE, TANK)],
  ['a colored HDPE bottle with labels and inserts set in the Cost Guide', input(HDPE, BOTTLE, { colored: true, labels: 2, inserts: 1 })],
  ['an HDPE tank with its oven time set in the Cost Guide', input(HDPE, TANK, { ovenTimeS: 900, colored: true, labels: 1, inserts: 2 })],
];

describe('every Roto & Blow Molding calculator input says where its value came from', () => {
  it.each(CASES)('%s', (_name, routeInput) => {
    const { routes } = buildRotoBlowRoutes(routeInput);
    expect(routes.length).toBeGreaterThan(0);
    expect(sourceGaps(routes.flatMap((r) => [...r.lines, ...runsAsLines({ material: r.material.run })]))).toEqual({ withoutRef: [], openingNothing: [] });
  });
});
