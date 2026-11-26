// Every input of every roll forming line says where its value came from (SourceRef), so the calculator dialog's eye beside it opens that
// source: the roll forming variable or lookup row, the line machine or material record, the CAD measurement, the calculation that derived
// it (the stations, the line speed, the coil), the part's costing inputs or the Cost Guide setting. This guard runs both routes on the real
// memory/Sheet metal roll forming data and lists any input with no ref, or a ref that opens nothing.
import { realRollFormingCatalog, realRollFormingReference, rollFormingMachines, rollFormingMaterial } from './roll-forming-test-data';
import { loadRollFormingCalculatorSpec, rollFormingCalculatorsByName } from '../../../../../modules/bom-items/costing/roll-forming/calculators/roll-forming-calculator-spec';
import { rollFormPart, ROLL_FORM_EXTRACTION_VERSION, type RollFormPart } from '../../../../../modules/bom-items/costing/roll-forming/roll-forming-part';
import { buildRollFormingRoutes, type RollFormingRouteInput } from '../../../../../modules/bom-items/costing/roll-forming/roll-forming-route';
import { realToolShop } from '../hydroforming/hydroforming-test-data';
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
const STEEL = rollFormingMaterial('Steel, Cold Worked, AISI 1008');

const hole = (diameter: number, station: number, face: number) =>
  ({ feature_type: 'SimpleHole', size_mm: diameter, perimeter_mm: Math.PI * diameter, area_mm2: (Math.PI * diameter * diameter) / 4, depth_mm: null, station_mm: station, face_ids: [face] });
const bend = (angle: number, before: number, level: number | null, faces: number[] = []) =>
  ({ angle_deg: angle, inner_radius_mm: 1.5, flange_before_mm: before, level, face_ids: faces });
const measured = (over: Record<string, unknown>) => ({
  extractionVersion: ROLL_FORM_EXTRACTION_VERSION, axis: [1, 0, 0], axisSource: 'bends', constantSection: true, stockFraction: 0.998,
  thicknessMm: 1.5, curve: null, features: [],
  ends: [
    { end: 'start', kind: 'square', cut_angle_deg: 0, cut_perimeter_mm: 120, face_ids: [90] },
    { end: 'end', kind: 'square', cut_angle_deg: 0, cut_perimeter_mm: 120, face_ids: [91] },
  ],
  ...over,
});
const partOf = (g: Record<string, unknown>): RollFormPart => {
  const { part, missing } = rollFormPart(g);
  if (!part) throw new Error(missing.join('; '));
  return part;
};
// A C channel 2 m long with four holes along it; a closed square tube welded along its seam.
const CHANNEL_G = measured({
  lengthMm: 2000, section: { height_mm: 36.5, width_mm: 53, area_mm2: 181.2, perimeter_mm: 244, closed: false, stock_form: 'GENERIC_EXTRUSION' },
  stripWidthMm: 120.8, stripWidthNeutralMm: 120, stripWidthCheck: { flats_mm: 113.7, bend_arcs_mm: 7.07, agrees: true },
  bends: [bend(90, 33, 1, [1, 2]), bend(90, 47.7, 1, [3, 4])], lastFlangeMm: 33,
  features: [hole(8, 200, 11), hole(8, 700, 12), hole(8, 1300, 13), hole(8, 1800, 14)],
});
const CHANNEL = partOf(CHANNEL_G);
const TUBE = partOf(measured({
  lengthMm: 1500, section: { height_mm: 40, width_mm: 40, area_mm2: 228, perimeter_mm: 302, closed: true, stock_form: 'SQUARE_TUBE' },
  stripWidthMm: 152, stripWidthNeutralMm: 150.7, bends: [bend(90, 37, 1), bend(90, 37, 2), bend(90, 37, 2), bend(90, 37, 1)], lastFlangeMm: 0,
  ends: [{ end: 'start', kind: 'square', cut_angle_deg: 0, cut_perimeter_mm: 150.7, face_ids: [] }, { end: 'end', kind: 'square', cut_angle_deg: 0, cut_perimeter_mm: 150.7, face_ids: [] }],
}));
const SHARP = partOf({ ...CHANNEL_G, bends: [{ ...bend(90, 33, 1, [1]), inner_radius_mm: 0, sharp: true }, bend(90, 47.7, 1, [2])] });

const input = (part: RollFormPart, over: Partial<RollFormingRouteInput> = {}, scenario: Partial<RollFormingRouteInput['scenario']> = {}): RollFormingRouteInput => ({
  ref: realRollFormingReference(), spec: loadRollFormingCalculatorSpec(), calculators: rollFormingCalculatorsByName(), material: STEEL, part,
  machinesByClass: rollFormingMachines('USA'), costContext: ZERO, toolShop: realToolShop(), catalog: realRollFormingCatalog(),
  ...over,
  scenario: { batchSize: 1000, route: null, stations: null, welding: null, toolingMultiplier: null, amortizationParts: 100000, ...scenario },
});

describe('every roll forming calculator input says where its value came from', () => {
  const cases: Array<[string, RollFormingRouteInput]> = [
    ['a punched C channel', input(CHANNEL)],
    ['a welded square tube', input(TUBE)],
    ['a thick channel (the coil flattened), in a high-strength steel', input({ ...CHANNEL, thicknessMm: 2.6 }, { material: rollFormingMaterial('Steel, Hot Worked, S900MC') })],
    ['a channel curved on the line', input({ ...CHANNEL, curve: { radiusMm: 2000, angleDeg: 57.3 } })],
    ['a channel with a sharp bend', input(SHARP)],
    ['a short channel', input({ ...CHANNEL, lengthMm: 150, features: CHANNEL.features.slice(0, 1) })],
    ['the Cost Guide: stations, welding and tooling', input(TUBE, {}, { stations: 30, welding: 'rotary-spot', toolingMultiplier: 1.5 })],
  ];

  it.each(cases)('%s', (_name, inp) => {
    const { routes, missing } = buildRollFormingRoutes(inp);
    expect(missing).toEqual([]);
    expect(routes.length).toBeGreaterThan(0);
    expect(sourceGaps([...routes.flatMap((r) => r.lines), ...routes.flatMap((r) => runsOf(r).map((x) => ({ ...x, process: `${r.key} ${x.process}` })))])).toEqual({ withoutRef: [], openingNothing: [] });
  });

  it('covers both routes', () => {
    const keys = new Set(cases.flatMap(([, inp]) => buildRollFormingRoutes(inp).routes.map((r) => r.key)));
    expect([...keys].sort()).toEqual(['blade', 'scissor']);
  });
});
