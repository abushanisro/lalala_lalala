import { allAssemblyMachines, realAssemblyReference } from './assembly-test-data';
import { buildAssemblyCostSummary } from '../../../../../modules/bom-items/costing/assembly/assembly-cost-summary';
import { finishedAssembly } from '../../../../../modules/bom-items/costing/assembly/assembly-cost.service';
import { componentOf, deriveJoints, mergeJoints, threadedHolesOf, type AssemblyComponent, type AssemblyJoint } from '../../../../../modules/bom-items/costing/assembly/assembly-joints';
import {
  buildAssemblyRoutes, chooseAssemblyRoute, loadRow, mechanicalOperationTimes, migRow, passesRow, type AssemblyRoute, type AssemblyRouteInput,
} from '../../../../../modules/bom-items/costing/assembly/assembly-route';
import { assemblyRouteFor } from '../../../../../modules/bom-items/costing/assembly/assembly-route-comparison';
import { assemblyCalculatorsByName, loadAssemblyCalculatorSpec } from '../../../../../modules/bom-items/costing/assembly/calculators/assembly-calculator-spec';
import { machineValue } from '../../../../../modules/bom-items/costing/casting/sand/sand-machines';

import type { CostSummaryResponseDto, ProcessLineCost } from '../../../../../modules/bom-items/dto/cost-breakdown.dto';


const ZERO = { qairPerHr: 0, inspTimeMin: 0, samplingRate: 0, yieldPct: 1, netMatCost: 0, netWeightKg: 0, scrapPricePerKg: 0 };
const ref = realAssemblyReference();
const machines = allAssemblyMachines();

// A housing with four M4 threaded holes (as feature_graph_v2 stores them) and two brackets.
const housingGraph = { feature_graph_v2: { features: [
  { id: 'SimpleHole-threaded_d3.2_c4', feature_type: 'SimpleHole', variant: 'threaded', occurrences: [1, 2, 3, 4].map((i) => ({ spec: 'M4×0.7', face_ids: [i] })) },
  { id: 'hole-9', feature_type: 'SimpleHole', variant: 'through', occurrences: [{ face_ids: [90] }] },
] } };
const HOUSING = componentOf({ id: 'housing', name: 'Housing', quantity: 1, weight: 0.044, maxLength: 80.3, maxWidth: 65.5, maxHeight: 22.5, featureGraph: housingGraph });
const BRACKET = componentOf({ id: 'bracket', name: 'Bracket', quantity: 2, weight: 0.5, maxLength: 120, maxWidth: 40, maxHeight: 5, featureGraph: null });
const COMPONENTS = [HOUSING, BRACKET];

const weld = (over: Partial<AssemblyJoint> = {}): AssemblyJoint => mergeJoints([], [{ id: 'w1', process: 'MIG Welding', lengthMm: 500, throatMm: 4, weldMaterial: 'Steel', gas: 'Argon', ...over }]).joints[0];
const input = (over: Partial<AssemblyRouteInput> = {}): AssemblyRouteInput => ({
  ref, spec: loadAssemblyCalculatorSpec(), calculators: assemblyCalculatorsByName(), components: COMPONENTS, joints: deriveJoints(COMPONENTS),
  assembly: finishedAssembly({ id: 'a', name: 'A' }, COMPONENTS),
  machinesByClass: machines, batchSize: 250, costContext: ZERO, ...over,
});
const routeOf = (key: string, over: Partial<AssemblyRouteInput> = {}): AssemblyRoute => {
  const r = buildAssemblyRoutes(input(over)).routes.find((x) => x.key === key);
  if (!r) throw new Error(`no ${key} route`);
  return r;
};
const sec = (l: ProcessLineCost) => l.cycleTimeMin * 60;
const gapsOf = (r: AssemblyRoute) => r.lines.filter((l) => l.physicsGap).map((l) => `${l.process}: ${(l.physicsGap as { reason?: string }).reason}`);
const mechanicalLine = (r: AssemblyRoute): ProcessLineCost => {
  const line = r.lines.find((l) => l.process === 'Mechanical Assembly');
  if (!line) throw new Error('no Mechanical Assembly line');
  return line;
};

