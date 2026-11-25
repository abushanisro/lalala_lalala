import { describe, expect, it } from 'vitest';

import type { SourceRef } from '@/lib/calculators/input-source';
import { allReadFrom, isCleared, isEntry, machineFieldsOf, readFromAnotherMachine, runsOnLiveTool } from '@/lib/calculators/machine-inputs';

// The engine's run of Tapping on the cannula end bearing housing: its spindle cap read from the mill it ran on.
const spindle = (machineId: string, column = 'specs.spindle_speed_rpm'): SourceRef =>
  ({ kind: 'machine', machineId, machineName: 'Virtual 3 Axis Mill w Rotary Table - Small', machineClass: '4_axis_mill', location: 'USA', column });
const refs: Record<string, SourceRef> = {
  'Max Spindle Speed': spindle('mhr-small'),
  'Speed Min': { kind: 'lookup', domain: 'machining', table: 'tblHssHoleSpeeds', column: 'SpeedMinMPerMin', row: { WorkGroup: 'Mild steels' } },
};

describe('a machining calculator\'s machine inputs (Max Spindle Speed)', () => {
  it('are the inputs the engine read from its machine record', () => {
    expect([...machineFieldsOf(refs)]).toEqual(['Max Spindle Speed']);
    expect(machineFieldsOf(undefined).size).toBe(0);
  });

  it('read the live tool\'s top speed only where the engine ran on a lathe\'s live tool', () => {
    expect(runsOnLiveTool(refs)).toBe(false);
    expect(runsOnLiveTool({ 'Max Spindle Speed': spindle('mhr-lathe', 'specs.live_tooling_speed_rpm') })).toBe(true);
    expect(runsOnLiveTool(null)).toBe(false);
  });

  it('are read again when the machine chosen in the dialog is not the one the engine read them from', () => {
    expect(readFromAnotherMachine(refs, 'mhr-haas')).toBe(true);
    expect(readFromAnotherMachine(refs, 'mhr-small')).toBe(false);
    // No machine chosen yet: nothing to read them from.
    expect(readFromAnotherMachine(refs, undefined)).toBe(false);
  });

  it('are not read again for a machine they were all read from', () => {
    expect(allReadFrom([spindle('mhr-haas')], 'mhr-haas')).toBe(true);
    expect(allReadFrom([spindle('mhr-small')], 'mhr-haas')).toBe(false);
    // A value with no machine record (typed, or never read) is read again.
    expect(allReadFrom([undefined], 'mhr-haas')).toBe(false);
    expect(allReadFrom([], 'mhr-haas')).toBe(false);
  });
});

describe('leaving a machining input', () => {
  it('is no entry when its value is the one it was filled with: it keeps its source ("Machine: ..."), not "Entered in the calculator"', () => {
    expect(isEntry(false, 10000, 10000)).toBe(false);
    expect(isEntry(false, 10000, '10000')).toBe(false);
  });

  it('is an entry when the value changed, the field was entered before, or it was never filled', () => {
    expect(isEntry(false, 10000, 8000)).toBe(true);
    expect(isEntry(true, 10000, 10000)).toBe(true);
    expect(isEntry(false, undefined, 6)).toBe(true);
  });
});

describe('a cleared machining input', () => {
  it('is an emptied box (no value), never a 0 the calculator would divide by', () => {
    for (const v of ['', '  ', null, undefined]) expect(isCleared(v)).toBe(true);
    for (const v of [0, '0', 10000, 'x']) expect(isCleared(v)).toBe(false);
  });
});
