// The board a PCB route is priced for, from what the analysis measured and what the Cost Guide states. Pure.
//
// A board set (Gerber, drill file, Pick Place: cad-engine pcb/) measures the outline, the copper layer count, the holes by diameter and
// plating, the solder mask and legend sides, the nets and the placements. A STEP model measures only the outline, the thickness and the
// drilled holes. What neither states (the copper weight, the finish, a STEP board's layer count) comes from the Cost Guide, else from the
// reference's default (memory/PCBA/pcb_variables.csv), else it is missing. Every value carries where it came from, and the Cost Guide
// shows it: a default is never presented as measured.

/** Where a board value came from. */
export type PcbBasis = 'board_files' | 'cad_model' | 'cost_guide' | 'reference_default' | 'derived';

export interface PcbFact<T> {
  value: T;
  basis: PcbBasis;
  /** What stated it: the file or measurement, the Cost Guide field, or the reference variable. */
  source: string;
}

export const PCB_FINISHES = ['hasl', 'enig', 'osp'] as const;
export type PcbFinish = (typeof PCB_FINISHES)[number];
export const PCB_FINISH_LABEL: Readonly<Record<PcbFinish, string>> = {
  hasl: 'Hot Air Solder Leveling', enig: 'Electroless Nickel Immersion Gold', osp: 'Organic Solderability Preservative',
};

/** The copper weights the reference prices (oz/ft²): its cores and foils (memory/PCBA/raw_materials.csv). */
export const PCB_COPPER_OZ = [0.5, 1, 1.5, 2] as const;

export interface PcbHoleGroup { diameterMm: number; plated: boolean; count: number }
export type BoardSide = 'top' | 'bottom';
export interface PcbPlacement { side: BoardSide; packageClass: string; count: number; footprint?: string }
export interface PcbThtPart { label: string; count: number; jointsPerPart: number }

/** What the analysis measured: a board set's feature graph (pcbGeometry) or a STEP board's measurements, in one shape. */
export interface PcbMeasured {
  source: 'board_files' | 'cad_model';
  /** The files or model it was measured from, for the facts' sources. */
  sourceName: string;
  outline?: { lengthMm: number; widthMm: number; areaMm2?: number | null } | null;
  /** The outline's own path length (mm), when measured; else the bounding box's perimeter is used and said. */
  outlinePerimeterMm?: number | null;
  thicknessMm?: number | null;
  layers?: number | null;
  holes?: readonly PcbHoleGroup[] | null;
  soldermask?: { top?: boolean; bottom?: boolean } | null;
  silkscreen?: { top?: boolean; bottom?: boolean } | null;
  /** Electrical nodes a test touches: the pins on nets (connectivity.pins). */
  pins?: number | null;
  /** The paste openings (SMD pads) on both sides, mm²: the pads a surface finish covers. */
  pasteAreaMm2?: number | null;
  /** The paste openings of each side, mm² (the stencil of that side prints them). */
  pasteAreaBySideMm2?: { top?: number | null; bottom?: number | null } | null;
  /** The copper on the outer layers, both sides, mm². */
  copperAreaMm2?: number | null;
  nets?: number | null;
  placements?: readonly PcbPlacement[] | null;
  thtParts?: readonly PcbThtPart[] | null;
  sidesPopulated?: readonly BoardSide[] | null;
  /** The bodies a 3D model shows standing on each side of the board (a model does not say what they are). */
  modelComponents?: { top: number; bottom: number } | null;
  /** What a measurement's source says beside a value it states differently (a model's holes: their plating is not stated). */
  notes?: { holes?: string; perimeter?: string } | null;
}

/** The Cost Guide's board values (scenario overrides), each optional. */
export interface PcbOverrides {
  layers?: number | null;
  thicknessMm?: number | null;
  outerCopperOz?: number | null;
  innerCopperOz?: number | null;
  finish?: PcbFinish | null;
  soldermaskSides?: number | null;
  silkscreenSides?: number | null;
  /** Points the electrical test touches, when the board set gives no nets. */
  testPoints?: number | null;
  /** tblLayerMaterialType Board Preference (1 = copper foil outside, cores inside). */
  stackupPreference?: number | null;
  viaPlugging?: boolean | null;
}

/** The reference defaults the part falls back on (pcb_variables). */
export interface PcbDefaults {
  thicknessMm: number | null;
  copperOz: number | null;
  soldermaskSides: number | null;
  viaPlugging: boolean | null;
}

