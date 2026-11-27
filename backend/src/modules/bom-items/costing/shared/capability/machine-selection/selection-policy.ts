// How the reference data narrows the machines a part fits, before the cheapest of them is taken. Pure.
//
// Every folder of memory/ states the rule in its variables:
//   usePreferredMachines   "If true the model will first try to select a preferred machine. If false, the system chooses either the default
//                           machine or from the entire non-preferred set of machines."  (true in every folder that has it)
//   preferVirtualMachines  "Controls machine selection - if true the model will first try to select a virtual machine, if present and
//                           feasible based on size constraints."  (Machining, Assembly, Secondary process)
// and each machine carries its own flags (specs is_preferred, is_virtual_machine). So the choice is technical first, then cost:
//   1. the machines that can do the part (the capability check);
//   2. of them the virtual machines, when the family prefers them and one is capable;
//   3. of those the preferred machines, when the family uses them and one is capable;
//   4. the lowest machine hour rate (for a line whose machines run at different speeds, the lowest cost per part).
// A family with neither variable on file narrows nothing: the cheapest capable machine is taken.
//
// Machining also chooses by the spindle: spindlePowerBias and spindleSpeedBias, "For machine selection, 0 to 1. 0 selects the cheapest hourly
// machine. 0.5 selects only machines more powerful / faster than the average." They are applied between the preferred step and the cost:
//   - only where the choice is among real machines. A virtual machine is chosen "based on size constraints" (preferVirtualMachines): held
//     to the average, the small virtual mill could never be chosen, and no virtual 4 axis mill has the average power of its class;
//   - a bias sets a floor between the least and the most of the machines left: 0 the least (no machine set aside), 0.5 their average,
//     1 the most. The data states 0 and 0.5; a straight line between and beyond them is this engine's reading;
//   - a machine at or above the floor passes; one with no spindle power (or speed) on file does not;
//   - machines must pass both floors. The data does not say what is chosen when none does (the more powerful of two machines is usually
//     the slower: no drill press of the data is above both averages): then the machines that pass either floor are kept, and when none
//     does, all of them. The biases narrow the choice; they never leave a part without a machine.

import { MEMORY_DOMAINS } from '../../../../../processes/reference-domains';
import { MACHINING_REFERENCE_SOURCE_VERSION } from '../../../machining/lookup/machining-lookup-tables';

export interface MachineSelectionPolicy {
  /** usePreferredMachines of the machine's family. */
  usePreferredMachines: boolean;
  /** preferVirtualMachines of the machine's family. */
  preferVirtualMachines: boolean;
  /** spindlePowerBias / spindleSpeedBias of the machine's family (0 to 1); null when the family has none: no spindle step. */
  spindlePowerBias: number | null;
  spindleSpeedBias: number | null;
}

/** No narrowing: the cheapest capable machine. What a family with no selection variable on file gets. */
export const NO_SELECTION_POLICY: MachineSelectionPolicy = { usePreferredMachines: false, preferVirtualMachines: false, spindlePowerBias: null, spindleSpeedBias: null };

/** The policy of a machine's process group (mhr_records.process_group, as HR Rates shows it). */
export type SelectionPolicyOf = (processGroup: string | null) => MachineSelectionPolicy;

/** The variables' names. One folder (Sheet metal stretch forming) spells the first with a single r. */
export const SELECTION_POLICY_KEYS = ['usePreferredMachines', 'usePreferedMachines', 'preferVirtualMachines', 'spindlePowerBias', 'spindleSpeedBias'] as const;

/** A variable row of machining_reference_data (every folder of memory/ is staged there under its own source_version). */
export interface PolicyVariableRow { source_version: string | null; key: string; value: string | null }

const on = (value: string | null | undefined): boolean => (value ?? '').trim().toLowerCase() === 'true';

const SHEET_METAL_GROUP = 'Sheet Metal';
const MACHINING_GROUP = 'Machining';

/**
 * The policy of every process group, from the staged variables: `folderRows` are the variable rows of machining_reference_data (all source
 * versions), `sheetMetalRows` those of sm_reference_data (Sheet Metal's own staging table).
 */
