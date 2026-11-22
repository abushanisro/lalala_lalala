// The stock a machined part is cut from, by memory/Stock Maching's rules (stock-reference.ts): which form (round, hex, square or rectangular
// bar, plate, round tube), its size (the part plus an allowance on each side, snapped to a preferred size), the piece cut for one part, and
// what the whole bar or plate yields. Pure.
//
// The data states the allowance, snapping and plate rules as variables; it has no formula for the piece, the yield or the choice of form.
// Those are the engine's own (agreed with the user 2026-11-22), each said on the quote:
// - the ends are faced: the piece is the part's length plus the allowance on each end;
// - a bar makes floor((bar length - bar end) / (piece + cut width)) parts, and each part carries its share of the whole bar;
// - plate blanks are cut in a grid on the standard plate, a kerf apart, in the better of the two orientations;
// - Auto follows the part's shape (autoStockForm); every other form that holds the part is offered beside it.
import { allowancePerSideMm, barSectionAreaMm2, circumscribedDiameterMm, partingWidthMm, snapUp, type PreferredSize, type UnitSystem } from './stock-sizing';

import type { StockReference } from './stock-reference';

/** The forms the reference prices stock in (memory/Stock Maching materials), plus billet: a block cut to the part's own size from plate. */
export type StockForm = 'round_bar' | 'hex_bar' | 'rectangular_bar' | 'square_bar' | 'plate' | 'round_tube' | 'billet';
export const STOCK_FORMS: readonly StockForm[] = ['round_bar', 'hex_bar', 'rectangular_bar', 'square_bar', 'plate', 'round_tube', 'billet'];
export const STOCK_FORM_LABEL: Readonly<Record<StockForm, string>> = {
  round_bar: 'round bar', hex_bar: 'hex bar', rectangular_bar: 'rectangular bar', square_bar: 'square bar', plate: 'plate', round_tube: 'round tube', billet: 'billet',
};

/** A machined part as the stock model takes it: its envelope along the axis the stock runs. */
export interface StockPart {
  /** Measured by the cad-engine (machining/stock_envelope.py), or read off the bounding box of an analysis made before that measurement. */
  source: 'measured' | 'bounding box';
  family: 'milled' | 'turned' | 'mill_turn';
  lengthMm: number;
  /** The smallest circle round the part seen along its length. */
  roundOdMm: number;
  /** The smallest rectangle round it, widthMm >= heightMm. */
  widthMm: number;
  heightMm: number;
  /** Its width across flats when it is a hexagon seen along its length. */
  hexAcrossFlatsMm: number | null;
  /** The smallest diameter of a hole through its whole length on its axis. */
  boreMm: number | null;
  volumeMm3: number;
}

export interface StockSettings {
  unitSystem: UnitSystem;
  /** What parts a bar into pieces: the band saw (its kerf between two parts) or a bar-fed lathe's parting tool (its ring width). */
  cutOff: 'saw' | 'parting';
  /** The end of a bar that makes no part (mm). */
  remnantMm: number;
  /** The Cost Guide's stock on each side (mm), replacing the rule; null for the rule. */
  allowanceMm: number | null;
  /** The Cost Guide's snap to preferred sizes, replacing snapStockSize / hexSnapStockSize; null for the data's. */
  snap: boolean | null;
}

export interface StockOption {
  form: StockForm;
  sizeLabel: string;
  /** The section as bought (mm). a: diameter, width across flats, side, width, plate thickness, tube OD. b: height, tube ID; null otherwise. */
  aMm: number;
  bMm: number | null;
  /** What the part needed before snapping. */
  requiredAMm: number;
  requiredBMm: number | null;
  /** The stock left on each side of the section, and on each end. */
  allowancePerSideMm: number;
  endAllowanceMm: number;
  snapped: boolean;
  /** The bar's metal cross-section (mm²); null for plate. */
  sectionAreaMm2: number | null;
  /** The circle round the bar's corners: what a lathe turns down from. Null for plate. */
  circumscribedMm: number | null;
  /** The piece cut for one part, which the machine starts from. */
  blank: { lengthMm: number; widthMm: number | null; thicknessMm: number | null; volumeMm3: number };
  /** The stock lost between two parts (mm): the saw's kerf, or a parting tool's width. */
  cutWidthMm: number;
  /** The stock as bought, and the parts one bar or plate makes. `virtual`: a plate cut to the blank, when the blank is larger than the standard plate. */
  stock: { lengthMm: number; widthMm: number | null; partsPerStock: number; virtual: boolean };
  /** The stock bought per part: the whole bar or plate over its parts (its end, the cuts and the nest's gaps shared). */
  purchasedVolumeMm3: number;
  utilizationPct: number;
  /** The saw's cut for one part: the area cut, and the stock's width and height in the vise (a plate lies flat: its thickness is the height). */
  saw: { cutAreaMm2: number; widthMm: number; heightMm: number };
  /** What else the quote says of this stock (a virtual plate, an override). */
  notes: string[];
}
export interface StockUnavailable { form: StockForm; unavailable: string }
export type StockOptionResult = StockOption | StockUnavailable;
export const isStockOption = (o: StockOptionResult): o is StockOption => !('unavailable' in o);

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const mm = (n: number) => `${r3(n)} mm`;
const isTurned = (part: StockPart) => part.family === 'turned' || part.family === 'mill_turn';

