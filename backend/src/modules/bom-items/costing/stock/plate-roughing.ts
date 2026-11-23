// How a part cut from PLATE is separated from the plate, and what is left round it for the mill: the reference's three roughing techniques
// (memory/Stock Maching defaultRoughingTechnique: All Bulk Milling, Perimeter Milling with Dropoff, Plate Cutting with Dropoff). Pure.
//
//   All Bulk Milling          a rectangular blank is sawn out of the plate and the mill removes everything round the part
//                             (stock-selection.ts fromPlate: this file changes nothing of it).
//   Perimeter Milling with    the plate goes on the mill whole; the mill cuts round each part's outline through the plate's thickness,
//   Drop-off                  and the rest of the plate drops off. Nothing is sawn.
//   Plate Cutting with        the outline, with the stock allowance left on it for the mill, is cut out of the plate by a plate cutting
//   Drop-off                  process (laser, plasma, oxyfuel, waterjet); the cut blank goes to the mill. Nothing is sawn.
//
// The data states the techniques' names, the plate a mill takes, each cutting process's lead-in allowance and the spacing between cut parts
// (tblPartSpacing). It has no formula for the nest, the cut or the stock left: those are the engine's own (user decision 2026-11-22), said
// on the quote. The data's kerf multipliers (laserKerf, plasmaKerf, oxyfuelKerf, waterjetKerf) and kerf width limits (kerfWidthMax*) are
// NOT used: the data gives no formula for them, and tblPartSpacing already states the gap between two cut parts.
import { gridNest, type PlateNest } from './plate-nest';
import { grownOutline, type OutlineShape, type PlateOutline } from './plate-outline';
import { virtualPlateNote, type StockOption, type StockPart } from './stock-selection';
import { snapUp, type PreferredSize } from './stock-sizing';

import type { StockReference } from './stock-reference';
import type { SandReference } from '../casting/sand/sand-reference';

export type RoughingTechnique = 'all_bulk_milling' | 'perimeter_milling_dropoff' | 'plate_cutting_dropoff';
export const ROUGHING_TECHNIQUES: readonly RoughingTechnique[] = ['all_bulk_milling', 'perimeter_milling_dropoff', 'plate_cutting_dropoff'];
export const ROUGHING_TECHNIQUE_LABEL: Readonly<Record<RoughingTechnique, string>> = {
  all_bulk_milling: 'All Bulk Milling', perimeter_milling_dropoff: 'Perimeter Milling with Drop-off', plate_cutting_dropoff: 'Plate Cutting with Drop-off',
};

/** The technique a text of the data names (defaultRoughingTechnique), whatever its case, spacing and hyphens; null for any other text. */
export function roughingTechniqueOf(text: string | null | undefined): RoughingTechnique | null {
  const words = (text ?? '').toLowerCase().replace(/[^a-z]+/g, '');
  if (words === 'allbulkmilling') return 'all_bulk_milling';
  if (words === 'perimetermillingwithdropoff') return 'perimeter_milling_dropoff';
  if (words === 'platecuttingwithdropoff') return 'plate_cutting_dropoff';
  return null;
}

/** The plate cutting processes, by the names tblPartSpacing lists them under. */
export const PLATE_CUT_PROCESSES = ['Laser Cut', 'Plasma Cut', 'Oxyfuel Cut', 'Waterjet Cut'] as const;
export type PlateCutProcess = (typeof PLATE_CUT_PROCESSES)[number];

/** The lead-in and lead-out a process adds to its cut round a part (the data's "perimeter cutting allowance"), by its variable. */
const PERIMETER_ALLOWANCE_VARIABLE: Readonly<Record<PlateCutProcess, string>> = {
  'Laser Cut': 'defaultLaserPerimeterAllowance', 'Plasma Cut': 'defaultPlasmaPerimeterAllowance',
  'Oxyfuel Cut': 'defaultOxyFuelPerimeterAllowance', 'Waterjet Cut': 'defaultWaterjetPerimeterAllowance',
};
export const perimeterAllowanceVariable = (process: PlateCutProcess): string => PERIMETER_ALLOWANCE_VARIABLE[process];

export interface PartSpacingRow { process: string; thicknessMm: number; spacingMm: number }

/** What the drop-off techniques read of the staged Stock Machining data. */
export interface RoughingReference {
  /** The largest plate a mill takes for perimeter milled parts (maxPlateLengthForNestedMilledParts x maxPlateWidthForNestedMilledParts). */
  nestedMilledPlate: { lengthMm: number; widthMm: number };
  perimeterAllowanceMm: Readonly<Record<PlateCutProcess, number>>;
  /** tblPartSpacing: the gap between two cut parts, by process and plate thickness. */
  partSpacing: readonly PartSpacingRow[];
}

