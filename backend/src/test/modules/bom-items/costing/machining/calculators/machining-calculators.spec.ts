import { readFileSync } from 'fs';
import { join } from 'path';
import { runMachiningCalculator, CYCLE_TIME_FIELD, type CalcSeed } from '../../../../../../modules/bom-items/costing/machining/calculators/machining-calculator';
import { loadMachiningCalculatorSpec, specAsCalculators, STATION_OPERATION } from '../../../../../../modules/bom-items/costing/machining/calculators/machining-calculator-spec';
import { buildMachiningCalculatorMigrationSql, buildMachiningCalculatorsMigrationSql } from '../../../../../../modules/bom-items/costing/machining/calculators/machining-calculators-migration';

// Contract between the machining calculator spec, its migration, and the
// engine: one definition of every machining formula, stored in the database,
// evaluated by the engine — never a second copy.
const spec = loadMachiningCalculatorSpec();
const calcs = specAsCalculators(spec);
const ROOT = join(__dirname, '../../../../../../..');

describe('machining calculator spec ↔ migration ↔ engine', () => {
  it('the committed migration is exactly what the spec generates', () => {
    const committed = readFileSync(join(ROOT, 'migrations/804_machining_calculators.sql'), 'utf-8');
    // 804 is built from the whole spec, superseded entries included: an applied migration never changes.
    expect(committed).toBe(buildMachiningCalculatorsMigrationSql());
  });

  it('a calculator replaced later keeps its 804 entry, and the replacement ships in its own migration (Inspection, 1029)', () => {
    const committed = readFileSync(join(ROOT, 'migrations/1029_machining_inspection_from_reference.sql'), 'utf-8');
    expect(committed).toBe(buildMachiningCalculatorMigrationSql(1029, spec));
    expect(committed).toContain('tblInspection');
    // The engine sees only the current entry.
    expect(spec.calculators.filter((c) => c.name === 'Machining - Inspection').map((c) => c.fields.map((f) => f.name))).toEqual([
      ['Batch Inspection Time', 'Sample Quantity', 'Sample Lot Size', 'Batch Size', 'Sampled Parts', 'Time per Sampled Part', 'Tool Price', 'Tool Life', 'Tool Cost per Part', 'Cycle Time'],
    ]);
    expect(buildMachiningCalculatorsMigrationSql()).toContain('Positioning Time');
  });

  it('a calculator added later ships in its own migration, and 804 does not change for it', () => {
    const committed = readFileSync(join(ROOT, 'migrations/1027_machining_milling_calculator.sql'), 'utf-8');
    expect(committed).toBe(buildMachiningCalculatorMigrationSql(1027, spec));
    expect(buildMachiningCalculatorsMigrationSql()).not.toContain('Machining - Milling');
  });

  it('the calculators added to the spec after 804 was applied ship again in 1028, so a database that ran the earlier 804 gets them', () => {
    const committed = readFileSync(join(ROOT, 'migrations/1028_machining_calculators_missing_after_804.sql'), 'utf-8');
    expect(committed).toBe(buildMachiningCalculatorMigrationSql(1028, spec));
    for (const name of ['Surface Grinding', 'Hobbing', 'Shaving', 'Rotary Broaching']) expect(committed).toContain(`Machining - ${name}`);
  });

  it('the second batch of calculators ships in 1030: ten more reference processes get one', () => {
    const committed = readFileSync(join(ROOT, 'migrations/1030_machining_calculators_batch_2.sql'), 'utf-8');
    expect(committed).toBe(buildMachiningCalculatorMigrationSql(1030, spec));
    for (const station of ['Rotary Surface Grinder', 'Shaper', 'Drill Press', 'Stock Prep Mill', 'Stock Prep Lathe', 'Bench Operation', '3 Axis Router', '5 Axis Router']) {
      expect(calcs[station]?.name).toMatch(/^Machining - /);
    }
    expect(calcs['Straight BG Face Milling']?.name).toBe('Machining - Straight Bevel Gear Cutting');
    expect(calcs['Automated Deburring']?.name).toBe('Machining - Automated Deburring');
  });

  it('the milling operations of the sequencer each have a calculator, shipped in 1031', () => {
    const committed = readFileSync(join(ROOT, 'migrations/1031_machining_mill_operation_calculators.sql'), 'utf-8');
    expect(committed).toBe(buildMachiningCalculatorMigrationSql(1031, spec));
    for (const op of ['Facing', 'Rough Milling', 'Bulk Milling', 'Fine Finish Milling', 'Contouring', 'Perimeter Milling', 'Slot Milling', 'Center Drilling', 'Chamfering', 'Filleting', 'Groove Milling']) {
      expect(calcs[op]?.name).toBe(`Machining - ${op}`);
    }
  });

  it('the third batch ships in 1032: every reference process with a machine now has a calculator', () => {
    const committed = readFileSync(join(ROOT, 'migrations/1032_machining_calculators_batch_3.sql'), 'utf-8');
    expect(committed).toBe(buildMachiningCalculatorMigrationSql(1032, spec));
    for (const station of ['Mask Cure', 'Scribe', 'Etch Cell', 'DeMask', 'Spline Roller', 'Profile Gear Grinder', 'Threaded Wheel Gear Grinder']) {
      expect(calcs[station]?.name).toMatch(/^Machining - /);
    }
  });

  it('countersinking has its own machining calculator, shipped in 1035', () => {
    const committed = readFileSync(join(ROOT, 'migrations/1035_machining_countersinking_calculator.sql'), 'utf-8');
    expect(committed).toBe(buildMachiningCalculatorMigrationSql(1035, spec));
    expect(calcs['Countersinking']?.name).toBe('Machining - Countersinking');
  });

  it('part setup (load, unload, reorient) has a calculator, shipped in 1037', () => {
    const committed = readFileSync(join(ROOT, 'migrations/1037_machining_part_setup_calculator.sql'), 'utf-8');
    expect(committed).toBe(buildMachiningCalculatorMigrationSql(1037, spec));
    expect(calcs['Part Setup']?.name).toBe('Machining - Part Setup');
  });

  it('the finishing passes as tool paths replace their 1031 entries, shipped in 1038', () => {
    const committed = readFileSync(join(ROOT, 'migrations/1038_machining_finishing_calculators.sql'), 'utf-8');
    expect(committed).toBe(buildMachiningCalculatorMigrationSql(1038, spec));
    for (const op of ['Fine Finish Milling', 'Contouring', 'Perimeter Milling']) expect(calcs[op]?.fields.map((f) => f.field_name)).toContain('Feed Rate');
  });

  it('milling a keyway has its own calculator, shipped in 1118 and mapped on the machines the catalog gives the operation', () => {
    const committed = readFileSync(join(ROOT, 'migrations/1118_machining_obround_slot_milling_calculator.sql'), 'utf-8');
    expect(committed).toBe(buildMachiningCalculatorMigrationSql(1118, spec));
    expect(calcs['Obround Slot Milling']?.name).toBe('Machining - Obround Slot Milling');
    // The reference catalog's "Obround Slot Milling//Keyway" rows: the mills and the lathes with a live tool, not the 2-axis lathes.
    expect(spec.calculators.find((c) => c.operation === 'Obround Slot Milling')!.machineClasses.map((cls) => spec.stations[cls])).toEqual([
      '3 Axis Lathe', '3 Axis Bar Feed Lathe with Sub Spindle', 'Simultaneous Turning', 'MillTurn', '3 Axis Mill', '4 Axis Mill', '5 Axis Mill',
    ]);
    // The header states where the one default the reference data has no value for comes from; the database keeps it in the description.
    expect(committed).toContain('-- Machining - Obround Slot Milling, Slotting Depth Ratio = 0.2. The engine\'s own value: the');
    expect(committed).toContain('mmc-carbide.com/permanent/courses/70/depth-of-cut.html');
    expect(spec.calculators.find((c) => c.operation === 'Obround Slot Milling')!.description).toContain('Mitsubishi Materials');
    // The calculators shipped before it are the files they were: the header's new paragraph is written only for a field with a source note.
    expect(readFileSync(join(ROOT, 'migrations/1037_machining_part_setup_calculator.sql'), 'utf-8')).not.toContain('The engine\'s own value');
  });

  it('the turning family follows the workbook (1138); what 1128, 1030 and 804 shipped is kept', () => {
    for (const [n, file] of [[1128, '1128_machining_turning_follows_the_workbook.sql'], [1138, '1138_machining_turning_family_workbook.sql']] as const) {
      expect(readFileSync(join(ROOT, 'migrations', file), 'utf-8')).toBe(buildMachiningCalculatorMigrationSql(n, spec));
    }
    const committed = readFileSync(join(ROOT, 'migrations/1138_machining_turning_family_workbook.sql'), 'utf-8');
    for (const name of ['Rough Turning', 'Finish Turning', 'Stock Prep Lathe', 'Parting', 'End Facing', 'Thread Turning', 'Knurling']) {
      expect(committed).toContain(`Machining - ${name}`);
    }
    // 804 still ships the formulas it was applied with; the engine sees only the current entries.
    expect(buildMachiningCalculatorsMigrationSql()).toContain('round({Rough Stock} / {Rough Depth of Cut})');
    expect(calcs['Rough Turning']?.fields.map((f) => f.field_name)).toEqual([
      'Turned Diameter', 'Turned Length', 'Bar Diameter', 'Rough Depth of Cut', 'Finish Depth of Cut',
      'Rough Speed Min', 'Rough Speed Max', 'Rough Feed Min', 'Rough Feed Max', 'Range Position', 'Max Spindle Speed', 'Approach Length',
      'Rough Cutting Speed', 'Rough Feed', 'Finish Start Diameter', 'Rough Passes', 'Spindle Speed', 'Machining Time', CYCLE_TIME_FIELD,
    ]);
    // The lathe's stock preparation is the same cut: it copies the current Rough Turning, and its 1128 entry kept the 1128 fields.
    expect(calcs['Stock Prep Lathe']?.fields).toEqual(calcs['Rough Turning']?.fields);
    expect(readFileSync(join(ROOT, 'migrations/1128_machining_turning_follows_the_workbook.sql'), 'utf-8')).toContain('$q$Time per Pass$q$');
  });

  /** Runs a calculator on the workbook sheet's own inputs (a range given as one value: min = max). */
  const sheet = (operation: string, values: Record<string, number>) => {
    const seeds: Record<string, CalcSeed> = Object.fromEntries(Object.entries({ 'Max Spindle Speed': 100_000, ...values })
      .map(([name, value]) => [name, { value, source: 'workbook sheet' }]));
    const run = runMachiningCalculator(calcs, operation, seeds);
    const value = (field: string) => Number(run.trace.find((step) => step.fieldName === field)?.value);
    return { value, sec: run.sec, missing: run.missing };
  };

  it('Rough Turning reproduces the workbook\'s Turning sheet rows, in whole passes and whole seconds', () => {
    // Turning sheet: n = 1000 v / (pi D1), np = (D1 - D2) / (2 t), Tc = pi D1 (L + 10) / (1000 v s) x np. A row is one cut from D1 to D2,
    // so no finish allowance is left (Finish Depth of Cut 0). pi is exact here (the sheet writes 3.14 and 3.1428).
    const row = (d1: number, d2: number, length: number, v: number, s: number, t: number) => sheet('Rough Turning', {
      'Bar Diameter': d1, 'Turned Diameter': d2, 'Turned Length': length, 'Rough Speed Min': v, 'Rough Speed Max': v,
      'Rough Feed Min': s, 'Rough Feed Max': s, 'Rough Depth of Cut': t, 'Finish Depth of Cut': 0,
    });
    // Row 1: 1 pass, 381.97 rpm, pi x 100 x 210 / (1000 x 120 x 0.2) = 2.749 min = 164.9 s -> 165 s (the sheet: 2.75 min).
    const first = row(100, 96, 200, 120, 0.2, 2);
    expect(first.missing).toEqual([]);
    expect(first.value('Rough Passes')).toBe(1);
    expect(first.value('Spindle Speed')).toBeCloseTo(381.97, 1);
    expect(first.sec).toBe(165);
    // Row 2: the sheet's 11.25 passes are 12 whole passes (correction): 1.4431 min a pass x 12 = 17.318 min = 1039.1 s -> 1040 s
    // (the sheet: 16.24 min on its fraction of a pass).
    const second = row(70, 25, 200, 160, 0.2, 2);
    expect(second.value('Rough Passes')).toBe(12);
    expect(second.sec).toBe(1040);
    // Row 3: 10 passes, 318.31 rpm, 17.279 min = 1036.7 s -> 1037 s (the sheet: 17.29 min).
    const third = row(80, 40, 100, 80, 0.2, 2);
    expect(third.value('Rough Passes')).toBe(10);
    expect(third.sec).toBe(1037);
  });

  it('a cut is capped at the machine\'s spindle limit', () => {
    // Row 1 on a 300 rpm spindle: 2.749 min x 381.97 / 300 = 3.5 min = 210 s.
    const capped = sheet('Rough Turning', {
      'Max Spindle Speed': 300, 'Bar Diameter': 100, 'Turned Diameter': 96, 'Turned Length': 200, 'Rough Speed Min': 120, 'Rough Speed Max': 120,
      'Rough Feed Min': 0.2, 'Rough Feed Max': 0.2, 'Rough Depth of Cut': 2, 'Finish Depth of Cut': 0,
    });
    expect(capped.value('Spindle Speed')).toBe(300);
    expect(capped.sec).toBe(210);
  });

  it('Thread Turning reproduces the workbook\'s Threading sheet', () => {
    // Threading sheet: M27 x 1 (Ø26.35 pitch diameter), 3.5 mm long, 5 m/min, 4 passes, feed = pitch:
    // n = 5000 / (pi x 26.35) = 60.40 rpm; (3.5 + 4) / (1 x 60.40) x 4 = 0.4967 min = 29.80 s -> 30 s, the sheet's own 30 s.
    const run = sheet('Thread Turning', { 'Thread Diameter': 26.35, 'Thread Length': 3.5, 'Pitch': 1 });
    expect(run.missing.join('; ')).toMatch(/Tool Price.*Tool Life|Tool Life.*Tool Price/);
    const timed = sheet('Thread Turning', { 'Thread Diameter': 26.35, 'Thread Length': 3.5, 'Pitch': 1, 'Tool Price': 100, 'Tool Life': 300 });
    expect(timed.value('Spindle Speed')).toBeCloseTo(60.40, 1);
    expect(timed.sec).toBe(30);
    expect(timed.value('Tool Cost per Part')).toBeCloseTo(0.3333, 4);
  });

  it('Knurling: the sheet\'s 30 s on its own feed; the corrected feed is a turning feed, not 25.4 / TPI', () => {
    const knurl = (feed: number) => sheet('Knurling', {
      'Knurl Diameter': 27, 'Knurl Length': 3, 'Feed Min': feed, 'Feed Max': feed, 'Tool Price': 100, 'Tool Life': 300,
    });
    // Knurling sheet: 6 m/min on Ø27 = 70.74 rpm; feed 25.4 / 32 TPI = 0.79375; (3 + 4) / (0.79375 x 70.74) x 4 = 0.4989 min -> 30 s.
    expect(knurl(25.4 / 32).sec).toBe(30);
    // The workbook's finishing turning feed (aluminium 0.05-0.2, middle 0.125): 7 / (0.125 x 70.7355) x 4 = 3.1667 min = 190.004 s -> 191 s.
    expect(knurl(0.125).sec).toBe(191);
  });

  it('End Facing and Parting: the workbook\'s Facing and Cutoff sheets, with the travel corrected to the bar\'s radius', () => {
    // Facing sheet: Ø50, 50 m/min, 0.15 mm/rev, 1 mm of stock at 0.5 a pass = 2 passes, both ends. The sheet types a 13 mm length of
    // cut: 2 x ceil(pi x 50 x 23 / (1000 x 50 x 0.15) x 2 x 60) = 2 x 58 = 116 s. Across the radius: n = 318.31 rpm;
    // (25 + 10) / (0.15 x 318.31) x 2 = 1.4661 min = 87.96 s -> 88 s a face, 176 s both ends.
    const facing = sheet('End Machining', {
      'Bar Diameter': 50, 'Facing Stock': 1, 'Faces': 2, 'Speed Min': 50, 'Speed Max': 50, 'Feed Min': 0.15, 'Feed Max': 0.15,
      'Tool Price': 732.4, 'Tool Life': 1000,
    });
    expect(facing.value('Passes')).toBe(2);
    expect(facing.value('Time per Face')).toBe(88);
    expect(facing.sec).toBe(176);
    expect(facing.value('Tool Cost per Part')).toBeCloseTo(0.7324, 4);
    // Cutoff sheet: Ø50, 18 m/min, 0.8 mm a rev, 13 mm typed: ceil(15.06 s) = 16 s. Through the radius: n = 114.59 rpm;
    // (25 + 10) / (0.8 x 114.59) = 0.3818 min = 22.9 s -> 23 s. A tube's part-off cuts its wall only: Ø50 x Ø40, (5 + 10) mm -> 10 s.
    const part = (bore: number) => sheet('Parting', { 'Bar Diameter': 50, 'Bore Diameter': bore, 'Cutting Speed': 18, 'Feed': 0.8, 'Tool Price': 732.4, 'Tool Life': 1000 });
    expect(part(0).sec).toBe(23);
    expect(part(40).sec).toBe(10);
  });

  it('the inspection gauge and the XRF composition check ship in 1146', () => {
    expect(readFileSync(join(ROOT, 'migrations/1146_machining_inspection_gauge_and_xrf.sql'), 'utf-8')).toBe(buildMachiningCalculatorMigrationSql(1146, spec));
  });

  it('Inspection follows the workbook (1151); what 1146, 1029 and 804 shipped is kept', () => {
    expect(readFileSync(join(ROOT, 'migrations/1151_machining_inspection_workbook.sql'), 'utf-8')).toBe(buildMachiningCalculatorMigrationSql(1151, spec));
    expect(readFileSync(join(ROOT, 'migrations/1146_machining_inspection_gauge_and_xrf.sql'), 'utf-8')).toBe(buildMachiningCalculatorMigrationSql(1146, spec));
    expect(calcs['Inspection']?.fields.map((f) => f.field_name)).toEqual([
      'Batch Inspection Time', 'Sample Quantity', 'Sample Lot Size', 'Batch Size', 'Sampled Parts', 'Time per Sampled Part',
      'Tool Price', 'Tool Life', 'Tool Cost per Part', 'Cycle Time',
    ]);
  });

  it('Inspection reproduces the workbook\'s Inspection sheet: 60 s a batch for 5 of its 50 parts, 1.2 s a part, the gauge Rs 0.35 a part', () => {
    // The sheet: Part inspection quantity 5, Batch size 50, Time/batch 60 s, Time/part = 60 / 50 = 1.2 s; Tool cost 3500 / 10 000 = 0.35.
    const r = sheet('Inspection', { 'Batch Size': 50, 'Tool Price': 3500, 'Tool Life': 10000 });
    expect(r.missing).toEqual([]);
    expect(r.value('Sampled Parts')).toBe(5);
    expect(r.value('Time per Sampled Part')).toBe(12);
    expect(r.sec).toBeCloseTo(1.2, 9);
    expect(r.value('Tool Cost per Part')).toBeCloseTo(0.35, 9);
  });

  it.each([
    [1, 1, 12], [3, 3, 12], [5, 5, 12], [49, 5, 60 / 49], [50, 5, 1.2], [51, 10, 120 / 51], [100, 10, 1.2], [300, 30, 1.2],
  ])('Inspection of a %i-part batch: %i sampled, %f s a part', (batch, sampled, perPart) => {
    const r = sheet('Inspection', { 'Batch Size': batch, 'Tool Price': 3500, 'Tool Life': 10000 });
    expect(r.value('Sampled Parts')).toBe(sampled);
    expect(r.sec).toBeCloseTo(perPart, 9);
  });

  it('spotting, countersinking and the edges follow the workbook (1152); what 1031 and 1035 shipped is kept', () => {
    expect(readFileSync(join(ROOT, 'migrations/1152_machining_edges_and_spots_workbook.sql'), 'utf-8')).toBe(buildMachiningCalculatorMigrationSql(1152, spec));
    for (const n of [1031, 1035]) {
      const file = n === 1031 ? '1031_machining_mill_operation_calculators.sql' : '1035_machining_countersinking_calculator.sql';
      expect(readFileSync(join(ROOT, `migrations/${file}`), 'utf-8')).toBe(buildMachiningCalculatorMigrationSql(n, spec));
    }
    const current = loadMachiningCalculatorSpec().calculators;
    const fields = (name: string) => current.find((c) => c.name === name)!.fields;
    // No set time per hole or per edge is left.
    for (const name of ['Machining - Center Drilling', 'Machining - Countersinking', 'Machining - Chamfering', 'Machining - Filleting', 'Machining - Groove Milling']) {
      expect(fields(name).some((f) => /Time per (Hole|Unsized Edge)/.test(f.name) && f.source === 'default')).toBe(false);
      expect(fields(name).find((f) => f.name === 'Max Spindle Speed')).toMatchObject({ source: 'machine' });
    }
    // Groove Milling copies the 1152 Filleting.
    expect(fields('Machining - Groove Milling')).toEqual(fields('Machining - Filleting'));
  });

  it('Center Drilling and Countersinking reproduce the Drilling sheet; an edge the End Milling sheet', () => {
    // Mild steel Ø6 spot: 17 m/min, 0.1 mm/rev, n = 17 000 / (pi x 6) = 901.9 rpm; (3 + 10) / (0.1 x 901.9) = 0.14414 min -> 9 s a hole.
    const spot = sheet('Center Drilling', { 'Hole Diameter': 6, 'Holes': 2, 'Speed Min': 17, 'Speed Max': 17, 'Feed': 0.1 });
    expect(spot.missing).toEqual([]);
    expect(spot.value('Spot Depth')).toBe(3);
    expect(spot.value('Time per Hole')).toBe(9);
    expect(spot.sec).toBe(18);
    // Ø8 countersink over a 4.8 mm hole: 1.6 mm deep; 0.23 mm/rev at 676.4 rpm; (1.6 + 10) / (0.23 x 676.4) = 0.07457 min -> 5 s.
    const csk = sheet('Countersinking', { 'Countersink Diameter': 8, 'Hole Diameter': 4.8, 'Holes': 1, 'Speed Min': 17, 'Speed Max': 17, 'Feed': 0.23 });
    expect(csk.value('Countersink Depth')).toBeCloseTo(1.6, 9);
    expect(csk.sec).toBe(5);
    // A 27 mm edge, 10 mm 3-tooth end mill, 450 m/min, 0.15 mm/tooth, held to a 10 000 rpm machine: (27 + 10 + 5) / (0.15 x 3 x 10 000) min
    // = 0.56 s -> 1 s an edge.
    const edge = sheet('Filleting', { 'Edge Length': 27, 'Edges': 3, 'Cutter Diameter': 10, 'Teeth': 3, 'Speed Min': 450, 'Speed Max': 450,
      'Feed per Tooth Min': 0.15, 'Feed per Tooth Max': 0.15, 'Max Spindle Speed': 10000 });
    expect(edge.value('Time per Edge')).toBe(1);
    expect(edge.sec).toBe(3);
  });

  it('RM Composition Analysis reproduces the workbook\'s sheet: 60 s a lot over its 300 parts, 0.2 s a part', () => {
    // The sheet: Time/part = 60 / (MOQ 0.6256 t x 1000 / part weight 2.0855 kg) = 60 / 300 = 0.2 s.
    expect(sheet('RM Composition Analysis', { 'Lot Size': 300 }).sec).toBeCloseTo(0.2, 9);
  });

  it('the milling line times its moves from data (1142): tool changes and rapids, not a flat 15 %', () => {
    expect(readFileSync(join(ROOT, 'migrations/1142_machining_milling_rapids_tool_changes.sql'), 'utf-8')).toBe(buildMachiningCalculatorMigrationSql(1142, spec));
    const station = loadMachiningCalculatorSpec().calculators.find((c) => c.name === 'Machining - Milling')!;
    expect(station.fields.map((f) => f.name)).not.toContain('Rapids and Tool Change Allowance');
    expect(station.fields.find((f) => f.name === 'Cycle Time')!.formula).toBe('{Cutting Time} + {Tool Change Time Total} + {Rapid Time}');
  });

  it('Stock Prep Mill times its moves as the Milling station does (1149); what 1030 shipped is kept', () => {
    expect(readFileSync(join(ROOT, 'migrations/1149_machining_stock_prep_mill_moves_from_data.sql'), 'utf-8')).toBe(buildMachiningCalculatorMigrationSql(1149, spec));
    expect(readFileSync(join(ROOT, 'migrations/1030_machining_calculators_batch_2.sql'), 'utf-8')).toBe(buildMachiningCalculatorMigrationSql(1030, spec));
    const current = loadMachiningCalculatorSpec().calculators;
    const prep = current.find((c) => c.name === 'Machining - Stock Prep Mill')!;
    const station = current.find((c) => c.name === 'Machining - Milling')!;
    // The same fields and formulas as the Milling station: no flat allowance left.
    expect(prep.fields).toEqual(station.fields);
    expect(prep.fields.map((f) => f.name)).not.toContain('Rapids and Tool Change Allowance');
    expect(prep.fields.find((f) => f.name === 'Cycle Time')!.formula).toBe('{Cutting Time} + {Tool Change Time Total} + {Rapid Time}');
    // The engine sees only the current entry.
    expect(current.filter((c) => c.name === 'Machining - Stock Prep Mill')).toHaveLength(1);
  });

  it('a copied calculator keeps the version it was copied at: Bulk Milling stays the removal-rate model 1031 shipped (a fresh database builds it so)', () => {
    // sameFieldsAs resolves at the copy's own migration, so a database built from the migrations in order and the spec agree: Rough Milling
    // moved to the workbook in 1140, Bulk Milling (the stock around the part, which no workbook sheet times) did not (user decision 2026-11-25).
    const bulk = loadMachiningCalculatorSpec().calculators.find((c) => c.name === 'Machining - Bulk Milling')!;
    expect(bulk.fields.map((f) => f.name)).toEqual(['Removed Volume', 'Material Removal Rate', 'Roughing Share', 'Finishing Rate Factor', 'Cycle Time']);
    expect(readFileSync(join(ROOT, 'migrations/1031_machining_mill_operation_calculators.sql'), 'utf-8')).toBe(buildMachiningCalculatorMigrationSql(1031, spec));
  });

  it('the named milling operations follow the workbook (1140); Bulk Milling keeps the Rough Milling fields 1031 shipped it with', () => {
    expect(readFileSync(join(ROOT, 'migrations/1140_machining_milling_named_ops_workbook.sql'), 'utf-8')).toBe(buildMachiningCalculatorMigrationSql(1140, spec));
    // Rough Milling is now the End Milling sheet; Bulk Milling (the stock around the part) is still the removed volume at the removal rate.
    expect(calcs['Bulk Milling']?.fields.map((f) => f.field_name)).toEqual(['Removed Volume', 'Material Removal Rate', 'Roughing Share', 'Finishing Rate Factor', 'Cycle Time']);
    expect(calcs['Rough Milling']?.fields.map((f) => f.field_name)).toContain('Width Passes');
  });

  it('Facing reproduces the workbook\'s Face Milling sheet, in whole passes: 4 x 5 passes, 21.99 min (the sheet: 3.62 x 5, 19.91 min)', () => {
    // D 60, 6 teeth, 40 m/min, 0.1 mm/tooth, 240 x 100 face, 10 mm deep at 2 mm a pass: n = 212.21 rpm; width passes ceil((240 - 30) / 58) =
    // 4, depth passes 5; (100 + 10 + 30) / (0.1 x 6 x 212.21) x 4 x 5 = 21.9911 min -> 1320 s.
    const run = sheet('Facing', {
      'Face Length': 100, 'Face Width': 240, 'Stock Depth': 10, 'Faces': 1, 'Cutter Diameter': 60, 'Teeth': 6,
      'Speed Min': 40, 'Speed Max': 40, 'Feed per Tooth Min': 0.1, 'Feed per Tooth Max': 0.1, 'Depth of Cut': 2,
    });
    expect([run.value('Width Passes'), run.value('Depth Passes')]).toEqual([4, 5]);
    expect(run.value('Machining Time')).toBeCloseTo(21.9911, 4);
    expect(run.sec).toBe(1320);
  });

  it('Rough Milling reproduces the workbook\'s End Milling sheet, in whole passes: 32.99 min (the sheet: 29.87 min on 3.62 width passes)', () => {
    // D 60, 4 teeth, 40 m/min, 0.1 mm/tooth, 240 x 100 x 10 at 2 mm a pass: the sheet's stepover D - 2 = 58; 4 x 5 passes;
    // (100 + 10 + 30) / (0.1 x 4 x 212.21) x 20 = 32.9867 min -> 1980 s.
    const run = sheet('Rough Milling', {
      'Cut Length': 100, 'Cut Width': 240, 'Cut Depth': 10, 'Cuts': 1, 'Cutter Diameter': 60, 'Teeth': 4,
      'Speed Min': 40, 'Speed Max': 40, 'Feed per Tooth Min': 0.1, 'Feed per Tooth Max': 0.1, 'Depth of Cut': 2, 'Tool Price': 1337.5, 'Tool Life': 1000,
    });
    expect([run.value('Stepover'), run.value('Width Passes'), run.value('Depth Passes')]).toEqual([58, 4, 5]);
    expect(run.value('Machining Time')).toBeCloseTo(32.9867, 4);
    expect(run.sec).toBe(1980);
    expect(run.value('Tool Cost per Part')).toBeCloseTo(1.3375, 4);
  });

  it('the End Milling stepover is never less than half the cutter: a 3 mm cutter steps 1.5 mm, not D - 2 = 1 mm', () => {
    const run = sheet('Rough Milling', {
      'Cut Length': 20, 'Cut Width': 10, 'Cut Depth': 2, 'Cuts': 1, 'Cutter Diameter': 3, 'Teeth': 2,
      'Speed Min': 100, 'Speed Max': 100, 'Feed per Tooth Min': 0.05, 'Feed per Tooth Max': 0.05, 'Depth of Cut': 2, 'Tool Price': 1337.5, 'Tool Life': 1000,
    });
    // ceil((10 - 1.5) / 1.5) = 6 width passes.
    expect([run.value('Stepover'), run.value('Width Passes')]).toEqual([1.5, 6]);
  });

  it('Slot Milling reproduces the workbook\'s Slot Milling sheet: 0.35814 min, 22 s (the sheet: 0.35828 min, 22 s)', () => {
    // 16 x 12 x 6.5 with a 12 mm 4-tooth cutter, 50 m/min, 0.02 mm/tooth, the whole depth in one pass (the sheet cuts 6.5 mm a pass: any
    // ratio from 6.5 / 12 up does); n = 1326.29 rpm; (16 + 10 + 12) / (0.02 x 4 x 1326.29) = 0.35814 min = 21.49 s -> 22 s.
    const run = sheet('Slot Milling', {
      'Slot Length': 16, 'Slot Width': 12, 'Slot Depth': 6.5, 'Slots': 1, 'Cutter Diameter': 12, 'Teeth': 4,
      'Speed Min': 50, 'Speed Max': 50, 'Feed per Tooth Min': 0.02, 'Feed per Tooth Max': 0.02, 'Slotting Depth Ratio': 0.55, 'Tool Price': 1337.5, 'Tool Life': 1000,
    });
    expect([run.value('Depth Passes'), run.value('Width Passes')]).toEqual([1, 1]);
    expect(run.value('Machining Time')).toBeCloseTo(0.3581, 4);
    expect(run.sec).toBe(22);
  });

  it('Plunge Milling, corrected: plunges half a cutter apart along the slot (the sheet copies Slot Milling on 3.7 x 3.142 x 10 mm)', () => {
    // The sheet's 116.254 mm x 10 x 5 deep, a 10 mm 4-tooth cutter, 50 m/min, 0.05 mm/tooth: ceil(116.254 / 5) = 24 plunges, each
    // (5 + 10) / (0.05 x 4 x 1591.55) = 0.047124 min; 1.13097 min = 67.86 s -> 68 s. (The sheet: 129 s, the slot formula over 5 passes.)
    const run = sheet('Plunge Milling', {
      'Slot Length': 116.254, 'Slot Width': 10, 'Slot Depth': 5, 'Slots': 1, 'Cutter Diameter': 10, 'Teeth': 4,
      'Speed Min': 50, 'Speed Max': 50, 'Feed per Tooth Min': 0.05, 'Feed per Tooth Max': 0.05, 'Tool Price': 1337.5, 'Tool Life': 1000,
    });
    expect([run.value('Plunges'), run.value('Width Passes')]).toEqual([24, 1]);
    expect(run.value('Machining Time')).toBeCloseTo(1.131, 3);
    expect(run.sec).toBe(68);
  });

  it('hole making follows the workbook (1139); Drill Press copies the 1139 Drilling, and what 804 and 1030 shipped is kept', () => {
    expect(readFileSync(join(ROOT, 'migrations/1139_machining_hole_making_workbook.sql'), 'utf-8')).toBe(buildMachiningCalculatorMigrationSql(1139, spec));
    expect(calcs['Drill Press']?.fields).toEqual(calcs['Drilling']?.fields);
    expect(calcs['ID Turning']?.name).toBe('Machining - Internal Boring');
    expect(calcs['Boring']?.fields).toEqual(calcs['ID Turning']?.fields);
  });

  it('Drilling reproduces the workbook\'s Drilling sheet: 48 s a hole, 192 s for its 4 uses, the drill\'s Rs 1.0413 a part', () => {
    // Ø6.5 x 95 mm, 18 m/min, 0.15 mm/rev: n = 881.47 rpm; (95 + 10) / (0.15 x 881.47) = 0.7941 min = 47.65 s -> 48 s (the sheet: 48, 192).
    const run = sheet('Drilling', { 'Hole Diameter': 6.5, 'Hole Depth': 95, 'Holes': 4, 'Speed Min': 18, 'Speed Max': 18, 'Feed': 0.15, 'Tool Price': 624.8, 'Tool Life': 600 });
    expect(run.value('Time per Hole')).toBe(48);
    expect(run.sec).toBe(192);
    expect(run.value('Tool Cost per Part')).toBeCloseTo(1.0413, 4);
  });

  it('Step Drilling reproduces the workbook\'s Step Drilling sheet: 16 s a step, 64 s for its 4 uses', () => {
    // Ø3 x 6 mm, 6 m/min, 0.1 mm/rev: n = 636.62 rpm; (6 + 10) / (0.1 x 636.62) = 0.2513 min = 15.08 s -> 16 s (the sheet: 16, 64).
    const run = sheet('Step Drilling', { 'Step Diameter': 3, 'Step Depth': 6, 'Holes': 4, 'Speed Min': 6, 'Speed Max': 6, 'Feed': 0.1, 'Tool Price': 113.27, 'Tool Life': 1000 });
    expect(run.sec).toBe(64);
  });

  it('Reaming reproduces the workbook\'s Reaming sheet: the depth + 4 mm + the point length (D / 2) x 0.577', () => {
    // Ø25 x 60 mm, 45 m/min, 0.25 mm/rev: point 7.2125 mm; n = 572.96 rpm; (60 + 4 + 7.2125) / (0.25 x 572.96) = 0.4972 min (the sheet:
    // 0.4973) = 29.83 s -> 30 s.
    const run = sheet('Reaming', { 'Hole Diameter': 25, 'Hole Depth': 60, 'Holes': 1, 'Speed Min': 45, 'Speed Max': 45, 'Feed': 0.25 });
    expect(run.value('Point Length')).toBeCloseTo(7.2125, 4);
    expect(run.sec).toBe(30);
  });

  it('Internal Boring reproduces the workbook\'s Internal Boring sheet: 2 passes, 200 s, the boring bar\'s Rs 0.79284 a part', () => {
    // Ø30 to Ø32, 102 mm, 30 m/min, 0.2 mm/rev, 0.5 mm a pass: ceil(2 / 1) = 2 passes; n = 318.31 rpm at Ø30;
    // (102 + 4) / (0.2 x 318.31) x 2 = 3.330 min = 199.81 s -> 200 s (the sheet: 200).
    const run = sheet('ID Turning', {
      'Initial Diameter': 30, 'Final Diameter': 32, 'Bore Length': 102, 'Bores': 1, 'Speed Min': 30, 'Speed Max': 30, 'Feed Min': 0.2, 'Feed Max': 0.2,
      'Tool Price': 1585.68, 'Tool Life': 2000,
    });
    expect(run.value('Passes')).toBe(2);
    expect(run.sec).toBe(200);
    expect(run.value('Tool Cost per Part')).toBeCloseTo(0.7928, 4);
  });

  it('Tapping, corrected: the feed is the pitch and the tap goes in and back out (the sheet feeds 0.25 mm/rev, one way)', () => {
    // M25 x 1.5, 60 mm deep, 44 m/min: n = 560.22 rpm; 2 x (60 + 4) / (1.5 x 560.22) = 0.1523 min = 9.14 s -> 10 s.
    // (The sheet: (60 + 4) / (0.25 x 560.22) = 0.457 min, a drilling cut.)
    const run = sheet('Tapping', { 'Thread Diameter': 25, 'Thread Depth': 60, 'Thread Pitch': 1.5, 'Threads': 1, 'Speed Min': 44, 'Speed Max': 44 });
    expect(run.sec).toBe(10);
  });

  it('the milling calculator prices the line of every mill station, and of the live-tool turning machines', () => {
    expect(['3 Axis Mill', '4 Axis Mill', '5 Axis Mill', 'MillTurn', '3 Axis Lathe'].map((station) => calcs[station]?.name)).toEqual(Array(5).fill('Machining - Milling'));
  });

  it.each(spec.calculators.map((c) => [c.name, c] as const))('%s: every formula references only its own fields, and it outputs Cycle Time', (_name, c) => {
    const names = new Set(c.fields.map((f) => f.name));
    expect(names.has(CYCLE_TIME_FIELD)).toBe(true);
    for (const f of c.fields.filter((x) => x.formula)) {
      const refs = [...f.formula!.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!);
      expect(refs.filter((r) => !names.has(r))).toEqual([]);
    }
  });

  it.each(spec.calculators.map((c) => [c.name, c] as const))('%s: evaluates to a finite cycle time from its inputs', (_name, c) => {
    const seeds: Record<string, CalcSeed> = Object.fromEntries(
      c.fields.filter((f) => !f.formula && f.source !== 'default').map((f) => [f.name, { value: 2, source: 'test' }]),
    );
    // A station calculator is keyed by each station it prices ("3 Axis Mill", ...).
    const operation = c.operation === STATION_OPERATION ? spec.stations[c.machineClasses[0]!]! : c.operation;
    const run = runMachiningCalculator(calcs, operation, seeds);
    expect(run.missing).toEqual([]);
    expect(Number.isFinite(run.sec)).toBe(true);
    expect(run.sec).toBeGreaterThanOrEqual(0);
  });

  it('every operation the engine evaluates has a calculator in the spec', () => {
    const engine = readFileSync(join(ROOT, 'src/modules/bom-items/costing/machining/process/cost-machining-engine.ts'), 'utf-8');
    const called = new Set([...engine.matchAll(/runMachiningCalculator\([^,]+,\s*'([^']+)'/g)].map((m) => m[1]!));
    // Deep-hole lines pass their process name through a variable.
    called.add('Gun Drilling'); called.add('Deep Bore Machine');
    const specified = new Set(spec.calculators.map((c) => c.operation));
    expect([...called].filter((op) => !specified.has(op))).toEqual([]);
  });

  it('a missing calculator is a named gap, not a number', () => {
    const run = runMachiningCalculator({}, 'Drilling', {});
    expect(run.sec).toBeNull();
    expect(run.missing[0]).toContain('none mapped');
  });
});
