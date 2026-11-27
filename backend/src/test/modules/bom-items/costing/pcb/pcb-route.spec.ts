// PCB fabrication on the real memory/PCBA data: the calculators against the reference, the steps a board takes and how they are timed, the
// four routes and the one quoted, the finishes priced beside the specified one, the tooling, the summary and the route comparison.
import { readFileSync } from 'fs';
import { join } from 'path';
import { loadPcbCalculatorSpec, pcbCalculatorsByName } from '../../../../../modules/bom-items/costing/pcb/calculators/pcb-calculator-spec';
import { buildPcbCalculatorsMigrationSql, PCB_CALCULATORS_MIGRATION } from '../../../../../modules/bom-items/costing/pcb/calculators/pcb-calculators-migration';
import { buildPcbCostSummary } from '../../../../../modules/bom-items/costing/pcb/pcb-cost-summary';
import { pcbMeasuredFrom, pcbOverridesFrom } from '../../../../../modules/bom-items/costing/pcb/pcb-cost.service';
import { resolvePcbPart, type PcbMeasured, type PcbOverrides } from '../../../../../modules/bom-items/costing/pcb/pcb-part';
import { buildPcbRoutes, choosePcbRoute, pcbRouteCostWithTooling, PCB_CLASS, type PcbBuild, type PcbRoute } from '../../../../../modules/bom-items/costing/pcb/pcb-route';
import { pcbRouteFor } from '../../../../../modules/bom-items/costing/pcb/pcb-route-comparison';
import { machineValue } from '../../../../../modules/bom-items/costing/casting/sand/sand-machines';
import type { CostSummaryResponseDto } from '../../../../../modules/bom-items/dto/cost-breakdown.dto';
import { allPcbMachines, PCB_DIR, pcbLaminates, realPcbReference } from './pcb-test-data';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { readCsv } = require('../../../../../../migrations/scripts/lib/memory-machine-seed.js') as { readCsv: (p: string) => { rows: Record<string, unknown>[] } };

const ZERO = { qairPerHr: 0, inspTimeMin: 0, samplingRate: 0, yieldPct: 1, netMatCost: 0, netWeightKg: 0, scrapPricePerKg: 0 };
const DEFAULTS = { thicknessMm: 1.6, copperOz: 1, soldermaskSides: 2, viaPlugging: false };
// The FL285182 board as the CAD engine measures its board set (memory/PCBA/Reference): 273.7 x 170.7 mm, 2 layers, 224 plated 0.6 mm and 2
// unplated 1.5 mm holes, mask and legend on both sides, 1,246 pins on nets.
const FL285182: PcbMeasured = {
  source: 'board_files', sourceName: 'FL285182-board-set.zip', outline: { lengthMm: 273.7, widthMm: 170.7, areaMm2: 23161.89 }, layers: 2,
  holes: [{ diameterMm: 0.6, plated: true, count: 224 }, { diameterMm: 1.5, plated: false, count: 2 }],
  soldermask: { top: true, bottom: true }, silkscreen: { top: true, bottom: true }, pins: 1246, pasteAreaMm2: 4000, copperAreaMm2: 30203,
};
const FOUR_LAYER: PcbMeasured = { ...FL285182, outline: { lengthMm: 100, widthMm: 80, areaMm2: 8000 }, layers: 4, pasteAreaMm2: 900 };

function build(measured: PcbMeasured, overrides: PcbOverrides = {}, scenario: { annualVolume?: number | null } = {}): PcbBuild {
  const { part, missing } = resolvePcbPart(measured, overrides, DEFAULTS);
  if (!part) throw new Error(missing.join('; '));
  return buildPcbRoutes({
    ref: realPcbReference(), spec: loadPcbCalculatorSpec(), calculators: pcbCalculatorsByName(), part, laminates: pcbLaminates(), machinesByClass: allPcbMachines(),
    scenario: { batchSize: 500, annualVolume: scenario.annualVolume === undefined ? 6000 : scenario.annualVolume, amortizationParts: 30000, route: null }, costContext: ZERO,
  });
}
const line = (r: PcbRoute, process: string) => {
  const l = r.lines.find((x) => x.process === process);
  if (!l) throw new Error(`no ${process} line`);
  return l;
};
const sec = (r: PcbRoute, process: string) => Math.round(line(r, process).cycleTimeMin * 60 * 100) / 100;

