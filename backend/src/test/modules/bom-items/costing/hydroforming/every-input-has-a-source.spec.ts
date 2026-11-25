// Every input of every hydroforming line says where its value came from (SourceRef), so the calculator dialog's eye beside it opens that
// source: the hydroforming variable or lookup row, the press or material record, the CAD measurement, the calculation that derived it (the
// blank, the draws, the parts on a tray), the part's costing inputs or the Cost Guide setting. This guard runs both routes on the real
// memory/Sheetmetal Hydroforming data and lists any input with no ref, or a ref that opens nothing.
import { allHydroformingMachines, MILD_STEEL, realHydroformingCatalog, realHydroformingReference, realToolShop } from './hydroforming-test-data';
import { hydroformingCalculatorsByName, loadHydroformingCalculatorSpec } from '../../../../../modules/bom-items/costing/hydroforming/calculators/hydroforming-calculator-spec';
import type { HydroformPart } from '../../../../../modules/bom-items/costing/hydroforming/hydroforming-part';
import { buildHydroformingRoutes, type HydroformingNest, type HydroformingRouteInput } from '../../../../../modules/bom-items/costing/hydroforming/hydroforming-route';
import { sourceGaps } from '../source-ref-guard';
import type { CalculationTraceStep } from '../../../../../modules/bom-items/dto/cost-breakdown.dto';

/**
 * Every calculator run a route holds besides its lines' (what the cost summary shows as calculatorRuns, with the eye beside each input), as a
 * line named by where it sits, so its inputs are checked the same way. The tools' runs are not among them: the summary lists the tools
 * without their runs.
 */
function runsOf(route: object): Array<{ process: string; calculationTrace: CalculationTraceStep[] }> {
  const out: Array<{ process: string; calculationTrace: CalculationTraceStep[] }> = [];
  const seen = new Set<object>();
  const walk = (v: unknown, path: string): void => {
    if (!v || typeof v !== 'object' || seen.has(v)) return;
    seen.add(v);
    const o = v as Record<string, unknown>;
    if (Array.isArray(o.trace) && 'calculatorId' in o) out.push({ process: `run ${path}`, calculationTrace: o.trace as CalculationTraceStep[] });
    for (const [k, x] of Object.entries(o)) if (k !== 'lines' && k !== 'trace' && k !== 'tooling') walk(x, path ? `${path}.${k}` : k);
  };
  walk(route, '');
  return out;
}


const ZERO = { qairPerHr: 0, inspTimeMin: 0, samplingRate: 0, yieldPct: 1, netMatCost: 0, netWeightKg: 0, scrapPricePerKg: 0 };
const NEST: HydroformingNest = { grossKgPerPart: 0.2, partsPerSheet: 50, utilizationPct: 70, sheetLengthMm: 2438.4, sheetWidthMm: 1219.2, method: 'true_shape', note: null };

