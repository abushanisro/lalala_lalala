import type { MaterialClass } from '../process/cost-machining-engine';
import { MACHINING_MATERIAL, nearestByHardness } from './machining-material-hardness';

/**
 * Real grooving cutting data — tblGrooving (machining_reference_data, migration 746, memory/machining/lookup/tblGrooving.csv): one row
 * per material cut code (with its real Brinell hardness) x insert width ("Length (mm)": 1.75 and 8 mm), each with its cutting speed, its
 * feed and the deepest groove the insert reaches ("Depth Max (mm)").
 *
 * Selection, as Parting reads its part-off inserts (partoff-table.ts): the rows of the material nearest this part's hardness within its
 * cut-code family. The insert is as wide as the groove, up to the widest the table gives (a wider groove takes several plunges); its feed
 * is read between the two widths the table gives, in proportion to the insert's width (the table's feed grows with the insert: 0.06 mm/rev
 * at 1.75 mm, 0.27 at 8 mm for mild steel). An insert narrower than the narrowest row is fed at that row's feed: the table goes no
 * narrower, and the narrowest is the nearest data. A material with no row, or a groove deeper than every insert reaches, is null: the
 * caller names the gap.
 */
export interface GroovingParams {
  cuttingSpeedMPerMin: number;
  feedMmPerRev: number;
  /** The insert the groove is plunged with: as wide as the groove, at most the widest row. */
  insertWidthMm: number;
  /** How the feed was read: one row's, or between two widths. */
  feedBasis: string;
  materialCutCode: number;
  hardnessHb: number;
  /** The table rows read (their insert widths), for the line's lookup references. */
  rowWidthsMm: number[];
}

interface GroovingRow {
  Hardness?: number;
  'Length (mm)'?: number;
  'Depth Max (mm)'?: number;
  'Feed (mm / rev)'?: number;
  'Cutting Speed (m / min)'?: number;
  'Material Cut Code Name'?: number | string;
}

const positive = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;
const r4 = (v: number) => Math.round(v * 1e4) / 1e4;

export function resolveGroovingParams(
  rows: GroovingRow[] | null | undefined,
  grooveWidthMm: number,
  grooveDepthMm: number,
  materialClass: MaterialClass,
): GroovingParams | null {
  if (!rows?.length || !(grooveWidthMm > 0) || !(grooveDepthMm > 0)) return null;
  const nearest = nearestByHardness(rows, MACHINING_MATERIAL[materialClass]);
  if (!nearest) return null;
  const code = Number(nearest['Material Cut Code Name']);
  const own = rows
    .filter((r) => Number(r['Material Cut Code Name']) === code && r.Hardness === nearest.Hardness)
    .filter((r) => positive(r['Length (mm)']) && positive(r['Feed (mm / rev)']) && positive(r['Cutting Speed (m / min)']))
    .filter((r) => typeof r['Depth Max (mm)'] === 'number' && r['Depth Max (mm)'] >= grooveDepthMm)
    .sort((a, b) => a['Length (mm)']! - b['Length (mm)']!);
  if (own.length === 0) return null;
  const narrowest = own[0]!;
  const widest = own[own.length - 1]!;
  const insertWidthMm = Math.min(grooveWidthMm, widest['Length (mm)']!);
  const base = { insertWidthMm, materialCutCode: code, hardnessHb: nearest.Hardness! };
  if (insertWidthMm <= narrowest['Length (mm)']!) {
    return {
      ...base,
      cuttingSpeedMPerMin: narrowest['Cutting Speed (m / min)']!,
      feedMmPerRev: narrowest['Feed (mm / rev)']!,
      feedBasis: insertWidthMm < narrowest['Length (mm)']!
        ? `the ${narrowest['Length (mm)']} mm insert's feed (the table's narrowest; the groove is ${r4(grooveWidthMm)} mm wide)`
        : `the ${narrowest['Length (mm)']} mm insert's feed`,
      rowWidthsMm: [narrowest['Length (mm)']!],
    };
  }
  const upper = own.find((r) => r['Length (mm)']! >= insertWidthMm)!;
  const lower = [...own].reverse().find((r) => r['Length (mm)']! <= insertWidthMm)!;
  if (upper === lower) {
    return {
      ...base, cuttingSpeedMPerMin: upper['Cutting Speed (m / min)']!, feedMmPerRev: upper['Feed (mm / rev)']!,
      feedBasis: `the ${upper['Length (mm)']} mm insert's feed`, rowWidthsMm: [upper['Length (mm)']!],
    };
  }
  const t = (insertWidthMm - lower['Length (mm)']!) / (upper['Length (mm)']! - lower['Length (mm)']!);
  const between = (column: 'Feed (mm / rev)' | 'Cutting Speed (m / min)') => lower[column]! + t * (upper[column]! - lower[column]!);
  return {
    ...base,
    cuttingSpeedMPerMin: r4(between('Cutting Speed (m / min)')),
    feedMmPerRev: r4(between('Feed (mm / rev)')),
    feedBasis: `between the ${lower['Length (mm)']} mm insert (${lower['Feed (mm / rev)']} mm/rev) and the ${upper['Length (mm)']} mm insert `
      + `(${upper['Feed (mm / rev)']} mm/rev), in proportion to the ${r4(insertWidthMm)} mm insert's width`,
    rowWidthsMm: [lower['Length (mm)']!, upper['Length (mm)']!],
  };
}