export interface PcbPart {
  lengthMm: PcbFact<number>;
  widthMm: PcbFact<number>;
  areaMm2: PcbFact<number>;
  perimeterMm: PcbFact<number>;
  thicknessMm: PcbFact<number>;
  layers: PcbFact<number>;
  outerCopperOz: PcbFact<number>;
  /** Null on a board of 1 or 2 layers (no inner copper). */
  innerCopperOz: PcbFact<number> | null;
  finish: PcbFact<PcbFinish>;
  holes: PcbFact<readonly PcbHoleGroup[]>;
  soldermaskSides: PcbFact<number>;
  silkscreenSides: PcbFact<number>;
  /** Points an electrical test touches; null when nothing states it (the flying probe then cannot be timed). */
  testPoints: PcbFact<number> | null;
  stackupPreference: PcbFact<number>;
  viaPlugging: PcbFact<boolean>;
  /** The paste openings (SMD pads), mm²; null when the board files have no paste layer. */
  pasteAreaMm2: number | null;
  /** The outer copper, mm²; null when not measured. */
  copperAreaMm2: number | null;
  /** The paste openings of each side, mm²; null when the board files have no paste layer. */
  pasteAreaBySideMm2: { top?: number; bottom?: number } | null;
  /** The nets with pins the board files trace (what an in-circuit fixture puts a nail on); null when not traced. */
  nets: PcbFact<number> | null;
  /** Where the placements and through-hole parts were read from (for the lines' sources). */
  placementsSource: string | null;
  placements: readonly PcbPlacement[];
  thtParts: readonly PcbThtPart[];
  sidesPopulated: readonly BoardSide[];
  /** The bodies a 3D model shows on each side; null when measured from board files or not stated. */
  modelComponents: { top: number; bottom: number } | null;
}

const positive = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;
const wholePositive = (v: unknown): v is number => positive(v) && Number.isInteger(v);
const sides = (s: { top?: boolean; bottom?: boolean } | null | undefined) => (s ? Number(s.top === true) + Number(s.bottom === true) : null);

