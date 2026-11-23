import { fetchMachinePool } from '../../../../../../modules/bom-items/costing/shared/capability/machine-selection/selector';
import { liveToolHoles, liveToolMilledFeatures, liveToolingVerdict } from '../../../../../../modules/bom-items/costing/machining/capability/live-tooling';

// R_M-0230-032 lead nut housing, its machining_features as the CAD engine stored them (local database). The two bores on the turning axis
// need no driven tool; the cross holes do. The off-axis axial bores carry distance_from_axis_mm once the CAD engine exports it for them.
const leadNut = [
  { type: 'SimpleHole', variant: 'through', params: { diameter_mm: 20, centroid: [0, 0, 0] } },
  { type: 'SimpleHole', variant: 'blind', params: { diameter_mm: 16, centroid: [0, 30, 0] } },
  { type: 'SimpleHole', variant: 'cross', params: { diameter_mm: 2, distance_from_axis_mm: 11.385 } },
  { type: 'SimpleHole', variant: 'cross', params: { diameter_mm: 3.2, distance_from_axis_mm: 9.801 } },
  { type: 'SimpleHole', variant: 'cross', params: { diameter_mm: 3.2, distance_from_axis_mm: 9.801 } },
  { type: 'SimpleHole', variant: 'cross', params: { diameter_mm: 6, distance_from_axis_mm: 13.966 } },
  { type: 'SimpleHole', variant: 'cross', params: { diameter_mm: 6, distance_from_axis_mm: 13.966 } },
  { type: 'Edge', variant: 'chamfer', params: { diameter_mm: 1.623 } },
];
const offAxis = [
  { type: 'SimpleHole', variant: 'blind', params: { diameter_mm: 8, distance_from_axis_mm: 6.0 } },
  { type: 'SimpleHole', variant: 'threaded', params: { diameter_mm: 1.623, distance_from_axis_mm: 11.88, spec: 'M2×0.4' } },
  { type: 'SimpleHole', variant: 'blind', params: { diameter_mm: 16, distance_from_axis_mm: 0 } },
];

describe('liveToolHoles: the holes a lathe drills only with a driven tool', () => {
  it('counts the cross holes, by diameter, and not the bores on the turning axis or the chamfers', () => {
    expect(liveToolHoles(leadNut)).toEqual([
      { diameterMm: 2, count: 1, why: 'cross' },
      { diameterMm: 3.2, count: 2, why: 'cross' },
      { diameterMm: 6, count: 2, why: 'cross' },
    ]);
  });

  it('counts an axial bore more than 3 mm off the axis (the CAD engine\'s central-bore limit), not one on it', () => {
    expect(liveToolHoles(offAxis)).toEqual([
      { diameterMm: 1.623, count: 1, why: 'off_axis' },
      { diameterMm: 8, count: 1, why: 'off_axis' },
    ]);
  });

  it('counts a hole pattern on a pitch circle (always off the axis) by its hole count', () => {
    expect(liveToolHoles([{ type: 'SimpleHole', variant: 'pcd_pattern', params: { pcd_mm: 40, hole_count: 6, hole_diameter_mm: 5 } }]))
      .toEqual([{ diameterMm: 5, count: 6, why: 'off_axis' }]);
  });

  it('is empty for no features', () => {
    expect(liveToolHoles(undefined)).toEqual([]);
    expect(liveToolHoles([])).toEqual([]);
  });
});

// Lead Screw side shaft, its feature_graph_v2 as the CAD engine stores it once the keyway on its turned diameter is recognised: one closed
// keyway (a broach cannot enter it, so it is milled) and two Ø2.529 cross holes.
const shaftKeyway = {
  id: 'Keyway-default_c1', feature_type: 'Keyway', variant: 'default',
  occurrences: [{ face_ids: [13, 14, 15, 25, 26], material_removed_mm3: 107.91, depth_mm: 2.951, walled_fraction: 1.0, length_mm: 9.971, width_mm: 4.0 }],
};
const radialSlots = { id: 'Slot-radial_c1', feature_type: 'Slot', variant: 'radial', occurrences: [{ material_removed_mm3: 60 }, { material_removed_mm3: 60 }] };
const shaftCrossHoles = [
  { type: 'SimpleHole', variant: 'cross', params: { diameter_mm: 2.529 } },
  { type: 'SimpleHole', variant: 'cross', params: { diameter_mm: 2.529 } },
];