/**
 * The form the part's shape asks for (the data's plate rule, and the shape itself): a hexagon takes hex bar; a turned part, or one a round
 * bar holds in less stock than a rectangle, round bar; a wide, thin part plate (at least minPlateTriggerWidth wide and no thicker than
 * maxPlateTriggerHeightOverWidth of its width); any other a rectangular bar. A tube is never the shape's own choice: it costs more per kg and
 * is offered beside the bar when the part has a bore through it.
 */
export function autoStockForm(part: StockPart, ref: StockReference): { form: StockForm; basis: string } {
  if (part.hexAcrossFlatsMm != null) return { form: 'hex_bar', basis: `the part is a hexagon ${mm(part.hexAcrossFlatsMm)} across flats` };
  if (isTurned(part)) return { form: 'round_bar', basis: `a turned part, ${mm(part.roundOdMm)} at its largest diameter` };
  const round = (Math.PI / 4) * part.roundOdMm ** 2;
  const rect = part.widthMm * part.heightMm;
  if (round <= rect) return { form: 'round_bar', basis: `a round bar holds the part in less stock (Ø${r3(part.roundOdMm)}) than a ${r3(part.widthMm)} x ${r3(part.heightMm)} mm rectangle` };
  const { triggerWidthMm, triggerHeightOverWidth } = ref.plate;
  if (part.widthMm >= triggerWidthMm - 1e-9 && part.heightMm / part.widthMm <= triggerHeightOverWidth + 1e-9) {
    return {
      form: 'plate',
      basis: `its ${r3(part.widthMm)} x ${r3(part.heightMm)} mm section is at least minPlateTriggerWidth ${triggerWidthMm} mm wide and no thicker than `
        + `maxPlateTriggerHeightOverWidth ${triggerHeightOverWidth} of its width`,
    };
  }
  return { form: 'rectangular_bar', basis: `its section is ${r3(part.widthMm)} x ${r3(part.heightMm)} mm` };
}

/** A size as bought: snapped up to the next preferred size, or the size needed itself when the form is not snapped. Null when no preferred size is that large. */
function sized(requiredMm: number, snap: boolean, sizes: readonly PreferredSize[]): { sizeMm: number; label: string; snapped: boolean } | null {
  if (!snap) return { sizeMm: requiredMm, label: mm(requiredMm), snapped: false };
  const s = snapUp(sizes, requiredMm);
  return s ? { sizeMm: s.sizeMm, label: s.label, snapped: true } : null;
}

/** The largest preferred size at or below a size (a tube's bore must stay inside the part's). */
function sizedDown(limitMm: number, snap: boolean, sizes: readonly PreferredSize[]): { sizeMm: number; label: string } | null {
  if (!snap) return limitMm > 0 ? { sizeMm: limitMm, label: mm(limitMm) } : null;
  const fits = sizes.filter((s) => s.sizeMm <= limitMm + 1e-9);
  const s = fits.at(-1);
  return s ? { sizeMm: s.sizeMm, label: s.label } : null;
}

const noSize = (form: StockForm, requiredMm: number, settings: StockSettings, sizes: readonly PreferredSize[]): StockUnavailable => ({
  form,
  unavailable: `no ${settings.unitSystem === 'US' ? 'inch' : 'metric'} preferred size of at least ${mm(requiredMm)} in tblPreferredSizes (largest ${sizes.at(-1)?.sizeMm ?? 0} mm)`,
});

