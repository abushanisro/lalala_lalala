import type { CatalogOperation } from '@/lib/api/hooks/useBOMItems';

/**
 * A molded part's step lists each kind of feature once. The backend resolves its catalog operations per feature group, so one size of hole
 * can arrive as several rows (one per lifter bundle that forms it, one for the holes the mold halves form), and every plane, curved face and
 * edge of the part as rows of their own. Here:
 *
 *   - the faces and edges the mold halves form with the part (PlanarFace, CurvedSurface, CurvedWall, SharpEdge) are one row, "Surfaces and
 *     edges", which still highlights all of them;
 *   - the rows of one feature type and size are one row, its count the sum, its operations and reasons each listed once.
 *
 * Every number comes from the backend's rows; nothing is derived but sums and unions.
 */
const SURFACE_TYPES: ReadonlySet<string> = new Set(['PlanarFace', 'CurvedSurface', 'CurvedWall', 'SharpEdge']);
export const SURFACES_ROW = 'Surfaces and edges';

const STATUS_RANK: Record<CatalogOperation['status'], number> = { resolved: 0, undecided: 1, infeasible: 2 };

const unique = <T,>(xs: readonly T[]): T[] => [...new Set(xs)];

function merge(featureType: string, variant: string, first: CatalogOperation, rest: readonly CatalogOperation[]): CatalogOperation {
  if (rest.length === 0 && featureType === first.featureType) return first;
  const ops = [first, ...rest];
  const reasons = unique(ops.map((o) => o.reason).filter((r): r is string => !!r));
  // Face lists are in featureIds order: with them, the ids are kept as they come so each still meets its faces.
  const faces = ops.every((o) => o.featureFaceIds) ? ops.flatMap((o) => o.featureFaceIds ?? []) : undefined;
  const ids = ops.flatMap((o) => o.featureIds);
  return {
    ...first,
    featureType,
    variant,
    count: ops.reduce((n, o) => n + o.count, 0),
    featureIds: faces ? ids : unique(ids),
    ...(faces ? { featureFaceIds: faces } : {}),
    operations: unique(ops.flatMap((o) => o.operations)),
    // The row is as settled as its least settled part.
    status: ops.reduce<CatalogOperation['status']>((s, o) => (STATUS_RANK[o.status] > STATUS_RANK[s] ? o.status : s), 'resolved'),
    ...(reasons.length > 0 ? { reason: reasons.join(' · ') } : {}),
    children: ops.flatMap((o) => o.children),
  };
}

export function moldedOperationRows(operations: readonly CatalogOperation[]): CatalogOperation[] {
  const byKind = new Map<string, CatalogOperation[]>();
  const surfaces: CatalogOperation[] = [];
  for (const o of operations) {
    if (SURFACE_TYPES.has(o.featureType)) { surfaces.push(o); continue; }
    const key = `${o.featureType}|${o.diameterMm != null ? o.diameterMm.toFixed(1) : ''}`;
    byKind.set(key, [...(byKind.get(key) ?? []), o]);
  }
  const rows = [...byKind.values()].flatMap(([first, ...rest]) => (first
    ? [merge(first.featureType, unique([first, ...rest].map((o) => o.variant).filter(Boolean)).join(', '), first, rest)]
    : []));
  const [firstSurface, ...otherSurfaces] = surfaces;
  if (firstSurface) {
    const counts = new Map<string, number>();
    for (const o of surfaces) counts.set(o.featureType, (counts.get(o.featureType) ?? 0) + o.count);
    rows.push(merge(SURFACES_ROW, [...counts].map(([t, n]) => `${t} ${n}`).join(', '), firstSurface, otherSurfaces));
  }
  return rows;
}
