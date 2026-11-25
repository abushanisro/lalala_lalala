// The external threads and the knurls a lathe cuts on a turned part, from its drawing's callouts and its turned diameters (Rings). Pure.
//
// A drawing's thread callout is a tapped hole or a thread turned on a diameter. Until the analyser read a callout's tolerance class, every
// callout was tapped: an M12 x 1.75-6g on a Ø12 journal became a Tapping line at the tapping calculator's thread-engagement depth. Here:
//
//   the callout states its kind (its class: 6g / 2A external, 6H / 2B internal; or its words: EXTERNAL, TAPPED): that kind;
//   it states none (every callout analysed before the class was read): external only when ALL hold
//     - the CAD found no tapped hole of that size (a tapped hole is the CAD's word that the size is internal),
//     - the drawing calls no internal thread of that size,
//     - a turned diameter (Ring) of the part is at the thread's major diameter: nominal - max(0.15, 0.3 x pitch) <= D <= nominal + 0.05
//       (an external thread's major diameter is turned to its nominal or a little under it, never over);
//     otherwise it stays a tapped thread, as before.
//
// An external thread is turned on its Ring: the nearest diameter among those that match; when the callout counts fewer threads than there
// are such Rings, the longest of them. Its length is the callout's stated length, else its Ring's length; an external thread by its class
// with no Ring and no stated length is threaded for 1.5 x its nominal diameter (the project owner's decision of 2026-11-25), stated as an
// assumption. Its pitch is the callout's written pitch, else the ISO 261 coarse pitch of its size (a UN thread's is 25.4 / its threads per
// inch). A value none of these gives is the line's named gap.
//
// A knurl callout knurls the Ring at the diameter it names (within 0.2 mm), else the part's one Ring, else, with several, the largest (the
// project owner's decision of 2026-11-25), stated as an assumption. Its length is the callout's, else its Ring's. No Ring and no named
// diameter: the line's named gap.
import { isoCoarsePitchMm } from '../shared/core/default-rates.constants';
import { normalizeThreadSpecs, type DrawnThread, type ThreadInput } from './feature-holes';
import { ringLabel, type TurnedRing } from './process/turned-diameters';

/** One external thread turned on the part (a Thread Turning calculator run): each value with where it came from. */
export interface ExternalThread {
  /** The callout's size ("M12", "1/4-20"). */
  size: string;
  /** Names the run on its line: "M12 // Ring Ø12 x 18.33 mm", or the size alone when no Ring is threaded. */
  label: string;
  diameterMm: number;
  diameterSource: string;
  /** Null: no length is stated or measured (the line's gap). */
  lengthMm: number | null;
  lengthSource: string;
  /** Null: no pitch is written and the size is off the coarse series (the line's gap). */
  pitchMm: number | null;
  pitchSource: string;
  threads: number;
  threadsSource: string;
  /** The Ring the thread is turned on (its faces lit); null when the CAD has no turned diameter at the thread's size. */
  ring: TurnedRing | null;
  /** What the calculator lacks, named; empty when every input is known. */
  missing: string[];
}

/** One knurl rolled on the part (a Knurling calculator run). */
export interface KnurlOp {
  label: string;
  diameterMm: number | null;
  diameterSource: string;
  lengthMm: number | null;
  lengthSource: string;
  ring: TurnedRing | null;
  missing: string[];
}

/** A knurl callout as drawing_intelligence.knurls stores it (cad-engine drawing_analyzer._extract_knurls). */
export interface KnurlCallout {
  pattern?: string | null;
  grade?: string | null;
  pitchMm?: number | null;
  tpi?: number | null;
  diameterMm?: number | null;
  lengthMm?: number | null;
  text?: string | null;
}

/** The user decision for a knurl note that names no diameter on a part with several turned diameters (2026-11-25). */
export const KNURL_LARGEST_RING_ASSUMPTION = 'Assumption: the largest turned diameter; the knurl note names none';
/** An external thread with no Ring and no stated length is threaded for this many nominal diameters (user decision 2026-11-25). */
export const UNMEASURED_THREAD_LENGTH_D = 1.5;

const r2 = (n: number) => Math.round(n * 100) / 100;
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const INCH_MM = 25.4;

/** The size a thread callout is grouped by ("M12x1.75" -> "M12"), as tapping groups it (normalizeThreadSpecs). */
const sizeKey = (size: string) => normalizeThreadSpecs([{ size, count: 1 }])[0]?.size ?? size.trim().toUpperCase();

/**
 * A thread size's nominal (major) diameter in mm: a metric M size's number; a UN fraction's inches (1/4-20: 6.35 mm); a UN number size's
 * 0.060 + 0.013 x N inches (ASME B1.1: #8-32 is 0.164 in). Null for a size it cannot read.
 */
