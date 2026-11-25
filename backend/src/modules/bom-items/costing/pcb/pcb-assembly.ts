// A printed circuit board's assembly (PCBA), priced on the sourced memory/PCBA/Assembly data (migrations 1133, 1134). Pure.
//
// The board files say what goes on the board: the Pick Place file's surface-mount placements by side and footprint, the through-hole parts
// and their joints, the paste openings and the nets. Each populated side goes down the SMT line (stencil print, solder paste inspection,
// pick and place, reflow, AOI), the line set up once per side and batch (the line changeover) and held, in line, for its slowest machine
// (the line balance). Through-hole parts are inserted by hand and soldered by wave, selective or hand soldering, the cheapest that can; the
// board is tested in circuit (a fixture is tooling) or by flying probe, the cheaper over the job; boards made in an array are routed out.
//
// Assembly is included automatically when the board has parts to place (the Pick Place file) or BOM children; the Cost Guide can include
// it, or price the bare board only. The parts themselves are the BOM children's own cost, never counted here.
import type { ProcessLineCost } from '../../dto/cost-breakdown.dto';
import type { CalcSeed, ReferenceCalcRun } from '../shared/calculators/reference-calculator';
import { machineValue, type SandMachine } from '../casting/sand/sand-machines';
import type { SandReference } from '../casting/sand/sand-reference';
import type { CostedStep, StepOutcome } from '../casting/sand/sand-steps';
import type { PcbNest } from './pcb-panel';
import { pcbFactRef, type BoardSide, type PcbPart } from './pcb-part';
import { saySourced, sourcedRef, type SourcedValue } from './pcb-reference';
import { batchSizeSeed, derivedSeed, inputStep, resultStep, seedStep } from '../shared/calculators/seed-refs';
import type { SourceRef } from '../../dto/cost-breakdown.dto';

/** The HR Rates machine class of each assembly process (migration 1133); insertion and hand soldering are bench work. */
export const PCBA_CLASS = {
  print: 'pcba_stencil_printer', spi: 'pcba_solder_paste_inspection', place: 'pcba_pick_and_place', reflow: 'pcba_reflow', aoi: 'pcba_aoi',
  wave: 'pcba_wave_solder', selective: 'pcba_selective_solder', ict: 'pcba_in_circuit_test', flyingProbe: 'pcba_flying_probe',
  depanel: 'pcba_depanel_router', bench: 'pcb_bench_operation',
} as const;
export const PCBA_ROUTE_CLASSES: readonly string[] = Object.values(PCBA_CLASS);

export const PCBA_HELPER = {
  changeover: 'PCB - SMT line changeover', balance: 'PCB - SMT line balance', paste: 'PCB - Solder paste', fixture: 'PCB - ICT fixture',
} as const;

export const PCBA_MODES = ['auto', 'include', 'bare'] as const;
export type PcbAssemblyMode = (typeof PCBA_MODES)[number];
export const PCBA_THT_SOLDERS = ['wave', 'selective', 'hand'] as const;
export type PcbThtSolder = (typeof PCBA_THT_SOLDERS)[number];
export const PCBA_TESTS = ['ict', 'flying_probe'] as const;
export type PcbAssemblyTest = (typeof PCBA_TESTS)[number];
const THT_LABEL: Readonly<Record<PcbThtSolder, string>> = { wave: 'Wave Solder', selective: 'Selective Solder', hand: 'Hand Solder' };
const TEST_LABEL: Readonly<Record<PcbAssemblyTest, string>> = { ict: 'In-Circuit Test', flying_probe: 'Assembly Flying Probe' };

/** What the Cost Guide states about the assembly. */
export interface PcbAssemblyChoice {
  mode: PcbAssemblyMode;
  thtSolder: PcbThtSolder | null;
  test: PcbAssemblyTest | null;
}

/** The region whose sourced prices the assembly takes, and how its currency converts. */
export interface PcbAssemblyRegion {
  /** The location quoted. */
  location: string;
  /** Indian rupees per US dollar (the app's rate), for an India quote; null elsewhere. */
  inrPerUsd: number | null;
}

/** The route builder's own tools, so an assembly step is selected, timed and costed exactly as a fabrication step is. */
export interface PcbAssemblyKit {
  ref: SandReference;
  part: PcbPart;
  nest: PcbNest;
  batchSize: number;
  amortizationParts: number | null;
  annualVolume: number | null;
  machinesByClass: Readonly<Record<string, readonly SandMachine[]>>;
  step: (process: string, machineClass: string, evaluate: (m: SandMachine) => StepOutcome, criteria: string[]) => CostedStep;
  timed: (process: string, m: SandMachine, engine?: Record<string, CalcSeed | undefined>) => StepOutcome;
  run: (calculator: string, m: SandMachine | null, engine: Record<string, CalcSeed | undefined>) => { run: ReferenceCalcRun } | { reasons: string[] };
  fail: (...reasons: string[]) => StepOutcome;
  /** A line of material or consumable (no machine time), carrying its calculator run. */
  consumableLine: (process: string, machineClass: string, r: ReferenceCalcRun, detail: string) => ProcessLineCost;
  gapLine: (process: string, machineClass: string, reason: string) => ProcessLineCost;
}

