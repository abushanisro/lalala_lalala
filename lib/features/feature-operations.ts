/**
 * The operations that make a machining feature, in the order they are done. The backend stamps each feature with one catalog operation
 * (canonical_operation, auto-fill.service.ts): a threaded hole is "Tapping // SimpleHole", a tapped cross hole "Drilling // SimpleHole".
 * A tapped hole is drilled first (its tap drill), then tapped, and the cost engine prices both (operation-sequencer.ts: Drilling at the
 * minor diameter, then Tapping), so the feature lists both: "Drilling → Tapping // SimpleHole". Both labels are the catalog's own
 * (canonical-operation.ts maps SimpleHole:through to Drilling and SimpleHole:threaded to Tapping). Any other feature is its one operation.
 */

const DRILL = 'Drilling // SimpleHole';
const TAP = 'Tapping // SimpleHole';

interface FeatureLike {
  feature_type?: unknown;
  canonical_operation?: string | null;
  occurrences?: readonly { tapped?: boolean | null }[] | null;
}

/** The feature's operations in order; `tapped` says whether the hole (one occurrence, or any of them) is tapped. */
export function featureOperations(f: FeatureLike, tapped: boolean = (f.occurrences ?? []).some((o) => o.tapped === true)): string[] {
  if (!f.canonical_operation) return [];
  if (f.feature_type === 'SimpleHole' && tapped) return [DRILL, TAP];
  return [f.canonical_operation];
}

/** "Drilling → Tapping // SimpleHole": the operations in order, the feature type they share named once. */
export function operationsLabel(operations: readonly string[]): string {
  if (operations.length === 0) return '';
  const parts = operations.map((o) => o.split('//').map((s) => s.trim()));
  const feature = parts[0]?.[1];
  return parts.every((p) => p[1] === feature) && feature
    ? `${parts.map((p) => p[0]).join(' → ')} // ${feature}`
    : operations.join(' → ');
}
