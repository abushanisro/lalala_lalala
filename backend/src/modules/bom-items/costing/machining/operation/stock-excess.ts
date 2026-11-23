// The stock a mill removes around a part, beyond what the operations on the part's features remove. Pure.
//
// A mill's time is the operations the sequencer plans (operation-sequencer.ts): Facing, then the operations on the part's recognised
// features. None of them takes off the rest of the piece the mill starts from: the allowance on the part's faces, what the stock size has
// over the part, the material outside the part's outline. That rest is milled away by one Bulk Milling operation (the reference catalog's
// "Bulk Milling:Bulk Milling Op//BulkRemoval" of every mill), and its volume is
//
//   stock excess = piece volume - part volume - volume the part's features remove
//
// so no cubic millimetre is milled twice and none is skipped: what a feature's own operation removes is taken off, the rest is the bulk's.
//
// The volume a feature removes is its occurrences' material_removed_mm3, as the CAD engine states it (cad-engine
// machining/machining_feature_recognizer.py, build_machining_feature_graph_v2). Every feature's is taken off, the features split out to
// another machine too, because each stated volume is removed by an operation of the plan or on its own line:
//
//   PocketV2, Slot straight / radial   floor area x depth. Rough Milling is timed on exactly this volume. A pocket that is rotary broached
//                                      or chemically milled, and a slot wire cut after heat treatment, leaves on that process instead.
//   Keyway                             floor area x depth. Obround Slot Milling cuts it (timed by its passes, not by its volume); a keyway
//                                      the broach cuts leaves on the Keyway Broaching line.
//   SimpleHole through / blind / cross / threaded, MultiStepHole counterbore, Edge countersink
//                                      the cylinder pi/4 x D^2 x depth. Drilling, Counterboring and Countersinking cut it (timed by the
//                                      tool's feed); a deep hole leaves on the Gun Drilling or Deep Bore line.
//   MultiStepHole stepped              the cylinders of its steps, drilled step by step.
//   Ring outer_diameter                the cylinder pi/4 x D^2 x length of a turned diameter (a turned part's analysis). A mill has no
//                                      operation for it, so the sequencer times that volume as Bulk Milling: the mill is charged for it
//                                      there, once. It is the diameter's own solid, not stock, so a turned analysis costed on a mill can
//                                      state more than its stock holds: that is the inconsistency reported below.
//
// These state 0, so nothing is taken off for them and what they remove stays in the bulk: a hole pattern, a chamfer, a rounded edge, a
// toroidal groove, gear teeth, and the faces (PlanarFace, CurvedWall, CurvedSurface, Cutout), whose finishing and contouring passes
// follow a surface. Facing is one pass at a fixed time and states no volume either.
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
  /** What the Bulk Milling operation removes: the rest of the piece. 0 when the part and its features account for all of it, or more. */
  excessMm3: number;
  /** The part and what its features remove come to more than the piece holds, by more than rounding: the volumes contradict each other. */
  inconsistent: boolean;
}

/** The volume the part's features remove (mm^3): the material_removed_mm3 of every occurrence of every feature of the feature graph. */
export function featureRemovedVolumeMm3(features: readonly unknown[] | null | undefined): number {
  let total = 0;
  for (const feature of features ?? []) {
    const occurrences = (feature as { occurrences?: unknown } | null)?.occurrences;
    for (const occurrence of Array.isArray(occurrences) ? occurrences : []) {
      const mm3 = Number((occurrence as { material_removed_mm3?: unknown } | null)?.material_removed_mm3);
      if (mm3 > 0) total += mm3;
    }
  }
  return total;
}

/** The stock around a part: the piece less the part and less what its features remove. Never negative. */
export function stockExcess(volumes: { pieceMm3: number; partMm3: number; featureRemovedMm3: number }): StockExcess {
  const rest = volumes.pieceMm3 - volumes.partMm3 - volumes.featureRemovedMm3;
  return { ...volumes, excessMm3: rest > ROUNDING_MM3 ? rest : 0, inconsistent: rest < -ROUNDING_MM3 };
}
