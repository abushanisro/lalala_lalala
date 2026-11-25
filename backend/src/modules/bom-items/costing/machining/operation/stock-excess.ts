// The stock a mill removes around a part, beyond what the operations on the part's features remove. Pure.
//
// A mill's time is the operations the sequencer plans (operation-sequencer.ts): Facing the piece's faces, then the operations on the
// part's recognised features. None of them takes off the rest of the piece the mill starts from: the allowance on the part's sides, what
// the stock size has over the part, the material outside the part's outline. That rest is milled away by one Bulk Milling operation (the
// reference catalog's "Bulk Milling:Bulk Milling Op//BulkRemoval" of every mill), and its volume is
//
//   stock excess = piece volume - part volume - volume the part's features remove - volume faced off the piece
//
// so no cubic millimetre is milled twice and none is skipped: what a feature's own operation removes, and what Facing takes off the
// piece's faces (stock/stock-facing.ts), are taken off, the rest is the bulk's.
//
// The volume a feature removes is its occurrences' material_removed_mm3, as the CAD engine states it (cad-engine
// machining/machining_feature_recognizer.py, build_machining_feature_graph_v2). Every feature's is taken off but a turned diameter's (see
// below), the features split out to another machine too, because each stated volume is removed by an operation of the plan or on its own
// line:
//
//   PocketV2, Slot straight / radial   floor area x depth. Rough Milling (a pocket) and Slot Milling (a slot) cut it, timed by their
//                                      passes over the floor's length, width and depth (the workbook's End and Slot Milling sheets). A
//                                      pocket that is rotary broached or chemically milled, and a slot wire cut after heat treatment,
//                                      leaves on that process instead.
//   Keyway                             floor area x depth. Obround Slot Milling cuts it (timed by its passes, not by its volume); a keyway
//                                      the broach cuts leaves on the Keyway Broaching line.
//   Flat                               the circular segment it cuts off the turned diameter, over its length. Rough Milling cuts it,
//                                      timed by its passes over the flat's length, width and depth.
//   SimpleHole through / blind / cross / threaded, MultiStepHole counterbore, Edge countersink
//                                      the cylinder pi/4 x D^2 x depth. Drilling, Counterboring and Countersinking cut it (timed by the
//                                      tool's feed); a deep hole leaves on the Gun Drilling or Deep Bore line.
//   MultiStepHole stepped              the cylinders of its steps, drilled step by step.
//
// These state 0, so nothing is taken off for them and what they remove stays in the bulk: a hole pattern, a chamfer, a rounded edge, a
// toroidal groove, gear teeth, and the faces (PlanarFace, CurvedWall, CurvedSurface, Cutout), whose finishing and contouring passes
// follow a surface.
//
// A turned diameter (Ring outer_diameter, in a turned part's analysis) states a volume that is not removed at all: the analysis writes
// every diameter-and-length feature's cylinder, pi/4 x D^2 x length, which for a hole is what the drill takes out and for a turned
// diameter is the diameter itself, the part's own material. Its removal is the stock round it, which no analysis can state: it depends
// on the stock. A lathe turns that stock off, costed per diameter (turned-diameters.ts). When a mill makes the part (its family set to
// milled, or a mill's route in the comparison) the same stock is milled off, and it is already in the difference above: the piece less
// the part is everything round the diameters. So a turned diameter's stated volume is neither taken off nor milled (isTurnedDiameter).
// Read as a removal it was milled as Bulk Milling of the part's own solid and taken off the stock: the real Lead Screw side shaft's
// diameters state 3873.84 mm^3, more than the whole part (2646.02 mm^3: it is bored), so its features "removed" more than its piece
// held, the volumes were reported as inconsistent, and none of the stock round the diameters was milled.
//
// A face the stock supplies finished needs no case of its own: the piece's volume is already the stock's.

/** Volumes are stated to 0.01 mm^3: a difference under one cubic millimetre is their rounding, neither stock to mill nor a contradiction. */
const ROUNDING_MM3 = 1;

/** The stock around a part, with the three volumes it is the difference of (mm^3). */
export interface StockExcess {
  /** The piece the mill starts from. */
  pieceMm3: number;
  partMm3: number;
  /** What the part's features remove (featureRemovedVolumeMm3). */
  featureRemovedMm3: number;
  /** What Facing takes off the piece's faces (stock/stock-facing.ts); 0 when nothing is faced. */
  facedMm3: number;
  /** What the Bulk Milling operation removes: the rest of the piece. 0 when the part and its features account for all of it, or more. */
  excessMm3: number;
  /** The part and what its features remove come to more than the piece holds, by more than rounding: the volumes contradict each other. */
  inconsistent: boolean;
}

/** A turned outer diameter of the feature graph (Ring:outer_diameter): the volume it states is its own cylinder, not material removed. */
export function isTurnedDiameter(feature: unknown): boolean {
  const f = feature as { feature_type?: unknown; variant?: unknown } | null;
  return f?.feature_type === 'Ring' && f.variant === 'outer_diameter';
}

/**
 * The volume the part's features remove (mm^3): the material_removed_mm3 of every occurrence of every feature of the feature graph, a
 * turned diameter apart (what it states is the part's own material).
 */
export function featureRemovedVolumeMm3(features: readonly unknown[] | null | undefined): number {
  let total = 0;
  for (const feature of features ?? []) {
    if (isTurnedDiameter(feature)) continue;
    const occurrences = (feature as { occurrences?: unknown } | null)?.occurrences;
    for (const occurrence of Array.isArray(occurrences) ? occurrences : []) {
      const mm3 = Number((occurrence as { material_removed_mm3?: unknown } | null)?.material_removed_mm3);
      if (mm3 > 0) total += mm3;
    }
  }
  return total;
}

/** The stock around a part: the piece less the part, less what its features remove and less what is faced off it. Never negative. */
export function stockExcess(volumes: { pieceMm3: number; partMm3: number; featureRemovedMm3: number; facedMm3?: number }): StockExcess {
  const facedMm3 = volumes.facedMm3 ?? 0;
  const rest = volumes.pieceMm3 - volumes.partMm3 - volumes.featureRemovedMm3 - facedMm3;
  return { ...volumes, facedMm3, excessMm3: rest > ROUNDING_MM3 ? rest : 0, inconsistent: rest < -ROUNDING_MM3 };
}
