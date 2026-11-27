import { describe, expect, it } from 'vitest';

import type { FillMesh, FillRun, FillSimulationInputs } from '@/lib/api/fill-simulation';
import {
  contourColour, costedFillTimeS, countUpTo, EMPTY_SETUP, legendTicks, nodeColours, planArrows, position, requestOf, RESULTS, scaleOf, specOf, suggestionsOf, UNFILLED, valuesOf,
  withSuggestions,
} from '@/lib/flow-simulation/display';

/** A 40 x 20 mm strip of 8 x 4 squares, filled left to right in one second. */
function strip(): { mesh: FillMesh; run: FillRun } {
  const nodesMm: FillMesh['nodesMm'] = [];
  const triangles: FillMesh['triangles'] = [];
  for (let i = 0; i <= 8; i++) for (let j = 0; j <= 4; j++) nodesMm.push([i * 5, j * 5, 0]);
  const id = (i: number, j: number) => i * 5 + j;
  for (let i = 0; i < 8; i++) {
    for (let j = 0; j < 4; j++) {
      triangles.push([id(i, j), id(i + 1, j), id(i + 1, j + 1)], [id(i, j), id(i + 1, j + 1), id(i, j + 1)]);
    }
  }
  const fillTimeS = nodesMm.map(([x]) => x / 40);
  const mesh: FillMesh = { nodesMm, triangles, thicknessMm: nodesMm.map(() => 2), faceId: triangles.map(() => 0), centreMm: [0, 0, 0] };
  const run = {
    fillTimeS, pressureMpa: nodesMm.map(([x]) => 40 - x), frontSpeedMmS: nodesMm.map(() => 40), wallShearStressMpa: nodesMm.map(() => 0.1),
    wallShearRatePerS: nodesMm.map(() => 300), velocityMmS: triangles.map(() => [40, 0, 0]),
  } as unknown as FillRun;
  return { mesh, run };
}

describe('the contour colour scale', () => {
  it('runs blue, cyan, green, yellow, red, and clamps outside 0..1', () => {
    expect(contourColour(0)).toEqual([0, 0, 1]);
    expect(contourColour(0.25)).toEqual([0, 1, 1]);
    expect(contourColour(0.5)).toEqual([0, 1, 0]);
    expect(contourColour(0.75)).toEqual([1, 1, 0]);
    expect(contourColour(1)).toEqual([1, 0, 0]);
    expect(contourColour(-3)).toEqual([0, 0, 1]);
    expect(contourColour(9)).toEqual([1, 0, 0]);
    expect(contourColour(Number.NaN)).toEqual([0, 0, 1]);
  });

  it('takes its range from the values present, and caps a gate-peaked result at the 98th percentile', () => {
    const values = [...Array.from({ length: 99 }, (_, i) => i + 1), 5000, null];
    expect(scaleOf(values, false)).toEqual({ min: 1, max: 5000, top: 5000 });
    expect(scaleOf(values, true)).toEqual({ min: 1, max: 5000, top: 99 });
    expect(scaleOf([null, null], false)).toBeNull();
    expect(position(7, { min: 7, max: 7, top: 7 })).toBe(0.5); // a flat field is one colour, not a division by zero
  });

  it('labels the legend from the top colour down in even steps', () => {
    expect(legendTicks({ min: 0, max: 10, top: 10 }, 5)).toEqual([10, 8, 6, 4, 2, 0]);
  });
});

describe('the animation', () => {
  it('colours a node only once the melt has reached it, and shows everything before a run', () => {
    const { mesh, run } = strip();
    const values = valuesOf('pressure', mesh, run);
    const scale = scaleOf(values, false);
    const half = nodeColours(values, scale, run.fillTimeS, 0.5, new Float32Array(3 * values.length));
    const colourOf = (node: number) => Array.from(half.slice(3 * node, 3 * node + 3));
    expect(colourOf(0)).toEqual([1, 0, 0]); // the gate edge: highest pressure, red
    expect(colourOf(4 * 5)).toEqual([0, 1, 0]); // x = 20 mm: reached exactly at 0.5 s, mid pressure
    expect(colourOf(8 * 5).map((c) => Number(c.toFixed(2)))).toEqual(UNFILLED); // x = 40 mm: not yet
    const before = nodeColours(mesh.thicknessMm, scaleOf(mesh.thicknessMm, false), null, 0, new Float32Array(3 * values.length));
    expect(Array.from(before.slice(0, 3))).toEqual([0, 1, 0]); // a uniform wall: the middle colour everywhere
  });

  it('counts what has happened by a time with a binary search', () => {
    const times = [0.1, 0.2, 0.2, 0.7];
    expect([0, 0.1, 0.2, 0.5, 0.7, 9].map((t) => countUpTo(times, t))).toEqual([0, 1, 3, 3, 4, 4]);
  });
});