/** The drop-off techniques' reference values, or what the staged data lacks of them, each named. */
export function roughingReference(ref: SandReference): { reference: RoughingReference | null; missing: string[] } {
  const numbers = ['maxPlateLengthForNestedMilledParts', 'maxPlateWidthForNestedMilledParts', ...PLATE_CUT_PROCESSES.map(perimeterAllowanceVariable)];
  const partSpacing = ref.table('tblPartSpacing')
    .map((r) => ({ process: String(r['Process'] ?? '').trim(), thicknessMm: Number(r['Thickness (mm)']), spacingMm: Number(r['Part Spacing (mm)']) }))
    .filter((r) => r.process !== '' && r.thicknessMm > 0 && r.spacingMm >= 0);
  const missing = [
    ...numbers.filter((n) => ref.number(n) == null).map((n) => `Stock Machining variable ${n}`),
    ...(partSpacing.length === 0 ? ['Stock Machining lookup tblPartSpacing (migration 1114)'] : []),
  ];
  if (missing.length) return { reference: null, missing };
  const allowance = (process: PlateCutProcess) => ref.number(perimeterAllowanceVariable(process))!;
  return {
    reference: {
      nestedMilledPlate: { lengthMm: ref.number('maxPlateLengthForNestedMilledParts')!, widthMm: ref.number('maxPlateWidthForNestedMilledParts')! },
      perimeterAllowanceMm: {
        'Laser Cut': allowance('Laser Cut'), 'Plasma Cut': allowance('Plasma Cut'), 'Oxyfuel Cut': allowance('Oxyfuel Cut'), 'Waterjet Cut': allowance('Waterjet Cut'),
      },
      partSpacing,
    },
    missing: [],
  };
}

/**
 * The gap between two parts a process cuts out of plate of this thickness: the table's first row of the process at or above the thickness
 * (each row is the upper bound of its bracket). Null when the table lists the process no thicker than that, or not at all: the process
 * then cannot cut the plate.
 */
export function partSpacingMm(rows: readonly PartSpacingRow[], process: string, thicknessMm: number): number | null {
  const own = rows.filter((r) => r.process === process).sort((a, b) => a.thicknessMm - b.thicknessMm);
  return own.find((r) => r.thicknessMm >= thicknessMm - 1e-9)?.spacingMm ?? null;
}

/** A plate part's stock under a drop-off technique: what replaces the sawn blank of All Bulk Milling. */
export interface DropoffStock {
  technique: Exclude<RoughingTechnique, 'all_bulk_milling'>;
  /** The process that cuts the blank out of the plate; null for perimeter milling (the mill cuts it). */
  process: PlateCutProcess | null;
  /** The plate the parts are nested on. `virtual`: a plate cut to the blank, when the blank is larger than the standard plate. */
  plate: { lengthMm: number; widthMm: number; virtual: boolean };
  /** The nest, with the gap between two parts and the margin to the plate's edge (mm). */
  nest: PlateNest & { gapMm: number; edgeMm: number };
  /** The piece left inside the cut, which the mill starts from: its outline through the plate's thickness. */
  piece: OutlineShape & { thicknessMm: number; volumeMm3: number };
  /** The cut round one part: its length (the lead-in and lead-out included) and the pierces it starts from. */
  cut: { lengthMm: number; pierces: number };
  purchasedVolumeMm3: number;
  utilizationPct: number;
  /** What the quote says of this stock. */
  notes: string[];
}
export type DropoffStockResult = DropoffStock | { unavailable: string };
export const isDropoffStock = (d: DropoffStockResult): d is DropoffStock => !('unavailable' in d);

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const isPlate = (o: StockOption) => o.form === 'plate' || o.form === 'billet';

/** Why the measured outline cannot be cut out of this plate option; null when it can. */
function outlineMismatch(part: StockPart, outline: PlateOutline): string | null {
  // The stock model lays the part in the plate on its section's smaller side (stock-selection.ts: the plate's thickness is the part's
  // height plus the allowance). The outline is what is seen along the part's thinnest direction, which is that side for every part but
  // one shorter along its axis than its section is high (a disc): its outline is then of another view, and is not this plate's.
  if (Math.abs(outline.thicknessMm - part.heightMm) > 0.01) {
    return `the plate outline was measured across the part's ${r3(outline.thicknessMm)} mm thickness, and the stock model lays the part in the plate on its `
      + `${r3(part.heightMm)} mm side: the outline is not this plate's`;
  }
  return null;
}