export interface PcbAssemblyTool { key: string; description: string; detail: string; costUsd: number | null }

export interface PcbAssemblyOption<K extends string> { key: K; label: string; perBoardUsd: number | null; reason: string | null }

export interface PcbAssembly {
  included: boolean;
  mode: PcbAssemblyMode;
  /** Why it is included or not, in words. */
  basis: string;
  /** The processes the quote includes, each group with its steps and whether it was decided automatically or set by the user. */
  processes: { group: string; steps: string[]; basis: 'auto' | 'user' }[];
  counts: {
    placements: number; placementsBySide: Partial<Record<BoardSide, number>>; feeders: number; sides: BoardSide[];
    thtParts: number; joints: number; nets: number | null; bomComponents: number;
  };
  lines: ProcessLineCost[];
  tooling: PcbAssemblyTool[];
  /** The SMT line the board runs on: the placers in series (the cheapest line of 1 to the most a source runs) and its takt; null without SMT. */
  smtLine: { placers: number; maxPlacers: number; taktSec: number } | null;
  thtSolder: { chosen: PcbThtSolder | null; basis: 'auto' | 'user'; options: PcbAssemblyOption<PcbThtSolder>[] } | null;
  test: { chosen: PcbAssemblyTest | null; basis: 'auto' | 'user'; options: PcbAssemblyOption<PcbAssemblyTest>[] } | null;
  warnings: string[];
}

type Row = Readonly<Record<string, unknown>>;
const num = (v: unknown): number | null => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const r2 = (n: number) => Math.round(n * 100) / 100;
const r4 = (n: number) => Math.round(n * 10000) / 10000;

/** A keyed sourced value of memory/PCBA/Assembly (assembly_rates or assembly_costs), its rows narrowed to a region when given. */
function sourcedOf(rows: readonly Row[], key: string, table: string, region?: string): SourcedValue | null {
  const keyed = rows.filter((r) => r['item_key'] === key && (region == null || r['region'] === region || r['region'] === 'any'));
  const lows = keyed.map((r) => num(r['value_min'])).filter((x): x is number => x != null);
  const highs = keyed.map((r) => num(r['value_max']) ?? num(r['value_min'])).filter((x): x is number => x != null);
  if (!lows.length || !highs.length) return null;
  const min = Math.min(...lows);
  const max = Math.max(...highs);
  return {
    key, min, max, mid: (min + max) / 2, unit: String(keyed[0]?.['unit'] ?? ''),
    sources: keyed.map((r) => ({ url: String(r['source_url'] ?? ''), date: String(r['source_date'] ?? ''), note: String(r['source_note'] ?? '') })),
    table, columns: ['value_min', 'value_max'] as const, row: { item_key: key },
  };
}
export const assemblyRate = (ref: SandReference, key: string): SourcedValue | null => sourcedOf(ref.table('assembly_rates'), key, 'assembly_rates');
export const assemblyCost = (ref: SandReference, key: string, region: string): SourcedValue | null => sourcedOf(ref.table('assembly_costs'), key, 'assembly_costs', region);

/** Whether the board is assembled, and why. */
export function assemblyIncluded(part: PcbPart, mode: PcbAssemblyMode, bomComponents: number): { included: boolean; basis: string } {
  const placed = part.placements.reduce((s, p) => s + p.count, 0);
  const tht = part.thtParts.reduce((s, t) => s + t.count, 0);
  if (mode === 'bare') return { included: false, basis: 'Bare board only: set in the Cost Guide' };
  if (mode === 'include') return { included: true, basis: 'Assembly: set to Include in the Cost Guide' };
  if (placed + tht > 0) return { included: true, basis: `Assembly included automatically: the Pick Place file places ${placed} surface-mount and ${tht} through-hole part(s)` };
  if (bomComponents > 0) return { included: true, basis: `Assembly included automatically: the board has ${bomComponents} component(s) as BOM children` };
  const bodies = part.modelComponents ? part.modelComponents.top + part.modelComponents.bottom : 0;
  if (bodies > 0) {
    return { included: true, basis: `Assembly included automatically: the 3D model shows ${bodies} part(s) on the board (${part.modelComponents!.top} on the top, ${part.modelComponents!.bottom} on the bottom)` };
  }
  return { included: false, basis: 'Bare board: the board files place no parts and the board has no BOM children (set Assembly to Include in the Cost Guide to assemble it)' };
}

