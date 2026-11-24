// Timing a part's planned operations on one machine. The operation sequencer plans every operation before any machine is chosen (its
// calculator runs and their inputs); each route times them on its own machine, since a calculator may cap its spindle at the machine's
// own limit (mhr_records.specs spindle_speed_rpm, migration 1136).
import { runPlanned, type CalcSeed, type MachiningCalculators } from '../calculators/machining-calculator';
import { prefixTrace, traceCalc } from '../process/machining-trace';
import type { OperationLine } from './operation-sequencer';

/**
 * The operations timed on one machine: each planned operation's calculator runs again with the machine's inputs (its spindle limit)
 * laid over the plan's, times its drawing factor. With no machine inputs, the times are the plan's own. An operation with no plan is
 * as it was.
 */
export function timeOperations(
  ops: readonly OperationLine[],
  calculators: MachiningCalculators | null | undefined,
  machine: Record<string, CalcSeed> = {},
): OperationLine[] {
  return ops.map((op) => {
    if (!op.plan?.length) return op;
    const runs = op.plan.map((p) => ({ p, run: runPlanned(calculators, p, machine) }));
    const factor = op.timeFactor ?? 1;
    const timeSec = runs.reduce((t, r) => t + (r.run.sec ?? 0), 0) * factor;
    const missing = runs.flatMap((r) => r.run.missing);
    const first = runs.find((r) => r.run.calculatorId)?.run;
    const trace = runs.length === 1
      ? runs[0]!.run.trace
      : [...runs.flatMap((r) => prefixTrace(`${r.p.label ?? r.p.operation} ·`, r.run.trace)), traceCalc(`${op.name} cycle time`, timeSec / factor, 's', 'Sum of every run\'s Cycle Time')];
    const { missing: _planned, ...rest } = op;
    return {
      ...rest,
      timeSec,
      trace,
      ...(first?.calculatorId ? { calculator: { id: first.calculatorId, version: first.calculatorVersion, lookups: Object.assign({}, ...runs.map((r) => r.run.lookups)) } } : {}),
      ...(missing.length > 0 ? { missing: missing.join('; ') } : {}),
    };
  });
}
