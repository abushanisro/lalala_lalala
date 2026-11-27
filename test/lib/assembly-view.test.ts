import { describe, expect, it } from 'vitest';

import { ASSEMBLY_SCENARIO_KEYS, isAssemblyItem, jointMeasures, jointVocabulary, withDerivedEnabled, type JointField, type JointRow } from '@/lib/costing/assembly-view';
import { missingMeasures, newRowId, prunedRow, tableOf, tablePatch, withRow, withoutRow } from '@/lib/costing/joint-table';
import { assemblyRouteKeyOf } from '@/lib/routing/assembly-route-id';

const screw = { id: 'screw:housing:hole-1', process: 'Mechanical Assembly', operation: 'Screw Tighten - Manual', count: 4 };
/** What the fastening time table holds today: the three verified operations, and none for the rest. */
const TIMES = [
  { operation: 'Screw Tighten - Manual', timeS: 9.8 }, { operation: 'Screw Tighten - Power', timeS: null }, { operation: 'Snap Fit', timeS: 6.95 },
  { operation: 'Press Fit', timeS: null }, { operation: 'Rivet', timeS: null }, { operation: 'Nut Insert', timeS: 9.13 }, { operation: 'Tab Bend', timeS: null },
  { operation: 'User-Defined Operation', timeS: null },
];
const joints = jointVocabulary(TIMES);
const mechanical = (operation: string, more: Partial<JointRow> = {}): JointRow => ({ id: 'j', process: 'Mechanical Assembly', operation, count: 2, ...more });