/** The assembly of a board: its lines (each step on the cheapest capable machine), tooling, and the choices made. */
export function buildPcbAssembly(kit: PcbAssemblyKit, choice: PcbAssemblyChoice, region: PcbAssemblyRegion, bomComponents: number): PcbAssembly {
  const { ref, part, nest } = kit;
  const warnings: string[] = [];
  const seed = (value: number, source: string): CalcSeed => ({ value, source });
  const sourced = (v: SourcedValue, what: string, scale = 1, unit = ''): CalcSeed =>
    ({ value: r4(v.mid * scale), source: `${what}: ${saySourced(v)}${scale !== 1 ? ` x ${scale}${unit ? ` ${unit}` : ''}` : ''} (${v.sources.map((s) => s.url).join(', ')})`, ref: sourcedRef(v, what, scale, unit) });
  // The placements of the Pick Place file, each side's, as the steps a count is made of.
  const placedOn = (side: BoardSide) => part.placements.filter((p) => p.side === side && p.count > 0);
  const placementSteps = (sidesOf: readonly BoardSide[]) => sidesOf.flatMap((s) => placedOn(s).map((p) =>
    inputStep(`${s}: ${p.footprint ?? p.packageClass}`, null, p.count, `${part.placementsSource ?? 'the Pick Place file'}: ${p.packageClass}`)));
  const machineRef = (m: SandMachine, column: string): SourceRef => ({ kind: 'machine', machineId: m.id, machineName: m.name, machineClass: m.machineClass, location: m.location, column });
  /** A machine's hourly rate as the line charges it: its machine rate and its crew's labour. */
  const rateSteps = (m: SandMachine, times = 1) => [
    inputStep(`${times > 1 ? `${times} x ` : ''}${m.name} machine rate`, 'USD/h', m.machineRatePerHr ?? 0, `machine ${m.name}: mhr_usd_per_hour`, machineRef(m, 'mhr_usd_per_hour')),
    inputStep(`${m.name} labour rate`, 'USD/h', m.labourRatePerHr ?? 0, `machine ${m.name}: usd_labor_rate_per_hr`, machineRef(m, 'usd_labor_rate_per_hr')),
    inputStep(`${m.name} operators`, null, m.operators ?? 0, `machine ${m.name}: operators`, machineRef(m, 'operators')),
  ];

  const bySide: Partial<Record<BoardSide, number>> = {};
  const feedersBySide: Partial<Record<BoardSide, Set<string>>> = {};
  for (const p of part.placements) {
    if (p.count <= 0) continue;
    bySide[p.side] = (bySide[p.side] ?? 0) + p.count;
    (feedersBySide[p.side] ??= new Set()).add(p.footprint ?? p.packageClass);
  }
  const sides = (['top', 'bottom'] as const).filter((s) => (bySide[s] ?? 0) > 0);
  const placements = sides.reduce((s, x) => s + bySide[x]!, 0);
  const feeders = sides.reduce((s, x) => s + feedersBySide[x]!.size, 0);
  const thtParts = part.thtParts.reduce((s, t) => s + t.count, 0);
  const joints = part.thtParts.reduce((s, t) => s + t.count * t.jointsPerPart, 0);
  const nets = part.nets?.value ?? part.testPoints?.value ?? null;
  const counts = { placements, placementsBySide: bySide, feeders, sides: [...sides], thtParts, joints, nets, bomComponents };
  const { included, basis } = assemblyIncluded(part, choice.mode, bomComponents);
  const empty: PcbAssembly = { included, mode: choice.mode, basis, processes: [], counts, lines: [], tooling: [], smtLine: null, thtSolder: null, test: null, warnings };
  if (!included) return empty;

  const lines: ProcessLineCost[] = [];
  const tooling: PcbAssemblyTool[] = [];
  const processes: PcbAssembly['processes'] = [];
  const userBasis = choice.mode === 'include' ? 'user' as const : 'auto' as const;
  if (placements + thtParts === 0) {
    lines.push(kit.gapLine('Pick and Place', PCBA_CLASS.place, bomComponents > 0 || (part.modelComponents && part.modelComponents.top + part.modelComponents.bottom > 0)
      ? `the board has parts (${bomComponents > 0 ? `${bomComponents} BOM component(s)` : 'bodies on the 3D model'}) but no Pick Place file says what and where they are: upload the board files with the Pick Place (centroid) file, then Refresh analysis`
      : 'no parts to place: the board files have no Pick Place file. Upload it with the board files, then Refresh analysis'));
    return { ...empty, processes: [{ group: 'Assembly', steps: ['Pick Place file needed'], basis: userBasis }], lines };
  }

  // The array the line carries (the fabrication nest's array, else the board alone).
  const array = nest.array ?? { lengthMm: part.lengthMm.value, widthMm: part.widthMm.value };
  const perArray = nest.array ? nest.boardsPerArray : 1;
  const arrayWidth = r2(Math.min(array.lengthMm, array.widthMm));
  const boardSteps = [
    inputStep('Board length', 'mm', part.lengthMm.value, part.lengthMm.source, pcbFactRef(part.lengthMm, 'Board length', 'mm')),
    inputStep('Board width', 'mm', part.widthMm.value, part.widthMm.source, pcbFactRef(part.widthMm, 'Board width', 'mm')),
  ];
  const nestSays = nest.array ? `the fabrication nest: ${nest.note}` : 'no array: the board alone';
  const arraySeeds: Record<string, CalcSeed> = {
    boards_per_array: derivedSeed(perArray, nest.array ? `${perArray} board(s) per ${r2(array.lengthMm)} x ${r2(array.widthMm)} mm array (the fabrication nest)` : 'the board alone (no array)', 'Boards per array', [
      ...boardSteps, resultStep('Boards per Array', null, perArray, nestSays),
    ]),
    array_length_mm: derivedSeed(r2(Math.max(array.lengthMm, array.widthMm)), nest.array ? 'the array\'s long side' : 'the board\'s long side', 'Array length', [
      ...boardSteps, resultStep('Array Length', 'mm', r2(Math.max(array.lengthMm, array.widthMm)), nestSays),
    ]),
    array_width_mm: derivedSeed(arrayWidth, nest.array ? 'the array\'s short side' : 'the board\'s short side', 'Array width', [
      ...boardSteps, resultStep('Array Width', 'mm', arrayWidth, nestSays),
    ]),
  };
  const need = (key: string, what: string): SourcedValue | null => {
    const v = assemblyRate(ref, key);
    if (!v) warnings.push(`${what} is not priced: memory/PCBA/Assembly/assembly_rates.csv has no ${key} row (migration 1133).`);
    return v;
  };

  // ── The SMT line, per populated side ─────────────────────────────────────────────────────────────────────────────────────────────
  const smt: { key: 'print' | 'spi' | 'place' | 'reflow' | 'aoi'; step: CostedStep }[] = [];
  let smtLine: PcbAssembly['smtLine'] = null;
  if (sides.length) {
    const sidesSeed = derivedSeed(sides.length, `${sides.join(' and ')} (the sides the Pick Place file places parts on)`, 'Populated sides', [
      ...placementSteps(sides), resultStep('Sides', null, sides.length, 'the sides the Pick Place file places parts on'),
    ]);
    const print = need('print_core_cycle_s', 'Stencil printing');
    const spi = need('spi_cm2_per_s', 'Solder paste inspection');
    const aoi = need('aoi_cm2_per_s', 'Assembly AOI');
    const share = need('placement_actual_pct_of_ipc', 'Pick and place');
    const smtSeeds = { ...arraySeeds, smt_sides: sidesSeed };
    smt.push({ key: 'print', step: kit.step('Stencil Print', PCBA_CLASS.print, (m) => (print
      ? kit.timed('Stencil Print', m, { ...smtSeeds, print_cycle_s: sourced(print, 'printer core cycle') })
      : kit.fail('no sourced print cycle time')), ['A stencil printer']) });
    smt.push({ key: 'spi', step: kit.step('Solder Paste Inspection', PCBA_CLASS.spi, (m) => (spi
      ? kit.timed('Solder Paste Inspection', m, { ...smtSeeds, spi_mm2_per_s: sourced(spi, 'SPI speed', 100, 'mm²/cm²') })
      : kit.fail('no sourced SPI speed')), ['A 3D solder paste inspection machine']) });
    smt.push({ key: 'place', step: kit.step('Pick and Place', PCBA_CLASS.place, (m) => {
      if (!share) return kit.fail('no sourced share of the IPC rate');
      if (machineValue(m, 'ipc_cph') == null) return kit.fail('no IPC-9850 or rated placement speed on file');
      return kit.timed('Pick and Place', m, {
        placements: derivedSeed(placements, `${sides.map((s) => `${bySide[s] ?? 0} on the ${s}`).join(', ')} (${part.placementsSource ?? 'the Pick Place file'})`, 'Placements', [
          ...placementSteps(sides), resultStep('Placements', null, placements, 'the parts placed, summed'),
        ]),
        placement_actual_pct_of_ipc: sourced(share, 'actual share of the IPC-9850 speed'),
      });
    }, ['A placer with a stated speed']) });
    smt.push({ key: 'reflow', step: kit.step('Reflow Solder', PCBA_CLASS.reflow, (m) => {
      if (machineValue(m, 'conveyor_speed_min_mm_per_min') == null || machineValue(m, 'conveyor_speed_max_mm_per_min') == null) return kit.fail('no conveyor speed range on file (memory/PCBA/Assembly/reflow_ovens.csv)');
      const width = machineValue(m, 'max_board_width_mm');
      if (width != null && arrayWidth > width) return kit.fail(`the ${arrayWidth} mm wide array is wider than its ${width} mm conveyor`);
      return kit.timed('Reflow Solder', m, smtSeeds);
    }, ['Its conveyor takes the array']) });
    smt.push({ key: 'aoi', step: kit.step('Assembly AOI', PCBA_CLASS.aoi, (m) => (aoi
      ? kit.timed('Assembly AOI', m, { ...smtSeeds, aoi_mm2_per_s: sourced(aoi, 'AOI speed', 100, 'mm²/cm²') })
      : kit.fail('no sourced AOI speed')), ['An AOI machine']) });
    lines.push(...smt.map((s) => s.step.line));
    processes.push(...sides.map((s) => ({ group: `SMT ${s}`, steps: ['Stencil Print', 'Solder Paste Inspection', 'Pick and Place', 'Reflow Solder', 'Assembly AOI'], basis: userBasis })));

    // The line: its machines in series, held for its slowest one (its takt). Placement is usually the slowest, so a line runs placers in series
    // (the line studies run 1 to 3: assembly_rates.csv smt_line_placers): the placers the line runs are the number, up to the most a source
    // runs, that makes the line cheapest for the board. Each machine's own time is its line; the time the line waits is the line balance.
    const rateOf = (m: SandMachine | null) => (m ? (m.machineRatePerHr ?? 0) + (m.labourRatePerHr ?? 0) * (m.operators ?? 0) : 0);
    const complete = smt.every((s) => s.step.machine && s.step.outcome);
    if (complete) {
      const byKey = (k: string) => smt.find((s) => s.key === k)!.step;
      const placer = byKey('place');
      const placerRate = rateOf(placer.machine);
      const otherRate = smt.filter((s) => s.key !== 'place').reduce((t, x) => t + rateOf(x.step.machine), 0);
      const placersRange = need('smt_line_placers', 'The line balance');
      const maxPlacers = Math.max(1, Math.round(placersRange?.max ?? 1));
      // Each side's time on the other machines (the same for every side) and on placement (its own parts).
      const otherSec = Math.max(...smt.filter((s) => s.key !== 'place').map((s) => s.step.outcome!.sec / sides.length));
      const effective = placer.outcome!.run.outputs['Effective Rate'] ?? null;
      const placeSec = sides.map((s) => (effective ? ((bySide[s] ?? 0) / effective) * 3600 : (placer.outcome!.sec * (bySide[s] ?? 0)) / placements));
      const lineCost = (n: number) => sides.reduce((t, _s, i) => t + Math.max(otherSec, placeSec[i]! / n), 0) * (otherRate + n * placerRate) / 3600;
      let placers = 1;
      for (let n = 2; n <= maxPlacers; n++) if (lineCost(n) < lineCost(placers) - 1e-9) placers = n;
      const takts = sides.map((_s, i) => Math.max(otherSec, placeSec[i]! / placers));
      const takt = takts.reduce((a, b) => a + b, 0);
      const lineRate = r2(otherRate + placers * placerRate);
      const lineWhy = [...smt.filter((x) => x.key !== 'place').map((x) => `${x.step.machine!.name} ${r2(rateOf(x.step.machine))}`),
        `${placers} x ${placer.machine!.name} ${r2(placerRate)}`].join(' + ');
      const lineRateSeed = derivedSeed(lineRate, `the line: ${lineWhy} USD/h`, 'The SMT line\'s rate', [
        ...smt.filter((x) => x.key !== 'place').flatMap((x) => rateSteps(x.step.machine!)), ...rateSteps(placer.machine!, placers),
        resultStep('Line Rate', 'USD/h', lineRate, 'each machine\'s machine rate + labour rate x operators, the placer\'s times the placers in series'),
      ]);
      const placersWhy = `${placers} placer(s) in series: the cheapest line for the board of 1 to ${maxPlacers} (the line studies run ${placersRange ? `${placersRange.min}-${placersRange.max}` : '1'}: ${placersRange?.sources.length ?? 0} sources)`;
      const fixed = need('line_changeover_fixed_min', 'The line changeover');
      const perFeeder = need('feeder_load_min', 'The line changeover');
      if (fixed && perFeeder) {
        const c = kit.run(PCBA_HELPER.changeover, null, {
          smt_sides: sidesSeed,
          feeders: derivedSeed(feeders, `${sides.map((s) => `${feedersBySide[s]!.size} on the ${s}`).join(', ')}: the distinct footprints placed`, 'Feeders', [
            ...placementSteps(sides), resultStep('Feeders', null, feeders, 'one feeder a distinct footprint on each side'),
          ]),
          changeover_fixed_min: sourced(fixed, 'changeover per side'), feeder_load_min: sourced(perFeeder, 'feeder load'),
          line_usd_per_h: lineRateSeed, batch_size: batchSizeSeed(kit.batchSize, 'the batch'),
        });
        if ('run' in c) {
          const l = kit.consumableLine('SMT Line Changeover', PCBA_CLASS.place, c.run, `${r2(c.run.outputs['Changeover Time'] ?? 0)} min a batch of ${kit.batchSize} at the line's ${lineRate} USD/h`);
          lines.push({ ...l, setupCost: l.totalCost, runCost: 0 });
        }
      }
      const busy = smt.reduce((t, x) => t + x.step.line.runCost, 0);
      const b = kit.run(PCBA_HELPER.balance, null, {
        line_takt_s: derivedSeed(r4(takt), `${sides.map((s, i) => `${s} ${r2(takts[i] ?? 0)} s`).join(' + ')}; ${placersWhy}`, 'The line\'s takt', [
          inputStep('Slowest other machine a side', 's', r4(otherSec), 'the slowest of the printer, SPI, reflow and AOI lines, a side'),
          ...sides.map((s, i) => inputStep(`Placement on the ${s}`, 's', r4(placeSec[i]!), `${bySide[s] ?? 0} parts at the placer's effective rate`)),
          inputStep('Placers in series', null, placers, placersWhy, placersRange ? sourcedRef(placersRange, 'placers in series') : undefined),
          resultStep('Line Takt', 's', r4(takt), 'each side: max({Slowest other machine a side}, {Placement} / {Placers in series}), summed'),
        ]),
        line_usd_per_h: lineRateSeed,
        busy_cost_usd: derivedSeed(r4(busy), 'the five SMT lines\' run cost', 'The SMT lines\' run cost', [
          ...smt.map((x) => inputStep(x.step.line.process, 'USD', r4(x.step.line.runCost), `the ${x.step.line.process} line's run cost`)), resultStep('Busy Cost', 'USD', r4(busy), 'summed'),
        ]),
      });
      if ('run' in b && (b.run.value ?? 0) > 0) lines.push(kit.consumableLine('SMT Line Balance', PCBA_CLASS.place, b.run, `the line held ${r2(takt)} s a board for its slowest machine; ${placersWhy}`));
      smtLine = { placers, maxPlacers, taktSec: r2(takt) };
      if (placers > 1) for (const g of processes) g.steps = g.steps.map((x) => (x === 'Pick and Place' ? `Pick and Place (${placers} placers in series)` : x));
    }

    // Solder paste: the paste openings of the populated sides, through the stencil.
    const area = sides.reduce((s, x) => s + (part.pasteAreaBySideMm2?.[x] ?? 0), 0);
    const thickness = assemblyCost(ref, 'stencil_thickness_mm', 'any');
    const density = assemblyCost(ref, 'paste_g_per_cm3', 'any');
    const price = priceOf(ref, region, 'solder_paste_usd_per_kg', 'solder_paste_inr_per_kg');
    if (!(area > 0)) warnings.push('The solder paste is not priced: the board files have no paste layer for the populated sides.');
    else if (!thickness || !density || !price) warnings.push('The solder paste is not priced: its sourced stencil thickness, density or price is missing.');
    else {
      const r = kit.run(PCBA_HELPER.paste, null, {
        paste_area_mm2: derivedSeed(r2(area), `the paste openings on the ${sides.join(' and ')} (the board files' paste layers)`, 'Paste area', [
          ...sides.map((x) => inputStep(`The ${x} side's paste openings`, 'mm²', part.pasteAreaBySideMm2?.[x] ?? 0, 'Measured from the board files: that side\'s paste layer')),
          resultStep('Paste Area', 'mm²', r2(area), 'the populated sides\' paste openings, summed'),
        ]),
        stencil_thickness_mm: sourced(thickness, 'stencil'), paste_g_per_cm3: sourced(density, 'paste density'),
        paste_usd_per_g: { value: r4(price.usd / 1000), source: `${price.say} / 1000 g`, ref: price.ref(1 / 1000, 'per gram') },
      });
      if ('run' in r) lines.push(kit.consumableLine('Solder Paste', PCBA_CLASS.print, r.run, `${r2(r.run.outputs['Paste Mass'] ?? 0)} g at ${price.say}`));
    }
    const stencil = priceOf(ref, region, 'stencil_usd', 'stencil_inr');
    tooling.push({
      key: 'smt-stencils', description: `Solder paste stencil${sides.length > 1 ? 's' : ''} (${sides.join(', ')})`,
      costUsd: stencil ? r2(stencil.usd * sides.length) : null, detail: stencil ? `${sides.length} x ${stencil.say}` : 'no stencil price sourced for the region',
    });
  }

  // ── Through-hole: insertion and the cheapest soldering that can ─────────────────────────────────────────────────────────────────
  let thtSolder: PcbAssembly['thtSolder'] = null;
  if (thtParts > 0) {
    const rate = need('tht_insertion_parts_per_hr', 'THT insertion');
    lines.push(kit.step('THT Insertion', PCBA_CLASS.bench, (m) => (rate
      ? kit.timed('THT Insertion', m, {
        tht_parts: derivedSeed(thtParts, `${thtParts} through-hole part(s) (${part.placementsSource ?? 'the Pick Place file'})`, 'Through-hole parts', [
          ...part.thtParts.map((t) => inputStep(t.label, null, t.count, part.placementsSource ?? 'the Pick Place file')), resultStep('THT Parts', null, thtParts, 'summed'),
        ]),
        insertion_parts_per_hr: sourced(rate, 'manual insertion'),
      })
      : kit.fail('no sourced insertion rate')), ['An assembly bench']).line);
    const jointsSeed = derivedSeed(joints, `${joints} through-hole joint(s): ${part.thtParts.map((t) => `${t.count} x ${t.label} (${t.jointsPerPart} pins)`).join(', ')}`, 'Through-hole joints', [
      ...part.thtParts.map((t) => inputStep(`${t.label}: ${t.count} x ${t.jointsPerPart} pins`, null, t.count * t.jointsPerPart, part.placementsSource ?? 'the Pick Place file')),
      resultStep('THT Joints', null, joints, 'each part\'s count x its pins, summed'),
    ]);
    const wave = need('wave_conveyor_m_per_min', 'Wave soldering');
    const sel = need('selective_solder_s_per_joint', 'Selective soldering');
    const hand = need('hand_solder_s_per_joint', 'Hand soldering');
    const methods: Record<PcbThtSolder, CostedStep> = {
      wave: kit.step('Wave Solder', PCBA_CLASS.wave, (m) => {
        const underneath = bySide.bottom ?? 0;
        if (underneath > 0) return kit.fail(`the bottom side carries ${underneath} surface-mount part(s), which would pass through the wave (glued parts or a selective pallet are not priced)`);
        return wave ? kit.timed('Wave Solder', m, { ...arraySeeds, wave_conveyor_mm_per_min: sourced(wave, 'wave conveyor', 1000, 'mm/m') }) : kit.fail('no sourced conveyor speed');
      }, ['The bottom side has no surface-mount parts']),
      selective: kit.step('Selective Solder', PCBA_CLASS.selective, (m) => (sel ? kit.timed('Selective Solder', m, { tht_joints: jointsSeed, selective_s_per_joint: sourced(sel, 'selective dwell per joint') }) : kit.fail('no sourced time per joint')), ['A selective soldering machine']),
      hand: kit.step('Hand Solder', PCBA_CLASS.bench, (m) => (hand ? kit.timed('Hand Solder', m, { tht_joints: jointsSeed, hand_s_per_joint: sourced(hand, 'hand soldering per joint') }) : kit.fail('no sourced time per joint')), ['An assembly bench']),
    };
    const options = PCBA_THT_SOLDERS.map((k): PcbAssemblyOption<PcbThtSolder> => {
      const l = methods[k].line;
      return { key: k, label: THT_LABEL[k], perBoardUsd: l.physicsGap ? null : r4(l.totalCost), reason: l.physicsGap ? gapReason(l) : null };
    });
    const user = choice.thtSolder;
    const cheapest = cheapestOf(options);
    const chosen = user ?? cheapest ?? 'hand';
    lines.push(methods[chosen].line);
    thtSolder = { chosen, basis: user ? 'user' : 'auto', options };
    processes.push({ group: 'THT', steps: ['THT Insertion', THT_LABEL[chosen]], basis: user ? 'user' : 'auto' });
  }

  // ── Test: in circuit (a fixture) or flying probe, the cheaper over the job ─────────────────────────────────────────────────────────
  let test: PcbAssembly['test'];
  {
    const netsFact = part.nets ?? part.testPoints;
    const netsSeed: CalcSeed | null = nets != null && netsFact
      ? { value: nets, source: part.nets ? `${nets} nets with pins (${part.nets.source})` : `${nets} test points (${part.testPoints!.source})`, ref: pcbFactRef(netsFact, part.nets ? 'Nets' : 'Test points') }
      : null;
    const timesOf = (k500: string, k3000: string, what: string) => {
      const a = need(k500, what);
      const b = need(k3000, what);
      return a && b ? { [k500]: sourced(a, '500 nets'), [k3000]: sourced(b, '3000 nets') } : null;
    };
    const ictTimes = timesOf('ict_s_at_500_nets', 'ict_s_at_3000_nets', 'In-circuit test');
    const fpTimes = timesOf('assembly_fp_min_at_500_nets', 'assembly_fp_min_at_3000_nets', 'Assembly flying probe');
    const steps: Record<PcbAssemblyTest, CostedStep> = {
      ict: kit.step('In-Circuit Test', PCBA_CLASS.ict, (m) => (netsSeed && ictTimes ? kit.timed('In-Circuit Test', m, { nets: netsSeed, ...ictTimes }) : kit.fail(netsSeed ? 'no sourced test time' : 'no nets: the board files trace none; set Test points in the Cost Guide')), ['An in-circuit tester']),
      flying_probe: kit.step('Assembly Flying Probe', PCBA_CLASS.flyingProbe, (m) => (netsSeed && fpTimes ? kit.timed('Assembly Flying Probe', m, { nets: netsSeed, ...fpTimes }) : kit.fail(netsSeed ? 'no sourced test time' : 'no nets: the board files trace none; set Test points in the Cost Guide')), ['A flying probe tester']),
    };
    const program = assemblyCost(ref, 'pcba_test_program_usd', 'any');
    const fixtureAt = [assemblyCost(ref, 'ict_fixture_usd_at_1024_nails', 'any'), assemblyCost(ref, 'ict_fixture_usd_at_5120_nails', 'any')];
    let fixtureUsd: number | null = null;
    let fixtureDetail = 'not priced: no nets or no sourced fixture price';
    if (nets != null && fixtureAt[0] && fixtureAt[1]) {
      const f = kit.run(PCBA_HELPER.fixture, null, {
        nails: derivedSeed(nets, 'one nail per net', 'Nails', [seedStep('Nets', null, netsSeed!), resultStep('Nails', null, nets, 'one nail per net')]), ict_fixture_usd_at_1024_nails: sourced(fixtureAt[0], '1024 nails'), ict_fixture_usd_at_5120_nails: sourced(fixtureAt[1], '5120 nails'),
      });
      if ('run' in f) { fixtureUsd = r2(f.run.value!); fixtureDetail = `${nets} nails, between ${saySourced(fixtureAt[0], 0)} (1024) and ${saySourced(fixtureAt[1], 0)} (5120 nails)`; }
    }
    const programUsd = program ? r2(program.mid) : null;
    const spread = kit.amortizationParts ?? kit.annualVolume;
    const toolingOf = (k: PcbAssemblyTest) => (k === 'ict' ? (fixtureUsd ?? Number.NaN) + (programUsd ?? 0) : (programUsd ?? 0));
    const options = PCBA_TESTS.map((k): PcbAssemblyOption<PcbAssemblyTest> => {
      const l = steps[k].line;
      if (l.physicsGap) return { key: k, label: TEST_LABEL[k], perBoardUsd: null, reason: gapReason(l) };
      const tool = toolingOf(k);
      if (!Number.isFinite(tool)) return { key: k, label: TEST_LABEL[k], perBoardUsd: null, reason: 'its fixture cannot be priced' };
      return { key: k, label: TEST_LABEL[k], perBoardUsd: spread ? r4(l.totalCost + tool / spread) : r4(l.totalCost), reason: null };
    });
    const user = choice.test;
    let chosen: PcbAssemblyTest;
    if (user) chosen = user;
    else if (!spread) {
      chosen = 'flying_probe';
      warnings.push('The assembly test is a flying probe: with no annual volume or production life there is nothing to spread an in-circuit fixture over.');
    } else chosen = cheapestOf(options) ?? 'flying_probe';
    lines.push(steps[chosen].line);
    if (chosen === 'ict') tooling.push({ key: 'ict-fixture', description: 'In-circuit test fixture', costUsd: fixtureUsd, detail: fixtureDetail });
    tooling.push({ key: 'pcba-test-program', description: `${TEST_LABEL[chosen]} program`, costUsd: programUsd, detail: program ? saySourced(program, 0) : 'no program price sourced' });
    test = { chosen, basis: user ? 'user' : 'auto', options };
    processes.push({ group: 'Test', steps: [TEST_LABEL[chosen]], basis: user ? 'user' : 'auto' });
  }

  // ── Depanel: boards assembled in an array are routed out ──────────────────────────────────────────────────────────────────────────
  if (perArray > 1) {
    const speed = need('depanel_router_mm_per_s', 'Depaneling');
    lines.push(kit.step('Depanel Router', PCBA_CLASS.depanel, (m) => (speed
      ? kit.timed('Depanel Router', m, {
        route_length_mm: { value: r2(part.perimeterMm.value), source: `${r2(part.perimeterMm.value)} mm outline (${part.perimeterMm.source})`, ref: pcbFactRef(part.perimeterMm, 'Outline', 'mm') },
        depanel_mm_per_s: sourced(speed, 'router cutting speed'),
      })
      : kit.fail('no sourced cutting speed')), ['A depaneling router']).line);
    processes.push({ group: 'Depanel', steps: ['Depanel Router'], basis: 'auto' });
  }

  return { included, mode: choice.mode, basis, processes, counts, lines, tooling, smtLine, thtSolder, test, warnings };
}