export function nominalThreadDiameterMm(size: string): number | null {
  const s = size.trim().toUpperCase();
  const metric = /^M\s*(\d+(?:\.\d+)?)/.exec(s);
  if (metric) return Number(metric[1]);
  const fraction = /^(\d{1,2})\/(\d{1,2})-\d{1,3}$/.exec(s);
  if (fraction && Number(fraction[2]) > 0) return r3((Number(fraction[1]) / Number(fraction[2])) * INCH_MM);
  const numbered = /^#(\d{1,2})-\d{1,3}$/.exec(s);
  if (numbered) return r3((0.06 + 0.013 * Number(numbered[1])) * INCH_MM);
  return null;
}

/** A callout's pitch and where it came from: written on the drawing, else a UN size's threads per inch, else the ISO 261 coarse pitch. */
function pitchOf(d: DrawnThread, nominalMm: number | null): { pitchMm: number | null; source: string } {
  if (d.pitchMm != null && d.pitchMm > 0 && d.pitchStated !== false) {
    return { pitchMm: d.pitchMm, source: `Drawing: pitch of the ${d.size} x ${d.pitchMm} callout` };
  }
  const tpi = /-(\d{1,3})$/.exec(d.size.trim());
  if (tpi && !/^M/i.test(d.size.trim()) && Number(tpi[1]) > 0) {
    return { pitchMm: r3(INCH_MM / Number(tpi[1])), source: `Drawing: ${d.size}, ${tpi[1]} threads per inch (25.4 / ${tpi[1]} mm)` };
  }
  const coarse = nominalMm != null && /^M/i.test(d.size.trim()) ? isoCoarsePitchMm(nominalMm) : null;
  return coarse != null
    ? { pitchMm: coarse, source: `ISO 261 coarse pitch of M${nominalMm} (the ${d.size} callout writes no pitch)` }
    : { pitchMm: null, source: '' };
}

/** The window a turned diameter must fall in to be a thread's major diameter: nominal - max(0.15, 0.3 x pitch) to nominal + 0.05. */
function majorDiameterWindow(nominalMm: number, pitchMm: number | null): { lo: number; hi: number } {
  return { lo: r3(nominalMm - Math.max(0.15, 0.3 * (pitchMm ?? 0))), hi: r3(nominalMm + 0.05) };
}

/**
 * The Rings a thread is turned on: those in its major-diameter window, nearest diameter first; within one diameter, the longest. `count`
 * of them, or all when it counts more.
 */
function ringsFor(rings: readonly TurnedRing[], nominalMm: number, window: { lo: number; hi: number }, count: number): TurnedRing[] {
  return rings
    .filter((r) => r.diameterMm >= window.lo && r.diameterMm <= window.hi)
    .sort((a, b) => r2(Math.abs(a.diameterMm - nominalMm)) - r2(Math.abs(b.diameterMm - nominalMm)) || b.lengthMm - a.lengthMm)
    .slice(0, Math.max(1, count));
}

const classWords = (d: DrawnThread) => (d.toleranceClass ? ` tolerance class ${d.toleranceClass}` : '');

/**
 * The drawing's thread callouts split into the external threads a lathe turns on the part's Rings and the internal ones it taps (left as
 * they are, for resolveThreads to merge with the CAD's tapped holes). `cadTapped` is the CAD's tapped holes (tappedHolesOfFeatures).
 */
