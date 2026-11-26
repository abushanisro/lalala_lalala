// The PCB reference as the routes read it: the memory/PCBA variables and stack-up tables (migration 823), and the sourced tables (migration
// 1130: consumables, process_times, yield), whose rows carry an item_key, a min and a max and their source. Pure.
//
// A sourced range is quoted at its midpoint, with both ends and the sources shown (user decision 2026-11-24): several rows of one key are one
// range, from the lowest minimum to the highest maximum.
import type { SandReference } from '../casting/sand/sand-reference';
import type { SourceRef } from '../../dto/cost-breakdown.dto';
import { calculationRef, inputStep, resultStep } from '../shared/calculators/seed-refs';

export const PCB_SOURCE_VERSION = '2026-PCB';

export interface SourcedValue {
  key: string;
  min: number;
  max: number;
  /** The quoted value: the middle of the range. */
  mid: number;
  unit: string;
  /** The sources the range is read from (url, date), for the line's trace. */
  sources: { url: string; date: string; note: string }[];
  /** The staged table the rows are in, the columns of each end and the keys of the rows (the eye outlines them). */
  table: string;
  columns: readonly [string, string];
  row: Record<string, string | number>;
}

/** The reference-data domain the PCB tables are staged in (pcb-route.ts PCB_DOMAIN). */
const PCB_REFERENCE_DOMAIN = 'pcb';

/**
 * A sourced range as the calculation it is: its lowest and highest ends (each opening the staged rows they are read from), the midpoint
 * quoted, and a unit conversion when the input takes it in another unit.
 */
export function sourcedRef(v: SourcedValue, label: string, scale = 1, scaleWhy = ''): SourceRef {
  const [minCol, maxCol] = v.columns;
  const at = (column: string): SourceRef => ({ kind: 'lookup', domain: PCB_REFERENCE_DOMAIN, table: v.table, column, row: v.row });
  const urls = v.sources.map((s) => s.url).filter(Boolean);
  return calculationRef(`${label}: ${v.key}`, [
    inputStep('Lowest', v.unit || null, v.min, `${v.table}: ${v.key}, the lowest ${minCol} of its ${v.sources.length} row(s)${urls.length ? ` (${urls.join(', ')})` : ''}`, at(minCol)),
    inputStep('Highest', v.unit || null, v.max, `${v.table}: ${v.key}, the highest ${maxCol} of its rows`, at(maxCol)),
    resultStep(label, v.unit || null, v.mid, '({Lowest} + {Highest}) / 2: the midpoint is quoted'),
    ...(scale !== 1 ? [resultStep(`${label} (as taken)`, null, v.mid * scale, `the midpoint x ${scale}${scaleWhy ? ` (${scaleWhy})` : ''}`)] : []),
  ]);
}

type Row = Readonly<Record<string, unknown>>;
const num = (v: unknown): number | null => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

function sourcedFrom(rows: readonly Row[], key: string, minCol: string, maxCol: string, table: string, rowKeys: Record<string, string | number> = {}): SourcedValue | null {
  const keyed = rows.filter((r) => r['item_key'] === key);
  const lows = keyed.map((r) => num(r[minCol]) ?? num(r[maxCol])).filter((x): x is number => x != null);
  const highs = keyed.map((r) => num(r[maxCol]) ?? num(r[minCol])).filter((x): x is number => x != null);
  if (!lows.length || !highs.length) return null;
  const min = Math.min(...lows);
  const max = Math.max(...highs);
  return {
    key, min, max, mid: (min + max) / 2, unit: String(keyed[0]?.['unit'] ?? ''),
    sources: keyed.map((r) => ({ url: String(r['source_url'] ?? ''), date: String(r['source_date'] ?? ''), note: String(r['source_note'] ?? '') })),
    table, columns: [minCol, maxCol], row: { item_key: key, ...rowKeys },
  };
}

/** A keyed consumable or tooling value (memory/PCBA/consumables.csv). */
export const consumable = (ref: SandReference, key: string): SourcedValue | null => sourcedFrom(ref.table('consumables'), key, 'value_min', 'value_max', 'consumables');
/** A keyed process time or thickness (memory/PCBA/process_times.csv). */
export const processTime = (ref: SandReference, key: string): SourcedValue | null => sourcedFrom(ref.table('process_times'), key, 'value_min', 'value_max', 'process_times');

/** The rows of a keyed consumable that apply to a drill diameter (their diameter_min_mm..diameter_max_mm covers it), as one range. */
export function consumableForDiameter(ref: SandReference, key: string, diameterMm: number): SourcedValue | null {
  const rows = ref.table('consumables').filter((r) => r['item_key'] === key && num(r['diameter_min_mm']) != null && num(r['diameter_max_mm']) != null
    && diameterMm >= num(r['diameter_min_mm'])! - 1e-9 && diameterMm <= num(r['diameter_max_mm'])! + 1e-9);
  return sourcedFrom(rows, key, 'value_min', 'value_max', 'consumables');
}

/** First-pass fabrication yield (%) for a layer count: the rows for that count, else for the nearest count the source gives. */
export function fabYield(ref: SandReference, layers: number): (SourcedValue & { layersRead: number }) | null {
  const rows = ref.table('yield').filter((r) => r['item_key'] === 'fab_yield_pct');
  const counts = [...new Set(rows.map((r) => num(r['layer_count_min'])).filter((x): x is number => x != null))];
  if (!counts.length) return null;
  const nearest = counts.sort((a, b) => Math.abs(a - layers) - Math.abs(b - layers) || a - b)[0]!;
  const v = sourcedFrom(rows.filter((r) => num(r['layer_count_min']) === nearest), 'fab_yield_pct', 'yield_min_pct', 'yield_max_pct', 'yield', { layer_count_min: nearest });
  return v ? { ...v, unit: '%', layersRead: nearest } : null;
}

/** A range as the trace says it: "0.6 USD/kg (0.5-0.7, 2 sources)". */
export function saySourced(v: SourcedValue, digits = 4): string {
  const f = (x: number) => String(Math.round(x * 10 ** digits) / 10 ** digits);
  return v.min === v.max ? `${f(v.mid)} ${v.unit}` : `${f(v.mid)} ${v.unit} (midpoint of ${f(v.min)}-${f(v.max)}, ${v.sources.length} source${v.sources.length === 1 ? '' : 's'})`;
}

/** Ounces per square foot of copper as the plating text gives them ("1/2 oz - 18 µm" -> 18 µm). */
export function micronsOfPlating(text: string | null): number | null {
  const m = text?.match(/([0-9.]+)\s*µm/);
  return m ? Number(m[1]) : null;
}
