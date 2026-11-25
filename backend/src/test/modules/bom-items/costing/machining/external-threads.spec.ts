// A turned part's external threads and knurls from its drawing's callouts and its turned diameters (external-threads.ts): which callout is
// turned on which Ring, and where each of its values comes from. The two values the drawing and the CAD may not give are the project
// owner's decisions of 2026-11-25, stated as assumptions: a knurl note naming no diameter knurls the largest turned diameter, and an
// external thread with no Ring and no length is threaded for 1.5 x its nominal diameter.
import {
  KNURL_LARGEST_RING_ASSUMPTION, knurlsOnRings, nominalThreadDiameterMm, splitExternalThreads,
} from '../../../../../modules/bom-items/costing/machining/external-threads';

import type { DrawnThread, ThreadInput } from '../../../../../modules/bom-items/costing/machining/feature-holes';
import type { TurnedRing } from '../../../../../modules/bom-items/costing/machining/process/turned-diameters';

// A shaft: a Ø14 collar, an M12 journal (its major diameter turned to 11.97), a short Ø12 bearing seat and a Ø8 pin.
const COLLAR: TurnedRing = { id: 'od_0', diameterMm: 14, lengthMm: 8.145, faceIds: [9] };
const JOURNAL: TurnedRing = { id: 'od_1', diameterMm: 11.97, lengthMm: 18.329, faceIds: [17] };
const SEAT: TurnedRing = { id: 'od_2', diameterMm: 11.97, lengthMm: 5, faceIds: [24] };
const PIN: TurnedRing = { id: 'od_3', diameterMm: 8, lengthMm: 6, faceIds: [30] };
const RINGS = [COLLAR, JOURNAL, SEAT, PIN];
const NO_TAPPED: ThreadInput[] = [];
const thread = (size: string, over: Partial<DrawnThread> = {}): DrawnThread => ({ size, count: 1, ...over });

describe('nominalThreadDiameterMm', () => {
  it('reads a metric size, a UN fraction and a UN number size', () => {
    expect(nominalThreadDiameterMm('M12')).toBe(12);
    expect(nominalThreadDiameterMm('M2.5x0.45')).toBe(2.5);
    expect(nominalThreadDiameterMm('1/4-20')).toBe(6.35);
    // ASME B1.1: #8 is 0.060 + 0.013 x 8 = 0.164 in.
    expect(nominalThreadDiameterMm('#8-32')).toBe(4.166);
    expect(nominalThreadDiameterMm('G1/4')).toBeNull();
  });
});

