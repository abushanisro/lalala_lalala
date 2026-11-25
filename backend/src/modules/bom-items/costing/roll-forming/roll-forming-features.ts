// What each roll forming step does to which feature of the part, as memory/Sheet metal roll forming's catalog states it
// (process_taxonomy_operations): "Roll Forming Mill:Bending//StraightBend", "Punch Press:Pre Punching//SimpleHole", "Punch Press:Notching//
// Cutout", "Cut-Off Press:Blade Cut-Off//End", ... The strip's holes, notches, lances and forms are punched before the mill (memory's Pre
// operations) by one progressive die, a die station per kind of feature; one the press cannot punch (too small for the strip, a form too deep,
// a tool too big) is a No Cost Feature with the reason. Each row carries the faces of its features (rollFormGeometry face ids, the analysis's
// face numbering) so the process tree lists and highlights them. Pure.
import { catalogPairs, type CatalogOperation } from '../sheet-metal/operation/catalog-operation-resolver';

import type { RollFormBend, RollFormEnd, RollFormFeature, RollFormFeatureType, RollFormPart } from './roll-forming-part';
import type { SandReference } from '../casting/sand/sand-reference';
import type { KitRow } from '../shared/calculators/route-kit';

/** The catalog operation that makes each feature type in the flat strip, before the mill. */
export const PRE_OPERATION: Readonly<Record<RollFormFeatureType, string>> = {
  SimpleHole: 'Pre Punching', ComplexHole: 'Pre Punching', Cutout: 'Notching', Lance: 'Pre Lancing', Form: 'Pre Forming',
};

/** A station of the progressive die: one kind of feature, every one of them in the strip. */
export interface DieStation {
  featureType: RollFormFeatureType;
  operation: string;
  features: RollFormFeature[];
  /** The largest feature of the station across (mm): its pitch along the die. */
  maxSizeMm: number;
}

