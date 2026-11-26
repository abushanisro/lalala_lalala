// Every input of every forging line says where its value came from (SourceRef), so the calculator dialog's eye beside it opens that source:
// the forging variable or lookup row, the machine or material record, the CAD measurement, the calculation that derived it (the bar stock,
// the blows the plant strikes), the part's costing inputs or the Cost Guide setting. This guard runs every forging route on the real
// memory/Forging data and lists any input with no ref, or a ref that opens nothing.
import { buildForgingRoutes, type ForgingPart, type ForgingRouteInput } from '../../../../../modules/bom-items/costing/forging/forging-route';
import { forgingCalculatorsByName, loadForgingCalculatorSpec } from '../../../../../modules/bom-items/costing/forging/calculators/forging-calculator-spec';
import { allForgingMachines, forgingMaterial, realForgingReference } from './forging-test-data';
import { sourceGaps } from '../source-ref-guard';
import type { CalculationTraceStep } from '../../../../../modules/bom-items/dto/cost-breakdown.dto';

/**
 * Every calculator run a route holds besides its lines' (what the cost summary shows as calculatorRuns, with the eye beside each input), as a
 * line named by where it sits, so its inputs are checked the same way.
 */
function runsOf(route: object): Array<{ process: string; calculationTrace: CalculationTraceStep[] }> {
  const out: Array<{ process: string; calculationTrace: CalculationTraceStep[] }> = [];
  const seen = new Set<object>();
  const walk = (v: unknown, path: string): void => {
    if (!v || typeof v !== 'object' || seen.has(v)) return;
    seen.add(v);
    const o = v as Record<string, unknown>;
    if (Array.isArray(o.trace) && 'calculatorId' in o) out.push({ process: `run ${path}`, calculationTrace: o.trace as CalculationTraceStep[] });
    for (const [k, x] of Object.entries(o)) if (k !== 'lines' && k !== 'trace') walk(x, path ? `${path}.${k}` : k);
  };
  walk(route, '');
  return out;
}


const ZERO = { qairPerHr: 0, inspTimeMin: 0, samplingRate: 0, yieldPct: 1, netMatCost: 0, netWeightKg: 0, scrapPricePerKg: 0 };
const BLOCK: ForgingPart = { volumeMm3: 150_000, projectedAreaMm2: 6_000, partingPerimeterMm: 320, dieDepthMm: 40, planLengthMm: 100, planWidthMm: 70, holes: [] };
const RING: ForgingPart = {
  volumeMm3: (Math.PI / 4) * (200 ** 2 - 120 ** 2) * 50, projectedAreaMm2: (Math.PI / 4) * (200 ** 2 - 120 ** 2), partingPerimeterMm: Math.PI * 200,
  dieDepthMm: 50, planLengthMm: 200, planWidthMm: 200, holes: [{ diameterMm: 120, depthMm: 50, angleToDieDeg: 0, variant: 'through' }],
};
const BIG: ForgingPart = { volumeMm3: 6_000_000, projectedAreaMm2: 60_000, partingPerimeterMm: 1_000, dieDepthMm: 120, planLengthMm: 300, planWidthMm: 200, holes: [] };

const input = (over: Partial<ForgingRouteInput> = {}, scenario: Partial<ForgingRouteInput['scenario']> = {}): ForgingRouteInput => ({
  ref: realForgingReference(), spec: loadForgingCalculatorSpec(), calculators: forgingCalculatorsByName(),
  material: forgingMaterial('Steel, AISI 4140, Medium-Carbon'), part: BLOCK,
  machinesByClass: allForgingMachines(), toolShopMachiningUsdPerHr: 75,
  scenario: { batchSize: 1000, complexity: null, route: null, lifetimeVolume: 50_000, ...scenario },
  costContext: ZERO, ...over,
});

describe('every forging calculator input says where its value came from', () => {
  const cases: Array<[string, ForgingRouteInput]> = [
    ['a closed-die block (press, hammer, mechanical press)', input()],
    ['a big part (furnace heated)', input({ part: BIG })],
    ['a flashless part (open die)', input({}, { complexity: 2 })],
    ['a ring (ring rolling)', input({ part: RING })],
    ['the Cost Guide: bar, blows and flash land', input({}, { overrides: { barDiameterMm: 80, hits: 3, flashThicknessMm: 3, flashWidthMm: 12 } })],
    ['the Cost Guide: induction heating set', input({}, { overrides: { heating: 'induction' } })],
  ];

  it.each(cases)('%s', (_name, inp) => {
    const { routes } = buildForgingRoutes(inp);
    expect(routes.length).toBeGreaterThan(0);
    const lines = [...routes.flatMap((r) => r.lines), ...routes.flatMap((r) => runsOf(r).map((x) => ({ ...x, process: `${r.key} ${x.process}` })))];
    expect(sourceGaps(lines)).toEqual({ withoutRef: [], openingNothing: [] });
  });

  it('covers every forging route', () => {
    const keys = new Set(cases.flatMap(([, inp]) => buildForgingRoutes(inp).routes.map((r) => r.key)));
    expect([...keys].sort()).toEqual(['closed_die_hammer', 'closed_die_mechanical_press', 'closed_die_press', 'open_die', 'ring_rolling']);
  });
});
