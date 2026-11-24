// A board set's measurement as a part's analysis stores it (feature_graph.summary.pcbGeometry). Pure: the version and the shape only.

/** The version of the board measurement a part's analysis stores; a stored measurement of another version is stale. */
export const PCB_GEOMETRY_VERSION = 'pcb_v1';

export interface PcbGeometrySummary {
  extractionVersion: typeof PCB_GEOMETRY_VERSION;
  source: 'board_files';
  /** The stored set's file name. */
  sourceName: string;
  /** The board feature graph the CAD engine measured (cad-engine pcb/extraction/board.py, contract 1.3). */
  graph: Record<string, unknown>;
  /** Each file of the set and what the engine did with it (used, reference, ignored), and what the set left out. */
  filesReport: { name: string; role: string; status: string; note: string }[];
}