export interface PunchPlan {
  punched: RollFormFeature[];
  stations: DieStation[];
  /** The features the punch press cannot make, grouped by why: each a No Cost Feature line. */
  notPunched: { featureType: RollFormFeatureType; features: RollFormFeature[]; reason: string }[];
  /** The smallest hole the strip can be punched with (mm), and how it is found; null when the thickness rule has no value. */
  minHoleMm: number | null;
  minHoleBasis: string;
  /** minHoleDiameterRatios' row at the material's UTS, for the trace. */
  ratioRow: KitRow | null;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const HOLES: ReadonlySet<RollFormFeatureType> = new Set(['SimpleHole', 'ComplexHole']);
const STATION_ORDER: readonly RollFormFeatureType[] = ['SimpleHole', 'ComplexHole', 'Cutout', 'Lance', 'Form'];

/**
 * The first row of a breakpoint table whose `key` column is at or above `value` (sorted by it): how the data's tables are read. Each row's key
 * is the upper bound of its band: memory's tables end with sentinel rows (999999999 in minHoleDiameterRatios and handlingTimes, 9999 in
 * minBendRadii, 9999999 in dieAccelerationRates) that only make sense as upper bounds, since read as lower bounds they would never be reached.
 */
export function stepRow(rows: readonly KitRow[], key: string, value: number): KitRow | null {
  return [...rows].filter((r) => Number.isFinite(Number(r[key]))).sort((a, b) => Number(a[key]) - Number(b[key])).find((r) => Number(r[key]) >= value - 1e-9) ?? null;
}

/**
 * Which features the punch press makes, in which die stations, and which it cannot (memory's limits): a hole under minHoleDiameterRatios at
 * the material's UTS x t (and never under minPunchingThicknessFactor x t) is too small to punch; a form deeper than
 * maxFormDepthInlinePunching, or any feature wider than maxToolSizeInlinePunching, is beyond the inline press.
 */
export function punchPlan(ref: SandReference, part: Pick<RollFormPart, 'features' | 'thicknessMm'>, utsMpa: number | null): PunchPlan {
  const t = part.thicknessMm;
  const factor = ref.number('minPunchingThicknessFactor');
  const ratioRow = utsMpa != null ? stepRow(ref.table('minHoleDiameterRatios'), 'Material Ultimate Tensile Strength (MPa)', utsMpa) : null;
  const ratio = ratioRow != null ? Number(ratioRow['Min Diameter To Thickness Ratio']) : null;
  const ratios = [...(ratio != null && Number.isFinite(ratio) ? [ratio] : []), ...(factor != null ? [factor] : [])];
  const minRatio = ratios.length ? Math.max(...ratios) : null;
  const minHoleMm = minRatio != null ? minRatio * t : null;
  const minHoleBasis = [
    ratio != null ? `minHoleDiameterRatios ${ratio} x t at the material's ${r2(utsMpa!)} MPa UTS` : utsMpa == null ? 'no UTS on file for minHoleDiameterRatios' : 'minHoleDiameterRatios has no row for the UTS',
    factor != null ? `minPunchingThicknessFactor ${factor} x t` : null,
  ].filter(Boolean).join('; ');
  const maxDepth = ref.number('maxFormDepthInlinePunching');
  const maxTool = ref.number('maxToolSizeInlinePunching');
  const why = (f: RollFormFeature): string | null => {
    if (HOLES.has(f.featureType) && f.sizeMm != null && minHoleMm != null && f.sizeMm < minHoleMm - 1e-9) {
      return `too small to punch in the ${r2(t)} mm strip: under the ${r2(minHoleMm)} mm smallest hole (${minHoleBasis})`;
    }
    if (f.featureType === 'Form' && f.depthMm != null && maxDepth != null && f.depthMm > maxDepth + 1e-9) {
      return `a form ${r2(f.depthMm)} mm deep, deeper than the inline press forms (maxFormDepthInlinePunching ${maxDepth} mm)`;
    }
    if (f.sizeMm != null && maxTool != null && f.sizeMm > maxTool + 1e-9) {
      return `a ${r2(f.sizeMm)} mm tool, bigger than the inline press takes (maxToolSizeInlinePunching ${maxTool} mm)`;
    }
    return null;
  };
  const punched: RollFormFeature[] = [];
  const refused = new Map<string, { featureType: RollFormFeatureType; features: RollFormFeature[]; reason: string }>();
  for (const f of part.features) {
    const reason = why(f);
    if (reason == null) { punched.push(f); continue; }
    const size = f.sizeMm != null ? ` of ${r2(f.sizeMm)} mm` : '';
    const key = `${f.featureType}|${size}|${reason}`;
    const g = refused.get(key) ?? { featureType: f.featureType, features: [], reason: '' };
    g.features.push(f);
    g.reason = `${g.features.length} ${f.featureType}${g.features.length === 1 ? '' : 's'}${size}: ${reason}`;
    refused.set(key, g);
  }
  const stations = STATION_ORDER.flatMap((type): DieStation[] => {
    const features = punched.filter((f) => f.featureType === type);
    return features.length ? [{ featureType: type, operation: PRE_OPERATION[type], features, maxSizeMm: Math.max(0, ...features.map((f) => f.sizeMm ?? 0)) }] : [];
  });
  return { punched, stations, notPunched: [...refused.values()], minHoleMm, minHoleBasis, ratioRow };
}

/** Memory's catalog rows of each step that name the part's features, each carrying the faces it acts on. */
export function rollFormingCatalogOperations(
  catalog: readonly string[], input: { bends: readonly RollFormBend[]; stations: readonly DieStation[]; ends: readonly RollFormEnd[]; cutOff: 'Scissor Cut-Off' | 'Blade Cut-Off' },
): { mill: CatalogOperation[]; punch: CatalogOperation[]; cutOff: CatalogOperation[] } {
  const rows = catalog.map((raw) => ({ raw, pairs: catalogPairs(raw) })).filter((r) => r.pairs.length > 0);
  const has = (process: string, operation: string, featureType: string) =>
    rows.some((r) => r.raw.startsWith(`${process}:`) && r.pairs[0].operation === operation && r.pairs[0].featureType === featureType);
  const row = (operation: string, featureType: string, faces: number[][], diameterMm: number | null = null): CatalogOperation => ({
    operations: [operation], featureType, variant: 'default', diameterMm, count: Math.max(1, faces.length), featureIds: [],
    ...(faces.some((f) => f.length) ? { featureFaceIds: faces } : {}), status: 'resolved', children: [],
  });
  const mill = input.bends.length && has('Roll Forming Mill', 'Bending', 'StraightBend') ? [row('Bending', 'StraightBend', input.bends.map((b) => b.faceIds))] : [];
  const punch = input.stations.filter((s) => has('Punch Press', s.operation, s.featureType)).map((s) => row(s.operation, s.featureType, s.features.map((f) => f.faceIds)));
  const ends = input.ends.length ? input.ends.map((e) => e.faceIds) : [[], []];
  const cutOff = has('Cut-Off Press', input.cutOff, 'End') ? [row(input.cutOff, 'End', ends)] : [];
  return { mill, punch, cutOff };
}