/** A gap line's reason in words. */
function gapReason(l: ProcessLineCost): string {
  const g = l.physicsGap!;
  return 'reason' in g ? g.reason : (g as { requiredAction?: string }).requiredAction ?? 'not priced';
}

/** The key of the cheapest priced option, or null when none is priced. */
function cheapestOf<K extends string>(options: readonly PcbAssemblyOption<K>[]): K | null {
  let best: PcbAssemblyOption<K> | null = null;
  for (const o of options) if (o.perBoardUsd != null && (best?.perBoardUsd == null || o.perBoardUsd < best.perBoardUsd)) best = o;
  return best?.key ?? null;
}

/** A keyed price of the quote's region in USD: India's in rupees at the app's rate, the USA's in dollars; another location takes the USA's. */
function priceOf(ref: SandReference, region: PcbAssemblyRegion, usdKey: string, inrKey: string): { usd: number; say: string; ref: (scale: number, why: string) => SourceRef } | null {
  if (region.location === 'India' && region.inrPerUsd) {
    const v = assemblyCost(ref, inrKey, 'India');
    const rate = region.inrPerUsd;
    if (v) return { usd: v.mid / rate, say: `${saySourced(v, 0)} / ${r2(rate)} INR per USD (India)`, ref: (scale, why) => sourcedRef(v, `${inrKey} in USD`, scale / rate, `${why}, at ${r2(rate)} INR per USD`) };
  }
  const v = assemblyCost(ref, usdKey, 'USA');
  return v ? { usd: v.mid, say: `${saySourced(v, 2)} (USA${region.location !== 'USA' ? `: none sourced for ${region.location}` : ''})`, ref: (scale, why) => sourcedRef(v, usdKey, scale, why) } : null;
}
