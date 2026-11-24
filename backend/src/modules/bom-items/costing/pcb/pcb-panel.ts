// How many boards one production panel carries. Pure.
//
// The reference (memory/PCBA/pcb_variables.csv) nests boards into an array (defaultArrayLength x defaultArrayWidth, when
// defaultEnableArrayDepanelization) and arrays onto the working panel, keeping an edge margin on the panel (defaultPanelSheetPerimeter*:
// 25.4 mm above two layers, 12.7 mm otherwise) and a spacing between neighbours (defaultPanelSheetRectangularNestingSpacing). The boards are
// placed on a rectangular grid by their outline's bounding box, in whichever orientation fits more; the reference's own default is a true-part
// nest, which a grid never beats, so the count is a floor and says so. A supplied boards-per-panel replaces the nest.

export interface PanelSize { lengthMm: number; widthMm: number }

export interface PcbPanelRules {
  panel: PanelSize;
  /** The array boards are nested into first; null when array depanelization is off. */
  array: PanelSize | null;
  edgeMarginLengthMm: number;
  edgeMarginWidthMm: number;
  spacingMm: number;
}

export interface PcbNest {
  boardsPerPanel: number;
  /** Arrays on the panel and boards in each; arrays 1 when the boards are nested on the panel directly. */
  arraysPerPanel: number;
  boardsPerArray: number;
  panel: PanelSize;
  array: PanelSize | null;
  /** Board area on the panel / the panel's area. */
  utilization: number;
  basis: 'grid' | 'supplied';
  note: string;
}

const fit = (usable: number, size: number, gap: number) => (size > 0 ? Math.max(0, Math.floor((usable + gap) / (size + gap))) : 0);

/** Pieces of size l x w on a usable area, in the better orientation. */
export function gridFit(usableL: number, usableW: number, l: number, w: number, gap: number): number {
  return Math.max(fit(usableL, l, gap) * fit(usableW, w, gap), fit(usableL, w, gap) * fit(usableW, l, gap));
}

const r2 = (v: number) => Math.round(v * 100) / 100;

/** The boards one panel carries, or why the board does not fit it. */
export function nestPcb(boardL: number, boardW: number, boardAreaMm2: number, rules: PcbPanelRules, supplied: number | null): { nest: PcbNest | null; reason: string | null } {
  const { panel, spacingMm: gap } = rules;
  const usableL = panel.lengthMm - 2 * rules.edgeMarginLengthMm;
  const usableW = panel.widthMm - 2 * rules.edgeMarginWidthMm;
  const area = panel.lengthMm * panel.widthMm;
  if (supplied != null && supplied >= 1) {
    const n = Math.floor(supplied);
    return {
      nest: {
        boardsPerPanel: n, arraysPerPanel: 1, boardsPerArray: n, panel, array: null, utilization: Math.min(1, (n * boardAreaMm2) / area), basis: 'supplied',
        note: `${n} board(s) per panel, as the Cost Guide states`,
      },
      reason: null,
    };
  }
  if (usableL <= 0 || usableW <= 0) return { nest: null, reason: `the ${panel.lengthMm} x ${panel.widthMm} mm panel has no usable area inside its edge margin` };
  const arr = rules.array;
  if (arr) {
    const perArray = gridFit(arr.lengthMm, arr.widthMm, boardL, boardW, gap);
    const arrays = gridFit(usableL, usableW, arr.lengthMm, arr.widthMm, gap);
    if (perArray >= 1 && arrays >= 1) {
      const boards = perArray * arrays;
      return {
        nest: {
          boardsPerPanel: boards, arraysPerPanel: arrays, boardsPerArray: perArray, panel, array: arr, utilization: (boards * boardAreaMm2) / area, basis: 'grid',
          note: `${perArray} board(s) per ${r2(arr.lengthMm)} x ${r2(arr.widthMm)} mm array, ${arrays} array(s) per ${r2(panel.lengthMm)} x ${r2(panel.widthMm)} mm panel (rectangular grid, ${gap} mm apart, ${rules.edgeMarginLengthMm} mm panel edge): a floor, the reference's true-part nest fits at least as many`,
        },
        reason: null,
      };
    }
  }
  // A board larger than the array (or arrays off) is nested on the panel directly.
  const boards = gridFit(usableL, usableW, boardL, boardW, gap);
  if (boards < 1) {
    return { nest: null, reason: `the ${r2(boardL)} x ${r2(boardW)} mm board does not fit the ${r2(usableL)} x ${r2(usableW)} mm usable area of the ${panel.lengthMm} x ${panel.widthMm} mm panel` };
  }
  return {
    nest: {
      boardsPerPanel: boards, arraysPerPanel: 1, boardsPerArray: boards, panel, array: null, utilization: (boards * boardAreaMm2) / area, basis: 'grid',
      note: `${boards} board(s) per ${r2(panel.lengthMm)} x ${r2(panel.widthMm)} mm panel (rectangular grid, ${gap} mm apart, ${rules.edgeMarginLengthMm} mm panel edge${arr ? '; larger than the array, so nested on the panel' : ''})`,
    },
    reason: null,
  };
}
