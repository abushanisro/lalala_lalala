/**
 * The roll-forming measurement a Sheet Metal Roll Forming part is priced from: the cad-engine's "roll_form" result (sheet_metal/features/
 * roll_form.py), stored as feature_graph.summary.rollFormGeometry (auto-fill.service rollFormGeometry()). An analysis carrying another
 * version (or none) is measured again by Refresh analysis.
 */
export const ROLL_FORM_EXTRACTION_VERSION = 'rf_v3';

// A roll formed part as the engine takes it: rollFormGeometry's top-level keys camelCase, the objects inside as the cad-engine writes them,
// snake_case (a key is read in either spelling). This file is the one place that reads it. Pure.

type Obj = Readonly<Record<string, unknown>>;

/** The summary's roll forming measurement, as stored. */
export type RollFormGeometrySummary = Obj;

/** The features memory's Punch Press makes in the flat strip (Pre Punching, Notching, Pre Lancing, Pre Forming). */
export const ROLL_FORM_FEATURE_TYPES = ['SimpleHole', 'ComplexHole', 'Cutout', 'Lance', 'Form'] as const;
export type RollFormFeatureType = (typeof ROLL_FORM_FEATURE_TYPES)[number];

/** A bend across the strip (its axis along the profile), formed by the mill. */
export interface RollFormBend {
  angleDeg: number;
  innerRadiusMm: number | null;
  /** The flat before it, across the strip (from the strip's first edge); null when not measured. */
  flangeBeforeMm: number | null;
  /** Bends out from the web (the widest flat): 1 next to it; null when the cad-engine did not say. */
  level: number | null;
  faceIds: number[];
}

/** A feature punched in the flat strip before the mill. */
export interface RollFormFeature {
  featureType: RollFormFeatureType;
  /** A hole's diameter, else the feature's largest size across (the punch's size). */
  sizeMm: number | null;
  perimeterMm: number;
  areaMm2: number;
  /** A form's depth; null for a cut feature. */
  depthMm: number | null;
  /** Where along the part it is (mm from its start). */
  stationMm: number | null;
  faceIds: number[];
}

export interface RollFormEnd {
  /** Which end: start or end. */
  end: string;
  /** square, angled, notched or slotted. */
  kind: string;
  cutPerimeterMm: number | null;
  faceIds: number[];
}

export interface RollFormPart {
  /** Along the profile (mm). */
  lengthMm: number;
  axisSource: string | null;
  /** The share of the length that is the constant section (the cad-engine's own check). */
  stockFraction: number | null;
  section: { heightMm: number; widthMm: number; areaMm2: number | null; perimeterMm: number | null; closed: boolean; stockForm: string | null };
  /**
   * The strip the coil is slit to (mm): the section's flats and bends at the neutral fibre (strip_width_neutral_mm, the flat pattern's own
   * K-factor rule), else its mid-line stretch-out (strip_width_mm: section area / t) when the strip's order across the section was not read.
   */
  stripWidthMm: number;
  /** Which width stripWidthMm is, and the mid-line one beside it. */
  stripWidthSource: 'neutral fibre' | 'mid-line';
  stripWidthMidMm: number;
  thicknessMm: number;
  bends: RollFormBend[];
  /** The flat after the last bend (the strip's other edge); null when not measured. */
  lastFlangeMm: number | null;
  /** A profile swept along an arc (bent along its length after forming); null when straight. */
  curve: { radiusMm: number; angleDeg: number | null } | null;
  features: RollFormFeature[];
  ends: RollFormEnd[];
  /** What the cad-engine could not measure on this part, each said on the quote (features or bends not measured are not read as none). */
  unmeasured: string[];
}

const camel = (k: string) => k.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
const get = (o: Obj | null | undefined, key: string): unknown => (o == null ? undefined : o[key] ?? o[camel(key)]);
const obj = (v: unknown): Obj | null => (v != null && typeof v === 'object' && !Array.isArray(v) ? v as Obj : null);
const list = (v: unknown): Obj[] => (Array.isArray(v) ? v.map(obj).filter((o): o is Obj => o != null) : []);
const num = (v: unknown): number | null => (v == null || v === '' || typeof v === 'boolean' || !Number.isFinite(Number(v)) ? null : Number(v));
const positive = (v: unknown): number | null => {
  const n = num(v);
  return n != null && n > 0 ? n : null;
};
const nonNegative = (v: unknown): number | null => {
  const n = num(v);
  return n != null && n >= 0 ? n : null;
};
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const faceIds = (v: unknown): number[] => (Array.isArray(v) ? v.map(num).filter((n): n is number => n != null && n >= 0) : []);

export const ROLL_FORM_REFRESH = 'press Refresh analysis so the part is measured for roll forming';
export const NOT_A_PROFILE = 'the part is not a roll formed profile';

/**
 * The part, or what keeps it from being one, each named. A part analysed before the measurement existed (no rollFormGeometry) is asked to be
 * analysed again; null is the current engine's answer that the part is not a profile (no constant cross-section along a long axis); a value a
 * current measurement left out is one the cad-engine could not measure on this part. `sheetThicknessMm`: the part's sheet thickness, used when
 * the measurement does not give one.
 */