describe('the assembly Cost Guide', () => {
  it('reads the joint table set in the Cost Guide, and nothing else as a row', () => {
    expect(tableOf<JointField>(ASSEMBLY_SCENARIO_KEYS.joints, { assemblyJoints: [{ id: 'joint-1', process: 'MIG Welding' }, { process: 'no id' }, 'text'] })).toEqual([{ id: 'joint-1', process: 'MIG Welding' }]);
    expect(tableOf(ASSEMBLY_SCENARIO_KEYS.joints, undefined)).toEqual([]);
  });

  it('adds a joint, replaces it by its id, removes it; an empty table clears the key', () => {
    const weld: JointRow = { id: 'joint-1', process: 'MIG Welding', count: 1, lengthMm: 300, throatMm: 4 };
    const t = withRow([], weld);
    expect(withRow(t, { ...weld, lengthMm: 200 })).toEqual([{ ...weld, lengthMm: 200 }]);
    expect(withoutRow(t, 'joint-1')).toEqual([]);
    expect(tablePatch(ASSEMBLY_SCENARIO_KEYS.joints, [])).toEqual({ assemblyJoints: null });
    expect(newRowId(t, 'joint')).toBe('joint-2');
  });

  it('switches a derived screw off and back on; back on keeps an edit, and drops a row that only switched it off', () => {
    const off = withDerivedEnabled([], screw, false);
    expect(off).toEqual([{ ...screw, enabled: false }]);
    expect(withDerivedEnabled(off, screw, true)).toEqual([]);
    const edited = withDerivedEnabled([{ ...screw, operation: 'Screw Tighten - Power', timeS: 6 }], screw, false);
    expect(withDerivedEnabled(edited, screw, true)).toEqual([{ ...screw, operation: 'Screw Tighten - Power', timeS: 6 }]);
  });

  it('names the measures a joint still needs for its process', () => {
    expect(missingMeasures(joints, { id: 'j', process: 'MIG Welding', count: 1, lengthMm: 300 })).toEqual(['throatMm']);
    expect(missingMeasures(joints, { id: 'j', process: 'Rivet', count: 8 })).toEqual(['timeS']);
    expect(missingMeasures(joints, { id: 'j', process: 'Cap Sealing', count: 6 })).toEqual([]);
  });

  it('offers a press fit, each other fastening and each weld as its own joint type', () => {
    const labels = joints.kinds.map((k) => k.label);
    for (const label of ['Press fit', 'Snap fit', 'Nut insert', 'Tab bend', 'Screw, power driven', 'Rivet, at the assembly bench', 'MIG weld', 'TIG weld', 'Spot welds', 'Laser weld', 'Electron beam weld', 'Ultrasonic stake']) {
      expect(labels).toContain(label);
    }
    expect(new Set(joints.kinds.map((k) => k.key)).size).toBe(joints.kinds.length);
  });

  it('a joint type is its process and operation: picking Press fit stores both, and the row reads back as that type', () => {
    const pressFit = joints.kinds.find((k) => k.label === 'Press fit');
    const row = joints.rekind({ id: 'joint-1', process: 'MIG Welding', label: 'Bush into housing', count: 3, lengthMm: 200, throatMm: 4 }, pressFit?.key ?? '');
    expect(row).toEqual({ id: 'joint-1', process: 'Mechanical Assembly', operation: 'Press Fit', label: 'Bush into housing', count: 3 });
    expect(joints.kindOf?.(row)).toBe(pressFit?.key);
    // Saved, the row keeps its operation (the engine reads it) and drops a measure the type does not take.
    expect(prunedRow(joints, { ...row, timeS: 12, lengthMm: 200 })).toEqual({ ...row, timeS: 12 });
    expect(joints.kindOf?.({ id: 'u', process: 'Ultrasonic Welding', operation: 'stake', count: 1 })).toBe('Ultrasonic Welding: stake');
  });

  it('a mechanical row with no operation, or one the engine does not know, is the type the engine costs it as', () => {
    expect(joints.kindOf?.({ id: 'j', process: 'Mechanical Assembly', count: 1 })).toBe('Mechanical Assembly: Screw Tighten - Manual');
    expect(joints.kindOf?.(mechanical('glued'))).toBe('Mechanical Assembly: Screw Tighten - Manual');
    expect(joints.kindOf?.({ id: 'u', process: 'Ultrasonic Welding', count: 1 })).toBe('Ultrasonic Welding: weld');
  });

  it('asks for the time of a fastening the table has none for, so a press fit cannot be saved uncosted', () => {
    expect(missingMeasures(joints, mechanical('Press Fit'))).toEqual(['timeS']);
    expect(missingMeasures(joints, mechanical('Press Fit', { timeS: 12 }))).toEqual([]);
    for (const operation of ['Screw Tighten - Power', 'Rivet', 'Tab Bend', 'User-Defined Operation']) expect(missingMeasures(joints, mechanical(operation))).toEqual(['timeS']);
    expect(joints.optional(mechanical('Press Fit'))).not.toContain('timeS');
  });

  it('a fastening the table times needs none, shows the table\'s time, and can still take the engineer\'s own', () => {
    expect(missingMeasures(joints, mechanical('Snap Fit'))).toEqual([]);
    expect(joints.optional(mechanical('Snap Fit'))).toContain('timeS');
    expect(joints.placeholder?.('timeS', mechanical('Snap Fit'))).toBe('6.95, the fastening time table\'s');
    expect(joints.placeholder?.('timeS', mechanical('Press Fit'))).toBeUndefined();
  });

  it('a plant that stages a press fit time no longer has to enter one', () => {
    const staged = jointVocabulary(TIMES.map((t) => (t.operation === 'Press Fit' ? { ...t, timeS: 7 } : t)));
    expect(missingMeasures(staged, mechanical('Press Fit'))).toEqual([]);
    expect(staged.placeholder?.('timeS', mechanical('Press Fit'))).toBe('7, the fastening time table\'s');
  });

  it('with no table times to go by (an older summary), only the engineer\'s own operation needs a time', () => {
    const untold = jointVocabulary();
    expect(missingMeasures(untold, mechanical('Press Fit'))).toEqual([]);
    expect(missingMeasures(untold, mechanical('User-Defined Operation'))).toEqual(['timeS']);
  });

  it('a joint found in a threaded hole stays a mechanical fastening: only those types are offered for it', () => {
    const derived = jointVocabulary(TIMES, true);
    expect(derived.kinds.every((k) => k.process === 'Mechanical Assembly')).toBe(true);
    expect(derived.kinds.map((k) => k.label)).toContain('Screw, power driven');
  });

  it('says a joint\'s measures in one line', () => {
    expect(jointMeasures({ count: 2, lengthMm: 300, throatMm: 4, depthMm: null, areaMm2: null, weldMaterial: 'Steel', gas: null, position: null, timeS: null })).toBe('2 x 300 mm, 4 mm throat, Steel');
  });

  it('an item is costed as an assembly by its Process, or as an assembly in the BOM with no Process', () => {
    expect(isAssemblyItem({ itemType: 'child_part', scenarioOverrides: { processGroup: 'Assembly' } })).toBe(true);
    expect(isAssemblyItem({ itemType: 'assembly', scenarioOverrides: {} })).toBe(true);
    expect(isAssemblyItem({ itemType: 'assembly', scenarioOverrides: { processGroup: 'Part Assembly' } })).toBe(false);
    expect(isAssemblyItem({ itemType: 'child_part' })).toBe(false);
  });

  it('reads an assembly route id as its route key, any other route as none', () => {
    expect(assemblyRouteKeyOf('assembly-robotic')).toBe('robotic');
    expect(assemblyRouteKeyOf('additive-printing')).toBeUndefined();
  });
});