export function selectionPolicyOf(
  folderRows: readonly PolicyVariableRow[],
  sheetMetalRows: readonly { key: string; value: string | null }[],
): SelectionPolicyOf {
  /** A bias as staged: a number from 0 to 1; anything else is no bias. */
  const bias = (rows: readonly { key: string; value: string | null }[], key: string): number | null => {
    const text = rows.find((r) => r.key === key)?.value;
    const n = text == null || text.trim() === '' ? NaN : Number(text);
    return Number.isFinite(n) && n >= 0 && n <= 1 ? n : null;
  };
  const policyOfRows = (rows: readonly { key: string; value: string | null }[]): MachineSelectionPolicy => ({
    usePreferredMachines: rows.some((r) => (r.key === 'usePreferredMachines' || r.key === 'usePreferedMachines') && on(r.value)),
    preferVirtualMachines: rows.some((r) => r.key === 'preferVirtualMachines' && on(r.value)),
    spindlePowerBias: bias(rows, 'spindlePowerBias'),
    spindleSpeedBias: bias(rows, 'spindleSpeedBias'),
  });
  const byVersion = new Map<string, PolicyVariableRow[]>();
  for (const r of folderRows) {
    if (r.source_version == null) continue;
    byVersion.set(r.source_version, [...(byVersion.get(r.source_version) ?? []), r]);
  }
  const versionOfGroup = new Map<string, string>([
    [MACHINING_GROUP, MACHINING_REFERENCE_SOURCE_VERSION],
    ...MEMORY_DOMAINS.flatMap((d): [string, string][] => (d.processGroup ? [[d.processGroup, d.sourceVersion]] : [])),
  ]);
  const sheetMetal = policyOfRows(sheetMetalRows);
  return (processGroup) => {
    if (processGroup == null) return NO_SELECTION_POLICY;
    if (processGroup === SHEET_METAL_GROUP) return sheetMetal;
    const version = versionOfGroup.get(processGroup);
    return version ? policyOfRows(byVersion.get(version) ?? []) : NO_SELECTION_POLICY;
  };
}

/** One step of the choice, as it is told: the rule applied and how many machines were left by it. */
export interface SelectionStep {
  rule: 'capable' | 'virtual' | 'preferred' | 'spindle' | 'cheapest';
  /** Machines left after the step. */
  count: number;
  text: string;
}

interface Flagged {
  preferred: boolean | null;
  virtual: boolean | null;
  processGroup: string | null;
  /** The main spindle's power (kW) and top speed (rpm); null when not on file. Absent on a machine with no spindle. */
  spindlePowerKw?: number | null;
  maxSpindleRpm?: number | null;
}

/** The floor a bias sets among `values`: their least at 0, their average at 0.5, their most at 1, on a straight line between. */
export function biasFloor(bias: number, values: readonly number[]): number {
  const min = Math.min(...values), max = Math.max(...values);
  const avg = values.reduce((s, v) => s + v, 0) / values.length;
  return bias <= 0.5 ? min + (avg - min) * (bias / 0.5) : avg + (max - avg) * ((bias - 0.5) / 0.5);
}

