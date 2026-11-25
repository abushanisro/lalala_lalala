// Formula registry (plastic-molding/formula-registry.ts): F-25 (mold base and plate steel). Change a rule here -> bump its version there.
//
// The mold base a part needs, chosen from memory/Plastic Modeling: the cavities laid out as layoutNumCav says for the cavity count (of the
// layouts it gives a count, the one with the smallest standard base), with
// betweenPartsMoldBorder of steel between neighbouring parts and the runner region coefficient on the width; the edge borders beside them
// (tblEdgeMoldBorderX / Y, the first row whose press force covers the press); and the smallest standard base (tblStandardMoldBaseSizes, in the
// system useMetricOrImperialValues names) that holds the result, either way round. The plate thicknesses, the steel and its price are the tooling
// calculator's formulas (mold-tooling-calculator.ts); this only looks up. A base larger than every standard one (a custom base) is not modelled:
// it is a named gap.
import type { MoldBaseReference } from '../plastic-reference';

export interface MoldBaseChoice {
  layout: { widthWise: number; lengthWise: number; runnerCoefficient: number };
  regionWidthMm: number;
  regionLengthMm: number;
  edgeBorderXMm: number;
  edgeBorderYMm: number;
  requiredWidthMm: number;
  requiredLengthMm: number;
  base: { name: string; widthMm: number; lengthMm: number };
  cavityDepthBorderMm: number;
  coreDepthBorderMm: number;
  /** The Max Press Force (kN) of the tblCavityPlateDepthBorder and tblCorePlateDepthBorder rows read: the rows the depth borders came from. */
  cavityDepthBorderRowKn: number;
  coreDepthBorderRowKn: number;
}

/** The first row whose press force covers the press (the last covers the rest). */
const rowByForce = (rows: ReadonlyArray<{ maxKn: number; mm: number }>, kn: number) => rows.find((r) => kn <= r.maxKn) ?? rows[rows.length - 1];
const byForce = (rows: ReadonlyArray<{ maxKn: number; mm: number }>, kn: number) => rowByForce(rows, kn)?.mm;

export function selectMoldBase(input: {
  /** The part's footprint on the parting plane: its two longest sides, mm. */
  partLengthMm: number;
  partWidthMm: number;
  cavities: number;
  /** The press's clamp force, kN: picks the borders. */
  clampKn: number | null;
  ref: MoldBaseReference;
}): MoldBaseChoice | { missing: string[] } {
  const { ref } = input;
  const missing: string[] = [];
  // Every layout the reference gives the count (4 cavities: 1 x 4, 2 x 2 or 4 x 1): the one whose standard base is smallest is the mold.
  const layouts = ref.layouts.filter((l) => l.cavities === input.cavities);
  if (layouts.length === 0) missing.push(`layoutNumCav has no layout for ${input.cavities} cavities`);
  if (!(input.clampKn != null && input.clampKn > 0)) missing.push('the press clamp force (it picks the mold borders)');
  if (!(input.partLengthMm > 0 && input.partWidthMm > 0)) missing.push('the part footprint (CAD bounding box)');
  if (missing.length > 0 || input.clampKn == null) return { missing };

  const edgeBorderXMm = byForce(ref.edgeBorderXByKn, input.clampKn)!;
  const edgeBorderYMm = byForce(ref.edgeBorderYByKn, input.clampKn)!;
  const sized = layouts.map((layout) => {
    const regionWidthMm = (layout.widthWise * input.partLengthMm + (layout.widthWise - 1) * ref.betweenPartsMm) * layout.runnerCoefficient;
    const regionLengthMm = layout.lengthWise * input.partWidthMm + (layout.lengthWise - 1) * ref.betweenPartsMm;
    const requiredWidthMm = regionWidthMm + 2 * edgeBorderXMm;
    const requiredLengthMm = regionLengthMm + 2 * edgeBorderYMm;
    const base = ref.bases.find((b) => (b.widthMm >= requiredWidthMm && b.lengthMm >= requiredLengthMm) || (b.lengthMm >= requiredWidthMm && b.widthMm >= requiredLengthMm));
    return { layout, regionWidthMm, regionLengthMm, requiredWidthMm, requiredLengthMm, base };
  });
  const fitting = sized.flatMap((s) => (s.base ? [{ ...s, base: s.base }] : []));
  if (fitting.length === 0) {
    // The most compact layout names the size a custom base would need.
    const s = sized.reduce((a, b) => (b.requiredWidthMm * b.requiredLengthMm < a.requiredWidthMm * a.requiredLengthMm ? b : a));
    return { missing: [`no standard mold base in tblStandardMoldBaseSizes (${ref.system}) holds ${Math.round(s.requiredWidthMm)} x ${Math.round(s.requiredLengthMm)} mm: a custom base is not modelled`] };
  }
  const area = (s: (typeof fitting)[number]) => s.base.widthMm * s.base.lengthMm;
  const { layout, regionWidthMm, regionLengthMm, requiredWidthMm, requiredLengthMm, base } = fitting.reduce((a, b) => (area(b) < area(a) ? b : a));
  const cavityDepth = rowByForce(ref.cavityDepthBorderByKn, input.clampKn)!;
  const coreDepth = rowByForce(ref.coreDepthBorderByKn, input.clampKn)!;
  return {
    layout: { widthWise: layout.widthWise, lengthWise: layout.lengthWise, runnerCoefficient: layout.runnerCoefficient },
    regionWidthMm, regionLengthMm, edgeBorderXMm, edgeBorderYMm, requiredWidthMm, requiredLengthMm, base,
    cavityDepthBorderMm: cavityDepth.mm, coreDepthBorderMm: coreDepth.mm,
    cavityDepthBorderRowKn: cavityDepth.maxKn, coreDepthBorderRowKn: coreDepth.maxKn,
  };
}
