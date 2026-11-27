import { describe, expect, it } from 'vitest';

import { buildIMHeatmapSources } from '@/lib/heatmap/sources';
import type { IMHeatmapFeatures, IMHeatmapSignals } from '@/lib/heatmap/types';
import type { FeatureGraph } from '@/lib/types/manufacturing';

const signals: IMHeatmapSignals = {
  wallThicknessNominalMm: 2, wallThicknessMaxMm: 4, wallUniformityRatio: 0.5, undercutFaceCount: 0,
  undraftedFaceCount: 0, blindFeatureCount: 0, partingComplexity: 0, avgDraftAngleDeg: 1.5, ribCount: 0,
  bboxMm: [200, 100, 20],
};
const features: IMHeatmapFeatures = {
  bosses: [], ribs: [], draft_faces: [],
  wall_samples: [
    { centroid: [10, 0, 0], thickness_mm: 1, delta_from_nominal: 0.5 },
    { centroid: [50, 0, 0], thickness_mm: 4, delta_from_nominal: 1 },
  ],
};
const fg = {} as FeatureGraph;

describe('flow_analysis heatmap layer', () => {
  it('marks thin walls, thick walls and the flow length / thickness risk, all as estimates', () => {
    const src = buildIMHeatmapSources(fg, signals, features, 'flow_analysis');
    expect(src.every((s) => s.layer === 'flow_analysis')).toBe(true);
    expect(src.some((s) => s.reason?.startsWith('Thin wall'))).toBe(true);
    expect(src.some((s) => s.reason?.startsWith('Thick section'))).toBe(true);
    expect(src.some((s) => s.reason?.startsWith('Flow length / thickness'))).toBe(true);
    expect(src.every((s) => s.reason == null || s.reason.includes('estimate'))).toBe(true);
  });

  it('a hard-flow material raises the fill difficulty of a thin wall', () => {
    const thin = (c: 'easy' | 'hard') => buildIMHeatmapSources(fg, signals, features, 'flow_analysis', c)
      .find((s) => s.reason?.startsWith('Thin wall'))!.amplitude;
    expect(thin('hard')).toBeGreaterThan(thin('easy'));
  });
});