describe('the PCB calculators', () => {
  const spec = loadPcbCalculatorSpec();

  it('are what migration 1132 creates', () => {
    const committed = readFileSync(join(__dirname, `../../../../../../migrations/${PCB_CALCULATORS_MIGRATION}_pcb_calculators.sql`), 'utf8');
    expect(buildPcbCalculatorsMigrationSql()).toBe(committed);
  });

  it('time every PCB process with a machine; Material Stock is the board\'s laminate, priced as a line', () => {
    const processes = readCsv(join(PCB_DIR, 'processes.csv')).rows.map((r) => String(r['Process Name']))
      .filter((p) => !['Material Stock', 'No Cost Feature', 'User-Defined Process', 'Bench Operation'].includes(p) || p === 'Bench Operation');
    const operations = new Set(spec.calculators.flatMap((c) => c.operations));
    expect(processes.filter((p) => !operations.has(p))).toEqual([]);
  });

  it('read only variables memory/PCBA defines, and only machine specs the class\'s machines carry', () => {
    const variables = new Set(readCsv(join(PCB_DIR, 'pcb_variables.csv')).rows.map((r) => String(r['Variable Name'])));
    const named = spec.calculators.flatMap((c) => c.fields.map((f) => (f.source as { variable?: string } | undefined)?.variable).filter((v): v is string => !!v));
    expect(named.filter((v) => !variables.has(v))).toEqual([]);
    const machines = allPcbMachines();
    const classOf: Record<string, string> = Object.fromEntries(Object.values(PCB_CLASS).map((cls) => [cls, cls]));
    for (const c of spec.calculators.filter((x) => x.operations.length)) {
      const process = c.operations[0]!;
      const cls = Object.values(classOf).find((k) => machines[k]?.length && c.name === `PCB - ${process}`) ?? null;
      const keys = c.fields.map((f) => (f.source as { machine?: string } | undefined)?.machine).filter((k): k is string => !!k);
      if (!keys.length || !cls) continue;
      const pool = Object.entries(machines).filter(([, ms]) => ms.length).map(([k, ms]) => ({ k, ms }));
      expect(pool.some(({ ms }) => keys.every((key) => ms.some((m) => machineValue(m, key) != null)))).toBe(true);
    }
  });
});

describe('a 2-layer board (FL285182)', () => {
  const b = build(FL285182);

  it('is one double-clad core, nested one to an array and two arrays to the 18 x 24 in panel', () => {
    expect(b.stackup).toMatchObject({ sequence: ['2PT', '2PB'], innerCores: 0, laminated: false });
    expect(b.nest).toMatchObject({ boardsPerArray: 1, arraysPerPanel: 2, boardsPerPanel: 2, panel: { lengthMm: 609.6, widthMm: 457.2 } });
  });

  it('prices all four routes and quotes the cheapest; the flying probe test program and the stamping die are tooling', () => {
    expect(b.routes.map((r) => [r.key, r.complete])).toEqual([
      ['router_flying_probe', true], ['router_bed_of_nails', true], ['stamp_flying_probe', true], ['stamp_bed_of_nails', true],
    ]);
    const { route, note } = choosePcbRoute(b.routes, b.gaps, null);
    const cheapest = [...b.routes].sort((x, y) => x.totalUsd! - y.totalUsd!)[0]!;
    expect(route).toBe(cheapest);
    expect(note).toMatch(/is quoted \(\d+\.\d\d USD per board\), the cheapest complete route/);
    expect(b.routes.find((r) => r.key === 'stamp_bed_of_nails')!.tooling.map((t) => t.key)).toEqual(['stamp-die', 'bed-of-nails-fixture']);
    expect(b.routes.find((r) => r.key === 'router_flying_probe')!.tooling.map((t) => t.key)).toEqual(['flying-probe-program']);
  });

  it('takes no inner-layer or lamination step, and times each step from the memory/PCBA variables and its machine', () => {
    const r = b.routes[0]!;
    expect(r.lines.map((l) => l.process)).not.toEqual(expect.arrayContaining(['DES', 'Bench Operation', 'Oven Cure Layers', 'Laser Drill Vias']));
    // Photolithography: load 15 s + 2 sides x 20 s exposure + unload 5 s = 60 s a panel, over its 2 boards.
    expect(sec(r, 'Photolithography')).toBe(30);
    // AOI on the Orbotech Fusion 22: 609.6 x 457.2 mm at 18,585 mm²/s, both sides, a 2 s turn and a 15 s load = 47.04 s a panel.
    expect(line(r, 'Automated Optical Inspection').machineName).toBe('Orbotech Fusion 22');
    expect(sec(r, 'Automated Optical Inspection')).toBeCloseTo(23.52, 1);
    // Film imaging: a 15 s load + 2 masked sides x (15 s mount + 60 s expose + 10 s dismount) = 185 s a panel.
    expect(sec(r, 'Film Imaging')).toBeCloseTo(92.5, 0);
  });

  it('prices the laminate as the Material Stock line: the panel\'s area of the 1.6 mm 1 oz core, over its 2 boards', () => {
    const r = b.routes[0]!;
    // 0.6096 x 0.4572 m x 19.48 USD/m² (2Ply-1ozCu-FR4) / 2.
    expect(line(r, 'Material Stock').totalCost).toBeCloseTo((0.6096 * 0.4572 * 19.48) / 2, 4);
    expect(r.material.uses).toEqual([expect.objectContaining({ name: '2Ply-1ozCu-FR4', count: 1, usdPerM2: 19.48 })]);
    expect(r.totalUsd).toBeCloseTo(r.lines.reduce((s, l) => s + l.totalCost, 0), 2);
  });

  it('charges the consumables and the scrap of the fabrication yield as lines', () => {
    const r = b.routes[0]!;
    for (const p of ['Drilling consumables', 'Tin (etch resist)', 'Solder mask', 'Router bits', 'Fabrication yield']) expect(line(r, p).totalCost).toBeGreaterThan(0);
    // No 2-layer yield is sourced: the 4-layer rows (95-98 %) are read, and said.
    expect(line(r, 'Fabrication yield').featureBreakdown![0]!.name).toMatch(/first-pass yield at 4 layers/);
  });

  it('prices the other finishes beside HASL, never quoting them', () => {
    expect(b.finishOptions.map((f) => [f.finish, f.totalUsd != null])).toEqual([['enig', true], ['osp', true]]);
    expect(b.routes[0]!.lines.map((l) => l.process)).toContain('Hot Air Solder Leveling');
  });
});