export function rollFormPart(g: RollFormGeometrySummary | null | undefined, sheetThicknessMm?: number | null): { part: RollFormPart | null; missing: string[] } {
  if (g === undefined) return { part: null, missing: [`the roll forming measurements: ${ROLL_FORM_REFRESH}`] };
  if (g === null) return { part: null, missing: [`${NOT_A_PROFILE}: the cad-engine found no cross-section swept along one axis (no bends running one way, or a flat part)`] };
  const version = get(g, 'extraction_version') ?? get(g, 'version');
  if (version !== ROLL_FORM_EXTRACTION_VERSION) return { part: null, missing: [`the roll forming measurements: ${ROLL_FORM_REFRESH}`] };
  const stockFraction = nonNegative(get(g, 'stock_fraction'));
  if (get(g, 'constant_section') === false) {
    const share = stockFraction != null ? ` (the section holds over ${Math.round(stockFraction * 100)} % of its length)` : '';
    return { part: null, missing: [`${NOT_A_PROFILE}: its cross-section changes along its length${share}`] };
  }
  const section = obj(get(g, 'section'));
  const length = positive(get(g, 'length_mm'));
  const mid = positive(get(g, 'strip_width_mm'));
  const neutral = positive(get(g, 'strip_width_neutral_mm'));
  const strip = neutral ?? mid;
  const thickness = positive(get(g, 'thickness_mm')) ?? positive(sheetThicknessMm);
  const height = positive(get(section, 'height_mm'));
  const width = positive(get(section, 'width_mm'));
  if (length == null || strip == null || thickness == null || height == null || width == null) {
    const missing = [
      ...(length == null ? ['the length along the profile'] : []),
      ...(strip == null ? ['the strip width (the section\'s stretch-out)'] : []),
      ...(thickness == null ? ['the sheet thickness'] : []),
      ...(height == null || width == null ? ['the cross-section\'s height and width'] : []),
    ];
    return { part: null, missing: missing.map((m) => `${m}: the cad-engine could not measure it on this part`) };
  }
  const bendsRaw = get(g, 'bends');
  const featuresRaw = get(g, 'features');
  const bends = list(bendsRaw).flatMap((b): RollFormBend[] => {
    const angle = num(get(b, 'angle_deg'));
    if (angle == null || !(Math.abs(angle) > 0)) return [];
    const level = num(get(b, 'level'));
    return [{
      angleDeg: Math.abs(angle), innerRadiusMm: nonNegative(get(b, 'inner_radius_mm')), flangeBeforeMm: nonNegative(get(b, 'flange_before_mm')),
      level: level != null && level >= 1 ? Math.round(level) : null, faceIds: faceIds(get(b, 'face_ids')),
    }];
  });
  const features = list(featuresRaw).flatMap((f): RollFormFeature[] => {
    const type = text(get(f, 'feature_type'));
    if (!type || !(ROLL_FORM_FEATURE_TYPES as readonly string[]).includes(type)) return [];
    return [{
      featureType: type as RollFormFeatureType, sizeMm: positive(get(f, 'size_mm')), perimeterMm: nonNegative(get(f, 'perimeter_mm')) ?? 0,
      areaMm2: nonNegative(get(f, 'area_mm2')) ?? 0, depthMm: nonNegative(get(f, 'depth_mm')), stationMm: num(get(f, 'station_mm')), faceIds: faceIds(get(f, 'face_ids')),
    }];
  });
  const curve = obj(get(g, 'curve'));
  const radius = positive(get(curve, 'radius_mm'));
  return {
    part: {
      lengthMm: length, axisSource: text(get(g, 'axis_source')), stockFraction,
      section: {
        heightMm: height, widthMm: width, areaMm2: positive(get(section, 'area_mm2')), perimeterMm: positive(get(section, 'perimeter_mm')),
        closed: get(section, 'closed') === true, stockForm: text(get(section, 'stock_form')),
      },
      stripWidthMm: strip, stripWidthSource: neutral != null ? 'neutral fibre' : 'mid-line', stripWidthMidMm: mid ?? strip,
      thicknessMm: thickness, bends, lastFlangeMm: nonNegative(get(g, 'last_flange_mm')),
      curve: radius != null ? { radiusMm: radius, angleDeg: positive(get(curve, 'angle_deg')) } : null,
      features,
      ends: list(get(g, 'ends')).map((e) => ({
        end: text(get(e, 'end')) ?? 'end', kind: text(get(e, 'kind')) ?? 'square', cutPerimeterMm: positive(get(e, 'cut_perimeter_mm')), faceIds: faceIds(get(e, 'face_ids')),
      })),
      unmeasured: [
        ...(Array.isArray(bendsRaw) ? [] : ['the bends across the strip, so the roll stations are the finishing and lead-in passes only']),
        ...(Array.isArray(featuresRaw) ? [] : ['the holes and forms in the strip, so none is punched']),
      ],
    },
    missing: [],
  };
}