describe('splitExternalThreads: a callout that states its kind', () => {
  it('an external class is turned on the Ring at its major diameter, on the Ring\'s length, at the written pitch', () => {
    const { external, internal } = splitExternalThreads([thread('M12', { pitchMm: 1.75, pitchStated: true, threadKind: 'external', toleranceClass: '6g' })], [COLLAR, JOURNAL, PIN], NO_TAPPED);
    expect(internal).toEqual([]);
    expect(external).toHaveLength(1);
    expect(external[0]).toMatchObject({
      size: 'M12', label: 'M12 // Ring Ø11.97 x 18.33 mm', diameterMm: 11.97, lengthMm: 18.329, pitchMm: 1.75, threads: 1, ring: JOURNAL, missing: [],
    });
    expect(external[0]!.diameterSource).toMatch(/^CAD: the turned diameter the thread is cut on \(Ring feature\); the drawing's M12 tolerance class 6g callout is an external thread$/);
    expect(external[0]!.lengthSource).toBe('CAD: length of the turned diameter the thread is cut on (Ring feature)');
    expect(external[0]!.pitchSource).toBe('Drawing: pitch of the M12 x 1.75 callout');
  });

  it('an internal class is tapped, whatever Ring is at its size', () => {
    const tapped = thread('M12', { threadKind: 'internal', toleranceClass: '6H' });
    expect(splitExternalThreads([tapped], RINGS, NO_TAPPED)).toEqual({ external: [], internal: [tapped] });
  });

  it('a stated length is the thread\'s length; a pitch the analyser defaulted is replaced by the ISO 261 coarse pitch', () => {
    const [t] = splitExternalThreads([thread('M12', { pitchMm: 1, pitchStated: false, threadKind: 'external', lengthMm: 15 })], RINGS, NO_TAPPED).external;
    expect(t).toMatchObject({ lengthMm: 15, lengthSource: 'Drawing: the M12 callout\'s stated thread length', pitchMm: 1.75 });
    expect(t!.pitchSource).toBe('ISO 261 coarse pitch of M12 (the M12 callout writes no pitch)');
  });

  it('when the callout counts fewer threads than there are Rings at its size, the longest is threaded', () => {
    const { external } = splitExternalThreads([thread('M12', { threadKind: 'external' })], [SEAT, JOURNAL], NO_TAPPED);
    expect(external.map((t) => t.ring)).toEqual([JOURNAL]);
    // Two counted: both, each its own run.
    const two = splitExternalThreads([thread('M12', { count: 2, threadKind: 'external' })], [SEAT, JOURNAL], NO_TAPPED).external;
    expect(two.map((t) => [t.ring, t.threads])).toEqual([[JOURNAL, 1], [SEAT, 1]]);
  });

  it('more threads counted than Rings at the size: the others are cut on the one Ring, and its source says so', () => {
    const [t] = splitExternalThreads([thread('M12', { count: 3, threadKind: 'external' })], [JOURNAL], NO_TAPPED).external;
    expect(t).toMatchObject({ ring: JOURNAL, threads: 3 });
    expect(t!.threadsSource).toMatch(/3 x M12, 1 turned diameter at its size in the CAD: the other 2 cut on this one's length/);
  });

  it('user decision: an external thread by its class with no Ring and no stated length is threaded for 1.5 x its nominal diameter, stated', () => {
    const [t] = splitExternalThreads([thread('M20', { pitchMm: 2.5, pitchStated: true, threadKind: 'external', toleranceClass: '6g' })], RINGS, NO_TAPPED).external;
    expect(t).toMatchObject({ label: 'M20', diameterMm: 20, lengthMm: 30, ring: null, missing: [] });
    expect(t!.lengthSource).toBe('Assumption: 1.5 x the 20 mm nominal diameter; the M20 callout states no length and the CAD has no turned diameter at its size');
    expect(t!.diameterSource).toMatch(/^Drawing: nominal diameter of M20; .* and the CAD has no turned diameter at its size$/);
  });

  it('a UN external thread: its pitch from its threads per inch', () => {
    const quarter: TurnedRing = { id: 'od_9', diameterMm: 6.33, lengthMm: 10, faceIds: [] };
    const [t] = splitExternalThreads([thread('1/4-20', { threadKind: 'external', toleranceClass: '2A' })], [quarter], NO_TAPPED).external;
    expect(t).toMatchObject({ ring: quarter, pitchMm: 1.27, lengthMm: 10 });
    expect(t!.pitchSource).toBe('Drawing: 1/4-20, 20 threads per inch (25.4 / 20 mm)');
  });

  it('an off-series size with no written pitch is turned with its pitch named as missing, never assumed', () => {
    const [t] = splitExternalThreads([thread('M13', { pitchMm: 1, pitchStated: false, threadKind: 'external', lengthMm: 10 })], [], NO_TAPPED).external;
    expect(t!.pitchMm).toBeNull();
    expect(t!.missing).toEqual(['the M13 thread\'s pitch (none written, and the size is off the ISO 261 coarse series)']);
  });
});

describe('splitExternalThreads: a callout that states no kind (every drawing analysed before the class was read)', () => {
  it('is external when the CAD taps no hole of its size, the drawing calls no internal one, and a Ring is at its major diameter', () => {
    const { external, internal } = splitExternalThreads([thread('M12', { pitchMm: 1.75 })], [COLLAR, JOURNAL], NO_TAPPED);
    expect(internal).toEqual([]);
    expect(external[0]).toMatchObject({ ring: JOURNAL, diameterMm: 11.97, lengthMm: 18.329 });
    expect(external[0]!.diameterSource).toMatch(/M12 callout states no class; the CAD has no M12 tapped hole, the drawing calls no internal M12, and the turned diameter is at its major diameter \(11\.475-12\.05 mm\)/);
  });

  it('stays tapped when the CAD tapped a hole of its size', () => {
    const drawn = thread('M12', { pitchMm: 1.75 });
    expect(splitExternalThreads([drawn], [JOURNAL], [{ size: 'M12×1.75', count: 2 }])).toEqual({ external: [], internal: [drawn] });
  });

  it('stays tapped when the drawing also calls an internal thread of its size', () => {
    const bare = thread('M12');
    const tapped = thread('M12x1.75', { threadKind: 'internal' });
    expect(splitExternalThreads([bare, tapped], [JOURNAL], NO_TAPPED)).toEqual({ external: [], internal: [bare, tapped] });
  });

  it('stays tapped when no Ring is at its major diameter (over the nominal, or more than the pitch window under it)', () => {
    const drawn = thread('M12', { pitchMm: 1.75 });
    const over: TurnedRing = { ...JOURNAL, diameterMm: 12.1 };
    const under: TurnedRing = { ...JOURNAL, diameterMm: 11.4 };
    expect(splitExternalThreads([drawn], [over, under, COLLAR], NO_TAPPED).internal).toEqual([drawn]);
    // The window's floor: M3 x 0.5 reaches max(0.15, 0.3 x 0.5) = 0.15 mm under its nominal, Ø2.85 and no lower.
    expect(splitExternalThreads([thread('M3', { pitchMm: 0.5 })], [{ ...PIN, diameterMm: 2.85 }], NO_TAPPED).external).toHaveLength(1);
    expect(splitExternalThreads([thread('M3', { pitchMm: 0.5 })], [{ ...PIN, diameterMm: 2.84 }], NO_TAPPED).external).toHaveLength(0);
  });

  it('a Ring threaded once is not threaded again by another callout', () => {
    const { external, internal } = splitExternalThreads([thread('M12', { threadKind: 'external' }), thread('M12x1.5')], [JOURNAL], NO_TAPPED);
    expect(external).toHaveLength(1);
    expect(internal.map((t) => t.size)).toEqual(['M12x1.5']);
  });
});

describe('knurlsOnRings', () => {
  it('a named diameter knurls the Ring within 0.2 mm of it, on the callout\'s length', () => {
    const [k] = knurlsOnRings([{ pattern: 'diamond', diameterMm: 14.1, lengthMm: 6, text: 'Ø14.1 DIAMOND KNURL 6 LG' }], RINGS);
    expect(k).toMatchObject({ label: 'Ring Ø14 x 8.15 mm', diameterMm: 14.1, lengthMm: 6, ring: COLLAR, missing: [] });
    expect(k!.diameterSource).toBe('Drawing: the diameter the knurl callout "Ø14.1 DIAMOND KNURL 6 LG" names');
    expect(k!.lengthSource).toBe('Drawing: the knurl callout "Ø14.1 DIAMOND KNURL 6 LG" states its length');
  });

  it('a note naming no diameter on a part with one turned diameter knurls it, on its length', () => {
    const [k] = knurlsOnRings([{ pattern: 'diamond', text: 'MEDIUM DIAMOND KNURL' }], [COLLAR]);
    expect(k).toMatchObject({ diameterMm: 14, lengthMm: 8.145, ring: COLLAR });
    expect(k!.diameterSource).toBe('CAD: the part\'s one turned diameter (Ring feature); the knurl callout "MEDIUM DIAMOND KNURL" names none');
    expect(k!.lengthSource).toBe('CAD: length of the turned diameter knurled (Ring feature)');
  });

  it('user decision: a note naming no diameter on a part with several knurls the largest, stated as an assumption', () => {
    const [k] = knurlsOnRings([{ text: 'STRAIGHT KNURL 30 TPI' }], RINGS);
    expect(k).toMatchObject({ diameterMm: 14, lengthMm: 8.145, ring: COLLAR, missing: [] });
    expect(k!.diameterSource.startsWith(KNURL_LARGEST_RING_ASSUMPTION)).toBe(true);
    expect(KNURL_LARGEST_RING_ASSUMPTION).toBe('Assumption: the largest turned diameter; the knurl note names none');
  });

  it('a named diameter no Ring is at: the drawing\'s diameter, and its length named as missing unless stated', () => {
    const [k] = knurlsOnRings([{ diameterMm: 30, text: 'Ø30 KNURL' }], RINGS);
    expect(k).toMatchObject({ label: 'Knurl Ø30', diameterMm: 30, lengthMm: null, ring: null });
    expect(k!.missing).toEqual(['the knurl\'s length (the knurl callout "Ø30 KNURL" states none and no turned diameter of the CAD is at its diameter)']);
  });

  it('no Ring and no named diameter: the diameter is a named gap, never a guess', () => {
    const [k] = knurlsOnRings([{ text: 'DIAMOND KNURL' }], []);
    expect(k).toMatchObject({ diameterMm: null, lengthMm: null, ring: null });
    expect(k!.missing[0]).toBe('the diameter knurled (the knurl callout "DIAMOND KNURL" names none and the CAD has no turned diameter)');
  });

  it('no knurl callout: no knurl', () => {
    expect(knurlsOnRings([], RINGS)).toEqual([]);
  });
});