describe('liveToolMilledFeatures: the keyways and slots a lathe mills', () => {
  it('counts the keyways and the slots left to mill, one per occurrence, and nothing a lathe turns or drills', () => {
    const turnedAndDrilled = [
      { id: 'Ring-outer_diameter_c1', feature_type: 'Ring', variant: 'outer_diameter', occurrences: [{}, {}] },
      { id: 'SimpleHole-cross_c1', feature_type: 'SimpleHole', variant: 'cross', occurrences: [{}, {}] },
    ];
    expect(liveToolMilledFeatures([...turnedAndDrilled, shaftKeyway, radialSlots])).toEqual([{ type: 'Keyway', count: 1 }, { type: 'Slot', count: 2 }]);
    expect(liveToolMilledFeatures(turnedAndDrilled)).toEqual([]);
  });

  it('adds up the groups of one type: two keyways of different sizes are two keyways', () => {
    expect(liveToolMilledFeatures([shaftKeyway, { ...shaftKeyway, id: 'Keyway-default_c2' }])).toEqual([{ type: 'Keyway', count: 2 }]);
  });

  it('is empty for no features', () => {
    expect(liveToolMilledFeatures(undefined)).toEqual([]);
    expect(liveToolMilledFeatures([])).toEqual([]);
  });
});

describe('liveToolingVerdict: can this lathe make what the part needs a live tool for?', () => {
  const holes = liveToolHoles(leadNut);
  const shaftHoles = liveToolHoles(shaftCrossHoles);
  const shaftMilled = liveToolMilledFeatures([shaftKeyway]);
  const noLiveTool = { liveToolingPowerKw: 0 };
  const liveTool = { liveToolingPowerKw: 14.9 };
  const notOnFile = { liveToolingPowerKw: null };

  describe('holes only', () => {
    it('a machine with no live-tool spindle (0 kW) cannot, and says which holes', () => {
      const v = liveToolingVerdict({ holes, milled: [] }, noLiveTool, 'Haas DS-30 with BAR3010SS Feeder');
      expect(v.capable).toBe(false);
      expect(v.warnings).toEqual([
        'Haas DS-30 with BAR3010SS Feeder has no live-tool spindle (memory/Machining/machine): it cannot drill the part\'s 5 cross holes '
        + '(1x Ø2, 2x Ø3.2, 2x Ø6); a lathe with live tooling (C/Y axis) or a mill is needed.',
      ]);
    });

    it('a machine with one can', () => {
      expect(liveToolingVerdict({ holes, milled: [] }, liveTool, 'Haas DS-30Y with BAR3010SS Feeder')).toEqual({ capable: true, warnings: [] });
    });

    it('a machine whose live tooling is not on file is not ruled out, and says so (unknown is never assumed either way)', () => {
      const v = liveToolingVerdict({ holes, milled: [] }, notOnFile, 'Lathe X');
      expect(v.capable).toBe(true);
      expect(v.warnings).toEqual(['Live tooling of Lathe X is not on file: whether it can drill the part\'s 5 cross holes (1x Ø2, 2x Ø3.2, 2x Ø6) is not checked.']);
    });
  });

  describe('milled features only: a keyway or a slot needs the live tool exactly as a cross hole does', () => {
    const work = { holes: [], milled: liveToolMilledFeatures([shaftKeyway, radialSlots]) };

    it('a machine with no live-tool spindle (0 kW) cannot, and says what it cannot mill', () => {
      expect(liveToolingVerdict(work, noLiveTool, 'Haas DS-30')).toEqual({
        capable: false,
        warnings: ['Haas DS-30 has no live-tool spindle (memory/Machining/machine): it cannot mill the part\'s 1 keyway and 2 slots; a lathe with live tooling (C/Y axis) or a mill is needed.'],
      });
    });

    it('a machine with one can', () => {
      expect(liveToolingVerdict(work, liveTool, 'Haas DS-30Y')).toEqual({ capable: true, warnings: [] });
    });

    it('a machine whose live tooling is not on file is not ruled out, and says so', () => {
      expect(liveToolingVerdict(work, notOnFile, 'Lathe X')).toEqual({
        capable: true, warnings: ['Live tooling of Lathe X is not on file: whether it can mill the part\'s 1 keyway and 2 slots is not checked.'],
      });
      // No capability resolved for the machine at all is the same unknown.
      expect(liveToolingVerdict(work, null, 'Lathe X').capable).toBe(true);
    });
  });

  describe('both: the shaft\'s keyway and its two cross holes', () => {
    const work = { holes: shaftHoles, milled: shaftMilled };

    it('a machine with no live-tool spindle (0 kW) cannot, and names both', () => {
      expect(liveToolingVerdict(work, noLiveTool, 'Haas DS-30 with BAR3010SS Feeder')).toEqual({
        capable: false,
        warnings: [
          'Haas DS-30 with BAR3010SS Feeder has no live-tool spindle (memory/Machining/machine): it cannot mill the part\'s 1 keyway and drill its '
          + '2 cross holes (2x Ø2.529); a lathe with live tooling (C/Y axis) or a mill is needed.',
        ],
      });
    });

    it('a machine with one can', () => {
      expect(liveToolingVerdict(work, liveTool, 'Haas DS-30Y with BAR3010SS Feeder')).toEqual({ capable: true, warnings: [] });
    });

    it('a machine whose live tooling is not on file is not ruled out, and says so', () => {
      expect(liveToolingVerdict(work, notOnFile, 'Lathe X')).toEqual({
        capable: true,
        warnings: ['Live tooling of Lathe X is not on file: whether it can mill the part\'s 1 keyway and drill its 2 cross holes (2x Ø2.529) is not checked.'],
      });
    });
  });

  describe('flats: a flat milled on a turned diameter needs the live tool as a keyway does', () => {
    // Two wrench flats on the shaft, as the CAD engine's feature_graph_v2 carries them (one group, an occurrence per flat).
    const flats = { id: 'Flat-default_c2', feature_type: 'Flat', variant: 'default', occurrences: [{ material_removed_mm3: 290.12 }, { material_removed_mm3: 290.12 }] };
    const work = { holes: [], milled: liveToolMilledFeatures([flats]) };

    it('counts each flat', () => {
      expect(work.milled).toEqual([{ type: 'Flat', count: 2 }]);
      expect(liveToolMilledFeatures([shaftKeyway, radialSlots, flats])).toEqual([{ type: 'Keyway', count: 1 }, { type: 'Slot', count: 2 }, { type: 'Flat', count: 2 }]);
    });

    it('a machine with no live-tool spindle (0 kW) cannot, and says it cannot mill the flats', () => {
      expect(liveToolingVerdict(work, noLiveTool, 'Mazak 6G')).toEqual({
        capable: false,
        warnings: ['Mazak 6G has no live-tool spindle (memory/Machining/machine): it cannot mill the part\'s 2 flats; a lathe with live tooling (C/Y axis) or a mill is needed.'],
      });
    });

    it('a machine with one can; one whose live tooling is not on file is not ruled out, and says so', () => {
      expect(liveToolingVerdict(work, liveTool, 'Miyano BNC-20')).toEqual({ capable: true, warnings: [] });
      expect(liveToolingVerdict(work, notOnFile, 'Lathe X')).toEqual({
        capable: true, warnings: ['Live tooling of Lathe X is not on file: whether it can mill the part\'s 2 flats is not checked.'],
      });
    });
  });

  it('none: a part with no such hole, keyway or slot needs no live tooling on any machine', () => {
    for (const capability of [noLiveTool, liveTool, notOnFile, null]) {
      expect(liveToolingVerdict({ holes: [], milled: [] }, capability, 'Haas DS-30')).toEqual({ capable: true, warnings: [] });
    }
  });
});

