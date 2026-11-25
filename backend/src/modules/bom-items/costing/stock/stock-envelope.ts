/**
 * The stock envelope a Stock Machining part is priced from: the cad-engine's "stock" result for a machined part (machining/stock_envelope.py,
 * in machining_features), stored as feature_graph.summary.machiningStock (auto-fill.service machiningStock()). An analysis carrying another
 * version (or none) is measured again by Refresh analysis.
 */
export const MACHINING_STOCK_EXTRACTION_VERSION = 'stk_v1';

/**
 * The summary's stock measurement, as stored: its top-level keys camelCase (extractionVersion, axis, axisSource, lengthMm, round, rect, hex,
 * bore, endFaces, stockSurface, plate), the objects inside as the cad-engine writes them, snake_case.
 *
 * plate is the part as a piece cut out of plate (the engine's "plate" block, with its own version, plt_v1): normal, thickness_mm and the
 * outline seen along the normal (perimeter_mm, area_mm2, rect { length_mm, width_mm, angle_deg }, openings { count, perimeter_mm,
 * area_mm2 }). It was added to stk_v1 without a new stock version: null on an analysis made before it, and when the engine could not
 * measure it.
 */
export type MachiningStockSummary = Readonly<Record<string, unknown>>;
