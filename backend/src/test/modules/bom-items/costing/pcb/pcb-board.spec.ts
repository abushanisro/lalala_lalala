// The board, its stack-up and its panel nest, on the real memory/PCBA tables.
import { holeTotals, resolvePcbPart, type PcbMeasured } from '../../../../../modules/bom-items/costing/pcb/pcb-part';
import { nestPcb, type PcbPanelRules } from '../../../../../modules/bom-items/costing/pcb/pcb-panel';
import { pcbStackup, prepregPlies } from '../../../../../modules/bom-items/costing/pcb/pcb-stackup';
import { realPcbReference } from './pcb-test-data';

const DEFAULTS = { thicknessMm: 1.6, copperOz: 1, soldermaskSides: 2, viaPlugging: false };
// The FL285182 board set (cad-engine pcb/, memory/PCBA/Reference): 273.7 x 170.7 mm, 2 copper layers, 226 holes.
const FL285182: PcbMeasured = {
  source: 'board_files', sourceName: 'OPT-FL285182-X6-V1.0.2', outline: { lengthMm: 273.7, widthMm: 170.7, areaMm2: 23161.89 }, layers: 2,
  holes: [{ diameterMm: 0.5, plated: true, count: 224 }, { diameterMm: 3.2, plated: false, count: 2 }], soldermask: { top: true, bottom: true }, silkscreen: { top: true },
  pins: 1252,
};

describe('the board a PCB route is priced for', () => {
  it('takes the board set\'s measurements, the reference defaults for what it cannot state, and says which is which', () => {
    const { part, missing } = resolvePcbPart(FL285182, {}, DEFAULTS);
    expect(missing).toEqual([]);
    expect(part!.layers).toMatchObject({ value: 2, basis: 'board_files' });
    expect(part!.thicknessMm).toMatchObject({ value: 1.6, basis: 'reference_default', source: 'PCB variable defaultBoardThickness' });
    expect(part!.outerCopperOz).toMatchObject({ value: 1, basis: 'reference_default' });
    expect(part!.innerCopperOz).toBeNull();
    expect(part!.finish).toMatchObject({ value: 'hasl', basis: 'reference_default' });
    expect(part!.silkscreenSides).toMatchObject({ value: 1, basis: 'board_files' });
    expect(part!.testPoints).toMatchObject({ value: 1252, basis: 'board_files' });
    expect(holeTotals(part!.holes.value)).toEqual({ hits: 226, plated: 224, tools: 2 });
  });

  it('asks the Cost Guide for the layer count of a STEP board, and lets the Cost Guide state any value', () => {
    const step: PcbMeasured = { source: 'cad_model', sourceName: 'board.step', outline: { lengthMm: 100, widthMm: 80 }, thicknessMm: 1.2, holes: [] };
    expect(resolvePcbPart(step, {}, DEFAULTS).missing).toEqual(['the number of copper layers: set Layers in the Cost Guide (a STEP model does not show them)']);
    const { part } = resolvePcbPart(step, { layers: 4, innerCopperOz: 0.5, finish: 'enig' }, DEFAULTS);
    expect(part!.thicknessMm).toMatchObject({ value: 1.2, basis: 'cad_model' });
    expect(part!.innerCopperOz).toMatchObject({ value: 0.5, basis: 'cost_guide' });
    expect(part!.finish).toMatchObject({ value: 'enig', basis: 'cost_guide' });
    expect(part!.perimeterMm).toMatchObject({ value: 360, basis: 'derived' });
  });

  it('builds a 2-layer board as one double-clad core and a 4-layer as foil over a core, from tblLayerMaterialType and tblDielectricThickness', () => {
    const ref = realPcbReference();
    const two = pcbStackup(ref, 2, 1.6, 1, null, 1).stackup!;
    expect(two).toMatchObject({ sequence: ['2PT', '2PB'], doubleCores: 1, foils: 0, innerCores: 0, prepregSpaces: 0, coreDielectricMm: 1.6, laminated: false });
    const four = pcbStackup(ref, 4, 1.6, 1, 1, 1).stackup!;
    expect(four).toMatchObject({ sequence: ['CU', '2PT', '2PB', 'CU'], doubleCores: 1, foils: 2, innerCores: 1, prepregSpaces: 2, coreDielectricMm: 1, laminated: true });
    // 1.6 mm - 4 x 0.035 mm copper - the 1.00 mm core, over 2 spaces: 0.23 mm each. Three 1080 plies (0.225 mm) are nearest; two 2116
    // plies would press to 0.24 mm.
    expect(four.prepregPerSpaceMm).toBeCloseTo(0.23, 6);
    expect(prepregPlies(ref, four.prepregPerSpaceMm)).toEqual({ style: '1080', plies: 3, nominalMm: 0.075 });
    expect(pcbStackup(ref, 3, 1.6, 1, 1, 1).missing).toEqual(['a 3-layer build: tblLayerMaterialType builds 1, 2, 4, 6, 8, 10, 12 layers']);
  });

  it('nests the boards into the reference array and the arrays onto the panel; a board larger than the array goes on the panel directly', () => {
    const rules: PcbPanelRules = { panel: { lengthMm: 609.6, widthMm: 457.2 }, array: { lengthMm: 279.4, widthMm: 215.9 }, edgeMarginLengthMm: 12.7, edgeMarginWidthMm: 12.7, spacingMm: 2.54 };
    const small = nestPcb(50, 40, 2000, rules, null).nest!;
    // 584.2 x 431.8 mm usable: two arrays fit (2 x 279.4 + 2.54 = 561.3 mm); a second row needs 434.3 mm of the 431.8.
    expect(small).toMatchObject({ boardsPerArray: 25, arraysPerPanel: 2, boardsPerPanel: 50, basis: 'grid' });
    // FL285182 (273.7 x 170.7) fits the 279.4 x 215.9 array once; 2 arrays on the panel.
    expect(nestPcb(273.7, 170.7, 23161.89, rules, null).nest).toMatchObject({ boardsPerArray: 1, arraysPerPanel: 2, boardsPerPanel: 2 });
    expect(nestPcb(400, 300, 120000, rules, null).nest).toMatchObject({ boardsPerPanel: 1, array: null });
    expect(nestPcb(700, 300, 210000, rules, null).reason).toMatch(/does not fit/);
    expect(nestPcb(50, 40, 2000, rules, 12).nest).toMatchObject({ boardsPerPanel: 12, basis: 'supplied' });
  });
});