// The machine pool reads each lathe's own live-tool spindle (mhr_records.live_tooling_power_kw, migration 1043). It is a fact of the machine,
// carried with whichever limits it has: it neither makes a record "staged" nor is replaced by a seed or a class default.
describe('fetchMachinePool carries each machine\'s live-tool spindle', () => {
  const row = (id: string, name: string, cls: string, kw: number | null) => ({
    id, machine_name: name, machine_class: cls, process_group: 'Machining', total_machine_hour_rate: 60, live_tooling_power_kw: kw,
  });
  const rows = [
    row('a', 'Haas DS-30 with BAR3010SS Feeder', '2_axis_bar_feed_lathe_with_sub_spindle', 0),
    row('b', 'Haas DS-30Y with BAR3010SS Feeder', '3_axis_bar_feed_lathe_with_sub_spindle', 14.9),
    row('c', 'Lathe with nothing on file', '2_axis_lathe', null),
  ];
  const client = {
    from: () => ({ select: () => ({ eq: () => ({ order: () => ({ range: async () => ({ data: rows, error: null }) }) }) }) }),
  };

  it('reads 0 and 14.9 kW as they are, and null as not known', async () => {
    const pool = await fetchMachinePool(client as never, `live-tooling-test-${Date.now()}`);
    const kw = (name: string) => pool.find((c) => c.machineName === name)?.capability.liveToolingPowerKw;
    expect(kw('Haas DS-30 with BAR3010SS Feeder')).toBe(0);
    expect(kw('Haas DS-30Y with BAR3010SS Feeder')).toBe(14.9);
    expect(kw('Lathe with nothing on file')).toBeNull();
  });

  it('does not make a lathe\'s limits "staged": its capability source is what it was without the column', async () => {
    const withColumn = await fetchMachinePool(client as never, `live-tooling-src-${Date.now()}`);
    const without = { from: () => ({ select: () => ({ eq: () => ({ order: () => ({ range: async () => ({ data: rows.map(({ live_tooling_power_kw: _, ...r }) => r), error: null }) }) }) }) }) };
    const before = await fetchMachinePool(without as never, `live-tooling-src-before-${Date.now()}`);
    for (const c of withColumn) expect(c.capabilitySource).toBe(before.find((b) => b.machineName === c.machineName)!.capabilitySource);
  });
});