/** The board as the routes take it, or what is missing (named for the Cost Guide). */
export function resolvePcbPart(measured: PcbMeasured | null, o: PcbOverrides, d: PcbDefaults): { part: PcbPart | null; missing: string[] } {
  const missing: string[] = [];
  if (!measured?.outline || !positive(measured.outline.lengthMm) || !positive(measured.outline.widthMm)) {
    return { part: null, missing: ['the board outline: upload the board files (Gerber set with its outline layer) or a STEP model of the board, then press Refresh analysis'] };
  }
  const from = measured.source;
  const src = measured.sourceName;
  const fact = <T>(value: T, basis: PcbBasis, source: string): PcbFact<T> => ({ value, basis, source });
  const [length, width] = [Math.max(measured.outline.lengthMm, measured.outline.widthMm), Math.min(measured.outline.lengthMm, measured.outline.widthMm)];
  const area = positive(measured.outline.areaMm2)
    ? fact(measured.outline.areaMm2, from, `${src}: the area the outline encloses`)
    : fact(length * width, 'derived', 'the outline\'s bounding box (no enclosed area measured)');
  const perimeter = positive(measured.outlinePerimeterMm)
    ? fact(measured.outlinePerimeterMm, from, `${src}: ${measured.notes?.perimeter ?? 'the outline path'}`)
    : fact(2 * (length + width), 'derived', 'the outline\'s bounding-box perimeter');

  // A stated value wins over a measured one only where the files cannot state it (thickness, copper, finish); the Cost Guide's layer count
  // replaces a STEP board's (which states none) and is checked against a board set's.
  const layers = wholePositive(o.layers)
    ? fact(o.layers, 'cost_guide', 'Cost Guide: layers')
    : wholePositive(measured.layers) ? fact(measured.layers, from, `${src}: copper layer files counted`) : null;
  if (!layers) missing.push('the number of copper layers: set Layers in the Cost Guide (a STEP model does not show them)');
  const thickness = positive(o.thicknessMm)
    ? fact(o.thicknessMm, 'cost_guide', 'Cost Guide: board thickness')
    : positive(measured.thicknessMm) ? fact(measured.thicknessMm, from, `${src}: the board's thickness`)
      : positive(d.thicknessMm) ? fact(d.thicknessMm, 'reference_default', 'PCB variable defaultBoardThickness') : null;
  if (!thickness) missing.push('the board thickness: set it in the Cost Guide');
  const oz = (v: number | null | undefined, label: string): PcbFact<number> | null => {
    if (v != null && (PCB_COPPER_OZ as readonly number[]).includes(v)) return fact(v, 'cost_guide', `Cost Guide: ${label}`);
    if (d.copperOz != null && (PCB_COPPER_OZ as readonly number[]).includes(d.copperOz)) return fact(d.copperOz, 'reference_default', 'PCB variable defaultCopperLayerWeight');
    return null;
  };
  const outer = oz(o.outerCopperOz, 'outer copper weight');
  if (!outer) missing.push(`the outer copper weight: one of ${PCB_COPPER_OZ.join(', ')} oz (Cost Guide)`);
  const inner = layers && layers.value > 2 ? oz(o.innerCopperOz, 'inner copper weight') : null;
  if (layers && layers.value > 2 && !inner) missing.push(`the inner copper weight: one of ${PCB_COPPER_OZ.join(', ')} oz (Cost Guide)`);
  const finish = o.finish && (PCB_FINISHES as readonly string[]).includes(o.finish)
    ? fact(o.finish, 'cost_guide', 'Cost Guide: surface finish')
    : fact<PcbFinish>('hasl', 'reference_default', 'Hot Air Solder Leveling: the finish the reference board takes when none is stated');
  const holes = (measured.holes ?? []).filter((h) => positive(h.diameterMm) && wholePositive(h.count));
  const holesFact = fact<readonly PcbHoleGroup[]>(holes, measured.holes ? from : 'derived', measured.holes ? `${src}: ${measured.notes?.holes ?? 'drilled holes by diameter and plating'}` : 'no drill data: no holes');
  const maskSides = o.soldermaskSides != null && [0, 1, 2].includes(o.soldermaskSides)
    ? fact(o.soldermaskSides, 'cost_guide', 'Cost Guide: solder mask sides')
    : sides(measured.soldermask) != null && from === 'board_files' ? fact(sides(measured.soldermask)!, from, `${src}: solder mask layers present`)
      : fact(d.soldermaskSides ?? 2, 'reference_default', 'PCB variable defaultNumSolderMaskSides');
  const legendSides = o.silkscreenSides != null && [0, 1, 2].includes(o.silkscreenSides)
    ? fact(o.silkscreenSides, 'cost_guide', 'Cost Guide: legend (silkscreen) sides')
    : sides(measured.silkscreen) != null && from === 'board_files' ? fact(sides(measured.silkscreen)!, from, `${src}: legend layers present`)
      : fact(maskSides.value, 'derived', 'as many legend sides as solder mask sides (nothing states them)');
  const testPoints = wholePositive(o.testPoints)
    ? fact(o.testPoints, 'cost_guide', 'Cost Guide: test points')
    : wholePositive(measured.pins) ? fact(measured.pins, from, `${src}: pins on nets traced through the copper`) : null;
  const preference = wholePositive(o.stackupPreference) ? fact(o.stackupPreference, 'cost_guide', 'Cost Guide: stack-up preference') : fact(1, 'reference_default', 'tblLayerMaterialType Board Preference 1 (copper foil outside, cores inside)');
  const plugging = typeof o.viaPlugging === 'boolean'
    ? fact(o.viaPlugging, 'cost_guide', 'Cost Guide: via plugging')
    : fact(d.viaPlugging === true, 'reference_default', 'PCB variable defaultEnableViaPlugging');
  if (missing.length || !layers || !thickness || !outer) return { part: null, missing };
  return {
    part: {
      lengthMm: fact(length, from, `${src}: the outline's long side`), widthMm: fact(width, from, `${src}: the outline's short side`),
      areaMm2: area, perimeterMm: perimeter, thicknessMm: thickness, layers, outerCopperOz: outer, innerCopperOz: inner, finish, holes: holesFact,
      soldermaskSides: maskSides, silkscreenSides: legendSides, testPoints, stackupPreference: preference, viaPlugging: plugging,
      pasteAreaMm2: positive(measured.pasteAreaMm2) ? measured.pasteAreaMm2 : null, copperAreaMm2: positive(measured.copperAreaMm2) ? measured.copperAreaMm2 : null,
      pasteAreaBySideMm2: pasteBySide(measured.pasteAreaBySideMm2),
      nets: wholePositive(measured.nets) ? fact(measured.nets, from, `${src}: nets with pins traced through the copper`) : null,
      placementsSource: measured.placements?.length || measured.thtParts?.length ? `${src}: the Pick Place file` : null,
      placements: measured.placements ?? [], thtParts: measured.thtParts ?? [], sidesPopulated: measured.sidesPopulated ?? [],
      modelComponents: measured.modelComponents ?? null,
    },
    missing: [],
  };
}

function pasteBySide(p: PcbMeasured['pasteAreaBySideMm2']): PcbPart['pasteAreaBySideMm2'] {
  if (!p) return null;
  const out: { top?: number; bottom?: number } = {};
  if (positive(p.top)) out.top = p.top;
  if (positive(p.bottom)) out.bottom = p.bottom;
  return out.top != null || out.bottom != null ? out : null;
}

/** Drilled hits on one board, and the distinct drill diameters (each a tool change). */
export function holeTotals(holes: readonly PcbHoleGroup[]): { hits: number; plated: number; tools: number } {
  return {
    hits: holes.reduce((s, h) => s + h.count, 0),
    plated: holes.filter((h) => h.plated).reduce((s, h) => s + h.count, 0),
    tools: new Set(holes.map((h) => Math.round(h.diameterMm * 1000))).size,
  };
}
