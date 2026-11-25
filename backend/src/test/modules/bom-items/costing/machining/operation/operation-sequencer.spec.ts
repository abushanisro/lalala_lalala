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
    // The machining workbook's cutting data (migration 1137): the workbook-form operations read their speeds and feeds from it.
    workbook: workbookFixture(),
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
  // A 10 mm deep pocket whose floor (25 mm long) holds the volume: its CAD floor box, as the analysis states it (extents_mm).
  return {
    feature_type: 'PocketV2', variant: 'default',
    diameter_mm: 0,
    occurrences: Array.from({ length: count }, () => ({
      depth_mm: 10,
      extents_mm: [25, removedMm3Each / 10 / 25, 0],
      material_removed_mm3: removedMm3Each,
    })),
  };
}

// The stock model's facing of a 100 x 60 mm block with 2.5 mm on its top and its bottom (stock/stock-facing.ts).
const FACING = { faces: 2, lengthMm: 100, widthMm: 60, depthMm: 2.5, volumeMm3: 100 * 60 * 5, basis: 'a 100 x 60 x 25 mm test block' };

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

// Real cad-engine shape: build_machining_feature_graph_v2 buckets toroidal features by major_diameter_mm (entry.diameter_mm),
// material_removed_mm3 honestly 0.0 (never extracted for toroidal blends). Since geo_v89 (toroid_features.py) each occurrence states its
// sweep, profile, the arc its tube's centre follows (path_length_mm = major radius x sweep) and whether it is concave: a convex blend is a
// "round" (Edge:round, concave false), an inside fillet a concave Edge:round, a round-bottomed recess a groove (Slot:groove, with its
// depth and chord width). `legacy` is an analysis from before geo_v89: none of those, only the radius.
function toroidFeature(kind: 'round' | 'fillet' | 'groove', count = 1, majorDiamMm = 30, opts: { sweepDeg?: number; legacy?: boolean; radiusMm?: number } = {}): object {
  const [featureType, variant] = kind === 'groove' ? ['Slot', 'groove'] : ['Edge', 'round'];
  const sweepDeg = opts.sweepDeg ?? 90;
  const radiusMm = opts.radiusMm ?? 4;
  const profileDeg = kind === 'groove' ? 180 : 90;
  return {
    feature_type: featureType,
    variant,
    diameter_mm: majorDiamMm,
    occurrences: Array.from({ length: count }, () => ({
      radius_mm: radiusMm,
      material_removed_mm3: 0,
      ...(opts.legacy ? {} : {
        sweep_deg: sweepDeg, profile_deg: profileDeg, path_length_mm: Math.round((majorDiamMm / 2) * (sweepDeg * Math.PI / 180) * 1000) / 1000,
        concave: kind !== 'round',
        ...(kind === 'groove' ? { depth_mm: radiusMm, width_mm: 2 * radiusMm } : {}),
      }),
    })),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('buildOperationSequence', () => {
  it('returns empty array for null/empty feature list', () => {
    expect(buildOperationSequence(null, { matClass: 'aluminum' })).toEqual([]);
    expect(buildOperationSequence([], { matClass: 'aluminum' })).toEqual([]);
  });

  it('starts with Facing when the stock has stock on its faces, and ends with Deburr', () => {
    const features = [tappedHoleFeature(2)];
    const ops = buildOperationSequence(features, { matClass: 'aluminum', facing: FACING });
    expect(ops[0].name).toBe('Facing');
    expect(ops[ops.length - 1].name).toBe('Deburr');
  });

  it('faces nothing when the stock model states no faces to face (no stock chosen, a lathe\'s plan): no fixed 45 s', () => {
    const ops = buildOperationSequence([tappedHoleFeature(2)], { matClass: 'aluminum' });
    expect(ops.some((o) => o.name === 'Facing')).toBe(false);
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

  it('generates real, distinct Filleting / Concave Fillet Milling / Groove Milling ops for rounds, inside fillets and grooves', () => {
    const roundOps = buildOperationSequence([toroidFeature('round', 2, 30)], { matClass: 'aluminum', machinabilityFactor: 1.0 });
    const filletOps = buildOperationSequence([toroidFeature('fillet', 2, 30)], { matClass: 'aluminum', machinabilityFactor: 1.0 });
    const grooveOps = buildOperationSequence([toroidFeature('groove', 1, 18)], { matClass: 'aluminum', machinabilityFactor: 1.0 });

    // A convex round is rounded with the end mill (Filleting); an inside fillet is finished by a ball nose of its radius (Concave Fillet
    // Milling); a groove is milled by a ball nose (Groove Milling). Each its own operation, never one invented "Corner Round".
    const filletRound = roundOps.find((o) => o.name === 'Filleting')!;
    expect(filletRound).toBeDefined();
    expect(filletRound.cadFeatureType).toBe('Edge');
    expect(filletRound.diameterMm).toBe(30);
    expect(filletRound.timeSec).toBeGreaterThan(0);
    expect(roundOps.some((o) => o.name === 'Concave Fillet Milling')).toBe(false);

    const inside = filletOps.find((o) => o.name === 'Concave Fillet Milling')!;
    expect(inside.cadFeatureType).toBe('Edge');
    expect(inside.count).toBe(2);
    expect(inside.timeSec).toBeGreaterThan(0);
    expect(filletOps.some((o) => o.name === 'Filleting')).toBe(false);

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
    // One spot per hole assembly, at its entry step (Ø16), on the workbook's Drilling sheet (1152): mild steel 13.8 m/min (9-25 at the
    // Range Position 0.3), 0.33 mm/rev at Ø16 = 274.5 rpm; (16 / 2 + 10) / (0.33 x 274.5) min = 11.92 s -> 12 s.
    expect(spotDrill.diameterMm).toBe(16);
    expect(spotDrill.timeSec).toBe(12);
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
    const ops = buildOperationSequence([tappedHoleFeature(1)], { matClass: 'aluminum', facing: FACING });
    expect(ops.find((o) => o.name === 'Facing')!.cadFeatureType).toBeUndefined();
    expect(ops.find((o) => o.name === 'Deburr')!.cadFeatureType).toBeUndefined();
  });

  it('a pocket roughs faster in aluminium than in mild steel: the workbook\'s milling conditions for each material', () => {
    // A 40 x 25 x 10 pocket: 3 width passes (ceil((25 - 5) / 8)), 5 depth passes (ceil(10 / 2)). Mild steel at the Range Position 0.3:
    // 78 m/min, 0.101 mm/tooth, 4 teeth on the 10 mm cutter: n = 2482.82 rpm; (40 + 10 + 5) / (0.101 x 4 x 2482.82) x 15 = 0.82248 min
    // -> 50 s. Aluminium: 390 m/min holds the test machine's 10 000 rpm, 0.13 mm/tooth, 3 teeth: 55 / 3900 x 15 = 0.21154 min -> 13 s.
    // The machinability
    // factor no longer scales it: the workbook's speeds are the material's own.
    const features = [pocketFeature(1, 10_000)];
    const mild = buildOperationSequence(features, { matClass: 'mild_steel' }).find((o) => o.name === 'Rough Milling')!;
    const alu = buildOperationSequence(features, { matClass: 'aluminum' }).find((o) => o.name === 'Rough Milling')!;
    expect(mild.timeSec).toBe(50);
    expect(alu.timeSec).toBe(13);
  });

  it('ops are sorted in canonical manufacturing order', () => {
    const features = [pocketFeature(1), tappedHoleFeature(2), throughHoleFeature(1)];
    const ops = buildOperationSequence(features, { matClass: 'aluminum', facing: FACING });
    const names = ops.map((o) => o.name);

    // Facing must precede pockets; Drilling before Tapping; Deburr at end
    const faceIdx = names.indexOf('Facing');
    const roughIdx = names.indexOf('Rough Milling');
    const drillIdx = names.lastIndexOf('Drilling');
    const tapIdx = names.indexOf('Tapping');
    const deburrIdx = names.indexOf('Deburr');

    expect(faceIdx).toBe(0);
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

  it('adds a Tapping op for a callout without a depth, tapped to the material\'s thread engagement (1 x D in steel), never unpriced', () => {
    const opsWithoutTap = baseOps.filter((o) => o.name !== 'Tapping');
    const planned = injectDrawingIntelligence(opsWithoutTap, { threads: [{ spec: 'M6', count: 2 }] }, 'AISI 1018', workbookFixture(), specAsCalculators());
    const [tap] = timeOperations(planned.filter((o) => o.name === 'Tapping'), specAsCalculators(), TEST_MACHINE);
    expect(tap!.missing).toBeUndefined();
    expect(tap!.timeSec).toBeGreaterThan(0);
    expect(tap!.trace!.find((s) => s.fieldName === 'Thread Depth')).toMatchObject({ value: 6 });
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
//   aluminium  85.5 m/min (75-110 at the Range Position 0.3), 0.2 mm/rev (the 10-13 mm band): n = 2721.5 rpm; (5 + 10) / (0.2 x 2721.5)
//              = 1.65 s -> 2 s
//   stainless  15.3 m/min (12-23), 0.15 mm/rev: n = 487.0 rpm; (5 + 10) / (0.15 x 487.0) = 12.32 s -> 13 s
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
    expect(step('stainless').timeSec).toBe(13);
  });
});


// The edges, spots and countersinks on the workbook (migration 1152), worked out by hand on aluminium: the workbook's milling row
// ALUMINUM ALLOY CAST AND WROUGHT is 300-600 m/min and 0.1-0.2 mm/tooth (390 and 0.13 at the Range Position 0.3); its drilling rows
// 75-110 m/min (85.5) with a feed per diameter band. The material's end mill here is 10 mm, 3 teeth, on a 10 000 rpm test mill.
const ALU_END_MILL = { toolDiameterMm: 10, teeth: 3, cuttingSpeedMPerMin: 183, feedPerToothPerDiameter: 0.008 };
const TEST_MILL = { 'Max Spindle Speed': { value: 10000, source: 'Machine: test spindle_speed_rpm' } };
const onMill = (features: object[]) => timeOperations(buildOperationSequence(features, {
  matClass: 'aluminum', machinabilityFactor: 1.0, calculators: specAsCalculators(), workbook: workbookFixture(), finishing: ALU_END_MILL,
}), specAsCalculators(), TEST_MILL);
// One pass of the end mill along an edge: 390 000 / (pi x 10) = 12 414 rpm, held to the mill's 10 000; feed 0.13 x 3 x 10 000 = 3900 mm/min.
const edgeSec = (lengthMm: number) => Math.ceil(((lengthMm + 10 + 5) / 3900) * 60);

describe('chamfers, fillets and grooves: one pass of the end mill along each edge (the workbook\'s End Milling sheet, 1152)', () => {
  it('a round chamfer of Ø10: pi x 10 = 31.4 mm + 10 + 5 at 3900 mm/min = 0.71 s, 1 s an edge', () => {
    const chamfer = onMill([{ feature_type: 'Edge', variant: 'chamfer', diameter_mm: 10, occurrences: [{}, {}] }]).find((o) => o.name === 'Chamfering')!;
    expect(chamfer.missing).toBeUndefined();
    expect(chamfer.timeSec).toBe(2 * edgeSec(Math.PI * 10));
    expect(chamfer.trace!.find((t) => t.fieldName === 'Spindle Speed')!.value).toBe(10000);
    expect(chamfer.trace!.find((t) => t.fieldName === 'Cutting Speed')!.value).toBe(390);
    expect(chamfer.trace!.find((t) => t.fieldName === 'Feed per Tooth')!.value).toBe(0.13);
  });

  it('a straight edge is as long as its face\'s longest extent: edges of one length are one run, another length another', () => {
    const fillet = onMill([{ feature_type: 'Edge', variant: 'round', diameter_mm: 0, occurrences: [
      { radius_mm: 4, extents_mm: [27, 1.633, 0.075] }, { radius_mm: 4, extents_mm: [27, 1.633, 0.075] }, { radius_mm: 2, extents_mm: [30, 2.828, 0.573] },
    ] }]).find((o) => o.name === 'Filleting')!;
    expect(fillet.missing).toBeUndefined();
    expect(fillet.timeSec).toBe(2 * edgeSec(27) + edgeSec(30));
    expect(fillet.plan!.map((p) => [p.label, p.seeds['Edge Length']!.value, p.seeds['Edges']!.value])).toEqual([['Edge 27 mm', 27, 2], ['Edge 30 mm', 30, 1]]);
  });

  it('a chamfer with no CAD size and no extent is named, never a set time', () => {
    const chamfer = onMill([{ feature_type: 'Edge', variant: 'chamfer', diameter_mm: 0, occurrences: [{}, {}] }]).find((o) => o.name === 'Chamfering')!;
    expect(chamfer.timeSec).toBe(0);
    expect(chamfer.missing).toContain('the CAD length of 2 edges');
  });

  it('a convex round is rounded along its measured arc (path_length_mm), not pi x its major diameter', () => {
    // Ø30, a quarter turn: 15 x pi / 2 = 23.562 mm (pi x 30 = 94.2 mm was the old length).
    const round = onMill([toroidFeature('round', 2, 30)]).find((o) => o.name === 'Filleting')!;
    expect(round.missing).toBeUndefined();
    expect(round.timeSec).toBe(2 * edgeSec(23.562));
    expect(round.trace!.find((t) => t.fieldName === 'Edge Length')!.source).toMatch(/path_length_mm/);
  });

  it('a round analysed before the arc was measured is cut along the whole circle, and the step says to re-analyse', () => {
    const round = onMill([toroidFeature('round', 1, 30, { legacy: true })]).find((o) => o.name === 'Filleting')!;
    expect(round.timeSec).toBe(edgeSec(Math.PI * 30));
    const length = round.trace!.find((t) => t.fieldName === 'Edge Length')!;
    expect(length.value).toBeCloseTo(Math.PI * 30, 2);
    expect(length.source).toMatch(/whole circle.*re-analyse/);
  });

  it('without the material\'s end mill the edge is a named gap', () => {
    const ops = buildOperationSequence([{ feature_type: 'Edge', variant: 'chamfer', diameter_mm: 10, occurrences: [{}] }], {
      matClass: 'aluminum', calculators: specAsCalculators(), workbook: workbookFixture(), finishing: null,
    });
    expect(ops.find((o) => o.name === 'Chamfering')!.missing).toMatch(/end mill/);
  });

  it('the chamfer of a tapped hole is timed the same way', () => {
    const chamfer = onMill([tappedHoleFeature(1, 6, 'M6')]).find((o) => o.name === 'Chamfering')!;
    expect(chamfer.timeSec).toBe(edgeSec(Math.PI * 6));
  });
});

// Inside fillets and grooves on Haas's ball nose data (tblBallNoseCutData, migrations 1154-1155): a ball of the feature's radius along its
// path. Aluminium, R4 = a Ø8 ball: Haas HSAM1 2 flute, Ø8 row 216 m/min, 0.093 mm/tooth; n = 216 000 / (pi x 8) = 8594.4 rpm (under the
// test mill's 10 000); vf = 0.093 x 2 x 8594.4 = 1598.6 mm/min.
const ballSec = (pathMm: number, ballMm = 8, row = { vc: 216, fz: 0.093, teeth: 2, d: 8 }) => {
  const n = Math.min(10000, (row.vc * 1000) / (Math.PI * ballMm));
  const fz = row.fz * Math.min(1, ballMm / row.d);
  return Math.ceil(((pathMm + 10 + ballMm / 2) / (fz * row.teeth * n)) * 60);
};

describe('inside fillets and grooves: a ball nose end mill of their radius along their arc (Haas data, 1154-1155)', () => {
  it('an inside fillet of R4 on a Ø30 quarter arc: 23.562 mm at 1598.6 mm/min -> 2 s a fillet, the Ø8 row of the table', () => {
    const fillet = onMill([toroidFeature('fillet', 3, 30)]).find((o) => o.name === 'Concave Fillet Milling')!;
    expect(fillet.missing).toBeUndefined();
    expect(fillet.calculator?.id).toBe('Machining - Concave Fillet Milling');
    expect(fillet.timeSec).toBe(3 * ballSec(23.562));
    expect(ballSec(23.562)).toBe(2);
    const step = (name: string) => fillet.trace!.find((t) => t.fieldName === name)!;
    expect(step('Cutter Diameter').value).toBe(8);
    expect(step('Cutting Speed').value).toBe(216);
    expect(step('Teeth').value).toBe(2);
    expect(step('Feed per Tooth').value).toBe(0.093);
    expect(step('Path Length').source).toMatch(/path_length_mm/);
    expect(fillet.toolCostInr).toBeCloseTo(1.3375, 9);
  });

  it('the arc, not the circle: the CANNULA HOLDER\'s fillets were 7.5 x too long at pi x D', () => {
    const arc = onMill([toroidFeature('fillet', 1, 30, { sweepDeg: 48 })]).find((o) => o.name === 'Concave Fillet Milling')!;
    expect(arc.plan![0]!.seeds['Path Length']!.value).toBeCloseTo(12.566, 3);
    expect(arc.timeSec).toBeLessThan(ballSec(Math.PI * 30));
  });

  it('a groove is milled by the ball nose along its path; one analysed before geo_v89 along the whole circle, said so', () => {
    const groove = onMill([toroidFeature('groove', 1, 18, { sweepDeg: 180 })]).find((o) => o.name === 'Groove Milling')!;
    expect(groove.calculator?.id).toBe('Machining - Groove Milling');
    expect(groove.timeSec).toBe(ballSec(9 * Math.PI));
    const legacy = onMill([toroidFeature('groove', 1, 18, { legacy: true })]).find((o) => o.name === 'Groove Milling')!;
    expect(legacy.timeSec).toBe(ballSec(Math.round(Math.PI * 18 * 1000) / 1000));
    expect(legacy.trace!.find((t) => t.fieldName === 'Path Length')!.source).toMatch(/re-analyse/);
  });

  it('mild steel Ø4 ball (R2) along 12.12 mm: Haas 1/8 in row, 0.0254 mm/tooth x 4 teeth at the 10 000 rpm cap -> 2 s', () => {
    const ops = timeOperations(buildOperationSequence([{ feature_type: 'Edge', variant: 'round', diameter_mm: 20, occurrences: [
      { radius_mm: 2, sweep_deg: 69.4, profile_deg: 90, path_length_mm: 12.12, concave: true },
    ] }], { matClass: 'mild_steel', calculators: specAsCalculators(), workbook: workbookFixture(), finishing: null }), specAsCalculators(), TEST_MILL);
    const fillet = ops.find((o) => o.name === 'Concave Fillet Milling')!;
    expect(fillet.missing).toBeUndefined();
    expect(fillet.trace!.find((t) => t.fieldName === 'Table Cutter Diameter')!.value).toBe(3.175);
    expect(fillet.timeSec).toBe(ballSec(12.12, 4, { vc: 161.544, fz: 0.0254, teeth: 4, d: 3.175 }));
    expect(fillet.timeSec).toBe(2);
  });

  it('a ball smaller than Haas\'s smallest is fed at the smallest row\'s chip load per diameter (steel 0.008 x D)', () => {
    const ops = timeOperations(buildOperationSequence([toroidFeature('fillet', 1, 20, { radiusMm: 1 })], {
      matClass: 'mild_steel', calculators: specAsCalculators(), workbook: workbookFixture(), finishing: null,
    }), specAsCalculators(), TEST_MILL);
    const fillet = ops.find((o) => o.name === 'Concave Fillet Milling')!;
    expect(fillet.trace!.find((t) => t.fieldName === 'Feed per Tooth')!.value).toBeCloseTo(0.016, 4);
  });

  it('a fillet with no radius, a ball larger than Haas publishes, or a material with no ball nose row is a named gap', () => {
    const noRadius = onMill([{ feature_type: 'Edge', variant: 'round', diameter_mm: 30, occurrences: [{ concave: true, path_length_mm: 10, profile_deg: 90 }] }])
      .find((o) => o.name === 'Concave Fillet Milling')!;
    expect(noRadius.timeSec).toBe(0);
    expect(noRadius.missing).toMatch(/the CAD radius of 1 fillet/);
    const huge = onMill([toroidFeature('fillet', 1, 200, { radiusMm: 20 })]).find((o) => o.name === 'Concave Fillet Milling')!;
    expect(huge.timeSec).toBe(0);
    expect(huge.missing).toMatch(/tblBallNoseCutData .* has no DiameterMinMm-DiameterMaxMm band for Cutter Diameter 40/);
    const noTable = timeOperations(buildOperationSequence([toroidFeature('groove', 1, 18)], {
      matClass: 'aluminum', calculators: specAsCalculators(), workbook: workbookFixture({ tables: { ...workbookFixture().tables, tblBallNoseCutData: [] } }), finishing: null,
    }), specAsCalculators(), TEST_MILL).find((o) => o.name === 'Groove Milling')!;
    expect(noTable.timeSec).toBe(0);
    expect(noTable.missing).toMatch(/tblBallNoseCutData/);
  });

  it('a concave cylindrical arc (no major diameter, no arc) keeps the edge model; a turned-shoulder fillet is still milled on a mill', () => {
    const arc = onMill([{ feature_type: 'Edge', variant: 'round', diameter_mm: 0, occurrences: [
      { radius_mm: 3, sweep_deg: 90, concave: true, extents_mm: [25, 4.2, 0.9] },
    ] }]);
    expect(arc.map((o) => o.name)).toContain('Filleting');
    expect(arc.map((o) => o.name)).not.toContain('Concave Fillet Milling');
    const shoulder = onMill([{ feature_type: 'Edge', variant: 'round', diameter_mm: 30, occurrences: [
      { radius_mm: 2, sweep_deg: 360, profile_deg: 90, path_length_mm: 94.248, concave: true, turned_shoulder: true },
    ] }]).find((o) => o.name === 'Concave Fillet Milling')!;
    expect(shoulder.timeSec).toBeGreaterThan(0);
  });
});

describe('spotting and countersinking on the workbook\'s Drilling sheet (1152)', () => {
  const drillRow = (diameter: number) => (workbookFixture().tables.tblDrillReamData as Array<Record<string, string>>)
    .find((r) => r.WorkMaterial === 'ALUMINUM ALLOY CAST AND WROUGHT' && r.Operation === 'Drilling' && Number(r.DiameterMinMm) <= diameter && diameter <= Number(r.DiameterMaxMm))!;
  const holeSec = (depth: number, diameter: number) => {
    const n = Math.min(10000, (85.5 * 1000) / (Math.PI * diameter));
    return Math.ceil(((depth + 10) / (Number(drillRow(diameter).FeedMmPerRev) * n)) * 60);
  };

  it('a Ø6 hole is spotted to its diameter: 3 mm deep + 10 mm at the Ø6 drilling feed, whole seconds a hole', () => {
    const spot = onMill([{ feature_type: 'SimpleHole', variant: 'through', diameter_mm: 6, occurrences: [{ depth_mm: 20 }, { depth_mm: 20 }] }]).find((o) => o.name === 'Center Drilling')!;
    expect(spot.missing).toBeUndefined();
    expect(spot.trace!.find((t) => t.fieldName === 'Spot Depth')!.value).toBe(3);
    expect(spot.timeSec).toBe(2 * holeSec(3, 6));
    expect(spot.timeSec).not.toBe(2 * 5);
  });

  it('a Ø14 countersink over its 0.6 x 14 = 8.4 mm hole: (14 - 8.4) / 2 = 2.8 mm deep at the Ø14 drilling speed and feed', () => {
    const csk = onMill([{ feature_type: 'Edge', variant: 'countersink', diameter_mm: 14, occurrences: [{ depth_mm: 6 }] }]).find((o) => o.name === 'Countersinking')!;
    expect(csk.missing).toBeUndefined();
    expect(csk.trace!.find((t) => t.fieldName === 'Countersink Depth')!.value).toBeCloseTo(2.8, 9);
    expect(csk.timeSec).toBe(holeSec(2.8, 14));
  });

  it('a countersink on a recognised hole is cut over that hole\'s diameter, and the hole is not drilled again', () => {
    // CARRIAGE MOUNT: Ø4.0 countersinks on its four Ø2.2 holes: (4 - 2.2) / 2 = 0.9 mm deep, the CAD's own countersink depth.
    const XY: Array<[number, number]> = [[7.95, -2.75], [-7.95, -2.75], [7.95, 2.75], [-7.95, 2.75]];
    const ops = onMill([
      { feature_type: 'SimpleHole', variant: 'through', diameter_mm: 2.2, occurrences: XY.map(([x, y]) => ({ centroid: [x, y, 9.35], tool_axis: [0, 0, -1], depth_mm: 2.116 })) },
      { feature_type: 'Edge', variant: 'countersink', diameter_mm: 4, occurrences: XY.map(([x, y]) => ({ centroid: [x, y, 10.55], depth_mm: 0.9 })) },
    ]);
    const csk = ops.filter((o) => o.name === 'Countersinking');
    expect(csk.map((o) => o.count)).toEqual([4]);
    expect(csk[0]!.missing).toBeUndefined();
    expect(csk[0]!.trace!.find((t) => t.fieldName === 'Hole Diameter')).toMatchObject({ value: 2.2, source: 'CAD: the hole the countersink sits on, Ø2.2 mm' });
    expect(csk[0]!.trace!.find((t) => t.fieldName === 'Countersink Depth')!.value).toBeCloseTo(0.9, 9);
    expect(csk[0]!.timeSec).toBe(4 * holeSec(0.9, 4));
    expect(ops.filter((o) => o.cadFeatureType === 'Edge' && (o.name === 'Drilling' || o.name === 'Center Drilling'))).toEqual([]);
  });

  describe('holes wider than the drills reach (the drilling table ends at Ø38)', () => {
    const missingOf = (features: object[]) => onMill(features).filter((o) => o.missing).map((o) => `${o.name}: ${o.missing}`);
    const names = (features: object[], type: string) => onMill(features).filter((o) => o.cadFeatureType === type).map((o) => o.name);

    it('a Ø40 blind hole is spotted for the Ø38 drill that enters it, drilled at Ø38 and bored to Ø40: nothing is left unpriced', () => {
      // LINEAR BRACKET (2026-11-25): its Ø40 x 4.597 hole was drilled and bored, but the spot before it was looked up at Ø40, which the
      // drilling table does not reach, and that one step left the whole Drilling line "unresolved" at $0.
      const ops = onMill([{ feature_type: 'SimpleHole', variant: 'blind', diameter_mm: 40, occurrences: [{ depth_mm: 4.597 }] }]);
      expect(ops.filter((o) => o.missing)).toEqual([]);
      const of = (name: string) => ops.find((o) => o.name === name && o.cadFeatureType === 'SimpleHole')!;
      const spot = of('Center Drilling');
      expect(spot.trace!.find((t) => t.fieldName === 'Hole Diameter')!.value).toBe(38);
      expect(String(spot.trace!.find((t) => t.fieldName === 'Hole Diameter')!.source)).toContain('The largest drill, Ø38 mm: the Ø40 mm hole is wider than the drills reach');
      // Spotted 38 / 2 = 19 mm deep at the Ø38 drilling speed and feed; drilled 4.597 mm deep with the Ø38 drill.
      expect(spot.timeSec).toBe(holeSec(19, 38));
      const drill = of('Drilling');
      expect(drill.trace!.find((t) => t.fieldName === 'Hole Diameter')!.value).toBe(38);
      expect(drill.trace!.find((t) => t.fieldName === 'Hole Depth')!.value).toBe(4.597);
      expect(drill.timeSec).toBeGreaterThan(0);
      const bore = of('Boring');
      expect(bore.timeSec).toBeGreaterThan(0);
      expect([bore.trace!.find((t) => t.fieldName === 'Initial Diameter')!.value, bore.trace!.find((t) => t.fieldName === 'Final Diameter')!.value]).toEqual([38, 40]);
    });

    it('a hole pattern, a tapped hole and a stepped hole follow the same rule: drilled at Ø38, bored to size', () => {
      const pattern = [{ feature_type: 'SimpleHole', variant: 'pcd_pattern', diameter_mm: 40, occurrences: [{ hole_count: 4, depth_mm: 12 }] }];
      expect(missingOf(pattern)).toEqual([]);
      expect(names(pattern, 'SimpleHole')).toEqual(['Center Drilling', 'Drilling', 'Boring']);
      // An M52 x 5 thread: its tap drill (0.8 x 52 = 41.6 mm) is wider than the drills reach.
      const tapped = [{ feature_type: 'SimpleHole', variant: 'threaded', diameter_mm: 52, occurrences: [{ depth_mm: 30, spec: 'M52×5', tapped: true }] }];
      expect(missingOf(tapped)).toEqual([]);
      expect(names(tapped, 'SimpleHole')).toEqual(expect.arrayContaining(['Center Drilling', 'Drilling', 'Boring', 'Tapping']));
      // A stepped hole whose first step is Ø45: that step is drilled at Ø38 and bored, the Ø20 step drilled as it is.
      const stepped = [{ feature_type: 'MultiStepHole', variant: 'stepped', diameter_mm: 0, occurrences: [{ steps: [{ diameter_mm: 45, depth_mm: 6 }, { diameter_mm: 20, depth_mm: 15 }, { diameter_mm: 10, depth_mm: 8 }] }] }];
      expect(missingOf(stepped)).toEqual([]);
      const steppedOps = onMill(stepped).filter((o) => o.cadFeatureType === 'MultiStepHole');
      expect(steppedOps.map((o) => o.name)).toEqual(['Center Drilling', 'Drilling', 'Boring']);
      // The three steps are drilled with the Ø38, Ø20 and Ø10 drills; only the Ø45 step is bored (from Ø38).
      const stepDrills = steppedOps.find((o) => o.name === 'Drilling')!.trace!.filter((t) => t.fieldName.endsWith('Hole Diameter')).map((t) => t.value);
      expect(stepDrills).toEqual([38, 20, 10]);
      const stepBores = steppedOps.find((o) => o.name === 'Boring')!.trace!.filter((t) => /(Initial|Final) Diameter$/.test(t.fieldName)).map((t) => t.value);
      expect(stepBores).toEqual([38, 45]);
    });

    it('a counterbore wider than the drills is bored out from the hole under it; a countersink that wide is chamfer milled round its mouth', () => {
      // A Ø50 counterbore over its own Ø30 hole (0.6 x 50): the hole is spotted and drilled, the Ø50 step bored from Ø30.
      const counterbore = [{ feature_type: 'MultiStepHole', variant: 'counterbore', diameter_mm: 50, occurrences: [{ depth_mm: 8 }] }];
      expect(missingOf(counterbore)).toEqual([]);
      const cb = onMill(counterbore).filter((o) => o.cadFeatureType === 'MultiStepHole');
      expect(cb.map((o) => o.name)).toEqual(['Center Drilling', 'Drilling', 'Boring']);
      const bored = cb.find((o) => o.name === 'Boring')!;
      expect([bored.trace!.find((t) => t.fieldName === 'Initial Diameter')!.value, bored.trace!.find((t) => t.fieldName === 'Final Diameter')!.value]).toEqual([30, 50]);
      // A Ø50 countersink with no hole of its own in the CAD: its Ø30 hole is drilled, its mouth milled as a chamfer of pi x 50 mm.
      const countersink = [{ feature_type: 'Edge', variant: 'countersink', diameter_mm: 50, occurrences: [{ depth_mm: 5 }] }];
      expect(missingOf(countersink)).toEqual([]);
      const cs = onMill(countersink).filter((o) => o.cadFeatureType === 'Edge');
      expect(cs.map((o) => o.name)).toEqual(['Center Drilling', 'Drilling', 'Chamfering']);
      expect(cs.find((o) => o.name === 'Chamfering')!.timeSec).toBe(edgeSec(Math.PI * 50));
      // Up to the largest drill nothing changes: a Ø38 hole is spotted and drilled at its own diameter, with no boring.
      expect(names([{ feature_type: 'SimpleHole', variant: 'through', diameter_mm: 38, occurrences: [{ depth_mm: 10 }] }], 'SimpleHole')).toEqual(['Center Drilling', 'Drilling']);
    });
  });

  it('a stepped hole is spotted at its entry step', () => {
    const spot = onMill([{ feature_type: 'MultiStepHole', variant: 'stepped', diameter_mm: 0, occurrences: [{ steps: [{ diameter_mm: 8, depth_mm: 4 }, { diameter_mm: 5, depth_mm: 10 }] }] }])
      .find((o) => o.name === 'Center Drilling')!;
    expect(spot.diameterMm).toBe(8);
    expect(spot.timeSec).toBe(holeSec(4, 8));
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
    // Each hole spotted on the workbook's Drilling sheet (1152): aluminium 85.5 m/min, 0.13 mm/rev at Ø6 = 4536 rpm; (3 + 10) / (0.13 x
    // 4536) min = 1.32 s -> 2 s a hole.
    expect(spot6.timeSec).toBe(6 * 2);
    expect(spot3.timeSec).toBe(3 * 2);
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

  // Two 40 x 25 x 10 mm pockets, walled all round, as the analysis states them (their floor box and measured depth).
  const sized = [{
    feature_type: 'PocketV2', variant: 'default', diameter_mm: 0,
    occurrences: [0, 1].map(() => ({ material_removed_mm3: 10000, depth_mm: 10, extents_mm: [40, 25, 0], width_confined: true, walled_fraction: 1 })),
  }];

  it('rough milling: the workbook\'s End Milling sheet over the pocket\'s length, width and depth, one run for the two', () => {
    // Mild steel: 78 m/min and 0.101 mm/tooth (the workbook's 60 - 120 and 0.08 - 0.15 at the Range Position 0.3), the 10 mm 4-tooth
    // end mill: n = 78000 / (pi x 10) = 2482.82 rpm; width passes ceil((25 - 5) / 8) = 3, depth passes ceil(10 / 2) = 5;
    // (40 + 10 + 5) / (0.101 x 4 x 2482.82) x 3 x 5 = 0.82248 min = 49.35 s -> 50 s a pocket, 100 s for the two.
    const rough = buildOperationSequence(sized, { matClass: 'mild_steel' }).filter((o) => o.name === 'Rough Milling');
    expect(rough).toHaveLength(1);
    expect(rough[0]!).toMatchObject({ timeSec: 100, count: 2 });
    const step = (name: string) => rough[0]!.trace!.find((st) => st.fieldName === name)?.value;
    expect([step('Width Passes'), step('Depth Passes'), step('Time per Cut')]).toEqual([3, 5, 50]);
    expect(rough[0]!.calculator?.lookups['Speed Min']?.table).toBe('tblMillingConditions');
  });

  it('a pocket with no CAD size is a named gap for its roughing too, never its volume at a rate', () => {
    const rough = buildOperationSequence(pocket, { matClass: 'mild_steel' }).find((o) => o.name === 'Rough Milling')!;
    expect(rough).toMatchObject({ timeSec: 0, missing: 'the CAD length, width and depth of every pocket' });
  });

  it('a pocket with no CAD size has no finishing time: the gap is named, never a flat time per pocket', () => {
    const finish = buildOperationSequence(pocket, { matClass: 'mild_steel' }).filter((o) => o.name === 'Fine Finish Milling');
    expect(finish).toHaveLength(1);
    expect(finish[0]!.timeSec).toBe(0);
    expect(finish[0]!.missing).toContain('length and width');
  });

  it('facing: the workbook\'s Face Milling sheet over the stock model\'s faces, not a fixed time', () => {
    // Mild steel, the sheet's 60 mm 6-tooth face mill: n = 78000 / (pi x 60) = 413.80 rpm; width passes max(1, ceil((60 - 30) / 58)) = 1,
    // depth passes ceil(2.5 / 2) = 2; (100 + 10 + 30) / (0.101 x 6 x 413.80) x 1 x 2 = 1.11659 min = 67.00 s -> 67 s a face, 134 s for
    // the two.
    const hole = [{ feature_type: 'SimpleHole', variant: 'through', diameter_mm: 6, occurrences: [{ depth_mm: 10 }, { depth_mm: 10 }] }];
    const ops = buildOperationSequence(hole, { matClass: 'mild_steel', machinabilityFactor: 1.0, materialGrade: 'AISI 1018', facing: FACING });
    const facing = ops.find((o) => o.name === 'Facing')!;
    expect(facing).toMatchObject({ timeSec: 134, count: 2 });
    expect(facing.trace!.find((st) => st.fieldName === 'Face Length')!.source).toBe('Stock: a 100 x 60 x 25 mm test block');
    // Two Ø6 holes spotted on the workbook's Drilling sheet (1152): mild steel 13.8 m/min, 0.1 mm/rev = 732.1 rpm; (3 + 10) / (0.1 x 732.1)
    // min = 10.65 s -> 11 s a hole.
    expect(ops.find((o) => o.name === 'Center Drilling')!.timeSec).toBe(22);
  });

  it('with no calculators an operation is a named gap, never a number', () => {
    const ops = buildWith(sized, { matClass: 'mild_steel', machinabilityFactor: 1.0, calculators: {}, removalRateMm3PerMin: 12000, finishing: FINISHING.mild_steel, workbook: workbookFixture() });
    const rough = ops.find((o) => o.name === 'Rough Milling')!;
    expect(rough.timeSec).toBe(0);
    expect(rough.missing).toContain('none mapped');
  });
});

describe('the removal rate is data (tblMillingRemovalRate), not a table in the code', () => {
  // The Bulk Milling of the stock around the part is the one volume operation left: 12 000 mm^3 of it.
  const hole = [{ feature_type: 'SimpleHole', variant: 'through', diameter_mm: 6, occurrences: [{ depth_mm: 10 }] }];
  const stockAround = { pieceMm3: 60000, partMm3: 48000, featureRemovedMm3: 0, facedMm3: 0, excessMm3: 12000, inconsistent: false };

  it('a volume operation with no rate on file is a named gap', () => {
    const bulk = buildWith(hole, { matClass: 'mild_steel', machinabilityFactor: 1.0, calculators: specAsCalculators(), removalRateMm3PerMin: null, stockAround }).find((o) => o.name === 'Bulk Milling')!;
    expect(bulk.timeSec).toBe(0);
    expect(bulk.missing).toContain('Material Removal Rate');
  });

  it('the rate it is given is the one it uses, and the trace names the table', () => {
    const bulk = buildWith(hole, { matClass: 'mild_steel', machinabilityFactor: 1.0, calculators: specAsCalculators(), removalRateMm3PerMin: 24000, stockAround }).find((o) => o.name === 'Bulk Milling')!;
    // Roughing Share 0.9 (Otsuka et al. 1997, migration 1158), the rest at 0.4 of the rate: (0.45 + 0.125) min = 34.5 s.
    expect(bulk.timeSec).toBeCloseTo((12000 * 0.9 / 24000 + 12000 * 0.1 / (24000 * 0.4)) * 60, 6);
    expect(bulk.trace!.find((st) => st.fieldName === 'Material Removal Rate')!.source).toContain('tblMillingRemovalRate');
  });

  it('countersinking is the workbook\'s Drilling sheet at the countersink\'s diameter (1152), not a set 6 s a hole', () => {
    // Ø8 over its 4.8 mm hole: (8 - 4.8) / 2 = 1.6 mm deep; mild steel 13.8 m/min, 0.23 mm/rev at Ø8 = 549.1 rpm; (1.6 + 10) / (0.23 x
    // 549.1) min = 5.51 s -> 6 s a hole, 12 s for the two.
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

  // Floor stepover 0.95 x D (Autodesk Fusion's face default), wall step-down 1.5 x D (the Corrax side milling ap), migration 1158.
  it('a pocket wider than the cutter: floor at a 0.95-diameter stepover, walls 1.5 diameters per step-down, a lead-in and lead-out', () => {
    const [finish] = finishOf(pockets(pocketOf(60, 40, 12)));
    const path = (60 * 40) / (10 * 0.95) + (2 * (60 + 40) * 12) / (10 * 1.5) + 1 * 2 * 10;
    expect(finish!.timeSec).toBeCloseTo(path / feed * 60, 6);
    expect(finish!.trace!.map((st) => st.fieldName)).toEqual(expect.arrayContaining(['Floor Area', 'Wall Area', 'Tool Diameter', 'Spindle Speed', 'Feed Rate', 'Path Length']));
  });

  it('a pocket narrower than the cutter is finished by a cutter of its width, walls included, on its own line', () => {
    const finish = finishOf(pockets(pocketOf(60, 40, 12), pocketOf(30, 4, 5), pocketOf(20, 4, 5)));
    expect(finish.map((o) => o.count)).toEqual([1, 2]);
    // Ø4: 76 m/min is 6048 rpm, feed 4 x 0.008 x 4 mm per rev; floor only (the cutter fills the width).
    const narrowFeed = (76 * 1000 / (Math.PI * 4)) * 4 * 0.008 * 4;
    expect(finish[1]!.timeSec).toBeCloseTo(((30 * 4 + 20 * 4) / (4 * 0.95) + 2 * 2 * 4) / narrowFeed * 60, 6);
  });

  it('an open step narrower than the cutter is finished with the standard cutter: its floor, and its one wall at the measured depth', () => {
    // 45 x 6 step, 4 deep, walled along one long side (45 of its 102 boundary): nothing confines the cutter to 6 mm.
    const step = { extents_mm: [45, 6, 0], material_removed_mm3: 1, depth_mm: 4, walled_fraction: 45 / 102, width_confined: false };
    const finish = finishOf(pockets(step));
    expect(finish).toHaveLength(1);
    const path = (45 * 6) / (10 * 0.95) + (45 * 4) / (10 * 1.5) + 1 * 2 * 10;
    expect(finish[0]!.timeSec).toBeCloseTo(path / feed * 60, 6);
  });

  it('a small cutter is held to the spindle speed limit, so it feeds slower', () => {
    const [finish] = finishOf(pockets(pocketOf(20, 1, 1)));
    // Ø1 would need 24192 rpm; the calculator's limit is 10000.
    expect(finish!.timeSec).toBeCloseTo(((20 * 1) / (1 * 0.95) + 2 * 1) / (10000 * 4 * 0.008 * 1) * 60, 6);
  });

  it('a free-form surface is stepped over at the scallop height, a wall by the cutter side: the surface takes longer per area', () => {
    const region = (type: string) => [{ feature_type: type, variant: 'default', occurrences: [{ area_mm2: 500 }] }];
    const timeOf = (type: string) => buildOperationSequence(region(type), { matClass: 'mild_steel' }).find((o) => o.name === 'Contouring')!.timeSec;
    // Scallop height 0.0125 mm (Ra 3.2 um), wall step-down 1.5 x D (migration 1158).
    expect(timeOf('CurvedSurface')).toBeCloseTo((500 / Math.sqrt(4 * 10 * 0.0125) + 2 * 10) / feed * 60, 6);
    expect(timeOf('CurvedWall')).toBeCloseTo((500 / (10 * 1.5) + 2 * 10) / feed * 60, 6);
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

  it('is roughed as the workbook\'s End Milling sheet times it, over each flat\'s CAD length, width and depth', () => {
    // Aluminium: 390 m/min on the 10 mm 3-tooth end mill holds the test machine's 10 000 rpm, 0.13 mm/tooth; one width pass
    // (ceil((10.583 - 5) / 8)), one depth pass (ceil(2 / 2)); (20 + 10 + 5) / (0.13 x 3 x 10000) = 0.00897 min = 0.54 s -> 1 s a flat.
    const [op] = flatOps([FLATS]);
    expect(op.timeSec).toBe(2);
    expect(op.calculator?.id).toBe('Machining - Rough Milling');
    const step = (name: string) => op.trace!.find((s) => s.fieldName === name);
    expect([step('Cut Length')?.value, step('Cut Width')?.value, step('Cut Depth')?.value]).toEqual([20, 10.583, 2]);
    expect(step('Cut Depth')!.source).toBe('CAD: depth below the diameter');
  });

  it('a flat with no CAD length, width or depth is a named gap, never free', () => {
    const [op] = flatOps([{ ...FLATS, occurrences: [{ ...flat([4]), length_mm: 0 }] }]);
    expect(op).toMatchObject({ name: 'Rough Milling', timeSec: 0, missing: 'the CAD length, width and depth of the flat', count: 1 });
    const [two] = flatOps([{ ...FLATS, occurrences: [{ ...flat([4]), depth_mm: undefined }, { ...flat([8]), depth_mm: undefined }] }]);
    expect(two.missing).toBe('the CAD length, width and depth of 2 flats');
  });

  it('with no end mill on file for the material (tblMillingFinishing) it is a named gap', () => {
    const ops = buildWith([FLATS], { matClass: 'aluminum', machinabilityFactor: 1.0, calculators: specAsCalculators(), finishing: null, workbook: workbookFixture() }).filter((o) => o.cadFeatureType === 'Flat');
    expect(ops).toEqual([expect.objectContaining({ name: 'Rough Milling', timeSec: 0, missing: expect.stringContaining('end mill') })]);
  });
});
