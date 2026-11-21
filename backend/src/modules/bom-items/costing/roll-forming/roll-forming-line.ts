// The roll forming line as memory/Sheet metal roll forming lays it out: Coil Material Stock, Uncoiler, Coil Flattener (when the coil needs it),
// Punch Press (when the strip has features to punch), Roll Forming Mill, Integrated Welding (a closed section), Cut-Off Press. The line runs at
// one speed, the slowest of its limits (the engine's rule, agreed with the user 2026-11-22): each machine's max line speed, the part-length
// tolerance's (partLengthToleranceThresholds), profileRollBendingSpeed on a curved profile, and each stationary-die press's strokes a minute
// (x stationaryDieLineSpeedFactor, one stroke a part). The quote names the limit that sets it. Pure.
import { toleranceKey } from './roll-forming-stations';
import { machineValue, type SandMachine } from '../casting/sand/sand-machines';

import type { SandReference } from '../casting/sand/sand-reference';
import type { KitRow } from '../shared/calculators/route-kit';

/** A machine's place on the line, in the line's order. */
export type LineRole = 'stock' | 'uncoiler' | 'flattener' | 'punch' | 'mill' | 'welder' | 'cutoff';
export const LINE_ORDER: readonly LineRole[] = ['stock', 'uncoiler', 'flattener', 'punch', 'mill', 'welder', 'cutoff'];

/** A machine on the line: its process (the catalog's) and the machine. */
export interface LineMachine {
  process: string;
  machine: SandMachine;
}

export type Line = ReadonlyMap<LineRole, LineMachine>;

/** One limit on the line speed (mm/s), named as the quote says it. */
export interface SpeedCap {
  name: string;
  mmPerS: number;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** The partLengthToleranceThresholds row of the line's measurement system (cutOffMeasurementSystem) and the part-length tolerance, or null. */
export function partLengthToleranceRow(ref: SandReference): { row: KitRow | null; system: string | null; tolerance: string | null } {
  const system = ref.text('cutOffMeasurementSystem');
  const tolerance = ref.text('partLengthTolerance');
  const row = system && tolerance
    ? ref.table('partLengthToleranceThresholds').find((r) => toleranceKey(r['Measurement System']) === toleranceKey(system) && toleranceKey(r['Tolerance Name']) === toleranceKey(tolerance)) ?? null
    : null;
  return { row, system, tolerance };
}

/**
 * Whether the coil is flattened before the line: memory's Coil Flattener rules, a coil at or above coilFlatteningThickness (cross-bow) or of
 * a yield strength at or above coilFlatteningYieldStrength (longitudinal bow). A material with no yield strength on file is judged by its
 * thickness alone, said.
 */
export function flattening(ref: SandReference, thicknessMm: number, yieldMpa: number | null): { needed: boolean; reason: string } {
  const t = ref.number('coilFlatteningThickness');
  const y = ref.number('coilFlatteningYieldStrength');
  if (t != null && thicknessMm >= t) return { needed: true, reason: `the ${r2(thicknessMm)} mm coil is at or above coilFlatteningThickness ${t} mm (cross-bow)` };
  if (y != null && yieldMpa != null && yieldMpa >= y) return { needed: true, reason: `the material's ${r2(yieldMpa)} MPa yield is at or above coilFlatteningYieldStrength ${y} MPa (longitudinal bow)` };
  return {
    needed: false,
    reason: `the ${r2(thicknessMm)} mm coil is under coilFlatteningThickness ${t ?? '?'} mm and ${yieldMpa != null ? `its ${r2(yieldMpa)} MPa yield under coilFlatteningYieldStrength ${y ?? '?'} MPa` : 'the material has no yield strength on file'}`,
  };
}

/** The line's machines that limit its speed by their own max line speed (the mill, the uncoiler, the flattener, the welder). */
export function machineCaps(line: Line): SpeedCap[] {
  return LINE_ORDER.flatMap((role) => {
    const lm = line.get(role);
    const v = lm ? machineValue(lm.machine, 'max_line_speed_mm_per_s') : null;
    return lm && v != null && v > 0 ? [{ name: `${lm.process} ${lm.machine.name}`, mmPerS: v }] : [];
  });
}

/** The stationary-die press on the line with the fewest strokes a minute (the punch press, the cut-off press), or null when there is none. */
export function slowestPress(line: Line): { process: string; machine: SandMachine; spm: number } | null {
  let best: { process: string; machine: SandMachine; spm: number } | null = null;
  for (const role of ['punch', 'cutoff'] as const) {
    const lm = line.get(role);
    const spm = lm ? machineValue(lm.machine, 'strokes_per_minute') : null;
    if (lm && spm != null && spm > 0 && (best == null || spm < best.spm)) best = { process: lm.process, machine: lm.machine, spm };
  }
  return best;
}

/** The limit that sets the line speed: the slowest (the first of equals, in the order given). */
export function limitingCap(caps: readonly SpeedCap[]): SpeedCap | null {
  return caps.reduce<SpeedCap | null>((best, c) => (best == null || c.mmPerS < best.mmPerS - 1e-9 ? c : best), null);
}