describe('direction arrows', () => {
  it('thins the mesh to about the number asked for, each arrow pointing the way the melt moved, in order of arrival', () => {
    const { mesh, run } = strip();
    const plan = planArrows(mesh, run, 8);
    expect(plan.arrows.length).toBeGreaterThanOrEqual(6);
    expect(plan.arrows.length).toBeLessThanOrEqual(16); // 64 triangles thinned to about 8
    expect(plan.arrows.every((a) => a.direction[0] === 1 && a.direction[1] === 0 && a.speed === 40)).toBe(true);
    expect(plan.arrows.map((a) => a.time)).toEqual([...plan.arrows.map((a) => a.time)].sort((a, b) => a - b));
    expect(plan.length).toBeLessThan(10); // shorter than the spacing: neighbours do not overlap
  });

  it('puts no arrow on a triangle the melt never closed', () => {
    const { mesh, run } = strip();
    run.fillTimeS[mesh.triangles[0]?.[0] ?? 0] = null;
    run.velocityMmS[1] = [0, 0, 0];
    const all = planArrows(mesh, run, 1000);
    expect(all.arrows.length).toBeLessThan(mesh.triangles.length);
  });
});

describe('results and setup', () => {
  it('offers the standard fill results, each with a unit, and only the wall thickness before a run', () => {
    expect(RESULTS.map((r) => r.kind)).toEqual(['fillTime', 'pressure', 'frontSpeed', 'shearStress', 'shearRate', 'thickness']);
    expect(RESULTS.every((r) => r.unit.length > 0 && r.note.length > 0)).toBe(true);
    expect(specOf('pressure').unit).toBe('MPa');
    const { mesh, run } = strip();
    expect(valuesOf('fillTime', mesh, null)).toBe(mesh.thicknessMm);
    expect(valuesOf('fillTime', mesh, run)).toBe(run.fillTimeS);
  });

  it('builds a Cross-WLF request only from a complete setup and says what is missing otherwise', () => {
    const blank = { ...EMPTY_SETUP, viscosity: 'crossWlf' as const };
    expect(requestOf(blank).missing).toEqual([
      'a gate (click the model)', 'fill time (0 to 600 s)', 'melt temperature (deg C)', 'n (above 0, at most 1)', 'tau* (above 0)', 'D1 (above 0)', 'D2 (above 0)',
      'A1 (above 0)', 'A2 (above 0)',
    ]);
    const full = { ...blank, gate: [1, 2, 3] as [number, number, number], fillTimeS: '1.2', meltTempC: '230', n: '0.3', tauPa: '25000', d1PaS: '1e12', d2K: '263.15', a1: '25', a2K: '51.6' };
    expect(requestOf(full)).toEqual({
      request: { gateMm: [1, 2, 3], fillTimeS: 1.2, meltTempC: 230, rheology: { n: 0.3, tauPa: 25000, d1PaS: 1e12, d2K: 263.15, a1: 25, a2K: 51.6 } },
      missing: [],
    });
    expect(requestOf({ ...full, pullAxis: 'z', maxInjectionPressureMpa: '120' }).request).toMatchObject({ pullAxis: 'z', maxInjectionPressureMpa: 120 });
    expect(requestOf({ ...full, n: '1.4' }).missing).toEqual(['n (above 0, at most 1)']);
    expect(requestOf({ ...full, meltTempC: '-20' }).missing).toEqual(['melt temperature (deg C)']);
    expect(requestOf({ ...full, d2K: '600' }).missing).toEqual(['a melt temperature above D2']);
    expect(requestOf({ ...full, maxInjectionPressureMpa: 'abc' }).missing).toEqual(['a pressure limit above 0, or none']);
  });

  it('by default asks only for what the estimate needs: a gate, a fill time, the flow length ratio and the pressure available', () => {
    expect(EMPTY_SETUP.viscosity).toBe('estimate');
    expect(requestOf(EMPTY_SETUP).missing).toEqual(['a gate (click the model)', 'fill time (0 to 600 s)', "the grade's flow length ratio", 'the injection pressure available (MPa)']);
    const filled = { ...EMPTY_SETUP, gate: [1, 2, 3] as [number, number, number], fillTimeS: '1.2', flowLengthRatio: '175', maxInjectionPressureMpa: '127.5' };
    expect(requestOf(filled)).toEqual({ request: { gateMm: [1, 2, 3], fillTimeS: 1.2, flowLengthRatio: 175, maxInjectionPressureMpa: 127.5 }, missing: [] });
    expect(requestOf({ ...filled, meltTempC: '240' }).request).toMatchObject({ meltTempC: 240 }); // recorded with the run when given
    expect(requestOf({ ...filled, n: '0.3' }).request).not.toHaveProperty('rheology'); // constants typed in the other mode are not sent
  });
});

