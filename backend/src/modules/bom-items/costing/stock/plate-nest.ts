// The parts one plate makes: rectangles in a grid, a gap between two parts and a margin to the plate's edge, in the better of the two
// orientations. Pure. This is the reference's "COMPUTED" utilisation; nesting the parts' true outlines into each other (its "TRUE_PART",
// the data's defaultUtilizationMethod) is not built.

export interface PlateNest {
  partsPerPlate: number;
  /** The parts along the plate's length and across its width. */
  along: number;
  across: number;
  /** Whether the rectangle's length lies across the plate's width. */
  rotated: boolean;
}

/**
 * Rectangles of `cell` on a plate, `gapMm` between two of them and `edgeMm` to the plate's edge: along a side of S mm,
 * floor((S - 2 edge + gap) / (side + gap)) of them (n parts take n sides and n - 1 gaps). The orientation that makes more parts; neither
 * when the rectangle fits neither way (partsPerPlate 0).
 */
export function gridNest(plate: { lengthMm: number; widthMm: number }, cell: { lengthMm: number; widthMm: number }, gapMm: number, edgeMm: number): PlateNest {
  const fit = (sideMm: number, partMm: number) => Math.max(0, Math.floor((sideMm - 2 * edgeMm + gapMm + 1e-9) / (partMm + gapMm)));
  const lay = (alongMm: number, acrossMm: number, rotated: boolean): PlateNest => {
    const along = fit(plate.lengthMm, alongMm);
    const across = fit(plate.widthMm, acrossMm);
    return { partsPerPlate: along * across, along, across, rotated };
  };
  const straight = lay(cell.lengthMm, cell.widthMm, false);
  const turned = lay(cell.widthMm, cell.lengthMm, true);
  return turned.partsPerPlate > straight.partsPerPlate ? turned : straight;
}
