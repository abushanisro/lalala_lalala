/**
 * Unit tests for the operation sequencer (Sprint 1 — Fix 3 + Fix 4 + Fix 5)
 *
 * Each test uses synthetic feature_graph_v2 data and verifies:
 *  - Correct operation names generated per feature type
 *  - Machinability factor scales total time appropriately
 *  - Drawing intelligence injection adds/modifies ops correctly
 */

import {
  buildOperationSequence as buildWith,
  totalCycleTimeSec,
  injectDrawingIntelligence,
  type OperationLine,
  type SequenceOptions,
} from '../../../../../../modules/bom-items/costing/machining/operation/operation-sequencer';
import { specAsCalculators } from '../../../../../../modules/bom-items/costing/machining/calculators/machining-calculator-spec';
import { workbookFixture } from '../workbook-fixture';
import { timeOperations } from '../../../../../../modules/bom-items/costing/machining/operation/time-operations';

const REMOVAL_RATE: Record<string, number> = {
  aluminum: 60000, mild_steel: 12000, stainless: 5000, titanium: 3000, copper_alloy: 40000, tool_steel: 3000, plastic: 150000,
};

const cutter = (teeth: number, cuttingSpeedMPerMin: number, feedPerToothPerDiameter: number) => ({ toolDiameterMm: 10, teeth, cuttingSpeedMPerMin, feedPerToothPerDiameter });
const FINISHING: Record<string, ReturnType<typeof cutter>> = {
  aluminum: cutter(3, 183, 0.008), copper_alloy: cutter(3, 91, 0.008), plastic: cutter(2, 183, 0.012), mild_steel: cutter(4, 76, 0.008),
  stainless: cutter(4, 61, 0.004), titanium: cutter(4, 46, 0.004), tool_steel: cutter(4, 46, 0.004),
};

