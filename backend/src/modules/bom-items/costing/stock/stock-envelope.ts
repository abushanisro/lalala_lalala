/**
 * The stock envelope a Stock Machining part is priced from: the cad-engine's "stock" result for a machined part (machining/stock_envelope.py,
 * in machining_features), stored as feature_graph.summary.machiningStock (auto-fill.service machiningStock()). An analysis carrying another
 * version (or none) is measured again by Refresh analysis.
 */
export const MACHINING_STOCK_EXTRACTION_VERSION = 'stk_v1';

/**
 * The summary's stock measurement, as stored: its top-level keys camelCase (extractionVersion, axis, axisSource, lengthMm, round, rect, hex,
 * bore, endFaces, stockSurface), the objects inside as the cad-engine writes them, snake_case.
 */
export type MachiningStockSummary = Readonly<Record<string, unknown>>;