describe('the assembly\'s components and joints', () => {
  it('reads a child\'s threaded holes from its feature graph, at the root or under machining_features', () => {
    expect(threadedHolesOf(housingGraph)).toEqual([{ featureId: 'SimpleHole-threaded_d3.2_c4', spec: 'M4×0.7', occurrences: 4 }]);
    expect(threadedHolesOf({ machining_features: housingGraph })).toHaveLength(1);
    expect(threadedHolesOf(null)).toEqual([]);
  });

  it('a component is the BOM child: its quantity, weight and largest dimension', () => {
    expect(BRACKET).toMatchObject({ quantity: 2, massKg: 0.5, maxDimensionMm: 120, threadedHoles: [] });
    expect(componentOf({ id: 'x', name: 'X', quantity: null, weight: 0 }).massKg).toBeNull();
  });

  it('derives a screw in every threaded hole, per instance of its part, naming the part and the feature', () => {
    const twice = componentOf({ id: 'housing', name: 'Housing', quantity: 2, weight: 0.044, featureGraph: housingGraph });
    expect(deriveJoints([twice])).toEqual([expect.objectContaining({
      id: 'screw:housing:SimpleHole-threaded_d3.2_c4', process: 'Mechanical Assembly', operation: 'Screw Tighten - Manual', count: 8,
      componentId: 'housing', featureIds: ['SimpleHole-threaded_d3.2_c4'], source: 'derived',
    })]);
  });

  it('the joint table edits or switches off a derived joint by its id, adds its own, and names a row it cannot read', () => {
    const derived = deriveJoints(COMPONENTS);
    const { joints, ignored } = mergeJoints(derived, [
      { id: derived[0].id, process: 'Mechanical Assembly', operation: 'Snap Fit', count: 4 },
      { process: 'Fillet Sealing', lengthMm: 300 },
      { process: 'Glue gun' },
    ]);
    expect(joints[0]).toMatchObject({ operation: 'Snap Fit', source: 'derived', componentId: 'housing', featureIds: derived[0].featureIds });
    expect(joints[1]).toMatchObject({ process: 'Fillet Sealing', lengthMm: 300, source: 'engineer', count: 1 });
    expect(ignored).toEqual(['joint table row 3: no known process ("Glue gun")']);
    expect(mergeJoints(derived, [{ id: derived[0].id, process: 'Mechanical Assembly', enabled: false }]).joints[0].enabled).toBe(false);
  });
});

describe('the reference tables', () => {
  it('loads a component by the quickest componentLoadTimes row that takes its weight and size', () => {
    expect(loadRow(ref, 0.044, 80)).toMatchObject({ Equipment: 'None', 'Weight (kg)': 5, 'Part Max Dimension (mm)': 915, 'Load Time (s)': 10 });
    expect(loadRow(ref, 30, 1000)).toMatchObject({ Equipment: 'Lifting Aid 1', 'Weight (kg)': 30, 'Load Time (s)': 30 });
    expect(loadRow(ref, 6000, 100)).toBeNull();
  });

  it('a throat up to 5.66 mm (an 8 mm leg) is one pass; above it two; a very thick one 28', () => {
    expect(passesRow(ref, 'MIG', 4)!['Num Passes']).toBe(1);
    expect(passesRow(ref, 'MIG', 5.66)!['Num Passes']).toBe(1);
    expect(passesRow(ref, 'MIG', 6)!['Num Passes']).toBe(2);
    expect(passesRow(ref, 'TIG', 50)!['Num Passes']).toBe(28);
  });

  it('a MIG pass runs at the speed of the smallest tabled throat that takes it, with the largest wire unless the joint names one', () => {
    expect(migRow(ref, 'Steel', 'Argon', 4, null)).toMatchObject({ 'Throat Thickness (mm)': 4.19, 'Wire Diameter (mm)': 1.1, 'Travel Speed (mm / s)': 3.95 });
    expect(migRow(ref, 'Steel', 'Argon', 4, 0.9)).toMatchObject({ 'Wire Diameter (mm)': 0.9, 'Wire Feed Speed (mm / s)': 196.05 });
  });
});

