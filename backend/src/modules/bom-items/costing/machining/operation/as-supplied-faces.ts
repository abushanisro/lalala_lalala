// The faces of a part cut from stock that the stock supplies finished: a face lying on the stock's own surface, where the stock carries no
// allowance, is not machined (memory/Stock Maching's catalog: Material Stock, As Supplied, on a CurvedWall or a PlanarFace). Pure.

/** The catalog features a face of the part is (cad-engine shared/reference_features.json), which the mill would otherwise finish. */
const FACE_FEATURES: ReadonlySet<string> = new Set(['PlanarFace', 'CurvedWall']);

type Feature = { feature_type?: unknown; variant?: unknown; occurrences?: unknown };
type Occurrence = { face_ids?: unknown };

/**
 * The part's features (feature_graph_v2) without the faces left as supplied: an occurrence of a planar face or a curved wall whose faces
 * are all among `asSuppliedFaceIds` is taken out, so the operation sequencer's Fine Finish Milling and Contouring pass over the other faces
 * only; a face feature left with no occurrence goes with it. Every other feature, and every feature when no face is as supplied, is
 * returned as it is.
 */
export function withoutAsSuppliedFaces<T>(features: T[] | null | undefined, asSuppliedFaceIds: ReadonlySet<number>): T[] | null {
  if (!Array.isArray(features)) return null;
  if (asSuppliedFaceIds.size === 0) return features;
  const supplied = (o: Occurrence) => Array.isArray(o?.face_ids) && o.face_ids.length > 0 && o.face_ids.every((id) => asSuppliedFaceIds.has(id as number));
  return features.flatMap((feature) => {
    const f = feature as Feature;
    const isFace = typeof f?.feature_type === 'string' && FACE_FEATURES.has(f.feature_type) && (f.variant ?? 'default') === 'default';
    if (!isFace || !Array.isArray(f.occurrences)) return [feature];
    const kept = (f.occurrences as Occurrence[]).filter((o) => !supplied(o));
    if (kept.length === f.occurrences.length) return [feature];
    return kept.length ? [{ ...feature, occurrences: kept }] : [];
  });
}
