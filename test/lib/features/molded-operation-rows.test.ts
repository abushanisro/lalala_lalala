import { describe, expect, it } from 'vitest';

import type { CatalogOperation } from '@/lib/api/hooks/useBOMItems';
import { SURFACES_ROW, moldedOperationRows } from '@/lib/features/molded-operation-rows';

const op = (featureType: string, count: number, ids: string[], over: Partial<CatalogOperation> = {}): CatalogOperation => ({
  operations: ['Mold'], featureType, variant: '', diameterMm: null, count, featureIds: ids, status: 'resolved', children: [], ...over,
});

// Cannula Holder Right's molding step as the backend resolves it: one size of hole as several rows, every face and edge as rows of their own.
const cannula: CatalogOperation[] = [
  op('CurvedSurface', 36, ['cs']),
  op('LifterBundle', 5, ['b1', 'b2', 'b3', 'b4', 'b5'], { status: 'undecided', operations: ['Lifter', 'Slide'], variant: 'small' }),
  op('PlanarFace', 50, ['pf']),
  op('SharpEdge', 183, ['se1'], { variant: 'external' }),
  op('SharpEdge', 33, ['se2'], { variant: 'internal' }),
  op('SimpleHole', 1, ['h1'], { diameterMm: 3.2, operations: [], reason: 'Formed by its LifterBundle (bundle-3).', variant: 'through' }),
  op('SimpleHole', 2, ['h2', 'h3'], { diameterMm: 3.2, reason: 'Formed by the mold halves.', variant: 'through' }),
  op('SimpleHole', 1, ['h4'], { diameterMm: 3.249, operations: [], reason: 'Formed by its LifterBundle (bundle-4).', variant: 'through' }),
  op('SimpleHole', 1, ['h5'], { diameterMm: 2.075, variant: 'through' }),
];

describe('moldedOperationRows: each kind of feature of a molded part once', () => {
  const rows = moldedOperationRows(cannula);
  const byLabel = (t: string, d: number | null = null) => rows.find((r) => r.featureType === t && (r.diameterMm == null ? null : r.diameterMm.toFixed(1)) === (d == null ? null : d.toFixed(1)));

  it('one row per feature type and size, the plain faces and edges one row at the end', () => {
    expect(rows.map((r) => `${r.featureType}${r.diameterMm != null ? ` Ø${r.diameterMm.toFixed(1)}` : ''} ×${r.count}`)).toEqual([
      'LifterBundle ×5', 'SimpleHole Ø3.2 ×4', 'SimpleHole Ø2.1 ×1', `${SURFACES_ROW} ×302`,
    ]);
  });

  it('a merged row highlights every feature of its rows, names each operation and reason once, and is as settled as its least settled part', () => {
    const holes = byLabel('SimpleHole', 3.2)!;
    expect(holes.featureIds).toEqual(['h1', 'h2', 'h3', 'h4']);
    expect(holes.operations).toEqual(['Mold']);
    expect(holes.reason).toBe('Formed by its LifterBundle (bundle-3). · Formed by the mold halves. · Formed by its LifterBundle (bundle-4).');
    expect(holes.variant).toBe('through');
    expect(byLabel('LifterBundle')!.status).toBe('undecided');
  });

  it('the surfaces row highlights every face and edge, and says how many of each', () => {
    const surfaces = byLabel(SURFACES_ROW)!;
    expect(surfaces.featureIds).toEqual(['cs', 'pf', 'se1', 'se2']);
    expect(surfaces.variant).toBe('CurvedSurface 36, PlanarFace 50, SharpEdge 216');
  });

  it('a row alone is passed through as the backend sent it', () => {
    const single = cannula[1]!;
    expect(moldedOperationRows([single])).toEqual([single]);
  });

  it('face lists (a casting analysis) stay in step with their feature ids', () => {
    const merged = moldedOperationRows([
      op('SimpleHole', 1, ['a'], { diameterMm: 5, featureFaceIds: [[1, 2]] }),
      op('SimpleHole', 1, ['a'], { diameterMm: 5, featureFaceIds: [[3]] }),
    ]);
    expect(merged[0]).toMatchObject({ featureIds: ['a', 'a'], featureFaceIds: [[1, 2], [3]], count: 2 });
  });
});