/** The pieces a bar of this section makes, each part's share of it, and the saw's cut; or why the part does not come out of a bar. */
function fromBar(
  part: StockPart, ref: StockReference, settings: StockSettings,
  bar: { sectionAreaMm2: number; circumscribedMm: number; widthMm: number; heightMm: number; endAllowanceMm: number },
): Pick<StockOption, 'blank' | 'cutWidthMm' | 'stock' | 'purchasedVolumeMm3' | 'utilizationPct' | 'saw'> | { unavailable: string } {
  const blankLengthMm = part.lengthMm + 2 * bar.endAllowanceMm;
  const cutWidthMm = settings.cutOff === 'saw' ? ref.kerfMm : partingWidthMm(ref.partingRings, bar.circumscribedMm);
  if (cutWidthMm == null) return { unavailable: 'tblPartingRingWidth has no rows' };
  const usableMm = ref.barLengthMm - settings.remnantMm;
  if (blankLengthMm + cutWidthMm > usableMm + 1e-9) {
    return { unavailable: `the part takes ${mm(blankLengthMm)} of bar; a ${mm(ref.barLengthMm)} bar (standardStockLength) has ${mm(usableMm)} to cut from after its ${mm(settings.remnantMm)} end` };
  }
  const partsPerStock = Math.floor((usableMm + 1e-9) / (blankLengthMm + cutWidthMm));
  const purchasedVolumeMm3 = (bar.sectionAreaMm2 * ref.barLengthMm) / partsPerStock;
  return {
    blank: { lengthMm: blankLengthMm, widthMm: null, thicknessMm: null, volumeMm3: bar.sectionAreaMm2 * blankLengthMm },
    cutWidthMm,
    stock: { lengthMm: ref.barLengthMm, widthMm: null, partsPerStock, virtual: false },
    purchasedVolumeMm3,
    utilizationPct: purchasedVolumeMm3 > 0 ? Math.min(100, (part.volumeMm3 / purchasedVolumeMm3) * 100) : 0,
    saw: { cutAreaMm2: bar.sectionAreaMm2, widthMm: bar.widthMm, heightMm: bar.heightMm },
  };
}

/**
 * Blanks of a plate, a kerf apart, in the better of the two orientations on the standard plate; a blank the standard plate cannot hold is cut
 * from a plate of its own size (the variables' note: the standard sizes are those of a virtual stock).
 */
function fromPlate(part: StockPart, ref: StockReference, blank: { lengthMm: number; widthMm: number; thicknessMm: number }): Pick<StockOption, 'blank' | 'cutWidthMm' | 'stock' | 'purchasedVolumeMm3' | 'utilizationPct' | 'saw' | 'notes'> {
  const k = ref.kerfMm;
  const count = (l: number, w: number) => Math.floor((ref.plate.lengthMm + k + 1e-9) / (l + k)) * Math.floor((ref.plate.widthMm + k + 1e-9) / (w + k));
  const nested = Math.max(count(blank.lengthMm, blank.widthMm), count(blank.widthMm, blank.lengthMm));
  const virtual = nested < 1;
  const stock = virtual
    ? { lengthMm: blank.lengthMm, widthMm: blank.widthMm, partsPerStock: 1, virtual }
    : { lengthMm: ref.plate.lengthMm, widthMm: ref.plate.widthMm, partsPerStock: nested, virtual };
  const purchasedVolumeMm3 = (stock.lengthMm * stock.widthMm * blank.thicknessMm) / stock.partsPerStock;
  return {
    blank: { ...blank, volumeMm3: blank.lengthMm * blank.widthMm * blank.thicknessMm },
    cutWidthMm: k,
    stock,
    purchasedVolumeMm3,
    utilizationPct: purchasedVolumeMm3 > 0 ? Math.min(100, (part.volumeMm3 / purchasedVolumeMm3) * 100) : 0,
    // The saw frees a blank along two of its edges (its neighbours' cuts free the other two), through the plate's thickness.
    saw: { cutAreaMm2: blank.thicknessMm * (blank.lengthMm + blank.widthMm), widthMm: Math.min(stock.lengthMm, stock.widthMm), heightMm: blank.thicknessMm },
    notes: virtual
      ? [`The ${r3(blank.lengthMm)} x ${r3(blank.widthMm)} mm blank is larger than the standard ${ref.plate.lengthMm} x ${ref.plate.widthMm} mm plate: priced as a plate cut to the blank.`]
      : [],
  };
}