describe('a 4-layer board', () => {
  const b = build(FOUR_LAYER, { finish: 'enig' });
  const r = choosePcbRoute(b.routes, b.gaps, null).route!;

  it('images its inner core, lays up and laminates foil over it, and builds its 1.00 mm core from the reference\'s 1.6 mm one', () => {
    expect(b.stackup).toMatchObject({ sequence: ['CU', '2PT', '2PB', 'CU'], innerCores: 1, laminated: true, coreDielectricMm: 1 });
    expect(r.lines.map((l) => l.process)).toEqual(expect.arrayContaining(['DES', 'Bench Operation', 'Oven Cure Layers', 'Electroless Nickel Immersion Gold', 'Electroless nickel', 'Immersion gold']));
    // (19.48 - 2 x 3.68) / 1.6 mm = 7.575 USD/m²/mm of dielectric; at 1.00 mm, 2 x 3.68 + 7.575 = 14.935 USD/m².
    expect(r.material.uses.find((u) => u.name.includes('FR4'))).toMatchObject({ usdPerM2: 14.935 });
    expect(r.material.uses.find((u) => u.name === '1ozCu')).toMatchObject({ count: 2 });
  });

  it('presses its stacks one to a shelf for the 3 h cure', () => {
    // (10,800 s + 6 x 60 s load) / 6 shelves = 1,860 s a panel, over its 12 boards.
    expect(b.nest!.boardsPerPanel).toBe(12);
    expect(sec(r, 'Oven Cure Layers')).toBeCloseTo(155, 0);
  });
});

describe('route gates', () => {
  it('drops the flying probe routes above maxFlyingProbeProductionVolume a year, and says why', () => {
    const b = build(FL285182, {}, { annualVolume: 250000 });
    expect(b.routes.map((r) => r.key)).toEqual(['router_bed_of_nails', 'stamp_bed_of_nails']);
    expect(b.gaps[0]!.reason).toBe('250,000 boards a year is more than a flying probe tests (maxFlyingProbeProductionVolume 100,000)');
  });

  it('leaves the flying probe a named gap when nothing states the test points', () => {
    const b = build({ ...FL285182, pins: null });
    expect(b.routes.find((r) => r.key === 'router_flying_probe')!.complete).toBe(false);
    expect(b.routes.find((r) => r.key === 'router_bed_of_nails')!.complete).toBe(true);
    expect(choosePcbRoute(b.routes, b.gaps, null).route!.test).toBe('bed_of_nails');
  });

  it('builds no board of a layer count the stack-up table does not build', () => {
    expect(build({ ...FL285182, layers: 3 }).missing).toEqual(['a 3-layer build: tblLayerMaterialType builds 1, 2, 4, 6, 8, 10, 12 layers']);
  });
});

