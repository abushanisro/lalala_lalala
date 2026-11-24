// A printed circuit board priced from its 3D model when it has no board files (cad-engine pcb/feature_extractor.py, summary.pcbModelGeometry):
// what the model states (outline, thickness, holes, the bodies on it) and what it does not (layers, copper, plating, parts), each said.
import type { PcbModelGeometry } from '../../../../../modules/bom-items/costing/pcb/board-graph/pcb-geometry';
import { loadPcbCalculatorSpec, pcbCalculatorsByName } from '../../../../../modules/bom-items/costing/pcb/calculators/pcb-calculator-spec';
import { pcbMeasuredFrom, pcbMeasuredFromModel } from '../../../../../modules/bom-items/costing/pcb/pcb-cost.service';
import { resolvePcbPart } from '../../../../../modules/bom-items/costing/pcb/pcb-part';
import { buildPcbRoutes, choosePcbRoute } from '../../../../../modules/bom-items/costing/pcb/pcb-route';
import { allPcbMachines, pcbLaminates, realPcbReference } from './pcb-test-data';

const DEFAULTS = { thicknessMm: 1.6, copperOz: 1, soldermaskSides: 2, viaPlugging: false };
// The 100 x 80 x 1.6 mm board of cad-engine test/test_pcb_step_measurements.py: 4 holes of 3.2 mm, 6 of 0.8 mm, a 20 x 4 mm slot.
const MODEL: PcbModelGeometry = {
  extractionVersion: 'pcb-step-1',
  board: { thickness_mm: 1.6, length_mm: 100, width_mm: 80, area_mm2: 8000, perimeter_mm: 360 },
  holes: [{ diameter_mm: 0.8, count: 6 }, { diameter_mm: 3.2, count: 4 }], cutouts: [{ perimeter_mm: 48 }], components: { top: 0, bottom: 0 }, unresolved: [],
};

describe('a PCB from its 3D model', () => {
  it('takes the outline, thickness and holes the model measures, the cutouts routed with the outline, and says the plating is not stated', () => {
    const measured = pcbMeasuredFromModel(MODEL, 'board.step')!;
    expect(measured).toMatchObject({ source: 'cad_model', outline: { lengthMm: 100, widthMm: 80, areaMm2: 8000 }, thicknessMm: 1.6, outlinePerimeterMm: 408 });
    const { part, missing } = resolvePcbPart(measured, { layers: 2 }, DEFAULTS);
    expect(missing).toEqual([]);
    expect(part!.thicknessMm).toMatchObject({ value: 1.6, basis: 'cad_model' });
    expect(part!.perimeterMm.source).toBe('board.step: the outline and its 1 internal cutout(s), routed with it');
    expect(part!.holes.source).toMatch(/a model does not say which are plated: each is taken as plated/);
    expect(part!.layers).toMatchObject({ value: 2, basis: 'cost_guide' });
    // A model states no solder mask, legend or nets: the reference default, and no test points.
    expect(part!.soldermaskSides.basis).toBe('reference_default');
    expect(part!.testPoints).toBeNull();
  });

  it('asks for the layers, which a model does not show', () => {
    const { part, missing } = resolvePcbPart(pcbMeasuredFromModel(MODEL, 'board.step'), {}, DEFAULTS);
    expect(part).toBeNull();
    expect(missing.join(' ')).toMatch(/number of copper layers: set Layers in the Cost Guide \(a STEP model does not show them\)/);
  });

  it('is not read when the model shows no board, and the board files win when there are both', () => {
    expect(pcbMeasuredFromModel({ ...MODEL, board: null, unresolved: ['no board found'] }, 'block.step')).toBeNull();
    const files = pcbMeasuredFrom({ extractionVersion: 'pcb_v1', source: 'board_files', sourceName: 'set.zip', filesReport: [], graph: { outline: { lengthMm: 50, widthMm: 40 }, layers: 4 } });
    expect(files ?? pcbMeasuredFromModel(MODEL, 'board.step')).toMatchObject({ source: 'board_files', layers: 4 });
  });

  it('prices the bare board, and a model with parts on it is assembled once its Pick Place file says what they are', () => {
    const build = (model: PcbModelGeometry) => {
      const { part } = resolvePcbPart(pcbMeasuredFromModel(model, 'board.step'), { layers: 2 }, DEFAULTS);
      return buildPcbRoutes({
        ref: realPcbReference(), spec: loadPcbCalculatorSpec(), calculators: pcbCalculatorsByName(), part: part!, laminates: pcbLaminates(), machinesByClass: allPcbMachines(),
        scenario: { batchSize: 500, annualVolume: 6000, amortizationParts: 30000, route: null }, costContext: { qairPerHr: 0, inspTimeMin: 0, samplingRate: 0, yieldPct: 1, netMatCost: 0, netWeightKg: 0, scrapPricePerKg: 0 },
        assembly: { choice: { mode: 'auto', thtSolder: null, test: null }, bomComponents: 0, region: { location: 'USA', inrPerUsd: null } },
      });
    };
    const bare = build(MODEL);
    const quoted = choosePcbRoute(bare.routes, bare.gaps, null).route!;
    expect(quoted.complete).toBe(true);
    expect(bare.assembly!.included).toBe(false);
    // The 10 holes are drilled, all taken as plated.
    expect(quoted.lines.some((l) => l.process === 'Desmear and Plate Through Holes')).toBe(true);
    const populated = build({ ...MODEL, components: { top: 12, bottom: 3 } });
    expect(populated.assembly!.basis).toBe('Assembly included automatically: the 3D model shows 15 part(s) on the board (12 on the top, 3 on the bottom)');
    const gap = choosePcbRoute(populated.routes, populated.gaps, null).route!.lines.find((l) => l.process === 'Pick and Place')!;
    expect(JSON.stringify(gap.physicsGap)).toMatch(/bodies on the 3D model.*Pick Place \(centroid\) file/);
  });
});