describe('an assembly\'s routes', () => {
  it('loads every component (one band: 3 instances at 10 s x handlingMultiplier 1.15) and unloads the finished assembly once', () => {
    const r = routeOf('manual');
    const pick = r.lines.filter((l) => l.process === 'Pick and Place');
    expect(pick).toHaveLength(2);
    expect(sec(pick[0])).toBeCloseTo(3 * 10 * 1.15, 1);
    expect(pick[0].featureBreakdown!.map((o) => [o.name, o.featureType, o.featureIds])).toEqual([
      ['Housing ×1', 'AssemblyComponent', ['housing']], ['Bracket ×2', 'AssemblyComponent', ['bracket']],
    ]);
    // 0.044 + 2 x 0.5 kg, its largest component 120 mm: the None band's 10 s unload.
    expect(sec(pick[1])).toBeCloseTo(10 * 1.15, 1);
    expect(pick[1].featureBreakdown![0].name).toBe('Finished assembly ×1');
    expect(JSON.stringify(pick[1].calculationTrace)).toContain('1.044 kg');
  });

  it('names the parts each component row and each joint row concerns, for the assembly view to highlight', () => {
    const ops = routeOf('manual', { joints: [...deriveJoints(COMPONENTS), weld({ componentId: 'bracket' })] }).lines.flatMap((l) => l.featureBreakdown ?? []);
    const ofType = (type: string) => ops.filter((o) => o.featureType === type);
    expect(ofType('AssemblyComponent').map((o) => o.componentIds)).toEqual(expect.arrayContaining([['housing'], ['bracket']]));
    expect(ofType('AssemblyJointDerived').length).toBeGreaterThan(0);
    expect(ofType('AssemblyJointDerived').every((o) => o.componentIds?.[0] === 'housing')).toBe(true);
    expect(ofType('AssemblyJoint').map((o) => o.componentIds)).toEqual([['bracket']]);
    expect(ofType('Assembly').every((o) => o.componentIds === undefined)).toBe(true);
  });

  it('a machine is set up once per batch: the unload line on the pick and place station charges no second setup', () => {
    const pick = routeOf('manual').lines.filter((l) => l.process === 'Pick and Place');
    expect(pick[1].setupCost).toBe(0);
    expect(pick[1].totalCost).toBe(pick[1].runCost);
  });

  it('screws the four derived screws at the DFA 9.80 s each, on the housing\'s threaded hole', () => {
    const mech = routeOf('manual').lines.find((l) => l.process === 'Mechanical Assembly')!;
    expect(sec(mech)).toBeCloseTo(4 * 9.8, 1);
    expect(mech.featureBreakdown![0]).toMatchObject({ featureType: 'AssemblyJointDerived', count: 4, featureIds: ['SimpleHole-threaded_d3.2_c4'] });
    expect(mech.calculationTrace).toBeDefined();
  });

  it('names every Mechanical Assembly operation of memory/Assembly with the time the fastening table gives it, and none where it has none', () => {
    const times = Object.fromEntries(mechanicalOperationTimes(ref).map((t) => [t.operation, t.timeS]));
    expect(times).toEqual({
      'Screw Tighten - Manual': 9.8, 'Nut Insert': 9.13, 'Snap Fit': 6.95,
      'Screw Tighten - Power': null, 'Press Fit': null, Rivet: null, 'Tab Bend': null, 'User-Defined Operation': null,
    });
    expect(mechanicalOperationTimes(null).every((t) => t.timeS === null)).toBe(true);
  });

  it('a press fit is costed by the time set on it: three bushes at 12 s each on the assembly bench', () => {
    const joints = mergeJoints([], [{ id: 'p', process: 'Mechanical Assembly', operation: 'Press Fit', count: 3, timeS: 12, label: 'Bush into housing' }]).joints;
    const r = routeOf('manual', { joints });
    const line = mechanicalLine(r);
    expect(sec(line)).toBeCloseTo(3 * 12, 1);
    expect(line.featureBreakdown?.[0]).toMatchObject({ name: 'Bush into housing', featureType: 'AssemblyJoint', count: 3 });
    expect(r.complete).toBe(true);
  });

  it('a press fit with no time is a named gap (the table has none for it), never a guessed time', () => {
    const joints = mergeJoints([], [{ id: 'p', process: 'Mechanical Assembly', operation: 'Press Fit', count: 3 }]).joints;
    const r = routeOf('manual', { joints });
    expect(r.complete).toBe(false);
    expect(gapsOf(r)).toEqual(['Mechanical Assembly: Press Fit 1: Press Fit has no verified DFA time in assembly_tblDfaOperationTimes: enter its time per joint']);
  });

  it('a plant\'s own staged press fit time is used when the joint sets none', () => {
    // The same reference with one more row in the fastening time table, as a plant's own time study would stage it.
    const staged = Object.assign(Object.create(ref) as typeof ref, {
      table: (name: string) => (name === 'assembly_tblDfaOperationTimes' ? [...ref.table(name), { Operation: 'Press Fit', 'Total Time (s)': 7 }] : ref.table(name)),
    });
    const joints = mergeJoints([], [{ id: 'p', process: 'Mechanical Assembly', operation: 'Press Fit', count: 3 }]).joints;
    expect(sec(mechanicalLine(routeOf('manual', { ref: staged, joints })))).toBeCloseTo(3 * 7, 1);
    expect(mechanicalOperationTimes(staged).find((t) => t.operation === 'Press Fit')?.timeS).toBe(7);
  });

  it('the engineer\'s own operation (memory\'s User-Defined Operation) is read from the joint table and costed by its time', () => {
    const own = mergeJoints([], [{ id: 'u', process: 'Mechanical Assembly', operation: 'User-Defined Operation', count: 2, timeS: 30 }]).joints;
    expect(own[0]).toMatchObject({ operation: 'User-Defined Operation', label: 'User-Defined Operation 1' });
    expect(sec(mechanicalLine(routeOf('manual', { joints: own })))).toBeCloseTo(60, 1);
    const untimed = mergeJoints([], [{ id: 'u', process: 'Mechanical Assembly', operation: 'User-Defined Operation', count: 2 }]).joints;
    expect(gapsOf(routeOf('manual', { joints: untimed }))[0]).toContain('its time per joint');
  });

  it('a manual MIG weld, worked by hand: 500 mm, 4 mm throat, steel in argon (one pass at 3.95 mm/s), over the 0.45 efficiency, with its consumables', () => {
    const r = routeOf('manual', { joints: [weld()] });
    const line = r.lines.find((l) => l.process === 'Manual MIG Welding')!;
    const m = machines.manual_mig_welding.find((x) => x.name === line.machineName)!;
    const v = (k: string) => machineValue(m, k)!;
    const arc = (500 * 1) / 3.95 * v('arc_time_std');
    const tack = (500 / v('tack_pitch_mm')) * v('tack_length_mm') / 3.95;
    expect(sec(line)).toBeCloseTo((arc + tack) / 0.45 + v('gun_placement_time_s') + arc * v('gun_clean_time_per_arc_s'), 1);
    const wireKg = (Math.PI / 4) * 1.1 * 1.1 * 117.29 * arc * v('weld_density_kg_per_m3') / 1e9;
    const spray = 500 * 0.05 * 0.9 / (650 * 1); // CRC is the cheapest spray per gram: 6.75 USD a 500 mL can at 1.3 g/cm³
    const expected = wireKg * v('wire_cost_usd_per_kg') + 9.2 * arc / 3600 + wireKg / 9 * 0.32 + wireKg / 18 * 13.57 + spray * 6.75;
    expect(r.consumablesUsd).toBeCloseTo(expected, 3);
    expect(line.otherCostPerPartUsd).toBeCloseTo(expected, 3);
    expect(line.otherCostDetail).toContain('per assembly');
  });

  it('the robotic route welds on a robot at efficiency 1, its 300 s programming per weld spread over the batch', () => {
    const r = routeOf('robotic', { joints: [weld({ count: 2, lengthMm: 250 })] });
    const line = r.lines.find((l) => l.process === 'Robotic MIG Welding')!;
    const m = machines.robotic_mig_welding.find((x) => x.name === line.machineName)!;
    const v = (k: string) => machineValue(m, k)!;
    const arc = 500 / 3.95 * v('arc_time_std');
    const tack = (500 / v('tack_pitch_mm')) * v('tack_length_mm') / 3.95;
    const heads = Math.max(v('number_of_weld_heads'), 1);
    expect(sec(line)).toBeCloseTo((arc + tack + 2 * v('gun_placement_time_s') + arc * v('gun_clean_time_per_arc_s')) / heads + 2 * v('programming_time_per_weld_s') / 250, 1);
  });

  it('a TIG weld overhead runs at tigWeldOverheadSpeedMultiplier of the table speed', () => {
    const flat = routeOf('manual', { joints: [weld({ process: 'TIG Welding', throatMm: 2 })] }).lines.find((l) => l.process === 'Manual TIG Welding')!;
    const overhead = routeOf('manual', { joints: [weld({ process: 'TIG Welding', throatMm: 2, position: 'Overhead' })] }).lines.find((l) => l.process === 'Manual TIG Welding')!;
    expect(sec(overhead)).toBeGreaterThan(sec(flat));
    expect(JSON.stringify(overhead.calculationTrace)).toContain('0.7225');
  });

  it('weld prep and clean-up run along the weld when the joint asks for them', () => {
    const r = routeOf('manual', { joints: [weld({ prep: true, cleanUp: true })] });
    expect(sec(r.lines.find((l) => l.process === 'Weld Prep')!)).toBeCloseTo(500 / 10 + 500 / 5, 1);
    expect(sec(r.lines.find((l) => l.process === 'Weld Clean Up')!)).toBeCloseTo(500 / 10, 1);
  });

  it('spot welds, sealing, bonding, inserts and lock bolts are each one line on their own machines', () => {
    const joints = mergeJoints([], [
      { id: 's', process: 'Spot Welding', count: 10 }, { id: 'f', process: 'Fillet Sealing', lengthMm: 1000 }, { id: 'b', process: 'Adhesive Bonding', areaMm2: 10000 },
      { id: 't', process: 'Threaded Insert', count: 3 }, { id: 'l', process: 'Lock Bolt', count: 2 }, { id: 'c', process: 'Cap Sealing', count: 6 },
    ]).joints;
    const r = routeOf('manual', { joints });
    const at = (p: string) => sec(r.lines.find((l) => l.process === p)!);
    expect(at('Fillet Sealing')).toBeCloseTo(1000 * 0.05, 1);
    expect(at('Adhesive Bonding')).toBeCloseTo((0.01 / 0.03) * 60 + (0.01 / 0.02) * 60, 1);
    expect(at('Threaded Insert')).toBeCloseTo(3 * 4, 1);
    expect(at('Lock Bolt')).toBeGreaterThan(2 * 1.8);
    expect(r.adhesiveKg).toBeCloseTo(10000 * 0.002 * 1000 * 1100 / 1e9 * 1.1, 3);
    expect(r.warnings.join(' ')).toContain('no adhesive price');
    expect(r.complete).toBe(true);
  });

  it('names what it cannot cost: a rivet with no time, a component with no weight; the total excludes them', () => {
    const light = componentOf({ id: 'nut', name: 'Nut cap', quantity: 1, weight: null, maxLength: 24 });
    const r = routeOf('manual', { components: [...COMPONENTS, light], joints: mergeJoints([], [{ id: 'r', process: 'Rivet', count: 8 }]).joints });
    expect(gapsOf(r)).toEqual(expect.arrayContaining([
      expect.stringContaining('Nut cap: its weight'),
      expect.stringContaining("a rivet's time"),
    ]));
    expect(r.complete).toBe(false);
    expect(r.totalUsd).toBeNull();
  });

  it('robotic welding is not a route without a MIG, TIG or spot weld; nothing to cost at all is said', () => {
    const { routes, gaps } = buildAssemblyRoutes(input());
    expect(routes.map((r) => r.key)).toEqual(['manual']);
    expect(gaps).toEqual([{ key: 'robotic', label: 'Robotic welding', reason: 'the assembly has no MIG, TIG or spot weld for a robot to make' }]);
    expect(buildAssemblyRoutes(input({ components: [], joints: [] })).missing[0]).toContain('no components and no joints');
  });

  it('quotes the cheapest complete route, or the one set in the Cost Guide', () => {
    const { routes, gaps } = buildAssemblyRoutes(input({ joints: [weld()] }));
    const cheapest = [...routes].sort((a, b) => a.totalUsd! - b.totalUsd!)[0];
    expect(chooseAssemblyRoute(routes, gaps, null).route!.key).toBe(cheapest.key);
    const other = routes.find((r) => r !== cheapest)!;
    expect(chooseAssemblyRoute(routes, gaps, other.key).note).toContain('is set in the Cost Guide');
  });
});