const COMPUTED_NEST = 'The parts are nested as their outlines\' rectangles in a grid (the reference\'s COMPUTED utilisation): nesting the true outlines into '
  + 'each other is not built, so a plate may make more parts than is priced.';
const KERF_NOT_USED = 'The data\'s kerf multipliers (laserKerf, plasmaKerf, oxyfuelKerf, waterjetKerf) and kerf width limits (kerfWidthMax*) are not used: '
  + 'the data gives no formula for them, and tblPartSpacing states the gap between two cut parts.';

function dropoff(
  part: StockPart, thicknessMm: number,
  d: Pick<DropoffStock, 'technique' | 'process' | 'plate' | 'nest' | 'cut' | 'notes'> & { piece: OutlineShape },
): DropoffStock {
  const volumeMm3 = d.piece.areaMm2 * thicknessMm;
  const purchasedVolumeMm3 = (d.plate.lengthMm * d.plate.widthMm * thicknessMm) / d.nest.partsPerPlate;
  return {
    ...d, piece: { ...d.piece, thicknessMm, volumeMm3 }, purchasedVolumeMm3,
    utilizationPct: purchasedVolumeMm3 > 0 ? Math.min(100, (part.volumeMm3 / purchasedVolumeMm3) * 100) : 0,
  };
}

/**
 * Perimeter Milling with Drop-off: the part's outline rectangle in a grid on the plate a mill takes, the perimeter cut's width (the
 * cutter's diameter) between two parts and to the plate's edge. The mill cuts round the outline itself, so the piece left is the outline
 * through the plate. A part whose rectangle does not fit that plate cannot use the technique: the plate is not made larger.
 */
export function perimeterMilledStock(input: {
  option: StockOption; part: StockPart; outline: PlateOutline; stock: StockReference; reference: RoughingReference; cutterDiameterMm: number;
}): DropoffStockResult {
  const { option, part, outline, reference, cutterDiameterMm: d } = input;
  if (!isPlate(option)) return { unavailable: 'the stock is not plate' };
  const mismatch = outlineMismatch(part, outline);
  if (mismatch) return { unavailable: mismatch };
  const plate = {
    lengthMm: Math.min(input.stock.plate.lengthMm, reference.nestedMilledPlate.lengthMm),
    widthMm: Math.min(input.stock.plate.widthMm, reference.nestedMilledPlate.widthMm), virtual: false,
  };
  const nest = gridNest(plate, outline.rect, d, d);
  if (nest.partsPerPlate < 1) {
    return {
      unavailable: `the part's ${r3(outline.rect.lengthMm)} x ${r3(outline.rect.widthMm)} mm outline with a ${r3(d)} mm cut round it does not fit the `
        + `${plate.lengthMm} x ${plate.widthMm} mm plate a mill takes (maxPlateLengthForNestedMilledParts x maxPlateWidthForNestedMilledParts)`,
    };
  }
  return dropoff(part, option.aMm, {
    technique: 'perimeter_milling_dropoff', process: null, plate, nest: { ...nest, gapMm: d, edgeMm: d },
    piece: { perimeterMm: outline.perimeterMm, areaMm2: outline.areaMm2, rect: outline.rect },
    // One cutter diameter of lead: the cutter enters the plate beside the outline before it follows it.
    cut: { lengthMm: outline.perimeterMm + d, pierces: 1 },
    notes: [
      `Perimeter Milling with Drop-off: the ${plate.lengthMm} x ${plate.widthMm} mm plate is loaded on the mill whole and the mill cuts round each part's outline `
        + `through its ${r3(option.aMm)} mm thickness; nothing is sawn. ${nest.partsPerPlate} per plate, the ${r3(d)} mm cutter's width between two parts and to the `
        + 'plate\'s edge.',
      COMPUTED_NEST,
    ],
  });
}

/**
 * Plate Cutting with Drop-off by one process: the outline grown by the stock allowance is cut out of the standard plate, the blanks'
 * rectangles in a grid tblPartSpacing's gap apart (no margin is added at the plate's edge: the blank already carries the allowance). A
 * blank the standard plate cannot hold is cut from a plate of its own size, as a sawn blank is. The cut is the grown outline plus the
 * process's lead-in and lead-out, from one pierce; the openings through the part are left for the mill.
 */
