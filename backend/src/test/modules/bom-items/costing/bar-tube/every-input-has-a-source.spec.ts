// Every calculator input on a Bar and Tube line says where its value came from (SourceRef), so the eye beside it opens that source: this
// guard runs every route on the parts of the route tests (a bent, holed, notched and flared tube; a bent flat bar; a part cut from plate;
// an extruded profile) and lists any input with no ref, or a ref that opens nothing (source-ref-guard.ts).
import { buildBarTubeRoutes, type BarTubePart, type BarTubeRouteInput } from '../../../../../modules/bom-items/costing/bar-tube/bar-tube-route';
import { barTubeCalculatorsByName, loadBarTubeCalculatorSpec } from '../../../../../modules/bom-items/costing/bar-tube/calculators/bar-tube-calculator-spec';
import { runsAsLines, sourceGaps } from '../source-ref-guard';
import { allBarTubeMachines, barTubeMaterial, realBarTubeReference } from './bar-tube-test-data';

const ZERO = { qairPerHr: 0, inspTimeMin: 0, samplingRate: 0, yieldPct: 1, netMatCost: 0, netWeightKg: 0, scrapPricePerKg: 0 };
const A36 = 'Steel, Hot Worked, ASTM A36';
const AREA = (Math.PI / 4) * (25 ** 2 - 22 ** 2);
const TUBE: BarTubePart = {
  stockForm: 'ROUND_TUBE',
  section: { areaMm2: AREA, widthMm: 25, heightMm: 25, outerPerimeterMm: Math.PI * 25, odMm: 25, wallMm: 1.5, circumscribingDiameterMm: 25 },
  developedLengthMm: 1000, bends: [], holes: [], complexHoles: [], cutouts: [],
  ends: [{ end: 'start', variant: 'square', cutAngleDeg: 0, cutPerimeterMm: Math.PI * 25 }, { end: 'end', variant: 'square', cutAngleDeg: 0, cutPerimeterMm: Math.PI * 25 }],
  forms: [],
};
const WORKED: BarTubePart = {
  ...TUBE,
  bends: [{ clrMm: 50, angleDeg: 90 }, { clrMm: 50, angleDeg: 45, clockAngleDeg: 90 }],
  holes: [{ featureType: 'SimpleHole', diameterMm: 6, stationMm: 100 }, { featureType: 'SimpleHole', diameterMm: 6, stationMm: 900 }],
  complexHoles: [{ perimeterMm: 60, stationMm: 500 }], cutouts: [{ perimeterMm: 80, stationMm: 300 }],
  ends: [{ end: 'start', variant: 'angled', cutAngleDeg: 30, cutPerimeterMm: 90 }, { ...TUBE.ends[1], variant: 'notch' }],
  forms: [{ end: 'end', variant: 'flare' }],
};
const FLAT: BarTubePart = {
  ...TUBE, stockForm: 'RECTANGULAR_BAR', bends: [{ clrMm: 12, angleDeg: 90 }],
  section: { areaMm2: 300, widthMm: 50, heightMm: 6, outerPerimeterMm: 112, odMm: null, wallMm: null, circumscribingDiameterMm: null },
};
const PLATE: BarTubePart = {
  ...TUBE, stockForm: 'PLATE', developedLengthMm: 200, ends: [],
  section: { areaMm2: 600, widthMm: 100, heightMm: 6, outerPerimeterMm: 212, odMm: null, wallMm: 6, circumscribingDiameterMm: null },
  plate: { thicknessMm: 6, cutLengthMm: 700, pierces: 3, blankLengthMm: 200, blankWidthMm: 100, faceAreaMm2: 18000 },
};
const PROFILE: BarTubePart = {
  ...TUBE, stockForm: 'GENERIC_EXTRUSION', developedLengthMm: 500,
  section: { areaMm2: 200, widthMm: 30, heightMm: 20, outerPerimeterMm: 120, odMm: null, wallMm: 2, circumscribingDiameterMm: 36 },
};
const input = (part: BarTubePart, material = barTubeMaterial(A36, part.stockForm)): BarTubeRouteInput => ({
  ref: realBarTubeReference(), spec: loadBarTubeCalculatorSpec(), calculators: barTubeCalculatorsByName(), material,
  part, machinesByClass: allBarTubeMachines(), scenario: { batchSize: 100, route: null }, costContext: ZERO,
});

const CASES: [string, BarTubeRouteInput][] = [
  ['a plain round tube', input(TUBE)],
  ['a bent, holed, notched and flared round tube', input(WORKED)],
  ['a bent flat bar', input(FLAT)],
  ['a part cut from plate', input(PLATE)],
  ['an extruded profile', input(PROFILE, barTubeMaterial('Aluminum, ANSI 6061', 'GENERIC_EXTRUSION', 6.618))],
];

describe('every Bar and Tube calculator input says where its value came from', () => {
  it.each(CASES)('%s', (_name, routeInput) => {
    const { routes } = buildBarTubeRoutes(routeInput);
    expect(routes.length).toBeGreaterThan(0);
    expect(sourceGaps(routes.flatMap((r) => [...r.lines, ...runsAsLines({ stock: r.material.run })]))).toEqual({ withoutRef: [], openingNothing: [] });
  });
});
