// The stock rules of memory/Stock Maching (staged as 2026-Stock-Machining by migrations 816 and 1114): how much stock is left on each side
// of a part, whether its size snaps to a preferred size, when a part is cut from plate, the bar and plate the stock is bought as, and the
// band saw's kerf and bundle. Pure: the caller reads the staged rows (readStagedReference).
import { partingRingsOf, preferredSizesOf, type AllowanceRule, type PreferredSize, type UnitSystem } from './stock-sizing';

import type { SandReference } from '../casting/sand/sand-reference';

export interface StockReference {
  /** Round, square and rectangular bar, tube OD and plate: percentStockAllowance of the largest section dimension, clamped. */
  allowance: AllowanceRule;
  /** Hex bar: hexPercentStockAllowance of the width across flats, at least hexMinStockWidthAllowance (0 and 0: the flats as supplied). */
  hexAllowance: AllowanceRule;
  /** Round tube: the stock left on the bore (idStockTrimAllowance). */
  idTrimAllowanceMm: number;
  /** Whether a size snaps up to the next preferred size (snapStockSize; hex bar: hexSnapStockSize). */
  snap: boolean;
  hexSnap: boolean;
  /** The length a bar is bought in (standardStockLength). */
  barLengthMm: number;
  /** The plate a plate part is cut from (standardPlateLength x standardPlateWidth) and the shape that makes a part a plate part. */
  plate: { lengthMm: number; widthMm: number; triggerWidthMm: number; triggerHeightOverWidth: number };
  /** The width of a band saw cut (bandSawKerf): the stock lost between two parts. */
  kerfMm: number;
  /** The most bars a band saw cuts in one bundle (maxPartsPerBundleBandSaw). */
  maxBundle: number;
  /** Whether the chips are sold back (enableScrapMaterialCredit). */
  scrapCredit: boolean;
  /** How a plate part is roughed out (defaultRoughingTechnique: All Bulk Milling, Perimeter Milling with Dropoff, Plate Cutting with Dropoff). */
  roughingTechnique: string;
  /** By unit system, ascending. */
  preferredSizes: Readonly<Record<UnitSystem, readonly PreferredSize[]>>;
  /** Ascending by diameter. */
  partingRings: readonly { diameterMm: number; ringWidthMm: number }[];
}

const NUMBERS = [
  'percentStockAllowance', 'minStockAllowance', 'maxStockAllowance', 'hexPercentStockAllowance', 'hexMinStockWidthAllowance', 'idStockTrimAllowance',
  'standardStockLength', 'standardPlateLength', 'standardPlateWidth', 'minPlateTriggerWidth', 'maxPlateTriggerHeightOverWidth',
  'bandSawKerf', 'maxPartsPerBundleBandSaw',
] as const;
const FLAGS = ['snapStockSize', 'hexSnapStockSize', 'enableScrapMaterialCredit'] as const;
const TEXTS = ['defaultRoughingTechnique'] as const;
const TABLES = ['tblPreferredSizes', 'tblPartingRingWidth'] as const;

/** The stock rules of the staged Stock Machining data, or what the data lacks, each named. */
export function stockReference(ref: SandReference): { reference: StockReference | null; missing: string[] } {
  const missing = [
    ...NUMBERS.filter((n) => ref.number(n) == null).map((n) => `Stock Machining variable ${n}`),
    ...FLAGS.filter((n) => ref.flag(n) == null).map((n) => `Stock Machining variable ${n} (true or false)`),
    ...TEXTS.filter((n) => !ref.text(n)?.trim()).map((n) => `Stock Machining variable ${n}`),
    ...TABLES.filter((t) => ref.table(t).length === 0).map((t) => `Stock Machining lookup ${t} (migration 1114)`),
  ];
  if (missing.length) return { reference: null, missing };
  const n = (name: (typeof NUMBERS)[number]) => ref.number(name)!;
  return {
    reference: {
      allowance: { percent: n('percentStockAllowance'), minMm: n('minStockAllowance'), maxMm: n('maxStockAllowance') },
      hexAllowance: { percent: n('hexPercentStockAllowance'), minMm: n('hexMinStockWidthAllowance'), maxMm: n('maxStockAllowance') },
      idTrimAllowanceMm: n('idStockTrimAllowance'),
      snap: ref.flag('snapStockSize')!,
      hexSnap: ref.flag('hexSnapStockSize')!,
      barLengthMm: n('standardStockLength'),
      plate: {
        lengthMm: n('standardPlateLength'), widthMm: n('standardPlateWidth'),
        triggerWidthMm: n('minPlateTriggerWidth'), triggerHeightOverWidth: n('maxPlateTriggerHeightOverWidth'),
      },
      kerfMm: n('bandSawKerf'),
      maxBundle: n('maxPartsPerBundleBandSaw'),
      scrapCredit: ref.flag('enableScrapMaterialCredit')!,
      roughingTechnique: ref.text('defaultRoughingTechnique')!.trim(),
      preferredSizes: { US: preferredSizesOf(ref, 'US'), metric: preferredSizesOf(ref, 'metric') },
      partingRings: partingRingsOf(ref),
    },
    missing: [],
  };
}
