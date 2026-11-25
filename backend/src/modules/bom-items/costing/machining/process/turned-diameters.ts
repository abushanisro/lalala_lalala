// The diameters a lathe turns on a part, and which of them a given bar needs turned. Pure.
//
// The cad-engine recognises each turned outer diameter of a part as a Ring (machining_features, Ring:outer_diameter) with its own
// diameter, its length along the turning axis and its faces. A lathe turns each of them down from the bar: on a Ø16 bar, a Ø12 step of a
// part whose largest diameter is Ø14 has 2 mm of radial stock to remove, not the Ø14's 1 mm. A Ring at the bar's own diameter is the
// bar's surface: it is left as supplied. A part with no Ring features (an analysis made before they were recognised) is turned as one
// cylinder, its fallback diameter over its length.

/** One turned outer diameter of the part: a cad-engine Ring:outer_diameter feature. */
export interface TurnedRing {
  /** The feature's id in the analysis (od_0, od_1, ...). */
  id: string;
  diameterMm: number;
  /** Its length along the turning axis; 0 when the analysis has none. */
  lengthMm: number;
  /** Its CAD faces (face_map ids), lit on the model for the lines that turn it. */
  faceIds: number[];
}

/** The part as a lathe sees it: its largest turned diameter over its length (each with where it was read), and its Rings when recognised. */
export interface TurnedPart {
  diameterMm: number;
  lengthMm: number;
  diameterSource: string;
  lengthSource: string;
  rings?: readonly TurnedRing[] | null;
}

/** A cylinder the lathe turns down from the bar: one Ring, or the part's one fallback cylinder (`ring` null) when it has no Ring features. */
export interface TurnedCylinder {
  /** Names the cylinder on its line ("Ring Ø12 x 18.33 mm"); no two cylinders of a part share one. */
  label: string;
  diameterMm: number;
  lengthMm: number;
  diameterSource: string;
  lengthSource: string;
  ring: TurnedRing | null;
}

const RING_DIAMETER_SOURCE = 'CAD: turned outer diameter (Ring feature)';
const RING_LENGTH_SOURCE = 'CAD: length of that turned diameter along the turning axis (Ring feature)';

const r2 = (n: number) => Math.round(n * 100) / 100;
const cylinderLabel = (kind: string, diameterMm: number, lengthMm: number) => `${kind} Ø${r2(diameterMm)} x ${r2(lengthMm)} mm`;

/** A Ring as its lines name it: "Ring Ø12 x 18.33 mm". */
export const ringLabel = (ring: Pick<TurnedRing, 'diameterMm' | 'lengthMm'>) => cylinderLabel('Ring', ring.diameterMm, ring.lengthMm);

/** The part's turned outer diameters, from its analysis (feature_graph.machining_features.features), in the analysis's order. */
export function turnedRings(features: unknown): TurnedRing[] {
  return (Array.isArray(features) ? features : [])
    .filter((f) => f?.type === 'Ring' && f.variant === 'outer_diameter' && Number(f.params?.diameter_mm) > 0)
    .map((f, i) => {
      const length = Number(f.params.length_mm);
      return {
        id: typeof f.id === 'string' ? f.id : `od_${i}`,
        diameterMm: Number(f.params.diameter_mm),
        lengthMm: length > 0 ? length : 0,
        faceIds: Array.isArray(f.face_ids) ? f.face_ids.filter((id: unknown): id is number => Number.isInteger(id)) : [],
      };
    });
}

/**
 * The cylinders a lathe turns on `part` from a bar of `barDiameterMm`: every Ring smaller than the bar, each with its own diameter and
 * length; for a part with no Rings, its one fallback cylinder when the bar is larger than it. A cylinder at the bar's diameter has no
 * radial stock, so it is not turned.
 */
export function cylindersToTurn(part: TurnedPart, barDiameterMm: number): TurnedCylinder[] {
  const hasRadialStock = (diameterMm: number) => (barDiameterMm - diameterMm) / 2 > 0;
  if (!part.rings?.length) {
    return hasRadialStock(part.diameterMm)
      ? [{ label: cylinderLabel('Turned diameter', part.diameterMm, part.lengthMm), diameterMm: part.diameterMm, lengthMm: part.lengthMm, diameterSource: part.diameterSource, lengthSource: part.lengthSource, ring: null }]
      : [];
  }
  // Two Rings of one size (a journal at each end) are told apart by a number, so each keeps its own steps in the line's calculation.
  const seen = new Map<string, number>();
  return part.rings.filter((ring) => hasRadialStock(ring.diameterMm)).map((ring) => {
    const size = cylinderLabel('Ring', ring.diameterMm, ring.lengthMm);
    const nth = (seen.get(size) ?? 0) + 1;
    seen.set(size, nth);
    return { label: nth > 1 ? `${size} (${nth})` : size, diameterMm: ring.diameterMm, lengthMm: ring.lengthMm, diameterSource: RING_DIAMETER_SOURCE, lengthSource: RING_LENGTH_SOURCE, ring };
  });
}