// A cup drawn 60 mm deep with an 80 mm opening, 1 mm sheet.
const CUP_AREA = (Math.PI / 4) * 80 ** 2 + Math.PI * 80 * 60;
const CUP_D0 = Math.sqrt((4 * CUP_AREA) / Math.PI);
const CUP: HydroformPart = {
  depthMm: 60, planLengthMm: 80, planWidthMm: 80, minWidthMm: 80, projectedAreaMm2: (Math.PI / 4) * 80 ** 2, developedAreaMm2: CUP_AREA,
  mainSurface: { areaMm2: 0, perimeterMm: 0 },
  drawn: { depthMm: 60, openingWidthMm: 80, formProjectedAreaMm2: (Math.PI / 4) * 80 ** 2, formDevelopedAreaMm2: CUP_AREA },
  blank: {
    method: 'drawn_equal_area', areaMm2: CUP_AREA, perimeterMm: Math.PI * CUP_D0, lengthMm: CUP_D0, widthMm: CUP_D0, circumscribedDiameterMm: CUP_D0,
    outlinePointsMm: null, piercedHoleAreaMm2: 0, piercedHolePerimeterMm: 0,
  },
  flanges: [], holes: [{ featureType: 'SimpleHole', diameterMm: 6, perimeterMm: 18.8, areaMm2: 28.3, inFlat: false, onMainSurface: false, edgeDistanceMm: null, faceIds: [7] }], unmeasured: [],
};
// A 200 x 100 plate, 1.5 mm, with straight and curved flanges and two holes in the flat.
const PLATE: HydroformPart = {
  depthMm: 21.5, planLengthMm: 200, planWidthMm: 100, minWidthMm: 100, projectedAreaMm2: 20000, developedAreaMm2: 28000,
  mainSurface: { areaMm2: 20000, perimeterMm: 600 }, drawn: null,
  blank: { method: 'true_unfold', areaMm2: 28000, perimeterMm: 680, lengthMm: 200, widthMm: 140, circumscribedDiameterMm: 244.1, outlinePointsMm: null, piercedHoleAreaMm2: 157.1, piercedHolePerimeterMm: 62.8 },
  flanges: [
    { kind: 'straight', angleDeg: 90, lengthMm: 200, heightMm: 20, edgeRadiusMm: null },
    { kind: 'straight', angleDeg: 90, lengthMm: 200, heightMm: 20, edgeRadiusMm: null },
    { kind: 'curved', angleDeg: 90, lengthMm: 50, heightMm: 20, edgeRadiusMm: 30 },
  ],
  holes: [
    { featureType: 'SimpleHole', diameterMm: 10, perimeterMm: 31.4, areaMm2: 78.5, inFlat: true, onMainSurface: true, edgeDistanceMm: 10, faceIds: [40] },
    { featureType: 'SimpleHole', diameterMm: 10, perimeterMm: 31.4, areaMm2: 78.5, inFlat: true, onMainSurface: true, edgeDistanceMm: 2, faceIds: [41] },
  ],
  unmeasured: [],
};
const GRAPH = [{ id: 'blank_0', feature_type: 'Blank' }, { id: 'bend_0', feature_type: 'StraightBend' }, { id: 'hole_0', feature_type: 'SimpleHole' }];

const input = (part: HydroformPart, over: Partial<HydroformingRouteInput> = {}, scenario: Partial<HydroformingRouteInput['scenario']> = {}): HydroformingRouteInput => ({
  ref: realHydroformingReference(), spec: loadHydroformingCalculatorSpec(), calculators: hydroformingCalculatorsByName(), material: MILD_STEEL, part,
  thicknessMm: part === CUP ? 1 : 1.5, machinesByClass: allHydroformingMachines(), costContext: ZERO, nest: NEST, toolShop: realToolShop(),
  catalog: realHydroformingCatalog(), graphFeatures: GRAPH,
  ...over,
  scenario: { batchSize: 100, route: null, partsPerTray: null, intensifier: false, amortizationParts: 10000, ...scenario },
});

describe('every hydroforming calculator input says where its value came from', () => {
  const cases: Array<[string, HydroformingRouteInput]> = [
    ['a drawn cup (deep draw and fluid cell)', input(CUP)],
    ['a flanged plate (fluid cell and deep draw)', input(PLATE)],
    ['parts on a tray and the intensifier, set in the Cost Guide', input(PLATE, {}, { partsPerTray: 4, intensifier: true })],
  ];

  it.each(cases)('%s', (_name, inp) => {
    const { routes, missing } = buildHydroformingRoutes(inp);
    expect(missing).toEqual([]);
    expect(routes.length).toBeGreaterThan(0);
    expect(sourceGaps([...routes.flatMap((r) => r.lines), ...routes.flatMap((r) => runsOf(r).map((x) => ({ ...x, process: `${r.key} ${x.process}` })))])).toEqual({ withoutRef: [], openingNothing: [] });
  });

  it('covers both routes', () => {
    const keys = new Set(cases.flatMap(([, inp]) => buildHydroformingRoutes(inp).routes.map((r) => r.key)));
    expect([...keys].sort()).toEqual(['deep-draw', 'fluid-cell']);
  });
});
