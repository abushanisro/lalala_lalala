/**
 * Machining cycle times are computed BY the database calculators
 * (machining-calculators.json and its generated migration 804), evaluated by
 * the shared reference-calculator runner. These are the machining names for it.
 */
import {
  CYCLE_TIME_FIELD,
  runReferenceCalculator,
  type CalcRun,
  type CalcSeed,
  type LookupMatch,
  type ReferenceCalcRun,
  type ReferenceCalculatorDef,
  type ReferenceCalculatorField,
  type ReferenceCalculators,
} from '../../shared/calculators/reference-calculator';

export { CYCLE_TIME_FIELD };
export type { CalcRun, CalcSeed, LookupMatch };
export type MachiningCalculatorField = ReferenceCalculatorField;
/** Calculator per catalog operation name ("Drilling", "Rough Turning", ...). */
export type MachiningCalculators = ReferenceCalculators;

export function runMachiningCalculator(
  calculators: MachiningCalculators | null | undefined,
  operation: string,
  seeds: Record<string, CalcSeed>,
): ReferenceCalcRun {
  return runReferenceCalculator(calculators, operation, seeds);
}

/**
 * A calculator run an operation is timed by, kept with its inputs so it can be timed again on each route's machine: a workbook-form
 * calculator caps its spindle at the machine's own limit, so one operation takes a different time on each machine. `lookupMissing`
 * names the reference rows the plan could not read (they are reported with the run's own missing inputs).
 */
export interface PlannedRun {
  operation: string;
  seeds: Record<string, CalcSeed>;
  /** The run's name among an operation's several (a stepped hole's "Step Ø6"). */
  label?: string;
  lookupMissing?: string[];
}

/** A planned run on a machine: its inputs, with the machine's (its spindle limit) laid over them. */
export function runPlanned(
  calculators: MachiningCalculators | null | undefined,
  plan: PlannedRun,
  machine: Record<string, CalcSeed> = {},
): ReferenceCalcRun {
  const run = runReferenceCalculator(calculators, plan.operation, { ...plan.seeds, ...machine });
  return run.missing.length > 0 && plan.lookupMissing?.length ? { ...run, missing: [...plan.lookupMissing, ...run.missing] } : run;
}
