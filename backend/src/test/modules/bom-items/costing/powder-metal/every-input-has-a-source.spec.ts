// Every input of every powder metal line says where its value came from (SourceRef), so the calculator dialog's eye beside it opens that
// source: the powder metal variable or lookup row, the press or furnace record, the powder's material record, the CAD measurement along the
// press direction, the calculation that derived it, or the part's costing inputs. This guard runs the press-and-sinter route on the real
// memory/Powder metal data and lists any input with no ref, or a ref that opens nothing.
import { buildPowderMetalRoute, type PowderMetalPart, type PowderMetalRouteInput } from '../../../../../modules/bom-items/costing/powder-metal/powder-metal-route';
import { loadPowderMetalCalculatorSpec, powderMetalCalculatorsByName } from '../../../../../modules/bom-items/costing/powder-metal/calculators/powder-metal-calculator-spec';
import { allPowderMetalMachines, powderMetalMaterial, realPowderMetalReference } from './powder-metal-test-data';
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
const AREA = (Math.PI / 4) * (30 ** 2 - 15 ** 2);
const BUSHING: PowderMetalPart = { volumeMm3: AREA * 20, projectedAreaMm2: AREA, heightMm: 20, planLengthMm: 30, planWidthMm: 30, holes: [] };
const input = (over: Partial<PowderMetalRouteInput> = {}): PowderMetalRouteInput => ({
  ref: realPowderMetalReference(), spec: loadPowderMetalCalculatorSpec(), calculators: powderMetalCalculatorsByName(),
  material: powderMetalMaterial('F-0005'), part: BUSHING, machinesByClass: allPowderMetalMachines(),
  scenario: { batchSize: 1000, greenDensityKgM3: null }, costContext: ZERO, ...over,
});

describe('every powder metal calculator input says where its value came from', () => {
  const cases: Array<[string, PowderMetalRouteInput]> = [
    ['a bushing', input()],
    ['a green density set in the Cost Guide', input({ scenario: { batchSize: 1000, greenDensityKgM3: 7150 } })],
    ['a tall part', input({ part: { ...BUSHING, heightMm: 140, volumeMm3: AREA * 140 } })],
    ['a small batch', input({ scenario: { batchSize: 10, greenDensityKgM3: null } })],
  ];

  it.each(cases)('%s', (_name, inp) => {
    const { route, missing } = buildPowderMetalRoute(inp);
    expect(missing).toEqual([]);
    expect(route!.lines.length).toBeGreaterThan(0);
    expect(sourceGaps([...route!.lines, ...runsOf(route!)])).toEqual({ withoutRef: [], openingNothing: [] });
  });
});
