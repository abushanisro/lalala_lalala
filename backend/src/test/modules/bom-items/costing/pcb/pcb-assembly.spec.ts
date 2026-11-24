// PCB assembly on the real memory/PCBA/Assembly data: what is included and why, the SMT line per populated side, through-hole insertion and
// the cheapest soldering, the test over the job, depanel, the stencils and test tooling, the region's prices, and the calculators' migration.
import { readFileSync } from 'fs';
import { join } from 'path';
import { loadPcbCalculatorSpec, pcbCalculatorsByName } from '../../../../../modules/bom-items/costing/pcb/calculators/pcb-calculator-spec';
import { buildPcbAssemblyCalculatorsMigrationSql, PCB_ASSEMBLY_CALCULATORS_MIGRATION } from '../../../../../modules/bom-items/costing/pcb/calculators/pcb-calculators-migration';
import { buildPcbCostSummary } from '../../../../../modules/bom-items/costing/pcb/pcb-cost-summary';
import { pcbAssemblyChoiceFrom } from '../../../../../modules/bom-items/costing/pcb/pcb-cost.service';
import { assemblyIncluded, type PcbAssemblyChoice } from '../../../../../modules/bom-items/costing/pcb/pcb-assembly';
import { resolvePcbPart, type PcbMeasured } from '../../../../../modules/bom-items/costing/pcb/pcb-part';
import { buildPcbRoutes, choosePcbRoute, type PcbBuild, type PcbRoute } from '../../../../../modules/bom-items/costing/pcb/pcb-route';
import { allPcbMachines, pcbLaminates, realPcbReference } from './pcb-test-data';

const ZERO = { qairPerHr: 0, inspTimeMin: 0, samplingRate: 0, yieldPct: 1, netMatCost: 0, netWeightKg: 0, scrapPricePerKg: 0 };
const DEFAULTS = { thicknessMm: 1.6, copperOz: 1, soldermaskSides: 2, viaPlugging: false };
const AUTO: PcbAssemblyChoice = { mode: 'auto', thtSolder: null, test: null };

// The DC-DC converter's PCBA (memory/PCBA/Reference: 64 x 50 mm, 2 layers, HASL): 57 surface-mount parts, 14 on the top and 43 on the
// bottom, 3 through-hole parts on the top.
const DCDC: PcbMeasured = {
  source: 'board_files', sourceName: 'dcdc-board-set.zip', outline: { lengthMm: 64, widthMm: 50, areaMm2: 3200 }, layers: 2,
  holes: [{ diameterMm: 0.4, plated: true, count: 40 }, { diameterMm: 1.0, plated: true, count: 8 }],
  soldermask: { top: true, bottom: true }, silkscreen: { top: true, bottom: false }, pins: 139, nets: 42,
  pasteAreaMm2: 260, pasteAreaBySideMm2: { top: 90, bottom: 170 }, copperAreaMm2: 3600,
  placements: [
    { side: 'top', packageClass: 'chip_0603', count: 6, footprint: 'R0603' }, { side: 'top', packageClass: 'htssop', count: 1, footprint: 'HTSSOP-20' },
    { side: 'top', packageClass: 'chip_1206', count: 7, footprint: 'C1206' },
    { side: 'bottom', packageClass: 'chip_0603', count: 6, footprint: 'C0603' }, { side: 'bottom', packageClass: 'chip_0805', count: 9, footprint: 'R0805' },
    { side: 'bottom', packageClass: 'chip_1206', count: 9, footprint: 'C1206' }, { side: 'bottom', packageClass: 'dpak', count: 3, footprint: 'TO-252' },
    { side: 'bottom', packageClass: 'sod', count: 16, footprint: 'SOD-323' },
  ],
  thtParts: [{ label: 'Radial capacitor', count: 1, jointsPerPart: 2 }, { label: 'Terminal', count: 2, jointsPerPart: 3 }],
};