describe('the assembly\'s Cost Summary and route comparison', () => {
  const assemblyResult = (joints: AssemblyJoint[], components: AssemblyComponent[] = COMPONENTS, batchSize = 250) => {
    const { routes, gaps } = buildAssemblyRoutes(input({ joints, components, batchSize }));
    const { route, note } = chooseAssemblyRoute(routes, gaps, null);
    return { materialOfParts: true, route, routes, gaps, components, joints, note, missing: [], warnings: [] };
  };

  it('holds the assembly\'s own work only: no material, its total the sum of its lines; the components are listed, not costed', () => {
    const s = buildAssemblyCostSummary({ assembly: assemblyResult([...deriveJoints(COMPONENTS), weld()]), batchSize: 250, warnings: [], ratesSource: 'test' });
    expect(s.family).toBe('assembly');
    // Its material is its parts': Apply keeps no record of its own and the Cost tab counts its work without one.
    expect(s.materialOfParts).toBe(true);
    expect(s.materialCost).toBe(0);
    expect(s.totalCost).toBeCloseTo(s.processLines.reduce((t, l) => t + l.totalCost, 0), 2);
    expect(s.assembly!.components.map((c) => [c.name, c.quantity, c.threadedHoles])).toEqual([['Housing', 1, 4], ['Bracket', 2, 0]]);
    // At 250 a batch the robot's 300 s programming per weld is 1.2 s an assembly: the robotic route is the cheaper one.
    expect(s.assembly!.route).toBe('robotic');
    expect(s.assembly!.joints.map((j) => [j.label, j.componentId, j.routeProcess])).toEqual([['M4×0.7 screws ×4', 'housing', 'Mechanical Assembly'], ['MIG Welding 1', null, 'Robotic MIG Welding']]);
    expect(s.assembly!.consumablesCost).toBeGreaterThan(0);
    expect(Object.keys(s.calculatorRuns ?? {})).toEqual(['w1 consumables']);
  });

  it('one assembly at a time is welded by hand: the robot\'s programming is not spread over a batch', () => {
    const s = buildAssemblyCostSummary({ assembly: assemblyResult([weld()], COMPONENTS, 1), batchSize: 1, warnings: [], ratesSource: 'test' });
    expect(s.assembly!.route).toBe('manual');
    expect(s.assembly!.options.map((o) => [o.route, o.complete])).toEqual([['manual', true], ['robotic', true]]);
  });

  it('an assembly that cannot be costed is one named line', () => {
    const s = buildAssemblyCostSummary({ assembly: { materialOfParts: false, route: null, routes: [], gaps: [], components: [], joints: [], note: null, missing: ['the assembly has no components and no joints'], warnings: [] }, batchSize: 1, warnings: [], ratesSource: 'test' });
    expect(s.processLines).toHaveLength(1);
    expect(s.processLines[0].physicsGap).toBeDefined();
    expect(s.warnings).toContain('Assembly cannot be costed: the assembly has no components and no joints');
  });

  it('each route of the comparison is the summary priced on it; a route it is not says why', () => {
    const summary = { ...buildAssemblyCostSummary({ assembly: assemblyResult(deriveJoints(COMPONENTS)), batchSize: 250, warnings: [], ratesSource: 'test' }) } as CostSummaryResponseDto;
    const manual = assemblyRouteFor('manual', summary);
    expect(manual).toMatchObject({ routeId: 'assembly-manual', isFeasible: true, totalCost: summary.totalCost });
    const robotic = assemblyRouteFor('robotic', summary);
    expect(robotic).toMatchObject({ routeId: 'assembly-robotic', isFeasible: false, totalCost: null });
    expect(robotic.capability.warnings[0]).toContain('no MIG, TIG or spot weld');
  });

  it('an incomplete route says which step is missing what, so Apply can say why it refuses it', () => {
    const light = componentOf({ id: 'nut', name: 'Nut cap', quantity: 1, weight: null, maxLength: 24 });
    const summary = buildAssemblyCostSummary({ assembly: assemblyResult(deriveJoints(COMPONENTS), [...COMPONENTS, light]), batchSize: 250, warnings: [], ratesSource: 'test' }) as CostSummaryResponseDto;
    const manual = assemblyRouteFor('manual', summary);
    expect(manual.isFeasible).toBe(false);
    expect(manual.capability.warnings[0]).toContain('Pick and Place: the load time of Nut cap: its weight');
  });
});