/** One form's stock for the part, or why that form is not offered. */
export function stockOption(form: StockForm, part: StockPart, ref: StockReference, settings: StockSettings): StockOptionResult {
  const sizes = ref.preferredSizes[settings.unitSystem];
  const snap = settings.snap ?? ref.snap;
  const allow = (rule: StockReference['allowance'], outsideMm: number) => settings.allowanceMm ?? allowancePerSideMm(rule, outsideMm);
  const overridden = [
    ...(settings.allowanceMm != null ? [`Stock on each side set in the Cost Guide: ${mm(settings.allowanceMm)}.`] : []),
    ...(settings.snap != null ? [`Snapping to preferred sizes set in the Cost Guide: ${settings.snap ? 'on' : 'off'}.`] : []),
  ];
  // `endAllowance`: the stock faced off each end; the section's own allowance unless the form says otherwise (hex bar).
  const bar = (o: {
    aMm: number; bMm: number | null; requiredAMm: number; requiredBMm: number | null; allowance: number; endAllowance?: number; snapped: boolean; label: string;
    sectionAreaMm2: number; circumscribedMm: number; widthMm: number; heightMm: number;
  }): StockOptionResult => {
    const endAllowanceMm = o.endAllowance ?? o.allowance;
    const cut = fromBar(part, ref, settings, { ...o, endAllowanceMm });
    if ('unavailable' in cut) return { form, unavailable: cut.unavailable };
    return {
      form, sizeLabel: `${o.label} ${STOCK_FORM_LABEL[form]}`, aMm: o.aMm, bMm: o.bMm, requiredAMm: o.requiredAMm, requiredBMm: o.requiredBMm,
      allowancePerSideMm: o.allowance, endAllowanceMm, snapped: o.snapped, sectionAreaMm2: o.sectionAreaMm2, circumscribedMm: o.circumscribedMm, ...cut, notes: overridden,
    };
  };

  if (form === 'round_bar' || form === 'round_tube') {
    const allowance = allow(ref.allowance, part.roundOdMm);
    const required = part.roundOdMm + 2 * allowance;
    const od = sized(required, snap, sizes);
    if (!od) return noSize(form, required, settings, sizes);
    if (form === 'round_bar') {
      return bar({ aMm: od.sizeMm, bMm: null, requiredAMm: required, requiredBMm: null, allowance, snapped: od.snapped, label: od.snapped ? od.label : `Ø${r3(od.sizeMm)} mm`,
        sectionAreaMm2: barSectionAreaMm2('round', od.sizeMm), circumscribedMm: od.sizeMm, widthMm: od.sizeMm, heightMm: od.sizeMm });
    }
    if (part.boreMm == null) return { form, unavailable: 'a tube is stock for a part with a bore through its whole length on its axis; this part has none' };
    const boreLimit = part.boreMm - 2 * ref.idTrimAllowanceMm;
    const id = sizedDown(boreLimit, snap, sizes);
    if (!id || id.sizeMm >= od.sizeMm) return { form, unavailable: `no tube bore of at most ${mm(boreLimit)} (the part's ${mm(part.boreMm)} bore less idStockTrimAllowance) in tblPreferredSizes` };
    return bar({ aMm: od.sizeMm, bMm: id.sizeMm, requiredAMm: required, requiredBMm: boreLimit, allowance, snapped: od.snapped,
      label: `${od.snapped ? od.label : `Ø${r3(od.sizeMm)} mm`} x ${id.label} bore`,
      sectionAreaMm2: barSectionAreaMm2('round', od.sizeMm) - barSectionAreaMm2('round', id.sizeMm), circumscribedMm: od.sizeMm, widthMm: od.sizeMm, heightMm: od.sizeMm });
  }

  if (form === 'hex_bar') {
    // A hex part's own flats; any other part must fit inside the hexagon's inscribed circle (its width across flats).
    const outside = part.hexAcrossFlatsMm ?? part.roundOdMm;
    const allowance = allow(ref.hexAllowance, outside);
    const required = outside + 2 * allowance;
    const af = sized(required, settings.snap ?? ref.hexSnap, sizes);
    if (!af) return noSize(form, required, settings, sizes);
    const corners = circumscribedDiameterMm('hex', af.sizeMm);
    // The flats may be used as supplied (no allowance); the sawn ends are faced like any bar's, by the general rule on the bar's corners.
    return bar({ aMm: af.sizeMm, bMm: null, requiredAMm: required, requiredBMm: null, allowance, endAllowance: allow(ref.allowance, part.roundOdMm), snapped: af.snapped, label: `${af.label} A/F`,
      sectionAreaMm2: barSectionAreaMm2('hex', af.sizeMm), circumscribedMm: corners, widthMm: corners, heightMm: af.sizeMm });
  }

  const allowance = allow(ref.allowance, Math.max(part.widthMm, part.heightMm));
  const requiredW = part.widthMm + 2 * allowance;
  const requiredH = part.heightMm + 2 * allowance;

  if (form === 'square_bar') {
    const side = sized(requiredW, snap, sizes);
    if (!side) return noSize(form, requiredW, settings, sizes);
    return bar({ aMm: side.sizeMm, bMm: null, requiredAMm: requiredW, requiredBMm: null, allowance, snapped: side.snapped, label: `${side.label} x ${side.label}`,
      sectionAreaMm2: barSectionAreaMm2('square', side.sizeMm), circumscribedMm: circumscribedDiameterMm('square', side.sizeMm), widthMm: side.sizeMm, heightMm: side.sizeMm });
  }

  if (form === 'rectangular_bar') {
    const w = sized(requiredW, snap, sizes);
    const h = sized(requiredH, snap, sizes);
    if (!w) return noSize(form, requiredW, settings, sizes);
    if (!h) return noSize(form, requiredH, settings, sizes);
    return bar({ aMm: w.sizeMm, bMm: h.sizeMm, requiredAMm: requiredW, requiredBMm: requiredH, allowance, snapped: w.snapped, label: `${w.label} x ${h.label}`,
      sectionAreaMm2: w.sizeMm * h.sizeMm, circumscribedMm: Math.hypot(w.sizeMm, h.sizeMm), widthMm: w.sizeMm, heightMm: h.sizeMm });
  }

  // Plate, and a billet: a block of the part's own size (not snapped to a plate thickness), cut from plate.
  const thickness = sized(requiredH, form === 'plate' ? snap : false, sizes);
  if (!thickness) return noSize(form, requiredH, settings, sizes);
  const blank = { lengthMm: part.lengthMm + 2 * allowance, widthMm: requiredW, thicknessMm: thickness.sizeMm };
  const cut = fromPlate(part, ref, blank);
  return {
    form,
    sizeLabel: form === 'plate'
      ? `${thickness.label} plate, ${r3(blank.lengthMm)} x ${r3(blank.widthMm)} mm blank`
      : `${r3(blank.lengthMm)} x ${r3(blank.widthMm)} x ${r3(blank.thicknessMm)} mm billet`,
    aMm: thickness.sizeMm, bMm: null, requiredAMm: requiredH, requiredBMm: null, allowancePerSideMm: allowance, endAllowanceMm: allowance, snapped: thickness.snapped,
    sectionAreaMm2: null, circumscribedMm: null, ...cut, notes: [...overridden, ...cut.notes],
  };
}