function build(measured: PcbMeasured, choice: PcbAssemblyChoice = AUTO, opts: { bom?: number; location?: string; inrPerUsd?: number | null; annualVolume?: number | null; amortizationParts?: number | null } = {}): PcbBuild {
  const { part, missing } = resolvePcbPart(measured, {}, DEFAULTS);
  if (!part) throw new Error(missing.join('; '));
  return buildPcbRoutes({
    ref: realPcbReference(), spec: loadPcbCalculatorSpec(), calculators: pcbCalculatorsByName(), part, laminates: pcbLaminates(), machinesByClass: allPcbMachines(),
    scenario: { batchSize: 500, annualVolume: opts.annualVolume === undefined ? 6000 : opts.annualVolume, amortizationParts: opts.amortizationParts === undefined ? 30000 : opts.amortizationParts, route: null },
    costContext: ZERO,
    assembly: { choice, bomComponents: opts.bom ?? 0, region: { location: opts.location ?? 'USA', inrPerUsd: opts.inrPerUsd ?? null } },
  });
}
const quoted = (b: PcbBuild): PcbRoute => choosePcbRoute(b.routes, b.gaps, null).route!;
const line = (r: PcbRoute, process: string) => r.lines.find((x) => x.process === process);
const sec = (r: PcbRoute, process: string) => Math.round((line(r, process)?.cycleTimeMin ?? NaN) * 60 * 100) / 100;

describe('the PCB assembly calculators', () => {
  it('are what migration 1134 creates', () => {
    const committed = readFileSync(join(__dirname, `../../../../../../migrations/${PCB_ASSEMBLY_CALCULATORS_MIGRATION}_pcba_assembly_calculators.sql`), 'utf8');
    expect(buildPcbAssemblyCalculatorsMigrationSql()).toBe(committed);
  });
});