export function plateCutStock(input: {
  option: StockOption; part: StockPart; outline: PlateOutline; stock: StockReference; reference: RoughingReference; process: PlateCutProcess;
}): DropoffStockResult {
  const { option, part, outline, reference, process } = input;
  if (!isPlate(option)) return { unavailable: 'the stock is not plate' };
  const mismatch = outlineMismatch(part, outline);
  if (mismatch) return { unavailable: mismatch };
  const gapMm = partSpacingMm(reference.partSpacing, process, option.aMm);
  if (gapMm == null) return { unavailable: `tblPartSpacing lists no ${process} spacing for ${r3(option.aMm)} mm plate` };
  const a = option.allowancePerSideMm;
  const blank = grownOutline(outline, a);
  const standard = gridNest(input.stock.plate, blank.rect, gapMm, 0);
  const virtual = standard.partsPerPlate < 1;
  const plate = virtual ? { ...blank.rect, virtual } : { lengthMm: input.stock.plate.lengthMm, widthMm: input.stock.plate.widthMm, virtual };
  const nest = virtual ? { partsPerPlate: 1, along: 1, across: 1, rotated: false } : standard;
  const leadMm = reference.perimeterAllowanceMm[process];
  return dropoff(part, option.aMm, {
    technique: 'plate_cutting_dropoff', process, plate, nest: { ...nest, gapMm, edgeMm: 0 }, piece: blank,
    cut: { lengthMm: blank.perimeterMm + leadMm, pierces: 1 },
    notes: [
      `Plate Cutting with Drop-off: ${process} cuts the part's outline, with the ${r3(a)} mm stock allowance left on it, out of the ${r3(option.aMm)} mm plate; `
        + `nothing is sawn. ${virtual
          ? `The ${r3(blank.rect.lengthMm)} x ${r3(blank.rect.widthMm)} mm blank is larger than the standard ${input.stock.plate.lengthMm} x ${input.stock.plate.widthMm} mm plate: priced as a plate cut to the blank.`
          : `${nest.partsPerPlate} per ${plate.lengthMm} x ${plate.widthMm} mm plate, ${r3(gapMm)} mm between two parts (tblPartSpacing).`} `
        + `The cut is the grown outline (${r3(blank.perimeterMm)} mm) plus ${leadMm} mm of lead-in and lead-out (${perimeterAllowanceVariable(process)}), from one pierce; `
        + 'the openings through the part are left for the mill.',
      COMPUTED_NEST,
      KERF_NOT_USED,
    ],
  });
}

/** The thickness of a plate option as the stock table names it: the preferred size's own name, or its millimetres when it was not snapped. */
function thicknessLabel(option: StockOption, sizes: readonly PreferredSize[]): string {
  return (option.snapped ? snapUp(sizes, option.aMm)?.label : null) ?? `${r3(option.aMm)} mm`;
}

/**
 * A plate option as a drop-off technique leaves it: the piece the mill starts from, the plate and what it makes, the stock bought per part.
 * Everything that reads the chosen stock (the material, the quote's stock section, the mill's bulk) then reads the technique from the one
 * place. The form, the thickness and the allowance are the plate's own. Nothing is sawn, so the option's saw cut is never read.
 */
export function roughedOption(option: StockOption, d: DropoffStock, stock: StockReference, sizes: readonly PreferredSize[]): StockOption {
  const { rect } = d.piece;
  // What the plate option says of its sawn blank on a plate of its own size is not this technique's: the technique states its own plate.
  const sawnBlankNote = virtualPlateNote({ lengthMm: option.blank.lengthMm, widthMm: option.blank.widthMm ?? 0 }, stock);
  return {
    ...option,
    sizeLabel: `${thicknessLabel(option, sizes)} plate, ${r3(rect.lengthMm)} x ${r3(rect.widthMm)} mm ${d.technique === 'perimeter_milling_dropoff' ? 'outline' : 'cut blank'}`,
    blank: { lengthMm: rect.lengthMm, widthMm: rect.widthMm, thicknessMm: d.piece.thicknessMm, volumeMm3: d.piece.volumeMm3 },
    cutWidthMm: d.nest.gapMm,
    stock: { lengthMm: d.plate.lengthMm, widthMm: d.plate.widthMm, partsPerStock: d.nest.partsPerPlate, virtual: d.plate.virtual },
    purchasedVolumeMm3: d.purchasedVolumeMm3,
    utilizationPct: d.utilizationPct,
    notes: [...option.notes.filter((n) => n !== sawnBlankNote), ...d.notes],
    roughing: d,
  };
}
