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

/** The version of a board's measurement from its 3D model (cad-engine pcb/feature_extractor.py VERSION). */
export const PCB_MODEL_VERSION = 'pcb-step-1';

/**
 * A board measured from its 3D model when it has no board files (feature_graph.summary.pcbModelGeometry, written by the CAD analysis of a
 * part whose Process is PCB): the board found among the model's bodies, and nothing of its copper.
 */
export interface PcbModelGeometry {
  extractionVersion: string;
  /** Null when the model shows no board (no planar face with an opposite face of about its area a board's thickness behind it). */
  board: { thickness_mm: number; length_mm: number; width_mm: number; area_mm2: number; perimeter_mm: number } | null;
  holes: { diameter_mm: number; count: number }[];
  /** The openings through the board other than round holes (slots, windows): each one's boundary length. */
  cutouts: { perimeter_mm: number }[];
  /** The bodies standing on each side of the board (counted, not classified). */
  components: { top: number; bottom: number } | null;
  unresolved: string[];
}