describe('the DC-DC converter PCBA', () => {
  const b = build(DCDC);
  const r = quoted(b);
  const a = b.assembly!;

  it('is assembled automatically from its Pick Place file, and says which processes are included', () => {
    expect(a).toMatchObject({ included: true, mode: 'auto', counts: { placements: 57, placementsBySide: { top: 14, bottom: 43 }, feeders: 8, thtParts: 3, joints: 8, nets: 42 } });
    expect(a.basis).toMatch(/included automatically: the Pick Place file places 57 surface-mount and 3 through-hole/);
    expect(a.processes.map((p) => `${p.group}: ${p.steps.join(', ')} (${p.basis})`)).toEqual([
      'SMT top: Stencil Print, Solder Paste Inspection, Pick and Place (3 placers in series), Reflow Solder, Assembly AOI (auto)',
      'SMT bottom: Stencil Print, Solder Paste Inspection, Pick and Place (3 placers in series), Reflow Solder, Assembly AOI (auto)',
      'THT: THT Insertion, Selective Solder (auto)', 'Test: In-Circuit Test (auto)', 'Depanel: Depanel Router (auto)',
    ]);
    expect(r.complete).toBe(true);
  });

  it('times the SMT line from the files and the sourced rates, per array of 16 boards', () => {
    // 57 placements at the YSM20R's IPC rate (60 % of its rated 95,000 cph) x the 60 % a line achieves: 57 / 34,200 x 3600 = 6 s.
    expect(sec(r, 'Pick and Place')).toBe(6);
    // The printer's core cycle (6-12 s, midpoint 9 s) for each of the 2 sides, shared by the 16 boards of the 279.4 x 215.9 mm array.
    expect(sec(r, 'Stencil Print')).toBeCloseTo((9 * 2) / 16, 1);
    // The array through the Kait oven at the middle of its 300-2000 mm/min conveyor, both sides: 279.4 / 1150 x 60 x 2 / 16.
    expect(sec(r, 'Reflow Solder')).toBeCloseTo((279.4 / 1150) * 60 * 2 / 16, 1);
    expect(line(r, 'Reflow Solder')!.machineName).toBe('Kait KTE-1000');
  });

  it('sets the line up once a side and batch, balances it with placers in series, and charges its wait on its slowest machine', () => {
    const smt = ['Stencil Print', 'Solder Paste Inspection', 'Pick and Place', 'Reflow Solder', 'Assembly AOI'].map((p) => line(r, p)!);
    const rate = (l: (typeof smt)[number]) => l.hourlyRate + (l.labourRate ?? 0) * (l.operators ?? 0);
    const others = smt.filter((l) => l.process !== 'Pick and Place');
    const placer = rate(smt[2]!);
    const otherSec = Math.max(...others.map((l) => (l.cycleTimeMin * 60) / 2));
    // Placement takes 14 / 34,200 x 3600 = 1.47 s on the top and 4.53 s on the bottom; the other machines at most otherSec a side.
    const takt = (n: number) => Math.max(otherSec, (14 / 34200) * 3600 / n) + Math.max(otherSec, (43 / 34200) * 3600 / n);
    const cost = (n: number) => takt(n) * (others.reduce((t, l) => t + rate(l), 0) + n * placer) / 3600;
    // Of 1 to 3 placers in series (the line studies run 1-3), three make the line cheapest.
    expect(a.smtLine).toMatchObject({ placers: 3, maxPlacers: 3 });
    expect(cost(3)).toBeLessThan(Math.min(cost(1), cost(2)));
    expect(a.smtLine!.taktSec).toBeCloseTo(takt(3), 1);
    const busy = smt.reduce((t, l) => t + l.runCost, 0);
    expect(line(r, 'SMT Line Balance')!.totalCost).toBeCloseTo(cost(3) - busy, 2);
    // The changeover: (45 min x 2 sides + 1.67 min x 8 feeders) at the line's rate (3 placers), over the batch of 500.
    const changeover = line(r, 'SMT Line Changeover')!;
    expect(changeover.runCost).toBe(0);
    expect(changeover.setupCost).toBeCloseTo(((45 * 2 + 1.67 * 8) / 60) * (others.reduce((t, l) => t + rate(l), 0) + 3 * placer) / 500, 2);
  });

  it('solders the through-hole joints the cheapest way that can: wave is refused with surface-mount parts underneath', () => {
    expect(a.thtSolder!.chosen).toBe('selective');
    const wave = a.thtSolder!.options.find((o) => o.key === 'wave')!;
    expect(wave).toMatchObject({ perBoardUsd: null });
    expect(wave.reason).toMatch(/bottom side carries 43 surface-mount part/);
    const priced = a.thtSolder!.options.filter((o) => o.perBoardUsd != null);
    expect(Math.min(...priced.map((o) => o.perBoardUsd!))).toBe(a.thtSolder!.options.find((o) => o.key === 'selective')!.perBoardUsd);
    // 3 parts at 300 an hour (200-400) by hand; 8 joints at 2.5 s (1.5-3.5).
    expect(sec(r, 'THT Insertion')).toBeCloseTo(36, 1);
    expect(sec(r, 'Selective Solder')).toBeCloseTo(20, 1);
  });

  it('tests in circuit when the fixture pays over the job, else by flying probe', () => {
    expect(a.test!.chosen).toBe('ict');
    expect(r.tooling.map((t) => t.key)).toEqual(expect.arrayContaining(['smt-stencils', 'ict-fixture', 'pcba-test-program']));
    const fixture = r.tooling.find((t) => t.key === 'ict-fixture')!;
    expect(fixture.costUsd).toBe(5000);
    // 42 nets is at or under 500: the 500-net time (2-5 s, midpoint 3.5 s).
    expect(sec(r, 'In-Circuit Test')).toBeCloseTo(3.5, 1);
    const short = build(DCDC, AUTO, { annualVolume: 500, amortizationParts: 500 }).assembly!;
    expect(short.test!.chosen).toBe('flying_probe');
    const none = build(DCDC, AUTO, { annualVolume: null, amortizationParts: null }).assembly!;
    expect(none.test!.chosen).toBe('flying_probe');
    expect(none.warnings.join(' ')).toMatch(/nothing to spread an in-circuit fixture over/);
  });

  it('routes the boards out of their array and prices the paste the populated sides print', () => {
    expect(line(r, 'Depanel Router')!.machineName).toBe('Indus Robotics PCB depaneling router');
    // The 228 mm outline at the router's 1-100 mm/s (midpoint 50.5).
    expect(sec(r, 'Depanel Router')).toBeCloseTo(228 / 50.5, 1);
    // 260 mm² of openings x 0.1 mm stencil x 4.14 g/cm³ = 0.108 g, at the USA SAC305 price (233.19-341.40 USD/kg).
    expect(line(r, 'Solder Paste')!.totalCost).toBeCloseTo(0.10764 * ((233.185 + 341.4) / 2) / 1000, 4);
  });

  it('carries the assembly on every route, after the bare board\'s fabrication yield', () => {
    for (const route of b.routes) {
      const processes = route.lines.map((l) => l.process);
      expect(processes.indexOf('Fabrication yield')).toBeLessThan(processes.indexOf('Stencil Print'));
      expect(processes).toContain('In-Circuit Test');
    }
  });

  it('shows the assembly in the summary: the processes included, the choices and the counts', () => {
    const { part } = resolvePcbPart(DCDC, {}, DEFAULTS);
    const summary = buildPcbCostSummary({
      pcb: { route: r, routes: b.routes, gaps: b.gaps, part, stackup: b.stackup, nest: b.nest, finishOptions: b.finishOptions, assembly: a, note: null, missing: [], warnings: [] },
      batchSize: 500, warnings: [], ratesSource: 'test',
    });
    expect(summary.pcb!.assembly).toMatchObject({ included: true, mode: 'auto', counts: { placementsTop: 14, placementsBottom: 43 }, thtSolder: { chosen: 'selective' }, test: { chosen: 'ict' } });
    expect(summary.pcb!.assembly!.processes[0]!.group).toBe('Bare board fab');
    expect(summary.pcbTooling!.map((t) => t.key)).toEqual(r.tooling.map((t) => t.key));
  });
});