// Technical first: a machine must be able to hold the assembly before its cost is compared. The limits are the machines' own
// (memory/Assembly/Machines: the electron beam welders' working chamber and load, the ultrasonic welders' tables).
describe('the assembly must fit the machine that welds it', () => {
  const sized = (maxDimensionMm: number | null, massKg: number | null = 1) => ({ assembly: { massKg, maxDimensionMm, sizeSource: 'test' } });
  const lineOf = (r: AssemblyRoute, process: string) => r.lines.find((l) => l.process === process)!;
  const ebwJoint = mergeJoints([], [{ id: 'e', process: 'Electron Beam Welding', lengthMm: 200, depthMm: 5 }]).joints;
  const usJoint = mergeJoints([], [{ id: 'u', process: 'Ultrasonic Welding', count: 2 }]).joints;
  const welders = machines['electron_beam_welding']!;
  const longest = (m: (typeof welders)[number]) => Math.max(...['working_length_mm', 'working_width_mm', 'working_height_mm'].map((k) => machineValue(m, k)!));

  it('an electron beam weld is made in a chamber that takes the assembly: the smaller chambers are not capable', () => {
    const small = lineOf(routeOf('manual', { joints: ebwJoint, ...sized(200) }), 'Electron Beam Welding').machineChoice!;
    expect(small.criteria).toContain('A chamber that takes the 200 mm assembly and carries its 1 kg');
    expect(small.capableCount).toBe(welders.filter((m) => longest(m) >= 200).length);
    const big = lineOf(routeOf('manual', { joints: ebwJoint, ...sized(1500) }), 'Electron Beam Welding');
    const chosen = welders.find((m) => m.name === big.machineName)!;
    expect(longest(chosen)).toBeGreaterThanOrEqual(1500);
    expect(big.machineChoice!.capableCount).toBe(welders.filter((m) => longest(m) >= 1500).length);
    expect(big.machineChoice!.capableCount).toBeLessThan(small.capableCount);
  });

  it('an assembly longer than every chamber, or heavier than every welder carries, is a named gap', () => {
    const tooLong = lineOf(routeOf('manual', { joints: ebwJoint, ...sized(Math.max(...welders.map(longest)) + 1) }), 'Electron Beam Welding');
    expect((tooLong.physicsGap as { reason: string }).reason).toMatch(/the assembly is \d+ mm long, its chamber takes \d+ mm/);
    const tooHeavy = lineOf(routeOf('manual', { joints: ebwJoint, ...sized(100, 1e6) }), 'Electron Beam Welding');
    expect((tooHeavy.physicsGap as { reason: string }).reason).toMatch(/the assembly weighs 1000000 kg, it carries \d+ kg/);
  });

  it('with no size on file the chamber is not checked, and the line says so', () => {
    const line = lineOf(routeOf('manual', { joints: ebwJoint, ...sized(null, null) }), 'Electron Beam Welding');
    expect(line.physicsGap).toBeUndefined();
    expect(line.machineChoice!.criteria).toContain('Its chamber is not checked: the size of the assembly is not known');
  });

  it('an ultrasonic welder must take the assembly on its table: a bench table by its longer side, a rotary one by its diameter', () => {
    const us = machines['assembly_ultrasonic_welding']!;
    const table = (m: (typeof us)[number]) => (String(m.specs['table_configuration']).toLowerCase() === 'rotary'
      ? machineValue(m, 'max_table_diameter_mm')! : Math.max(machineValue(m, 'max_bench_table_length_mm') ?? 0, machineValue(m, 'max_bench_table_width_mm') ?? 0));
    const fits = (size: number) => us.filter((m) => table(m) >= size).length;
    const small = lineOf(routeOf('manual', { joints: usJoint, ...sized(100) }), 'Ultrasonic Welding').machineChoice!;
    expect(small.capableCount).toBe(fits(100));
    // 600 mm: no bench table takes it (the longest is under 400 mm), the larger rotary tables do.
    const wide = lineOf(routeOf('manual', { joints: usJoint, ...sized(600) }), 'Ultrasonic Welding');
    expect(wide.machineChoice!.capableCount).toBe(fits(600));
    expect(fits(600)).toBeLessThan(fits(100));
    expect(String(us.find((m) => m.name === wide.machineName)!.specs['table_configuration']).toLowerCase()).toBe('rotary');
    const none = lineOf(routeOf('manual', { joints: usJoint, ...sized(5000) }), 'Ultrasonic Welding');
    expect((none.physicsGap as { reason: string }).reason).toMatch(/the assembly is 5000 mm long, its (rotary|bench) table takes \d+ mm/);
  });
});