// Every operation is timed by its stored calculator, so the sequencer is always given them (as production does):
// the calculators of the spec unless a test passes its own.
// The plan is timed on a test machine with a 10 000 rpm spindle, as each route times it on its own (timeOperations).
const TEST_MACHINE = { 'Max Spindle Speed': { value: 10000, source: 'Machine: test spindle_speed_rpm' } };
const buildOperationSequence = (features: Parameters<typeof buildWith>[0], options: SequenceOptions): OperationLine[] => {
  const full: SequenceOptions = {
    calculators: specAsCalculators(),
    // The removal rate of the material class, as tblMillingRemovalRate stages it (migration 1036).
    removalRateMm3PerMin: REMOVAL_RATE[options.matClass] ?? null,
    // The finishing cutter of the material class, as tblMillingFinishing stages it (migration 1039).
    finishing: FINISHING[options.matClass] ?? null,
    ...options,
  };
  return timeOperations(buildWith(features, full), full.calculators, TEST_MACHINE);
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function tappedHoleFeature(count = 1, diamMm = 4, spec = 'M4'): object {
  return {
    feature_type: 'SimpleHole', variant: 'threaded',
    diameter_mm: diamMm,
    occurrences: Array.from({ length: count }, (_, i) => ({
      centroid: [i * 10, 0, 0],
      depth_mm: diamMm * 2,
      tapped: true,
      spec,
      material_removed_mm3: Math.PI * (diamMm / 2) ** 2 * diamMm * 2,
    })),
  };
}

function pocketFeature(count = 1, removedMm3Each = 5000): object {
  return {
    feature_type: 'PocketV2', variant: 'default',
    diameter_mm: 0,
    occurrences: Array.from({ length: count }, () => ({
      depth_mm: 10,
      material_removed_mm3: removedMm3Each,
    })),
  };
}

function throughHoleFeature(count = 1, diamMm = 6): object {
  return {
    feature_type: 'SimpleHole', variant: 'through',
    diameter_mm: diamMm,
    occurrences: Array.from({ length: count }, () => ({
      depth_mm: 20,
      material_removed_mm3: Math.PI * (diamMm / 2) ** 2 * 20,
    })),
  };
}

// Real cad-engine shape (face_classification.py): PlanarFace/CurvedWall/
// CurvedSurface regions carry a real classified area_mm2 per
// occurrence, no diameter, material_removed_mm3 honestly 0.0 (classifying a
// face does not reveal how much stock sat above it).
function faceRegionFeature(ftype: 'PlanarFace' | 'CurvedWall' | 'CurvedSurface', areaMm2 = 2000): object {
  return {
    feature_type: ftype,
    variant: 'default',
    occurrences: [{ centroid: [0, 0, 0], area_mm2: areaMm2, material_removed_mm3: 0 }],
  };
}

// Real cad-engine shape (Phase 5, detect_cutout_rings): a non-circular
// through-opening, real total wall area_mm2 + side_count, no diameter.
function cutoutFeature(areaMm2 = 1120, sideCount = 4): object {
  return {
    feature_type: 'Cutout', variant: 'default',
    occurrences: [{ centroid: [0, 0, 0], area_mm2: areaMm2, side_count: sideCount, material_removed_mm3: 0 }],
  };
}

// Real cad-engine shape (Phase 5, _detect_multistep_holes): each real
// occurrence carries its own steps[] of {diameter_mm, depth_mm}, strictly
// decreasing diameter, NOT a single scalar diameter_mm/depth_mm.
function multiStepHoleFeature(steps: Array<{ diameter_mm: number; depth_mm: number }>): object {
  return {
    feature_type: 'MultiStepHole', variant: 'stepped',
    occurrences: [{ centroid: [0, 0, 0], steps, step_count: steps.length, material_removed_mm3: 0 }],
  };
}

// Real cad-engine shape: build_machining_feature_graph_v2 buckets toroidal
// features (Edge/round = convex blend, Slot/groove = concave recess) by major_diameter_mm (entry.diameter_mm), material_removed_mm3
// honestly 0.0 (never extracted for toroidal blends) — see that function's
// own doc comment.
function toroidFeature(kind: 'fillet' | 'groove', count = 1, majorDiamMm = 30): object {
  const [featureType, variant] = kind === 'fillet' ? ['Edge', 'round'] : ['Slot', 'groove'];
  return {
    feature_type: featureType,
    variant,
    diameter_mm: majorDiamMm,
    occurrences: Array.from({ length: count }, () => ({
      radius_mm: 4,
      material_removed_mm3: 0,
    })),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('buildOperationSequence', () => {
  it('returns empty array for null/empty feature list', () => {
    expect(buildOperationSequence(null, { matClass: 'aluminum' })).toEqual([]);
    expect(buildOperationSequence([], { matClass: 'aluminum' })).toEqual([]);
  });

  it('always starts with Facing and ends with Deburr', () => {
    const features = [tappedHoleFeature(2)];
    const ops = buildOperationSequence(features, { matClass: 'aluminum' });
    expect(ops[0].name).toBe('Facing');
    expect(ops[ops.length - 1].name).toBe('Deburr');
  });

  it('generates Center Drilling + Drilling + Chamfering + Tapping for tapped holes', () => {
    const ops = buildOperationSequence([tappedHoleFeature(3, 4, 'M4')], { matClass: 'aluminum' });
    const names = ops.map((o) => o.name);
    expect(names).toContain('Center Drilling');
    expect(names).toContain('Drilling');
    expect(names).toContain('Chamfering');
    expect(names).toContain('Tapping');
  });

  it('generates Rough Milling + Fine Finish Milling (floor + wall) for pockets', () => {
    const ops = buildOperationSequence([pocketFeature(2, 8000)], { matClass: 'mild_steel' });
    const names = ops.map((o) => o.name);
    expect(names).toContain('Rough Milling');
    expect(names).toContain('Fine Finish Milling');
    expect(names).toContain('Fine Finish Milling');
  });

  it('generates Center Drilling + Drilling for through holes', () => {
    const ops = buildOperationSequence([throughHoleFeature(4, 6)], { matClass: 'aluminum' });
    const names = ops.map((o) => o.name);
    expect(names).toContain('Center Drilling');
    expect(names).toContain('Drilling');
    // No tap
    expect(names).not.toContain('Tapping');
  });

  it('carries the real CAD feature_type + diameter onto every hole-family op, for 3D-viewer highlight matching', () => {
    const ops = buildOperationSequence([tappedHoleFeature(3, 4, 'M4')], { matClass: 'aluminum' });
    const spotDrill = ops.find((o) => o.name === 'Center Drilling')!;
    const drill = ops.find((o) => o.name === 'Drilling')!;
    const chamfer = ops.find((o) => o.name === 'Chamfering')!;
    const rigidTap = ops.find((o) => o.name === 'Tapping')!;
    for (const op of [spotDrill, drill, chamfer, rigidTap]) {
      expect(op.cadFeatureType).toBe('SimpleHole');
      expect(op.diameterMm).toBe(4);
    }
  });

  it('carries the real CAD feature_type (no diameter) onto pocket/slot ops', () => {
    const ops = buildOperationSequence([pocketFeature(2, 8000)], { matClass: 'mild_steel' });
    const rough = ops.find((o) => o.name === 'Rough Milling')!;
    expect(rough.cadFeatureType).toBe('PocketV2');
    expect(rough.diameterMm).toBeUndefined();
  });

  it('generates real, distinct Filleting/Groove Milling ops for fillet and groove features (Phase 0 coverage fix; Phase 4b real-name split)', () => {
    // 13.7 mm/s: an edge speed, as tblCornerRoundingMill gives one for the material.
    const filletOps = buildOperationSequence([toroidFeature('fillet', 2, 30)], { matClass: 'aluminum', machinabilityFactor: 1.0, roundingLinearSpeedMmPerSec: 13.7 });
    const grooveOps = buildOperationSequence([toroidFeature('groove', 1, 18)], { matClass: 'aluminum', machinabilityFactor: 1.0, roundingLinearSpeedMmPerSec: 13.7 });

    // fillet and groove used to share one invented "Corner Round" name;
    // the real catalog treats them as two different real operations
    // (Filleting = edge rounding, Groove Milling = material removal) — the
    // split proves this file no longer conflates them.
    const filletRound = filletOps.find((o) => o.name === 'Filleting')!;
    expect(filletRound).toBeDefined();
    expect(filletRound.cadFeatureType).toBe('Edge');
    expect(filletRound.diameterMm).toBe(30);
    expect(filletRound.timeSec).toBeGreaterThan(0);

    const grooveRound = grooveOps.find((o) => o.name === 'Groove Milling')!;
    expect(grooveRound).toBeDefined();
    expect(grooveRound.cadFeatureType).toBe('Slot');
    expect(grooveRound.diameterMm).toBe(18);
  });

  it('generates real area-driven ops for planar_face/curved_wall/curved_surface regions (Phase 3)', () => {
    const planarOps = buildOperationSequence([faceRegionFeature('PlanarFace', 3000)], { matClass: 'aluminum' });
    const wallOps = buildOperationSequence([faceRegionFeature('CurvedWall', 900)], { matClass: 'aluminum' });
    const surfaceOps = buildOperationSequence([faceRegionFeature('CurvedSurface', 500)], { matClass: 'aluminum' });

    const face = planarOps.find((o) => o.name === 'Fine Finish Milling')!;
    expect(face).toBeDefined();
    expect(face.cadFeatureType).toBe('PlanarFace');
    expect(face.timeSec).toBeGreaterThan(0);

    const wall = wallOps.find((o) => o.name === 'Contouring')!;
    expect(wall).toBeDefined();
    expect(wall.cadFeatureType).toBe('CurvedWall');
    expect(wall.timeSec).toBeGreaterThan(0);

    const surface = surfaceOps.find((o) => o.name === 'Contouring')!;
    expect(surface).toBeDefined();
    expect(surface.cadFeatureType).toBe('CurvedSurface');
    expect(surface.timeSec).toBeGreaterThan(0);

    // Larger real area -> more real time, not a flat constant.
    expect(face.timeSec).toBeGreaterThan(wall.timeSec);
  });

  it('a zero-area face region contributes zero time, not a fabricated fallback', () => {
    const ops = buildOperationSequence([faceRegionFeature('PlanarFace', 0)], { matClass: 'aluminum' });
    const face = ops.find((o) => o.name === 'Fine Finish Milling')!;
    expect(face.timeSec).toBe(0);
  });

  it('generates real per-step Center Drilling + Drilling time for a multi_step_hole (Phase 5)', () => {
    const ops = buildOperationSequence(
      [multiStepHoleFeature([
        { diameter_mm: 16, depth_mm: 8 },
        { diameter_mm: 10, depth_mm: 10 },
        { diameter_mm: 6, depth_mm: 10 },
      ])],
      { matClass: 'mild_steel', machinabilityFactor: 1.0, workbook: workbookFixture(), calculators: specAsCalculators() },
    );
    const spotDrill = ops.find((o) => o.name === 'Center Drilling' && o.cadFeatureType === 'MultiStepHole')!;
    const drill = ops.find((o) => o.name === 'Drilling' && o.cadFeatureType === 'MultiStepHole')!;
    expect(spotDrill).toBeDefined();
    expect(spotDrill.timeSec).toBe(5); // one real spot-drill per hole assembly, not per step
    expect(drill).toBeDefined();
    expect(drill.timeSec).toBeGreaterThan(0);

    // Real per-step sum must exceed a single-step estimate at the largest
    // diameter alone -- proving all 3 real steps actually contributed time,
    // not just the first.
    const singleStepOps = buildOperationSequence(
      [multiStepHoleFeature([{ diameter_mm: 16, depth_mm: 8 }])],
      { matClass: 'mild_steel', machinabilityFactor: 1.0, workbook: workbookFixture(), calculators: specAsCalculators() },
    );
    const singleDrill = singleStepOps.find((o) => o.name === 'Drilling' && o.cadFeatureType === 'MultiStepHole')!;
    expect(drill.timeSec).toBeGreaterThan(singleDrill.timeSec);
  });

  it('generates a real Perimeter Milling op for a cutout region (Phase 5)', () => {
    const ops = buildOperationSequence([cutoutFeature(1120, 4)], { matClass: 'aluminum' });
    const perimeter = ops.find((o) => o.name === 'Perimeter Milling')!;
    expect(perimeter).toBeDefined();
    expect(perimeter.cadFeatureType).toBe('Cutout');
    expect(perimeter.timeSec).toBeGreaterThan(0);

    const zeroArea = buildOperationSequence([cutoutFeature(0, 4)], { matClass: 'aluminum' });
    const zeroPerimeter = zeroArea.find((o) => o.name === 'Perimeter Milling')!;
    expect(zeroPerimeter.timeSec).toBe(0);
  });

  it('through holes carry through_hole as cadFeatureType, distinct from tapped_hole', () => {
    const ops = buildOperationSequence([throughHoleFeature(4, 6)], { matClass: 'aluminum' });
    const drill = ops.find((o) => o.name === 'Drilling')!;
    expect(drill.cadFeatureType).toBe('SimpleHole');
    expect(drill.diameterMm).toBe(6);
  });

  it('fixed ops (Facing, Deburr) carry no cadFeatureType — nothing to highlight for them', () => {
    const ops = buildOperationSequence([tappedHoleFeature(1)], { matClass: 'aluminum' });
    expect(ops.find((o) => o.name === 'Facing')!.cadFeatureType).toBeUndefined();
    expect(ops.find((o) => o.name === 'Deburr')!.cadFeatureType).toBeUndefined();
  });

  it('machinability factor 2.0 (Al 6061 vs mild steel) halves cycle time for pockets', () => {
    const features = [pocketFeature(1, 10_000)];
    const milSteel = buildOperationSequence(features, { matClass: 'mild_steel', machinabilityFactor: 1.0 });
    const aluminum = buildOperationSequence(features, { matClass: 'aluminum', machinabilityFactor: 2.0 });

    const roughTimeMild = milSteel.find((o) => o.name === 'Rough Milling')!.timeSec;
    const roughTimeAlum = aluminum.find((o) => o.name === 'Rough Milling')!.timeSec;

    // Al MRR = 60000 * 2 = 120000; mild_steel MRR = 12000 * 1 = 12000 → 10× faster
    // so aluminum pocket rough time ≈ roughTimeMild / 10
    expect(roughTimeAlum).toBeCloseTo(roughTimeMild / 10, 0);
  });

  it('ops are sorted in canonical manufacturing order', () => {
    const features = [pocketFeature(1), tappedHoleFeature(2), throughHoleFeature(1)];
    const ops = buildOperationSequence(features, { matClass: 'aluminum' });
    const names = ops.map((o) => o.name);

    // Facing must precede pockets; Drilling before Tapping; Deburr at end
    const faceIdx = names.indexOf('Facing');
    const roughIdx = names.indexOf('Rough Milling');
    const drillIdx = names.lastIndexOf('Drilling');
    const tapIdx = names.indexOf('Tapping');
    const deburrIdx = names.indexOf('Deburr');

    expect(faceIdx).toBeLessThan(roughIdx);
    expect(drillIdx).toBeLessThan(tapIdx);
    expect(tapIdx).toBeLessThan(deburrIdx);
  });

  it('totalCycleTimeSec sums all operation times', () => {
    const ops: OperationLine[] = [
      { name: 'Facing', timeSec: 45, source: 'fixed' },
      { name: 'Rough Milling', timeSec: 120, source: 'feature' },
      { name: 'Deburr', timeSec: 90, source: 'fixed' },
    ];
    expect(totalCycleTimeSec(ops)).toBe(255);
  });
});

describe('injectDrawingIntelligence', () => {
  const baseOps: OperationLine[] = [
    { name: 'Facing', timeSec: 45, source: 'fixed' },
    { name: 'Rough Milling', timeSec: 200, source: 'feature' },
    { name: 'Fine Finish Milling', timeSec: 30, source: 'feature' },
    { name: 'Deburr', timeSec: 90, source: 'fixed' },
  ];

  it('returns ops unchanged when drawing intelligence is null', () => {
    const result = injectDrawingIntelligence(baseOps, null);
    expect(result).toEqual(baseOps);
  });

  it('scales finish op +30% when Ra < 1.6', () => {
    const result = injectDrawingIntelligence(baseOps, {
      surfaceFinishRa: { value: 0.8 },
    });
    const rough = result.find((o) => o.name === 'Rough Milling')!;
    // The first Finish/Rough op gets +30%
    expect(rough.timeSec).toBeCloseTo(200 * 1.3, 1);
  });

  it('does NOT scale finish op when Ra >= 1.6', () => {
    const result = injectDrawingIntelligence(baseOps, {
      surfaceFinishRa: { value: 3.2 },
    });
    const rough = result.find((o) => o.name === 'Rough Milling')!;
    expect(rough.timeSec).toBe(200); // unchanged
  });

  it('adds Tapping for a drawing thread callout, priced from the workbook\'s tapping speed when the depth is known', () => {
    const opsWithoutTap = baseOps.filter((o) => o.name !== 'Tapping');
    const result = injectDrawingIntelligence(opsWithoutTap, {
      threads: [{ spec: 'M6', count: 2, depthMm: 12 }],
    }, 'AISI 1018', workbookFixture(), specAsCalculators());
    // Planned before the machine is known; timed on the test machine, as a route times it.
    const tap = timeOperations(result, specAsCalculators(), TEST_MACHINE).find((o) => o.name === 'Tapping');
    expect(tap).toBeDefined();
    expect(tap!.timeSec).toBeGreaterThan(0);
    expect(tap!.missing).toBeUndefined();
  });

  it('adds an unpriced Tapping op naming the missing depth for a callout without one', () => {
    const opsWithoutTap = baseOps.filter((o) => o.name !== 'Tapping');
    const tap = injectDrawingIntelligence(opsWithoutTap, { threads: [{ spec: 'M6', count: 2 }] }, 'AISI 1018', workbookFixture(), specAsCalculators())
      .find((o) => o.name === 'Tapping')!;
    expect(tap.timeSec).toBe(0);
    expect(tap.missing).toContain('Thread Depth');
  });

  it('does NOT add duplicate Rigid Tap when one already exists', () => {
    const opsWithTap = [...baseOps, { name: 'Tapping', timeSec: 20, source: 'feature' as const }];
    const result = injectDrawingIntelligence(opsWithTap, {
      threads: [{ spec: 'M6', count: 2 }],
    });
    const tapCount = result.filter((o) => o.name === 'Tapping').length;
    expect(tapCount).toBe(1);
  });

  it('adds CMM Inspect when tightest tolerance < 0.05 mm', () => {
    const result = injectDrawingIntelligence(baseOps, {
      tolerances: { tightest: 0.02 },
    });
    expect(result.some((o) => o.name === 'CMM Inspect')).toBe(true);
  });

  it('does NOT add CMM Inspect when tolerance >= 0.05 mm', () => {
    const result = injectDrawingIntelligence(baseOps, {
      tolerances: { tightest: 0.1 },
    });
    expect(result.some((o) => o.name === 'CMM Inspect')).toBe(false);
  });
});

// Root-caused 2026-09-16: Counterbore used a flat "count * 8 sec" constant
// (no citation, no diameter or material sensitivity); Chamfer used a flat
// "count * 5 sec" constant. Both now use real tblCounterboring/
// tblChamfering physics when the caller resolves and passes them in
// (bom-items.service.ts, via MachiningLookupService) — falling back to the
// previous flat constants, disclosed as fallbacks, only when that data
// isn't available.
function counterboreFeature(count = 1, diamMm = 10): object {
  return {
    feature_type: 'MultiStepHole', variant: 'counterbore',
    diameter_mm: diamMm,
    occurrences: Array.from({ length: count }, () => ({
      depth_mm: 5,
      material_removed_mm3: 100,
    })),
  };
}

const COUNTERBORE_TABLE = [
  { tool_type: 'Counterbore', material_cut_code_name: '1.0', hardness: 125, hardness_system: 'Brinell', diameter_mm: 10, cutting_speed_m_min: 75.2, feed_mm_rev: 0.15, depth_max_mm: 38 },
  { tool_type: 'Counterbore', material_cut_code_name: '5.0', hardness: 275, hardness_system: 'Brinell', diameter_mm: 10, cutting_speed_m_min: 25.0, feed_mm_rev: 0.08, depth_max_mm: 38 },
  // Real row copied verbatim from memory/Machining/lookup (tblCounterboring__rows.csv): the aluminum-range
  // entry, so an aluminum part is inside the table's own hardness range.
  { tool_type: 'Counterbore', material_cut_code_name: '30.11', hardness: 60, hardness_system: 'Brinell', diameter_mm: 6.3, cutting_speed_m_min: 90.8, feed_mm_rev: 0.3, depth_max_mm: 38 },
  { tool_type: 'Counterbore', material_cut_code_name: '30.11', hardness: 60, hardness_system: 'Brinell', diameter_mm: 76.2, cutting_speed_m_min: 90.8, feed_mm_rev: 0.6, depth_max_mm: 38 },
];

// A counterbore is the catalog's Step Drilling, timed as the machining workbook's Step Drilling sheet times it (calculator of
// migration 1139; it replaces a tblCounterboring time and 8 s a hole when that had no row). Ø10 x 5 mm on the 10 000 rpm test machine:
//   aluminium  92.5 m/min (75-110), 0.2 mm/rev (the 10-13 mm band): n = 2944.4 rpm; (5 + 10) / (0.2 x 2944.4) = 1.53 s -> 2 s
//   stainless  17.5 m/min (12-23), 0.15 mm/rev:                       n = 557.0 rpm;  (5 + 10) / (0.15 x 557.0) = 10.77 s -> 11 s
describe('Counterbore — Step Drilling on the workbook', () => {
  const step = (matClass: 'aluminum' | 'stainless', workbook = workbookFixture()) =>
    buildOperationSequence([counterboreFeature(1, 10)], { matClass, workbook }).find((o) => o.name === 'Step Drilling')!;

  it('is Step Drilling, timed from the workbook\'s drilling data, with the step drill\'s wear', () => {
    const op = step('aluminum');
    expect(op.timeSec).toBe(2);
    expect(op.calculator?.id).toBe('Machining - Step Drilling');
    expect(op.trace!.find((s) => s.fieldName === 'Tool Cost per Part')).toMatchObject({ value: 0.1133 });
    expect(op.toolCostInr).toBeCloseTo(0.11327, 5);
  });

  it('without the workbook\'s tables it is a named gap, never a flat time', () => {
    const op = step('aluminum', null as never);
    expect(op.timeSec).toBe(0);
    expect(op.missing).toContain('tblDrillReamData');
  });

  it('is material-aware: stainless counterbores slower than aluminium', () => {
    expect(step('stainless').timeSec).toBe(11);
  });
});

const CHAMFER_LINEAR_SPEED = 10.7; // real tblChamfering value, material_cut_code "1.0"

describe('Chamfer — real tblChamfering physics vs the previous flat fallback', () => {
  it('a sized chamfer with no edge speed for the material is a named gap, not a flat time', () => {
    const ops = buildOperationSequence([{ feature_type: 'Edge', variant: 'chamfer', diameter_mm: 10, occurrences: [{}] }], { matClass: 'aluminum' });
    const chamfer = ops.find((o) => o.name === 'Chamfering')!;
    expect(chamfer.timeSec).toBe(0);
    expect(chamfer.missing).toContain('Edge Speed');
  });

  it('a chamfer with no CAD size takes the calculator\'s time per unsized edge (5 s), and needs no edge speed', () => {
    const ops = buildOperationSequence([{ feature_type: 'Edge', variant: 'chamfer', diameter_mm: 0, occurrences: [{}, {}] }], { matClass: 'aluminum' });
    const chamfer = ops.find((o) => o.name === 'Chamfering')!;
    expect(chamfer.timeSec).toBeCloseTo(10, 3);
    expect(chamfer.missing).toBeUndefined();
  });

  it('uses real diameter-derived edge length / real linear speed when provided', () => {
    const ops = buildOperationSequence(
      [{ feature_type: 'Edge', variant: 'chamfer', diameter_mm: 10, occurrences: [{}] }],
      { matClass: 'aluminum', machinabilityFactor: 1.0, chamferLinearSpeedMmPerSec: CHAMFER_LINEAR_SPEED },
    );
    const chamfer = ops.find((o) => o.name === 'Chamfering')!;
    // edgeLength = pi*10 = 31.4mm; time = 31.4 / 10.7 = 2.94s
    expect(chamfer.timeSec).toBeCloseTo(Math.PI * 10 / CHAMFER_LINEAR_SPEED, 2);
    expect(chamfer.timeSec).not.toBeCloseTo(5, 1);
  });

  it('also applies real chamfer physics inside the tapped_hole sequence, not just standalone chamfer features', () => {
    const withoutReal = buildOperationSequence([tappedHoleFeature(1, 6, 'M6')], { matClass: 'aluminum' });
    const withReal = buildOperationSequence(
      [tappedHoleFeature(1, 6, 'M6')], { matClass: 'aluminum', machinabilityFactor: 1.0, chamferLinearSpeedMmPerSec: CHAMFER_LINEAR_SPEED },
    );
    const flatChamfer = withoutReal.find((o) => o.name === 'Chamfering')!.timeSec;
    const realChamfer = withReal.find((o) => o.name === 'Chamfering')!.timeSec;
    expect(realChamfer).not.toBeCloseTo(flatChamfer, 3);
  });
});

const ROUNDING_LINEAR_SPEED = 5.4; // real tblCornerRoundingMill value, material_cut_code "1.0"

describe('Corner Rounding (Filleting/Groove Milling) — real tblCornerRoundingMill physics vs the previous flat fallback (Phase 1, 2026-09-19)', () => {
  it('a sized fillet with no edge speed for the material is a named gap, not a flat time', () => {
    const ops = buildOperationSequence([toroidFeature('fillet', 1, 30)], { matClass: 'aluminum' });
    const fillet = ops.find((o) => o.name === 'Filleting')!;
    expect(fillet.timeSec).toBe(0);
    expect(fillet.missing).toContain('Edge Speed');
  });

  it('uses real diameter-derived edge length / real linear speed when provided', () => {
    const ops = buildOperationSequence(
      [toroidFeature('fillet', 1, 30)],
      { matClass: 'aluminum', machinabilityFactor: 1.0, roundingLinearSpeedMmPerSec: ROUNDING_LINEAR_SPEED },
    );
    const fillet = ops.find((o) => o.name === 'Filleting')!;
    // edgeLength = pi*30 = 94.2mm; time = 94.2 / 5.4 = 17.45s
    expect(fillet.timeSec).toBeCloseTo(Math.PI * 30 / ROUNDING_LINEAR_SPEED, 2);
    expect(fillet.timeSec).not.toBeCloseTo(8, 1);
  });

  it('applies the same real physics to Groove Milling — fillet and groove share one real rate table', () => {
    const ops = buildOperationSequence(
      [toroidFeature('groove', 1, 18)],
      { matClass: 'aluminum', machinabilityFactor: 1.0, roundingLinearSpeedMmPerSec: ROUNDING_LINEAR_SPEED },
    );
    const groove = ops.find((o) => o.name === 'Groove Milling')!;
    expect(groove.timeSec).toBeCloseTo(Math.PI * 18 / ROUNDING_LINEAR_SPEED, 2);
    expect(groove.timeSec).not.toBeCloseTo(8, 1);
  });
});

// ── Reference-vocabulary dispatch: hole shapes that previously had no case ───
// Before the reference-vocabulary migration, "cross_hole" and
// "pcd_hole_pattern" had no switch case: a cross hole fell to Bulk Milling of
// its volume and a PCD pattern (material_removed_mm3 = 0) produced no op at
// all, so every hole in a bolt circle was costed at zero.
describe('buildOperationSequence — SimpleHole cross / pcd_pattern', () => {
  it('drills a cross hole like any other plain hole', () => {
    const ops = buildOperationSequence([
      { feature_type: 'SimpleHole', variant: 'cross', diameter_mm: 6,
        occurrences: [{ depth_mm: 20, material_removed_mm3: 565 }] },
    ], { matClass: 'aluminum' });
    const drill = ops.find((o) => o.name === 'Drilling')!;
    expect(drill).toBeDefined();
    expect(drill.cadFeatureType).toBe('SimpleHole');
    expect(ops.some((o) => o.name === 'Bulk Milling')).toBe(false);
  });

  it('drills every real hole a PCD pattern stands for (hole_count), not one', () => {
    const pattern = (holeCount: number) => [{
      feature_type: 'SimpleHole', variant: 'pcd_pattern', diameter_mm: 6,
      occurrences: [{ depth_mm: 12, hole_count: holeCount, material_removed_mm3: 0 }],
    }];
    const six = buildOperationSequence(pattern(6), { matClass: 'aluminum' });
    const three = buildOperationSequence(pattern(3), { matClass: 'aluminum' });
    const spot6 = six.find((o) => o.name === 'Center Drilling')!;
    const spot3 = three.find((o) => o.name === 'Center Drilling')!;
    expect(spot6.timeSec).toBe(6 * 5);
    expect(spot3.timeSec).toBe(3 * 5);
    expect(six.find((o) => o.name === 'Drilling')!.timeSec)
      .toBeCloseTo(2 * three.find((o) => o.name === 'Drilling')!.timeSec, 6);
  });
});

describe('OperationLine.count', () => {
  it('carries the real instance count of the feature each line came from', () => {
    const ops = buildOperationSequence([tappedHoleFeature(3)], { matClass: 'mild_steel' });
    const tapLines = ops.filter((o) => o.cadFeatureType === 'SimpleHole');
    expect(tapLines.length).toBeGreaterThan(0);
    for (const o of tapLines) expect(o.count).toBe(3);
  });

  it('counts every hole a PCD pattern stands for', () => {
    const pcd = {
      feature_type: 'SimpleHole', variant: 'pcd_pattern', diameter_mm: 6,
      occurrences: [{ hole_count: 6, depth_mm: 12 }, { hole_count: 4, depth_mm: 12 }],
    };
    const ops = buildOperationSequence([pcd], { matClass: 'mild_steel' });
    const centerDrill = ops.find((o) => o.name === 'Center Drilling');
    expect(centerDrill?.count).toBe(10);
  });
});

describe('OperationLine.featureIds', () => {
  it('names the exact feature_graph_v2 entry each op machines', () => {
    const a = { ...tappedHoleFeature(2), id: 'SimpleHole_threaded_0' };
    const b = { feature_type: 'PocketV2', variant: 'default', id: 'PocketV2_default_0', occurrences: [{ material_removed_mm3: 500 }] };
    const ops = buildOperationSequence([a, b], { matClass: 'mild_steel' });
    const holeOps = ops.filter((o) => o.cadFeatureType === 'SimpleHole');
    const pocketOps = ops.filter((o) => o.cadFeatureType === 'PocketV2');
    expect(holeOps.length).toBeGreaterThan(0);
    expect(pocketOps.length).toBeGreaterThan(0);
    for (const o of holeOps) expect(o.featureIds).toEqual(['SimpleHole_threaded_0']);
    for (const o of pocketOps) expect(o.featureIds).toEqual(['PocketV2_default_0']);
  });

  it('leaves fixed ops (not tied to one feature) without feature ids', () => {
    const ops = buildOperationSequence([{ ...tappedHoleFeature(1), id: 'x' }], { matClass: 'mild_steel' });
    expect(ops.find((o) => o.source === 'fixed')?.featureIds).toBeUndefined();
  });
});

describe('every milling operation is timed by its stored calculator', () => {
  const pocket = [{ feature_type: 'PocketV2', variant: 'default', diameter_mm: 0, occurrences: [{ material_removed_mm3: 6000 }, { material_removed_mm3: 6000 }] }];

  it('rough milling: the removed volume at the removal rate, 80 % roughed and 20 % at 0.4 of the rate', () => {
    const rough = buildOperationSequence(pocket, { matClass: 'mild_steel' }).find((o) => o.name === 'Rough Milling')!;
    expect(rough.timeSec).toBeCloseTo((12000 * 0.8 / 12000 + 12000 * 0.2 / (12000 * 0.4)) * 60, 6);
    expect(rough.trace!.map((st) => st.fieldName)).toEqual(expect.arrayContaining(['Removed Volume', 'Material Removal Rate', 'Roughing Share', 'Cycle Time']));
  });

  it('a pocket with no CAD size has no finishing time: the gap is named, never a flat time per pocket', () => {
    const finish = buildOperationSequence(pocket, { matClass: 'mild_steel' }).filter((o) => o.name === 'Fine Finish Milling');
    expect(finish).toHaveLength(1);
    expect(finish[0]!.timeSec).toBe(0);
    expect(finish[0]!.missing).toContain('length and width');
  });

  it('facing and centre drilling read their times from the calculator, not from this file', () => {
    const hole = [{ feature_type: 'SimpleHole', variant: 'through', diameter_mm: 6, occurrences: [{ depth_mm: 10 }, { depth_mm: 10 }] }];
    const ops = buildOperationSequence(hole, { matClass: 'mild_steel', machinabilityFactor: 1.0, materialGrade: 'AISI 1018', workbook: workbookFixture() });
    expect(ops.find((o) => o.name === 'Facing')!.timeSec).toBe(45);
    expect(ops.find((o) => o.name === 'Center Drilling')!.timeSec).toBe(10);
  });

  it('with no calculators an operation is a named gap, never a number', () => {
    const ops = buildWith(pocket, { matClass: 'mild_steel', machinabilityFactor: 1.0, calculators: {}, removalRateMm3PerMin: 12000 });
    const rough = ops.find((o) => o.name === 'Rough Milling')!;
    expect(rough.timeSec).toBe(0);
    expect(rough.missing).toContain('none mapped');
  });
});

describe('the removal rate is data (tblMillingRemovalRate), not a table in the code', () => {
  const pocket = [{ feature_type: 'PocketV2', variant: 'default', diameter_mm: 0, occurrences: [{ material_removed_mm3: 12000 }] }];

  it('a volume operation with no rate on file is a named gap', () => {
    const rough = buildWith(pocket, { matClass: 'mild_steel', machinabilityFactor: 1.0, calculators: specAsCalculators(), removalRateMm3PerMin: null }).find((o) => o.name === 'Rough Milling')!;
    expect(rough.timeSec).toBe(0);
    expect(rough.missing).toContain('Material Removal Rate');
  });

  it('the rate it is given is the one it uses, and the trace names the table', () => {
    const rough = buildWith(pocket, { matClass: 'mild_steel', machinabilityFactor: 1.0, calculators: specAsCalculators(), removalRateMm3PerMin: 24000 }).find((o) => o.name === 'Rough Milling')!;
    expect(rough.timeSec).toBeCloseTo((12000 * 0.8 / 24000 + 12000 * 0.2 / (24000 * 0.4)) * 60, 6);
    expect(rough.trace!.find((st) => st.fieldName === 'Material Removal Rate')!.source).toContain('tblMillingRemovalRate');
  });

  it('countersinking reads its time per hole from its calculator (6 s)', () => {
    const csk = [{ feature_type: 'Edge', variant: 'countersink', diameter_mm: 8, occurrences: [{ depth_mm: 4 }, { depth_mm: 4 }] }];
    const op = buildOperationSequence(csk, { matClass: 'mild_steel', machinabilityFactor: 1.0, materialGrade: 'AISI 1018', workbook: workbookFixture() }).find((o) => o.name === 'Countersinking')!;
    expect(op.timeSec).toBe(12);
  });
});

describe('finishing is a tool path at the cutter feed (tblMillingFinishing), not a share of the removal rate', () => {
  // Mild steel: 76 m/min on a 10 mm cutter = 2419 rpm; x 4 teeth x (0.008 x 10 mm) = 774.1 mm/min.
  const feed = (76 * 1000 / (Math.PI * 10)) * 4 * 0.008 * 10;
  const pocketOf = (lengthMm: number, widthMm: number, depthMm: number) => ({ extents_mm: [lengthMm, widthMm, 0], material_removed_mm3: lengthMm * widthMm * depthMm });
  const pockets = (...occurrences: object[]) => [{ feature_type: 'PocketV2', variant: 'default', occurrences }];
  const finishOf = (features: object[]) => buildOperationSequence(features, { matClass: 'mild_steel' }).filter((o) => o.name === 'Fine Finish Milling');

  it('a pocket wider than the cutter: floor at half-diameter stepover, walls one diameter per step-down, a lead-in and lead-out', () => {
    const [finish] = finishOf(pockets(pocketOf(60, 40, 12)));
    const path = (60 * 40) / (10 * 0.5) + (2 * (60 + 40) * 12) / (10 * 1) + 1 * 2 * 10;
    expect(finish!.timeSec).toBeCloseTo(path / feed * 60, 6);
    expect(finish!.trace!.map((st) => st.fieldName)).toEqual(expect.arrayContaining(['Floor Area', 'Wall Area', 'Tool Diameter', 'Spindle Speed', 'Feed Rate', 'Path Length']));
  });

  it('a pocket narrower than the cutter is finished by a cutter of its width, walls included, on its own line', () => {
    const finish = finishOf(pockets(pocketOf(60, 40, 12), pocketOf(30, 4, 5), pocketOf(20, 4, 5)));
    expect(finish.map((o) => o.count)).toEqual([1, 2]);
    // Ø4: 76 m/min is 6048 rpm, feed 4 x 0.008 x 4 mm per rev; floor only (the cutter fills the width).
    const narrowFeed = (76 * 1000 / (Math.PI * 4)) * 4 * 0.008 * 4;
    expect(finish[1]!.timeSec).toBeCloseTo(((30 * 4 + 20 * 4) / (4 * 0.5) + 2 * 2 * 4) / narrowFeed * 60, 6);
  });

  it('an open step narrower than the cutter is finished with the standard cutter: its floor, and its one wall at the measured depth', () => {
    // 45 x 6 step, 4 deep, walled along one long side (45 of its 102 boundary): nothing confines the cutter to 6 mm.
    const step = { extents_mm: [45, 6, 0], material_removed_mm3: 1, depth_mm: 4, walled_fraction: 45 / 102, width_confined: false };
    const finish = finishOf(pockets(step));
    expect(finish).toHaveLength(1);
    const path = (45 * 6) / (10 * 0.5) + (45 * 4) / (10 * 1) + 1 * 2 * 10;
    expect(finish[0]!.timeSec).toBeCloseTo(path / feed * 60, 6);
  });

  it('a small cutter is held to the spindle speed limit, so it feeds slower', () => {
    const [finish] = finishOf(pockets(pocketOf(20, 1, 1)));
    // Ø1 would need 24192 rpm; the calculator's limit is 10000.
    expect(finish!.timeSec).toBeCloseTo(((20 * 1) / (1 * 0.5) + 2 * 1) / (10000 * 4 * 0.008 * 1) * 60, 6);
  });

  it('a free-form surface is stepped over at the scallop height, a wall by the cutter side: the surface takes longer per area', () => {
    const region = (type: string) => [{ feature_type: type, variant: 'default', occurrences: [{ area_mm2: 500 }] }];
    const timeOf = (type: string) => buildOperationSequence(region(type), { matClass: 'mild_steel' }).find((o) => o.name === 'Contouring')!.timeSec;
    expect(timeOf('CurvedSurface')).toBeCloseTo((500 / Math.sqrt(4 * 10 * 0.01) + 2 * 10) / feed * 60, 6);
    expect(timeOf('CurvedWall')).toBeCloseTo((500 / 10 + 2 * 10) / feed * 60, 6);
  });

  it('with no finishing row the pass is a named gap', () => {
    const ops = buildWith(pockets(pocketOf(60, 40, 12)), { matClass: 'mild_steel', machinabilityFactor: 1.0, calculators: specAsCalculators(), removalRateMm3PerMin: 12000, finishing: null });
    const finish = ops.find((o) => o.name === 'Fine Finish Milling')!;
    expect(finish.timeSec).toBe(0);
    expect(finish.missing).toContain('Cutting Speed');
  });
});

describe('a flat milled on a turned diameter: Rough Milling // Flat', () => {
  // Two wrench flats 6 from the axis on a Ø16, 20 long, as the CAD engine's analysis of that shaft stores them: each cuts the circular
  // segment 64 acos(0.75) - 6 sqrt(28) = 14.506 mm^2 off the round over its 20 mm, 290.12 mm^3.
  const flat = (faces: number[]) => ({
    face_ids: faces, material_removed_mm3: 290.12, depth_mm: 2, length_mm: 20, width_mm: 10.583, diameter_mm: 16, area_mm2: 211.66, walled_fraction: 0.346,
  });
  const FLATS = { id: 'Flat-default_c2', feature_type: 'Flat', variant: 'default', occurrences: [flat([4, 5, 6]), flat([8, 9, 10])] };
  const flatOps = (features: unknown[]) => buildOperationSequence(features, { matClass: 'aluminum' }).filter((o) => o.cadFeatureType === 'Flat');

  it('is one Rough Milling operation for the group, counted per flat, on the flats\' feature id', () => {
    const [op, ...rest] = flatOps([FLATS]);
    expect(rest).toEqual([]);
    expect(op).toMatchObject({ name: 'Rough Milling', source: 'feature', count: 2, featureIds: ['Flat-default_c2'] });
    expect(op.missing).toBeUndefined();
  });

  it('is timed by the stored Rough Milling calculator on the volume the flats cut off, at the material\'s removal rate', () => {
    // 580.24 * 0.8 / 60000 + 580.24 * 0.2 / 24000 = 0.0125719 min = 0.75431 s.
    const [op] = flatOps([FLATS]);
    expect(op.timeSec).toBeCloseTo((580.24 * 0.8 / 60000 + 580.24 * 0.2 / (60000 * 0.4)) * 60, 6);
    expect(op.calculator?.id).toBe('Machining - Rough Milling');
    expect(op.trace!.find((s) => s.fieldName === 'Removed Volume')).toMatchObject({ value: 580.24 });
    expect(op.trace!.find((s) => s.fieldName === 'Material Removal Rate')!.source).toContain('tblMillingRemovalRate');
  });

  it('a flat with no removed volume on file is a named gap, never free', () => {
    const [op] = flatOps([{ ...FLATS, occurrences: [{ ...flat([4]), material_removed_mm3: 0 }] }]);
    expect(op).toMatchObject({ name: 'Rough Milling', timeSec: 0, missing: 'the CAD volume the flat removes', count: 1 });
    const [two] = flatOps([{ ...FLATS, occurrences: [{ ...flat([4]), material_removed_mm3: 0 }, { ...flat([8]), material_removed_mm3: 0 }] }]);
    expect(two.missing).toBe('the CAD volume 2 flats remove');
  });

  it('with no removal rate on file it is the calculator\'s named gap', () => {
    const ops = buildWith([FLATS], { matClass: 'aluminum', machinabilityFactor: 1.0, calculators: specAsCalculators(), removalRateMm3PerMin: null }).filter((o) => o.cadFeatureType === 'Flat');
    expect(ops).toEqual([expect.objectContaining({ name: 'Rough Milling', timeSec: 0, missing: expect.stringContaining('Material Removal Rate') })]);
  });
});
