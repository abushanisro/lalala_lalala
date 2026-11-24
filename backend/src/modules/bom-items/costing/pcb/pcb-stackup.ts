// A board's layer build-up, from the reference's stack-up tables (memory/PCBA/Lookup). Pure.
//
//   tblLayerMaterialType   the material of each copper layer at a layer count and board preference: 1P (a single-clad core), 2PT / 2PB (the top
//                          and bottom copper of a double-clad core), CU (a copper foil laminated over prepreg)
//   tblDielectricThickness at a layer count and finished thickness: the cores, the prepreg spaces between them and each core's dielectric,
//                          by copper weight
//   tblPrepregThickness    the glass styles and their pressed thickness
// What the stack-up decides: how many cores are imaged as inner layers, how many foils, how many prepreg spaces and how thick each is, so the
// materials can be priced and the inner-layer and lamination steps run.
import type { SandReference } from '../casting/sand/sand-reference';

export type LayerMaterial = '1P' | '2PT' | '2PB' | 'CU';

export interface PcbStackup {
  layers: number;
  preference: number;
  /** The material of each copper layer, top to bottom. */
  sequence: LayerMaterial[];
  /** Double-clad cores (2PT + 2PB) and single-clad cores (1P). */
  doubleCores: number;
  singleCores: number;
  /** Copper foils laminated over prepreg. */
  foils: number;
  /** Cores whose copper is an inner layer: imaged and etched before lamination. */
  innerCores: number;
  /** Prepreg spaces: between every two neighbouring cores or foils. 0 for a board of one core. */
  prepregSpaces: number;
  /** Each core's dielectric (mm) at the outer copper weight, per tblDielectricThickness; null when the table has no row. */
  coreDielectricMm: number | null;
  /** The prepreg each space takes (mm): what the finished thickness leaves after the cores and the copper, shared among the spaces. */
  prepregPerSpaceMm: number;
  /** The tblDielectricThickness row it was read from. */
  dielectricRow: { layers: number; thicknessMm: number } | null;
  /** Pressed: a board of more than one core or any foil goes through lay-up and lamination. */
  laminated: boolean;
}

const OZ_COLUMN: Readonly<Record<number, string>> = {
  0.5: 'Dielectric Thickness For Copper Weight0_5oz (mm)', 1: 'Dielectric Thickness For Copper Weight1_0oz (mm)',
  1.5: 'Dielectric Thickness For Copper Weight1_5oz (mm)', 2: 'Dielectric Thickness For Copper Weight2_0oz (mm)',
};
/** Copper thickness of one ounce per square foot (mm): 1.37 mil (IPC-6012), the thickness raw_materials gives 1ozCu (0.035 mm). */
export const COPPER_MM_PER_OZ = 0.035;

const n = (v: unknown): number | null => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

/** The stack-up of a board, or why the reference cannot build one. */
export function pcbStackup(ref: SandReference, layers: number, thicknessMm: number, outerOz: number, innerOz: number | null, preference: number): { stackup: PcbStackup | null; missing: string[] } {
  const types = ref.table('tblLayerMaterialType');
  if (types.length === 0) return { stackup: null, missing: ['PCB lookup tblLayerMaterialType (not staged)'] };
  const atLayers = types.filter((r) => n(r['Number Of Layers']) === layers);
  if (atLayers.length === 0) {
    const counts = [...new Set(types.map((r) => n(r['Number Of Layers'])).filter((x): x is number => x != null))].sort((a, b) => a - b);
    return { stackup: null, missing: [`a ${layers}-layer build: tblLayerMaterialType builds ${counts.join(', ')} layers`] };
  }
  const row = atLayers.find((r) => n(r['Board Preference']) === preference) ?? atLayers.find((r) => n(r['Board Preference']) === 1) ?? atLayers[0]!;
  const sequence = Array.from({ length: 12 }, (_, i) => String(row[`Layer${String(i + 1).padStart(2, '0')}`] ?? '').trim()).filter(Boolean) as LayerMaterial[];
  if (sequence.length !== layers || sequence.some((m) => !['1P', '2PT', '2PB', 'CU'].includes(m))) {
    return { stackup: null, missing: [`tblLayerMaterialType "${String(row['Name'])}": its layers are not ${layers} known materials`] };
  }
  const doubleCores = sequence.filter((m) => m === '2PT').length;
  const singleCores = sequence.filter((m) => m === '1P').length;
  const foils = sequence.filter((m) => m === 'CU').length;
  // A core's copper is an inner layer unless it is the board's top or bottom layer (a 1- or 2-layer board is one core, imaged as its outer layers).
  const innerCores = layers <= 2 ? 0 : doubleCores - (sequence[0] === '2PT' ? 1 : 0);
  // Prepreg goes between every two neighbouring laminates: cores and foils are the laminates, a core counted once.
  const laminates = doubleCores + singleCores + foils;
  const prepregSpaces = Math.max(0, laminates - 1);

  // The dielectric table: the row at the layer count and the nearest finished thickness at or above the board's, with this many cores.
  const dielectric = ref.table('tblDielectricThickness')
    .filter((r) => n(r['Number Layers']) === layers && n(r['Num Cores']) === doubleCores + singleCores)
    .map((r) => ({ r, t: n(r['Total Board Thickness (mm)'])! }))
    .filter((x) => x.t != null)
    .sort((a, b) => Math.abs(a.t - thicknessMm) - Math.abs(b.t - thicknessMm) || b.t - a.t)[0];
  const column = OZ_COLUMN[outerOz];
  const coreDielectricMm = dielectric && column ? n(dielectric.r[column]) : null;
  const copperMm = (2 * outerOz + Math.max(0, layers - 2) * (innerOz ?? outerOz)) * COPPER_MM_PER_OZ;
  const cores = doubleCores + singleCores;
  const left = thicknessMm - copperMm - cores * (coreDielectricMm ?? 0);
  return {
    stackup: {
      layers, preference: Number(row['Board Preference'] ?? preference), sequence, doubleCores, singleCores, foils, innerCores, prepregSpaces,
      coreDielectricMm, prepregPerSpaceMm: prepregSpaces > 0 ? Math.max(0, left / prepregSpaces) : 0,
      dielectricRow: dielectric ? { layers, thicknessMm: dielectric.t } : null,
      laminated: laminates > 1,
    },
    missing: [],
  };
}

/** The prepreg plies a space takes: the fewest plies of one glass style whose pressed thickness is closest to the space (tblPrepregThickness). */
export function prepregPlies(ref: SandReference, spaceMm: number): { style: string; plies: number; nominalMm: number } | null {
  if (!(spaceMm > 0)) return null;
  const styles = ref.table('tblPrepregThickness')
    .map((r) => ({ style: String(r['Type']), nominal: n(r['Nominal Thickness (mm)']) }))
    .filter((s): s is { style: string; nominal: number } => s.nominal != null && s.nominal > 0);
  let best: { style: string; plies: number; nominalMm: number; error: number } | null = null;
  for (const s of styles) {
    const plies = Math.max(1, Math.round(spaceMm / s.nominal));
    const error = Math.abs(plies * s.nominal - spaceMm);
    if (!best || error < best.error - 1e-9 || (Math.abs(error - best.error) <= 1e-9 && plies < best.plies)) best = { style: s.style, plies, nominalMm: s.nominal, error };
  }
  return best ? { style: best.style, plies: best.plies, nominalMm: best.nominalMm } : null;
}