describe('the summary and the route comparison', () => {
  it('reads the board from the CAD engine\'s board feature graph and the Cost Guide', () => {
    const measured = pcbMeasuredFrom({
      extractionVersion: 'pcb_v1', source: 'board_files', sourceName: 'set.zip', filesReport: [],
      graph: { outline: { lengthMm: 273.7, widthMm: 170.7, areaMm2: 23161.89 }, layers: 2, holes: [{ diameterMm: 0.6, plated: true, count: 224 }],
        fabrication: { soldermask: { top: true, bottom: true } }, connectivity: { pins: 1246, netsWithPins: 300 }, pasteAreaMm2: { top: 3000, bottom: 1000 }, copper: { areaMm2: { top: 8269.8, bottom: 21934.1 } } },
    });
    expect(measured).toMatchObject({ layers: 2, pins: 1246, pasteAreaMm2: 4000, soldermask: { top: true, bottom: true } });
    expect(measured!.copperAreaMm2).toBeCloseTo(30203.9, 6);
    expect(pcbOverridesFrom({ pcbLayers: '4', pcbFinish: 'ENIG', pcbViaPlugging: 'true' })).toMatchObject({ layers: 4, finish: 'enig', viaPlugging: true });
  });

  it('quotes the cheapest route in a summary of family pcb, its tooling apart, and every route in the comparison', () => {
    const b = build(FL285182);
    const { part } = resolvePcbPart(FL285182, {}, DEFAULTS);
    const { route, note } = choosePcbRoute(b.routes, b.gaps, null);
    const summary = buildPcbCostSummary({
      pcb: { route, routes: b.routes, gaps: b.gaps, part, stackup: b.stackup, nest: b.nest, finishOptions: b.finishOptions, assembly: b.assembly, note, missing: [], warnings: route!.warnings },
      batchSize: 500, warnings: [], ratesSource: 'test',
    });
    expect(summary).toMatchObject({ family: 'pcb', materialCost: 0, totalCost: route!.totalUsd });
    expect(summary.pcb).toMatchObject({ route: route!.key, complete: true, nest: { boardsPerPanel: 2 }, board: { layers: { value: 2, basis: 'board_files' }, thicknessMm: { basis: 'reference_default' } } });
    expect(summary.pcbTooling!.map((t) => t.key)).toEqual(route!.tooling.map((t) => t.key));
    const quoted = pcbRouteFor(route!.key, summary as CostSummaryResponseDto);
    expect(quoted).toMatchObject({ isFeasible: true, dataComplete: true, totalCost: route!.totalUsd, routeId: `pcb-${route!.key}` });
    const other = b.routes.find((x) => x.key !== route!.key)!;
    expect(pcbRouteFor(other.key, summary as CostSummaryResponseDto)).toMatchObject({ isFeasible: false, totalCost: null });
  });
});

// A stamping die or a bed of nails fixture is part of what a route costs: the routes are compared with their tooling spread over the boards.
describe('the route to quote counts its tooling', () => {
  const route = (key: string, totalUsd: number, toolingPerBoard: Array<number | null>): PcbRoute => ({
    key, label: key, complete: true, totalUsd, lines: [],
    tooling: toolingPerBoard.map((perPartUsd, i) => ({ key: `tool-${i}`, description: 'tool', detail: '', costUsd: perPartUsd == null ? null : perPartUsd * 1000, perPartUsd, amortizationParts: perPartUsd == null ? null : 1000 })),
  }) as unknown as PcbRoute;

  it('a route cheaper a board but with a dear die loses to the route that costs less with its tooling', () => {
    const stamped = route('stamp_bed_of_nails', 2.0, [1.5, 0.4]);   // 3.90 with tooling
    const routed = route('router_flying_probe', 2.6, [0.2]);        // 2.80 with tooling
    expect(pcbRouteCostWithTooling(stamped)).toBeCloseTo(3.9, 6);
    const { route: quoted, note } = choosePcbRoute([stamped, routed], [], null);
    expect(quoted).toBe(routed);
    expect(note).toBe('PCB: router_flying_probe is quoted (2.60 USD per board), the cheapest complete route with its tooling spread over the boards (2.80 USD per board with tooling; the quoted figure is material, process and consumables, the tooling shown apart). stamp_bed_of_nails 2.00 USD (3.90 USD with tooling).');
  });

  it('at a volume that spreads the die thin, the stamped route wins again', () => {
    const stamped = route('stamp_bed_of_nails', 2.0, [0.015, 0.004]);
    const routed = route('router_flying_probe', 2.6, [0.002]);
    expect(choosePcbRoute([stamped, routed], [], null).route).toBe(stamped);
  });

  it('when a tool has no price or no boards to be spread over, the routes are compared on the piece cost, and the note says so', () => {
    const stamped = route('stamp_bed_of_nails', 2.0, [null, 0.4]);
    const routed = route('router_flying_probe', 2.6, [0.2]);
    expect(pcbRouteCostWithTooling(stamped)).toBeNull();
    const { route: quoted, note } = choosePcbRoute([stamped, routed], [], null);
    expect(quoted).toBe(stamped);
    expect(note).toContain('its tooling is shown apart and not compared: it has no price or no boards to be spread over');
  });

  it('the route set in the Cost Guide stands, whatever the tooling', () => {
    const stamped = route('stamp_bed_of_nails', 2.0, [1.5]);
    const routed = route('router_flying_probe', 2.6, [0.2]);
    expect(choosePcbRoute([stamped, routed], [], 'stamp_bed_of_nails' as never).route).toBe(stamped);
  });
});