describe('what the Cost Guide says about the assembly', () => {
  it('reads Auto unless set, and a method only when it is one', () => {
    expect(pcbAssemblyChoiceFrom({})).toEqual({ mode: 'auto', thtSolder: null, test: null });
    expect(pcbAssemblyChoiceFrom({ pcbAssembly: 'bare', pcbThtSolder: 'hand', pcbAssemblyTest: 'flying_probe' })).toEqual({ mode: 'bare', thtSolder: 'hand', test: 'flying_probe' });
    expect(pcbAssemblyChoiceFrom({ pcbAssembly: 'sometimes', pcbThtSolder: 'glue' })).toEqual({ mode: 'auto', thtSolder: null, test: null });
  });

  it('prices the bare board only when told to, and the same bare board as an unpopulated one', () => {
    const bare = build(DCDC, { mode: 'bare', thtSolder: null, test: null });
    expect(bare.assembly).toMatchObject({ included: false, basis: 'Bare board only: set in the Cost Guide', lines: [] });
    const blank = build({ ...DCDC, placements: [], thtParts: [] });
    expect(blank.assembly!.included).toBe(false);
    expect(quoted(bare).totalUsd).toBe(quoted(blank).totalUsd);
    expect(quoted(build(DCDC)).totalUsd!).toBeGreaterThan(quoted(bare).totalUsd!);
  });

  it('takes the soldering and test the user sets, even when dearer', () => {
    const b = build(DCDC, { mode: 'auto', thtSolder: 'hand', test: 'flying_probe' });
    expect(b.assembly!.thtSolder).toMatchObject({ chosen: 'hand', basis: 'user' });
    expect(b.assembly!.test).toMatchObject({ chosen: 'flying_probe', basis: 'user' });
    expect(line(quoted(b), 'Hand Solder')).toBeDefined();
    expect(line(quoted(b), 'Selective Solder')).toBeUndefined();
  });

  it('includes a board with BOM components but no Pick Place file, and names what is missing (Apply still writes it)', () => {
    const b = build({ ...DCDC, placements: [], thtParts: [] }, AUTO, { bom: 37 });
    expect(b.assembly).toMatchObject({ included: true });
    expect(b.assembly!.basis).toMatch(/37 component\(s\) as BOM children/);
    const r = quoted(b);
    expect(r.complete).toBe(false);
    expect(JSON.stringify(line(r, 'Pick and Place')!.physicsGap)).toMatch(/no Pick Place file says where they go/);
    expect(assemblyIncluded(resolvePcbPart(DCDC, {}, DEFAULTS).part!, 'include', 0).basis).toBe('Assembly: set to Include in the Cost Guide');
  });

  it('wave-solders a board with nothing underneath, the cheapest of the three', () => {
    const topOnly = build({ ...DCDC, placements: DCDC.placements!.filter((p) => p.side === 'top') });
    expect(topOnly.assembly!.counts.sides).toEqual(['top']);
    expect(topOnly.assembly!.thtSolder!.options.find((o) => o.key === 'wave')!.perBoardUsd).not.toBeNull();
    expect(topOnly.assembly!.thtSolder!.chosen).toBe('wave');
  });
});

describe('the region\'s prices', () => {
  it('prices India\'s stencils and paste in rupees at the app\'s rate, and another location at the USA\'s, said', () => {
    const india = build(DCDC, AUTO, { location: 'India', inrPerUsd: 89 });
    const stencil = india.routes[0]!.tooling.find((t) => t.key === 'smt-stencils')!;
    expect(stencil.costUsd).toBeCloseTo((2 * 5250) / 89, 2);
    expect(stencil.detail).toMatch(/5250 inr_per_stencil \(midpoint of 4000-6500, 3 sources\) \/ 89 INR per USD/);
    const mexico = build(DCDC, AUTO, { location: 'Mexico' });
    expect(mexico.routes[0]!.tooling.find((t) => t.key === 'smt-stencils')!.detail).toMatch(/none sourced for Mexico/);
  });
});