// The Assembly folder's own order (variables preferVirtualMachines = true: "first try to select a virtual machine, if present and
// feasible"): each welding class has one virtual machine, the "Default" one, beside the named welders.
describe('of the machines that can do a joint, the virtual one comes first', () => {
  const mig = (over: Partial<AssemblyRouteInput> = {}) => routeOf('manual', { joints: [weld()], ...over }).lines.find((l) => l.process === 'Manual MIG Welding')!;

  it('a manual MIG weld is costed on the virtual welder, though a named welder costs less an hour; every capable welder stays counted', () => {
    expect(ref.flag('preferVirtualMachines')).toBe(true);
    const line = mig();
    expect(line.machineName).toBe('Default Mig Weld');
    const choice = line.machineChoice!;
    expect(choice.rule).toContain('of them the virtual machines (preferVirtualMachines)');
    expect(choice.capableCount).toBe(machines['manual_mig_welding']!.length);
    expect(choice.candidates[1]!.reasons).toEqual(['capable, not a virtual machine (preferVirtualMachines)']);
  });

  it('with the switch off the cheapest capable welder is taken', () => {
    const off = mig({ ref: ref.withOverrides(new Map([['preferVirtualMachines', 'false']])) });
    expect(off.machineChoice!.rule).not.toContain('virtual');
    expect(off.totalCost).toBeLessThanOrEqual(mig().totalCost);
  });
});

