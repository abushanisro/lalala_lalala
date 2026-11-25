// Every calculator input on an assembly line says where its value came from (SourceRef), so the eye beside it opens that source: this guard
// runs the manual and robotic routes on the housing-and-brackets assembly of the route tests with every joint the engine costs, and lists any
// input with no ref, or a ref that opens nothing (source-ref-guard.ts).
import { finishedAssembly } from '../../../../../modules/bom-items/costing/assembly/assembly-cost.service';
import { componentOf, deriveJoints, mergeJoints, type AssemblyJoint } from '../../../../../modules/bom-items/costing/assembly/assembly-joints';
import { buildAssemblyRoutes, type AssemblyRouteInput } from '../../../../../modules/bom-items/costing/assembly/assembly-route';
import { assemblyCalculatorsByName, loadAssemblyCalculatorSpec } from '../../../../../modules/bom-items/costing/assembly/calculators/assembly-calculator-spec';
import { runsAsLines, sourceGaps } from '../source-ref-guard';
import { allAssemblyMachines, realAssemblyReference } from './assembly-test-data';

const ZERO = { qairPerHr: 0, inspTimeMin: 0, samplingRate: 0, yieldPct: 1, netMatCost: 0, netWeightKg: 0, scrapPricePerKg: 0 };
const housingGraph = { feature_graph_v2: { features: [
  { id: 'SimpleHole-threaded_d3.2_c4', feature_type: 'SimpleHole', variant: 'threaded', occurrences: [1, 2, 3, 4].map((i) => ({ spec: 'M4×0.7', face_ids: [i] })) },
] } };
const HOUSING = componentOf({ id: 'housing', name: 'Housing', quantity: 1, weight: 0.044, maxLength: 80.3, maxWidth: 65.5, maxHeight: 22.5, featureGraph: housingGraph });
const BRACKET = componentOf({ id: 'bracket', name: 'Bracket', quantity: 2, weight: 0.5, maxLength: 120, maxWidth: 40, maxHeight: 5, featureGraph: null });
const COMPONENTS = [HOUSING, BRACKET];

const input = (joints: AssemblyJoint[]): AssemblyRouteInput => ({
  ref: realAssemblyReference(), spec: loadAssemblyCalculatorSpec(), calculators: assemblyCalculatorsByName(), components: COMPONENTS, joints,
  assembly: finishedAssembly({ id: 'a', name: 'A' }, COMPONENTS), machinesByClass: allAssemblyMachines(), batchSize: 250, costContext: ZERO,
});

const CASES: [string, AssemblyJoint[]][] = [
  ['the screws its threaded holes take', deriveJoints(COMPONENTS)],
  ['welds, with prep and clean-up', mergeJoints([], [
    { id: 'w1', process: 'MIG Welding', lengthMm: 500, throatMm: 4, weldMaterial: 'Steel', gas: 'Argon', prep: true, cleanUp: true },
    { id: 'w2', process: 'TIG Welding', lengthMm: 200, throatMm: 2, weldMaterial: 'Steel', gas: 'Argon', position: 'Overhead' },
    { id: 's', process: 'Spot Welding', count: 10 },
  ]).joints],
  ['sealing, bonding, inserts, lock bolts and snap fits', mergeJoints(deriveJoints(COMPONENTS), [
    { id: 'f', process: 'Fillet Sealing', lengthMm: 1000 }, { id: 'b', process: 'Adhesive Bonding', areaMm2: 10000 },
    { id: 't', process: 'Threaded Insert', count: 3 }, { id: 'l', process: 'Lock Bolt', count: 2 }, { id: 'c', process: 'Cap Sealing', count: 6 },
    { id: 'n', process: 'Mechanical Assembly', operation: 'Snap Fit', count: 4 },
  ]).joints],
];

describe('every assembly calculator input says where its value came from', () => {
  it.each(CASES)('%s', (_name, joints) => {
    const { routes } = buildAssemblyRoutes(input(joints));
    expect(routes.length).toBeGreaterThan(0);
    expect(sourceGaps(routes.flatMap((r) => [...r.lines, ...runsAsLines(r.runs)]))).toEqual({ withoutRef: [], openingNothing: [] });
  });
});
