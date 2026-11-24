/**
 * The inputs a machining calculator reads from the machine it runs on (Max Spindle Speed, from mhr_records.specs): in the Edit Process
 * Cost dialog they are read from the machine chosen there (POST /bom-items/:id/machining-calculator-inputs with its machineId), and read
 * again whenever that machine changes.
 */
import type { SourceRef } from './input-source';

const LIVE_TOOL_COLUMN = 'specs.live_tooling_speed_rpm';

/** The engine ran the calculator on a lathe's live tool (milling on the lathe): its spindle cap is the live tool's. */
export function runsOnLiveTool(refs: Readonly<Record<string, SourceRef>> | null | undefined): boolean {
  return Object.values(refs ?? {}).some((r) => r.kind === 'machine' && r.column === LIVE_TOOL_COLUMN);
}

/** The inputs the engine read from its machine's record, until the database names them (its machineFields). */
export function machineFieldsOf(refs: Readonly<Record<string, SourceRef>> | null | undefined): Set<string> {
  return new Set(Object.entries(refs ?? {}).filter(([, r]) => r.kind === 'machine').map(([f]) => f));
}

/** The engine read some input from a machine other than `machineId`: the machine inputs shown are not the chosen machine's. */
export function readFromAnotherMachine(refs: Readonly<Record<string, SourceRef>> | null | undefined, machineId: string | null | undefined): boolean {
  return !!machineId && Object.values(refs ?? {}).some((r) => r.kind === 'machine' && r.machineId !== machineId);
}

/** Every machine input shown was read from `machineId`'s record: there is nothing to read again for it. */
export function allReadFrom(shown: readonly (SourceRef | undefined)[], machineId: string): boolean {
  return shown.length > 0 && shown.every((r) => r?.kind === 'machine' && r.machineId === machineId);
}

/**
 * Leaving a field is an entry only when its value changed from the one it was filled with (cost engine, database, machine), or the
 * engineer already entered it; a field clicked into and left keeps its value's source.
 */
export function isEntry(alreadyEntered: boolean, filled: unknown, now: unknown): boolean {
  return alreadyEntered || filled === undefined || Number(now) !== Number(filled);
}