export function splitExternalThreads(
  drawn: readonly DrawnThread[], rings: readonly TurnedRing[], cadTapped: readonly ThreadInput[],
): { external: ExternalThread[]; internal: DrawnThread[] } {
  const tappedSizes = new Set(normalizeThreadSpecs(cadTapped).map((t) => t.size));
  const drawnInternal = new Set(drawn.filter((d) => d.threadKind === 'internal').map((d) => sizeKey(d.size)));
  const external: ExternalThread[] = [];
  const internal: DrawnThread[] = [];
  const taken = new Set<TurnedRing>();
  for (const d of drawn) {
    if (d.threadKind === 'internal') { internal.push(d); continue; }
    const nominal = nominalThreadDiameterMm(d.size);
    if (nominal == null) { internal.push(d); continue; }
    const { pitchMm, source: pitchSource } = pitchOf(d, nominal);
    const window = majorDiameterWindow(nominal, pitchMm);
    const free = rings.filter((r) => !taken.has(r));
    const count = Math.max(1, d.count);
    const chosen = ringsFor(free, nominal, window, count);
    let why: string;
    if (d.threadKind === 'external') {
      why = `the drawing's ${d.size}${classWords(d)} callout is an external thread`;
    } else {
      const key = sizeKey(d.size);
      if (tappedSizes.has(key) || drawnInternal.has(key) || chosen.length === 0) { internal.push(d); continue; }
      why = `the ${d.size} callout states no class; the CAD has no ${key} tapped hole, the drawing calls no internal ${key}, and the turned `
        + `diameter is at its major diameter (${window.lo}-${window.hi} mm)`;
    }
    chosen.forEach((r) => taken.add(r));
    const extra = count - chosen.length;
    const ringRuns: Array<TurnedRing | null> = chosen.length > 0 ? chosen : [null];
    ringRuns.forEach((ring, i) => {
      const threads = i === 0 && ring != null ? 1 + Math.max(0, extra) : ring == null ? count : 1;
      const length = d.lengthMm != null && d.lengthMm > 0
        ? { lengthMm: d.lengthMm, lengthSource: `Drawing: the ${d.size} callout's stated thread length` }
        : ring != null
          ? ring.lengthMm > 0
            ? { lengthMm: ring.lengthMm, lengthSource: 'CAD: length of the turned diameter the thread is cut on (Ring feature)' }
            : { lengthMm: null, lengthSource: '' }
          : {
            lengthMm: r3(UNMEASURED_THREAD_LENGTH_D * nominal),
            lengthSource: `Assumption: ${UNMEASURED_THREAD_LENGTH_D} x the ${nominal} mm nominal diameter; the ${d.size} callout states no length and the CAD has no turned diameter at its size`,
          };
      const missing = [
        ...(length.lengthMm == null ? [`the ${d.size} thread's length (the callout states none and its turned diameter has no length in the CAD)`] : []),
        ...(pitchMm == null ? [`the ${d.size} thread's pitch (none written, and the size is off the ISO 261 coarse series)`] : []),
      ];
      external.push({
        size: d.size,
        label: ring ? `${d.size} // ${ringLabel(ring)}` : d.size,
        diameterMm: ring ? ring.diameterMm : nominal,
        diameterSource: ring
          ? `CAD: the turned diameter the thread is cut on (Ring feature); ${why}`
          : `Drawing: nominal diameter of ${d.size}; ${why}, and the CAD has no turned diameter at its size`,
        ...length,
        pitchMm,
        pitchSource,
        threads,
        threadsSource: ring == null
          ? `Drawing: ${count} x ${d.size}`
          : threads > 1
            ? `Drawing: ${count} x ${d.size}, ${chosen.length} turned diameter${chosen.length === 1 ? '' : 's'} at its size in the CAD: the other ${extra} cut on this one's length`
            : `Drawing: one ${d.size} thread on this turned diameter`,
        ring,
        missing,
      });
    });
  }
  return { external, internal };
}

/** The knurl callouts on the part's Rings: one Knurling run each. */
export function knurlsOnRings(knurls: readonly KnurlCallout[], rings: readonly TurnedRing[]): KnurlOp[] {
  return knurls.map((k, i) => {
    const text = (k.text ?? '').trim() || 'KNURL';
    const named = k.diameterMm != null && k.diameterMm > 0 ? k.diameterMm : null;
    let ring: TurnedRing | null = null;
    let diameterSource = '';
    if (named != null) {
      ring = rings
        .filter((r) => Math.abs(r.diameterMm - named) <= 0.2)
        .sort((a, b) => Math.abs(a.diameterMm - named) - Math.abs(b.diameterMm - named) || b.lengthMm - a.lengthMm)[0] ?? null;
      diameterSource = `Drawing: the diameter the knurl callout "${text}" names`;
    } else if (rings.length === 1) {
      ring = rings[0]!;
      diameterSource = `CAD: the part's one turned diameter (Ring feature); the knurl callout "${text}" names none`;
    } else if (rings.length > 1) {
      ring = [...rings].sort((a, b) => b.diameterMm - a.diameterMm || b.lengthMm - a.lengthMm)[0]!;
      diameterSource = `${KNURL_LARGEST_RING_ASSUMPTION} ("${text}"), the CAD's Ø${r2(ring.diameterMm)} of ${rings.length} turned diameters`;
    }
    const diameterMm = named ?? ring?.diameterMm ?? null;
    const length = k.lengthMm != null && k.lengthMm > 0
      ? { lengthMm: k.lengthMm, lengthSource: `Drawing: the knurl callout "${text}" states its length` }
      : ring != null && ring.lengthMm > 0
        ? { lengthMm: ring.lengthMm, lengthSource: 'CAD: length of the turned diameter knurled (Ring feature)' }
        : { lengthMm: null, lengthSource: '' };
    const missing = [
      ...(diameterMm == null ? [`the diameter knurled (the knurl callout "${text}" names none and the CAD has no turned diameter)`] : []),
      ...(length.lengthMm == null ? [`the knurl's length (the knurl callout "${text}" states none${ring ? ' and its turned diameter has no length in the CAD' : ' and no turned diameter of the CAD is at its diameter'})`] : []),
    ];
    const label = ring ? ringLabel(ring) : named != null ? `Knurl Ø${named}` : `Knurl ${knurls.length > 1 ? i + 1 : ''}`.trim();
    return { label, diameterMm, diameterSource, ...length, ring, missing };
  });
}
