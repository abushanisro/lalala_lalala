import { describe, it, expect } from 'vitest';

import { computeOperationVisual } from '@/lib/features/operation-highlight';
import type { FeatureNodeV2 } from '@/lib/types/manufacturing';

const feat = (id: string, feature_type: string, variant: string, faceIds: number[]): FeatureNodeV2 =>
  ({ id, feature_type, variant, occurrences: [{ centroid: [0, 0, 0], face_ids: faceIds }] }) as unknown as FeatureNodeV2;

describe('computeOperationVisual: a Drilling row', () => {
  const features = [
    feat('h1', 'SimpleHole', 'threaded', [1]), feat('h2', 'SimpleHole', 'through', [2]),
    feat('s1', 'MultiStepHole', 'counterbore', [3, 4]), feat('p1', 'PocketV2', 'default', [9]),
  ];

  it('lights the holes it drills, plain and stepped, and nothing else', () => {
    const visual = computeOperationVisual('Drilling', features, []);
    expect(visual?.highlight.occurrences.flatMap((o) => o.face_ids)).toEqual([1, 2, 3, 4]);
  });

  it('a milling row still lights the whole part', () => {
    expect(computeOperationVisual('3 Axis Mill', features, [])).toBeNull();
    expect(computeOperationVisual('Rough Milling', features, [])?.highlight.occurrences.flatMap((o) => o.face_ids)).toEqual([1, 2, 3, 4, 9]);
  });
});
