// The milling a lathe does with a live tool: the part's keyways that are not broached, and its slots. Pure.
//
// The turning engine turns the part's diameters, drills its holes and taps its threads. A keyway or a slot it can only mill, with a driven
// tool (capability/live-tooling.ts: which features, and which lathes have the tool). The operations and their times are the operation
// sequencer's (operation-sequencer.ts), the ones a mill is priced on: "Rough Milling" of the volume the feature removes, "Slot Milling" of
// each slot, each timed by its own stored calculator from the feature's CAD measurements. On a lathe each operation name is one line: its
// sequenced operations summed, each one a row of the line naming the features it mills, for the Process tree to list and light.
import { sumRuns } from './machining-trace';
import { isLatheMilledFeatureType, type LatheMilledFeatureType } from '../capability/live-tooling';

import type { FeatureOp } from '../../../dto/cost-breakdown.dto';
import type { CalcRun } from '../calculators/machining-calculator';
import type { OperationLine } from '../operation/operation-sequencer';

/** A sequenced operation on a feature a lathe mills. */
export type LatheMillingOp = OperationLine & { cadFeatureType: LatheMilledFeatureType };

/** Of the part's sequenced operations, those a lathe mills: the operations on its Keyway and Slot features. */
export function latheMillingOps(ops: readonly OperationLine[]): LatheMillingOp[] {
  return ops.filter((o): o is LatheMillingOp => isLatheMilledFeatureType(o.cadFeatureType));
}

export interface LatheMillingLine {
  /** The catalog operation the line is ("Rough Milling", "Slot Milling"). */
  operation: string;
  /** The line's time and calculation: the calculator run of each of its sequenced operations, summed. */
  run: CalcRun;
  /** Each sequenced operation that has a time: the features it mills. */
  rows: FeatureOp[];
}

/** The calculator run that timed a sequenced operation; one the sequencer could not time has no time and names what it lacks. */
function runOf(op: LatheMillingOp): CalcRun {
  return {
    sec: op.missing ? null : op.timeSec,
    trace: op.trace ?? [],
    missing: op.missing ? [op.missing] : [],
    calculatorId: op.calculator?.id ?? null,
    calculatorVersion: op.calculator?.version ?? null,
    lookups: op.calculator?.lookups ?? {},
  };
}

/** A name for each operation of one line: its feature type, numbered when the line has several of the type ("Keyway 1", "Keyway 2"). */
function featureLabels(ops: readonly LatheMillingOp[]): string[] {
  const seen = new Map<string, number>();
  return ops.map((op) => {
    const nth = (seen.get(op.cadFeatureType) ?? 0) + 1;
    seen.set(op.cadFeatureType, nth);
    return ops.filter((o) => o.cadFeatureType === op.cadFeatureType).length > 1 ? `${op.cadFeatureType} ${nth}` : op.cadFeatureType;
  });
}

/**
 * The lathe's milling lines, one per operation name in the sequencer's order. A line is emitted only when it has a time or names what it
 * lacks: an operation with nothing to cut (no volume to rough) is not missing data.
 */
export function latheMillingLines(ops: readonly LatheMillingOp[] | null | undefined): LatheMillingLine[] {
  const byOperation = new Map<string, LatheMillingOp[]>();
  for (const op of ops ?? []) byOperation.set(op.name, [...(byOperation.get(op.name) ?? []), op]);
  return [...byOperation].map(([operation, group]): LatheMillingLine => {
    const labels = featureLabels(group);
    return {
      operation,
      run: sumRuns(group.map((op, i) => ({ label: labels[i], run: runOf(op) })), `${operation} cycle time`),
      rows: group.flatMap((op, i) => {
        if (!(op.timeSec > 0) || op.missing) return [];
        const count = op.count ?? 1;
        return [{
          name: `${operation} // ${labels[i]}${count > 1 ? ` ×${count}` : ''}`,
          timeSec: op.timeSec, featureType: op.cadFeatureType, count,
          ...(op.featureIds?.length ? { featureIds: [...op.featureIds] } : {}),
        }];
      }),
    };
  }).filter((line) => (line.run.sec ?? 0) > 0 || line.run.missing.length > 0);
}
