// The holes a machined part's inspection covers: Special Inspection, "Feature Inspection" of each SimpleHole, MultiStepHole and RingedHole
// (memory/Machining operations_full__operations.csv). The inspection's time is the machining workbook's Inspection sheet (calculator
// Machining - Inspection, migration 1151); these are listed on its line and lit on the model. Pure.

/** The feature types the reference inspects (Special Inspection: Feature Inspection//<type>). */
export const INSPECTED_FEATURE_TYPES: ReadonlySet<string> = new Set(['SimpleHole', 'MultiStepHole', 'RingedHole']);

/** The features the reference inspects, from the part's feature_graph_v2: every occurrence of a hole type it names. */
export function inspectedFeatures(features: ReadonlyArray<{ id: string; feature_type: string; occurrences?: readonly unknown[] }> | null | undefined) {
  return (features ?? []).filter((f) => INSPECTED_FEATURE_TYPES.has(f.feature_type));
}

/** Every occurrence the reference inspects, by feature and occurrence index: what the inspection line lists and lights. */
export function inspectedOccurrences(
  features: ReadonlyArray<{ id: string; feature_type: string; occurrences?: readonly unknown[] }> | null | undefined,
): Array<{ featureId: string; occurrenceIndex: number }> {
  return inspectedFeatures(features).flatMap((f) => (f.occurrences ?? []).map((_, occurrenceIndex) => ({ featureId: f.id, occurrenceIndex })));
}
