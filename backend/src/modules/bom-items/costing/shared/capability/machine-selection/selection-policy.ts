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
// Machining also has spindlePowerBias and spindleSpeedBias (0.5: "selects only machines more powerful / faster than the average"). They
// are not applied: the data does not say which machines the average is taken over, nor what is chosen when no machine is above both
// averages (among two capable mills the more powerful one is usually the slower). They would matter only for a part no virtual machine
// takes.

import { MEMORY_DOMAINS } from '../../../../../processes/reference-domains';
import { MACHINING_REFERENCE_SOURCE_VERSION } from '../../../machining/lookup/machining-lookup-tables';

export interface MachineSelectionPolicy {
  /** usePreferredMachines of the machine's family. */
  usePreferredMachines: boolean;
  /** preferVirtualMachines of the machine's family. */
  preferVirtualMachines: boolean;
}

/** No narrowing: the cheapest capable machine. What a family with neither variable on file gets. */
export const NO_SELECTION_POLICY: MachineSelectionPolicy = { usePreferredMachines: false, preferVirtualMachines: false };

/** The policy of a machine's process group (mhr_records.process_group, as HR Rates shows it). */
export type SelectionPolicyOf = (processGroup: string | null) => MachineSelectionPolicy;

/** The variables' names. One folder (Sheet metal stretch forming) spells the first with a single r. */
export const SELECTION_POLICY_KEYS = ['usePreferredMachines', 'usePreferedMachines', 'preferVirtualMachines'] as const;

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
  const policyOfRows = (rows: readonly { key: string; value: string | null }[]): MachineSelectionPolicy => ({
    usePreferredMachines: rows.some((r) => (r.key === 'usePreferredMachines' || r.key === 'usePreferedMachines') && on(r.value)),
    preferVirtualMachines: rows.some((r) => r.key === 'preferVirtualMachines' && on(r.value)),
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
  rule: 'capable' | 'virtual' | 'preferred' | 'cheapest';
  /** Machines left after the step. */
  count: number;
  text: string;
}

interface Flagged { preferred: boolean | null; virtual: boolean | null; processGroup: string | null }

/**
 * The machines the choice is made from: the capable ones, narrowed to the virtual and then the preferred machines as their family's
 * variables say. A step that would leave a family no machine is not taken (the model "first tries"). Each family narrows its own machines:
 * a line that draws on two families (deburr: sheet metal's deslag machines and machining's manual deburr) keeps the choice of each, so one
 * family's rule never sets aside the machines of another.
 */
export function narrowByPolicy<T extends Flagged>(capable: readonly T[], policyOf: SelectionPolicyOf): { pool: T[]; steps: SelectionStep[] } {
  const families = new Map<string | null, T[]>();
  for (const c of capable) families.set(c.processGroup, [...(families.get(c.processGroup) ?? []), c]);
  /** One step over every family: the machines `keep` picks in a family that takes the step, the family's own machines otherwise. */
  const step = (current: Map<string | null, T[]>, applies: (p: MachineSelectionPolicy) => boolean, keep: (c: T) => boolean) => {
    const next = new Map<string | null, T[]>();
    let kept = 0;
    for (const [family, machines] of current) {
      const chosen = applies(policyOf(family)) ? machines.filter(keep) : [];
      const narrowed = chosen.length > 0 && chosen.length < machines.length;
      if (narrowed) kept += chosen.length;
      next.set(family, narrowed ? chosen : machines);
    }
    return { next, kept, count: [...next.values()].reduce((n, m) => n + m.length, 0) };
  };
  const steps: SelectionStep[] = [];
  const virtual = step(families, (p) => p.preferVirtualMachines, (c) => c.virtual === true);
  if (virtual.kept > 0) {
    steps.push({ rule: 'virtual', count: virtual.count, text: `${virtual.kept} virtual machine${virtual.kept === 1 ? '' : 's'} the part fits come${virtual.kept === 1 ? 's' : ''} first (preferVirtualMachines)` });
  }
  const preferred = step(virtual.next, (p) => p.usePreferredMachines, (c) => c.preferred === true);
  if (preferred.kept > 0) {
    steps.push({ rule: 'preferred', count: preferred.count, text: `${preferred.kept} preferred machine${preferred.kept === 1 ? '' : 's'} of them come${preferred.kept === 1 ? 's' : ''} first (usePreferredMachines)` });
  }
  const left = new Set([...preferred.next.values()].flat());
  return { pool: capable.filter((c) => left.has(c)), steps };
}
