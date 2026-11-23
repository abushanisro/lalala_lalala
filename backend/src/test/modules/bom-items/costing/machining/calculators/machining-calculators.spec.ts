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
      ['Time Per Analysis', 'Inspection Sample Ratio', 'Final Inspection Time', 'Cycle Time'],
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

  it('turning is timed as the workbook\'s Turning sheet times a cut, shipped in 1128; the entries 804 and 1030 shipped are kept', () => {
    const committed = readFileSync(join(ROOT, 'migrations/1128_machining_turning_follows_the_workbook.sql'), 'utf-8');
    expect(committed).toBe(buildMachiningCalculatorMigrationSql(1128, spec));
    for (const name of ['Rough Turning', 'Finish Turning', 'Stock Prep Lathe']) expect(committed).toContain(`-- Machining - ${name}`);
    // 804 still ships the formulas it was applied with; the engine sees only the current entries.
    expect(buildMachiningCalculatorsMigrationSql()).toContain('round({Rough Stock} / {Rough Depth of Cut})');
    expect(calcs['Rough Turning']!.fields.map((f) => f.field_name)).toEqual([
      'Turned Diameter', 'Turned Length', 'Bar Diameter', 'Finish Depth of Cut', 'Rough Depth of Cut', 'Rough Cutting Speed', 'Rough Feed',
      'Approach Length', 'Finish Start Diameter', 'Rough Passes', 'Spindle Speed', 'Feed Rate', 'Time per Pass', CYCLE_TIME_FIELD,
    ]);
    // The lathe's stock preparation is the same cut: it copies the current Rough Turning.
    expect(calcs['Stock Prep Lathe']!.fields).toEqual(calcs['Rough Turning']!.fields);
  });

  it('Rough Turning reproduces the three worked rows of the workbook\'s Turning sheet', () => {
    // Machining - Calculator Database, Turning sheet: n = 1000 v / (pi D1), np = (D1 - D2) / (2 t), Tc = pi D1 (L + 10) / (1000 v s) x np.
    // A row is one cut from D1 to D2, so no finish allowance is left (Finish Depth of Cut 0). The sheet writes pi as 3.14 and 3.1428: its
    // own figures (382.17 rpm, 2.75 min; 727.93 rpm, 16.24 min; 318.47 rpm, 17.29 min) are met to that precision.
    const row = (d1: number, d2: number, length: number, v: number, s: number, t: number) => {
      const seeds: Record<string, CalcSeed> = Object.fromEntries(Object.entries({
        'Bar Diameter': d1, 'Turned Diameter': d2, 'Turned Length': length, 'Rough Cutting Speed': v, 'Rough Feed': s, 'Rough Depth of Cut': t, 'Finish Depth of Cut': 0,
      }).map(([name, value]) => [name, { value, source: 'Turning sheet' }]));
      const run = runMachiningCalculator(calcs, 'Rough Turning', seeds);
      const value = (field: string) => run.trace.find((step) => step.fieldName === field)!.value as number;
      return { rpm: value('Spindle Speed'), passes: value('Rough Passes'), min: run.sec! / 60, missing: run.missing };
    };
    const first = row(100, 96, 200, 120, 0.2, 2);
    expect(first.missing).toEqual([]);
    expect(first.passes).toBe(1);
    expect(first.rpm).toBeCloseTo(382.17, 0);
    expect(first.min).toBeCloseTo(2.75, 2);
    const second = row(70, 25, 200, 160, 0.2, 2);
    expect(second.passes).toBe(11.25);
    expect(second.rpm).toBeCloseTo(727.93, 0);
    expect(second.min).toBeCloseTo(16.24, 1);
    const third = row(80, 40, 100, 80, 0.2, 2);
    expect(third.passes).toBe(10);
    expect(third.rpm).toBeCloseTo(318.47, 0);
    expect(third.min).toBeCloseTo(17.29, 1);
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