describe('automatic setup', () => {
  const ABS: FillSimulationInputs = {
    materialGrade: 'ABS', referenceMaterial: 'ABS', meltTempC: 240, moldTempC: 70, injectionPressureMaxMpa: 150, flowLengthRatio: 175,
    availablePressureMpa: { cold: 127.5, hot: 105 }, notes: [],
  };

  it("reads the part's fill time from the cost engine's own calculation, and nothing when it has none", () => {
    const lines = [{ calculationTrace: [{ fieldName: 'Cooling Time', value: 9.1 }] }, { calculationTrace: [{ fieldName: 'Fill Time', value: 1.234567 }] }];
    expect(costedFillTimeS(lines)).toBe(1.234567);
    expect(costedFillTimeS([{ calculationTrace: [{ fieldName: 'Fill Time', value: 'n/a' }] }, {}])).toBeNull();
    expect(costedFillTimeS(undefined)).toBeNull();
  });

  it("suggests the grade's reference values and the pressure left after the part's own runner system, each with its source", () => {
    expect(suggestionsOf(ABS, { fillTimeS: 1.234567, runner: 'hot' })).toEqual({
      fillTimeS: { value: '1.235', source: "this part's costed fill time" },
      meltTempC: { value: '240', source: 'the ABS record' },
      maxInjectionPressureMpa: { value: '105', source: "the ABS record, less the hot runner's loss" },
      flowLengthRatio: { value: '175', source: 'the ABS record' },
    });
    expect(suggestionsOf(ABS, { fillTimeS: null, runner: null }).maxInjectionPressureMpa?.value).toBe('127.5'); // runner not known: the cold runner's
  });

  it('suggests nothing the data does not hold', () => {
    const bare: FillSimulationInputs = { ...ABS, referenceMaterial: null, meltTempC: null, injectionPressureMaxMpa: null, flowLengthRatio: null, availablePressureMpa: { cold: null, hot: null } };
    expect(suggestionsOf(bare, { fillTimeS: null, runner: null })).toEqual({});
    expect(suggestionsOf(undefined, { fillTimeS: 2, runner: null })).toEqual({ fillTimeS: { value: '2', source: "this part's costed fill time" } });
    const noModel: FillSimulationInputs = { ...ABS, availablePressureMpa: { cold: null, hot: null } };
    expect(suggestionsOf(noModel, { fillTimeS: null, runner: 'cold' }).maxInjectionPressureMpa).toEqual({ value: '150', source: 'the ABS record (maximum injection pressure)' });
  });

  it('fills the empty fields and never replaces what the engineer typed', () => {
    const suggestions = suggestionsOf(ABS, { fillTimeS: 1.2, runner: 'cold' });
    const fresh = withSuggestions(EMPTY_SETUP, suggestions);
    expect(fresh).toMatchObject({ fillTimeS: '1.2', meltTempC: '240', maxInjectionPressureMpa: '127.5', flowLengthRatio: '175', viscosity: 'estimate' });
    expect(requestOf({ ...fresh, gate: [0, 0, 0] }).missing).toEqual([]); // one click on the part and it can run
    const own = withSuggestions({ ...EMPTY_SETUP, fillTimeS: '0.8', meltTempC: '225' }, suggestions);
    expect(own).toMatchObject({ fillTimeS: '0.8', meltTempC: '225', flowLengthRatio: '175' });
  });
});
