/**
 * How much of a part is the sheet the cad-engine measured: the part's volume over that sheet (its area x thickness). A sheet part is about 1; a
 * machined or turned part that the sheet-metal measurement read as a thin sheet is many times more (R_M-0230-032 LEAD NUT HOUSING 7.3x, the
 * Lead Screw side shaft 90x). Memory has no rule for this; the limits are the user's decision (2026-11-21): above NOT_A_SHEET_RATIO the part is
 * not made from one sheet, above SHEET_WARN_RATIO it is quoted with a warning. Used by every sheet process that prices the measured sheet.
 */
export const NOT_A_SHEET_RATIO = 2;
export const SHEET_WARN_RATIO = 1.25;

/** The two reasons a part is more than the sheet measured, named together because the ratio cannot tell them apart. */
export const NOT_A_SHEET_CAUSES = 'it is not a sheet part, or its sheet was not all measured (a curved sheet of B-spline faces is not found)';

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * The ratio and what it reads, "the cad-engine found 1 % of the part's 2,626 mm³ as a 0.8 mm sheet (37 mm² flat, 89.68x)"; null when the
 * volume, the sheet's area or its thickness is not known. `areaLabel` names the area measured (developed, flat).
 */
export function sheetShare(
  partVolumeMm3: number | null | undefined, sheetAreaMm2: number | null | undefined, thicknessMm: number | null | undefined, areaLabel: string,
): { ratio: number; found: string } | null {
  if (!(partVolumeMm3 != null && partVolumeMm3 > 0 && sheetAreaMm2 != null && sheetAreaMm2 > 0 && thicknessMm != null && thicknessMm > 0)) return null;
  const sheetMm3 = sheetAreaMm2 * thicknessMm;
  const ratio = partVolumeMm3 / sheetMm3;
  return {
    ratio,
    found: `the cad-engine found ${Math.round((100 * sheetMm3) / partVolumeMm3)} % of the part's ${Math.round(partVolumeMm3).toLocaleString('en-US')} mm³ `
      + `as a ${r2(thicknessMm)} mm sheet (${Math.round(sheetAreaMm2).toLocaleString('en-US')} mm² ${areaLabel}, ${r2(ratio)}x)`,
  };
}