export interface StockSelection {
  /** The stock the quote prices; null only when no form, not even a billet, holds the part (a part with no size). */
  chosen: StockOption | null;
  /** What the part's shape asks for, and why. */
  rule: { form: StockForm; basis: string };
  /** Why the chosen stock is not the rule's or the Cost Guide's form, when it is not. */
  fallback: string | null;
  /** Every form, each with its stock or why it is not offered. */
  options: StockOptionResult[];
}

/**
 * The part's stock: the Cost Guide's form when one is set, else the form its shape asks for; a rectangular bar whose two sides snap to the
 * same size is a square bar. A form that cannot hold the part (no preferred size that large, a part longer than the bar, a tube for a part
 * with no bore) falls back to a billet, and says so. Every form is returned, for the quote to offer the others.
 */
export function selectStock(part: StockPart, ref: StockReference, settings: StockSettings, forcedForm: StockForm | null = null): StockSelection {
  const options = STOCK_FORMS.map((form) => stockOption(form, part, ref, settings));
  const of = (form: StockForm) => options.find((o) => o.form === form)!;
  const auto = autoStockForm(part, ref);
  const rect = of('rectangular_bar');
  const rule = auto.form === 'rectangular_bar' && isStockOption(rect) && rect.aMm === rect.bMm
    ? { form: 'square_bar' as const, basis: `${auto.basis}; both sides take a ${mm(rect.aMm)} bar` }
    : auto;
  const wanted = forcedForm ?? rule.form;
  const first = of(wanted);
  if (isStockOption(first)) return { chosen: first, rule, fallback: null, options };
  const billet = of('billet');
  const why = `${forcedForm ? 'The Cost Guide\'s' : 'The part\'s'} ${STOCK_FORM_LABEL[wanted]} is not available: ${first.unavailable}.`;
  return isStockOption(billet)
    ? { chosen: billet, rule, fallback: `${why} Priced as a billet cut from plate.`, options }
    : { chosen: null, rule, fallback: `${why} A billet is not either: ${billet.unavailable}.`, options };
}