/** The machines of one family the spindle biases keep, and how it is said; null when the biases set nothing aside. */
function spindleStep<T extends Flagged>(machines: readonly T[], policy: MachineSelectionPolicy): { kept: T[]; text: string } | null {
  const round = (n: number) => Math.round(n * 10) / 10;
  const floorOf = (bias: number | null, value: (m: T) => number | null | undefined) => {
    const values = machines.map(value).filter((v): v is number => v != null && v > 0);
    return bias != null && bias > 0 && values.length > 0 ? biasFloor(bias, values) : null;
  };
  const power = floorOf(policy.spindlePowerBias, (m) => m.spindlePowerKw);
  const speed = floorOf(policy.spindleSpeedBias, (m) => m.maxSpindleRpm);
  if (power == null && speed == null) return null;
  // A hair under the floor is the floor: an average of equal values must not fall a rounding below them.
  const at = (value: number | null | undefined, floor: number) => value != null && value >= floor - 1e-9;
  const passesPower = (m: T) => power == null || at(m.spindlePowerKw, power);
  const passesSpeed = (m: T) => speed == null || at(m.maxSpindleRpm, speed);
  const floors = [
    ...(power != null ? [`${round(power)} kW of spindle power (spindlePowerBias ${policy.spindlePowerBias})`] : []),
    ...(speed != null ? [`${Math.round(speed).toLocaleString('en-US')} rpm (spindleSpeedBias ${policy.spindleSpeedBias})`] : []),
  ];
  const both = machines.filter((m) => passesPower(m) && passesSpeed(m));
  if (both.length > 0) {
    return both.length < machines.length
      ? { kept: both, text: `${both.length} of them ${both.length === 1 ? 'is' : 'are'} at or above ${floors.join(' and ')}` }
      : null;
  }
  const either = machines.filter((m) => (power != null && at(m.spindlePowerKw, power)) || (speed != null && at(m.maxSpindleRpm, speed)));
  return either.length > 0 && either.length < machines.length
    ? { kept: either, text: `none of them is at or above both ${floors.join(' and ')}: the ${either.length} at or above either are kept` }
    : null;
}

/**
 * The machines the choice is made from: the capable ones, narrowed to the virtual and then the preferred machines as their family's
 * variables say, then by the family's spindle biases where the choice is among real machines. A step that would leave a family no machine
 * is not taken (the model "first tries"). Each family narrows its own machines: a line that draws on two families (deburr: sheet metal's
 * deslag machines and machining's manual deburr) keeps the choice of each, so one family's rule never sets aside the machines of another.
 */
export function narrowByPolicy<T extends Flagged>(capable: readonly T[], policyOf: SelectionPolicyOf): { pool: T[]; steps: SelectionStep[] } {
  const families = new Map<string | null, T[]>();
  for (const c of capable) families.set(c.processGroup, [...(families.get(c.processGroup) ?? []), c]);
  const many = (n: number, one: string, more: string) => `${n} ${n === 1 ? one : more}`;
  let virtualKept = 0, preferredKept = 0;
  const spindleTexts: string[] = [];
  const afterVirtual = new Map<string | null, T[]>(), afterPreferred = new Map<string | null, T[]>(), afterSpindle = new Map<string | null, T[]>();
  for (const [family, machines] of families) {
    const policy = policyOf(family);
    // The virtual machines first: chosen on size alone, so the spindle biases are not put to them.
    const virtual = policy.preferVirtualMachines ? machines.filter((c) => c.virtual === true) : [];
    const amongVirtual = virtual.length > 0;
    if (amongVirtual && virtual.length < machines.length) virtualKept += virtual.length;
    const v = amongVirtual ? virtual : machines;
    afterVirtual.set(family, v);
    const preferred = policy.usePreferredMachines ? v.filter((c) => c.preferred === true) : [];
    const narrowed = preferred.length > 0 && preferred.length < v.length;
    if (narrowed) preferredKept += preferred.length;
    const p = narrowed ? preferred : v;
    afterPreferred.set(family, p);
    const spindle = amongVirtual ? null : spindleStep(p, policy);
    if (spindle) spindleTexts.push(spindle.text);
    afterSpindle.set(family, spindle ? spindle.kept : p);
  }
  const count = (m: Map<string | null, T[]>) => [...m.values()].reduce((n, x) => n + x.length, 0);
  const steps: SelectionStep[] = [];
  if (virtualKept > 0) steps.push({ rule: 'virtual', count: count(afterVirtual), text: `${many(virtualKept, 'virtual machine', 'virtual machines')} the part fits come${virtualKept === 1 ? 's' : ''} first (preferVirtualMachines)` });
  if (preferredKept > 0) steps.push({ rule: 'preferred', count: count(afterPreferred), text: `${many(preferredKept, 'preferred machine', 'preferred machines')} of them come${preferredKept === 1 ? 's' : ''} first (usePreferredMachines)` });
  if (spindleTexts.length > 0) steps.push({ rule: 'spindle', count: count(afterSpindle), text: spindleTexts.join('; ') });
  const left = new Set([...afterSpindle.values()].flat());
  return { pool: capable.filter((c) => left.has(c)), steps };
}
