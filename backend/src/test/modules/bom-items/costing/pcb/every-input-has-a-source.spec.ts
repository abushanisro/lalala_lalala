// Every calculator input on a PCB line says where its value came from (SourceRef), so the eye beside it opens that source: this guard runs
// every route on the boards of the route and assembly tests (the FL285182 two-layer board, a four-layer ENIG board, the DC-DC converter
// assembled: SMT both sides, through-hole parts, the test chosen) and lists any input with no ref, or a ref that opens nothing
// (source-ref-guard.ts).
import { loadPcbCalculatorSpec, pcbCalculatorsByName } from '../../../../../modules/bom-items/costing/pcb/calculators/pcb-calculator-spec';
import { resolvePcbPart, type PcbMeasured, type PcbOverrides } from '../../../../../modules/bom-items/costing/pcb/pcb-part';
import { buildPcbRoutes, type PcbBuild } from '../../../../../modules/bom-items/costing/pcb/pcb-route';
import { runsAsLines, sourceGaps } from '../source-ref-guard';
import { allPcbMachines, pcbLaminates, realPcbReference } from './pcb-test-data';

import type { PcbAssemblyChoice } from '../../../../../modules/bom-items/costing/pcb/pcb-assembly';

const ZERO = { qairPerHr: 0, inspTimeMin: 0, samplingRate: 0, yieldPct: 1, netMatCost: 0, netWeightKg: 0, scrapPricePerKg: 0 };
const DEFAULTS = { thicknessMm: 1.6, copperOz: 1, soldermaskSides: 2, viaPlugging: false };
const FL285182: PcbMeasured = {
  source: 'board_files', sourceName: 'FL285182-board-set.zip', outline: { lengthMm: 273.7, widthMm: 170.7, areaMm2: 23161.89 }, layers: 2,
  holes: [{ diameterMm: 0.6, plated: true, count: 224 }, { diameterMm: 1.5, plated: false, count: 2 }],
  soldermask: { top: true, bottom: true }, silkscreen: { top: true, bottom: true }, pins: 1246, pasteAreaMm2: 4000, copperAreaMm2: 30203,
};
const FOUR_LAYER: PcbMeasured = { ...FL285182, outline: { lengthMm: 100, widthMm: 80, areaMm2: 8000 }, layers: 4, pasteAreaMm2: 900 };
const DCDC: PcbMeasured = {
  source: 'board_files', sourceName: 'dcdc-board-set.zip', outline: { lengthMm: 64, widthMm: 50, areaMm2: 3200 }, layers: 2,
  holes: [{ diameterMm: 0.4, plated: true, count: 40 }, { diameterMm: 1.0, plated: true, count: 8 }],
  soldermask: { top: true, bottom: true }, silkscreen: { top: true, bottom: false }, pins: 139, nets: 42,
  pasteAreaMm2: 260, pasteAreaBySideMm2: { top: 90, bottom: 170 }, copperAreaMm2: 3600,
  placements: [
    { side: 'top', packageClass: 'chip_0603', count: 6, footprint: 'R0603' }, { side: 'top', packageClass: 'htssop', count: 1, footprint: 'HTSSOP-20' },
    { side: 'top', packageClass: 'chip_1206', count: 7, footprint: 'C1206' },
    { side: 'bottom', packageClass: 'chip_0603', count: 6, footprint: 'C0603' }, { side: 'bottom', packageClass: 'chip_0805', count: 9, footprint: 'R0805' },
    { side: 'bottom', packageClass: 'chip_1206', count: 9, footprint: 'C1206' }, { side: 'bottom', packageClass: 'dpak', count: 3, footprint: 'TO-252' },
    { side: 'bottom', packageClass: 'sod', count: 16, footprint: 'SOD-323' },
  ],
  thtParts: [{ label: 'Radial capacitor', count: 1, jointsPerPart: 2 }, { label: 'Terminal', count: 2, jointsPerPart: 3 }],
};

function build(measured: PcbMeasured, overrides: PcbOverrides = {}, assembly: PcbAssemblyChoice | null = null): PcbBuild {
  const { part, missing } = resolvePcbPart(measured, overrides, DEFAULTS);
  if (!part) throw new Error(missing.join('; '));
  return buildPcbRoutes({
    ref: realPcbReference(), spec: loadPcbCalculatorSpec(), calculators: pcbCalculatorsByName(), part, laminates: pcbLaminates(), machinesByClass: allPcbMachines(),
    scenario: { batchSize: 500, annualVolume: 6000, amortizationParts: 30000, route: null }, costContext: ZERO,
    ...(assembly ? { assembly: { choice: assembly, bomComponents: 0, region: { location: 'USA', inrPerUsd: null } } } : {}),
  });
}

const CASES: [string, PcbBuild][] = [
  ['the FL285182 two-layer board', build(FL285182)],
  ['a four-layer ENIG board', build(FOUR_LAYER, { finish: 'enig' })],
  ['the DC-DC converter assembled, its choices automatic', build(DCDC, {}, { mode: 'auto', thtSolder: null, test: null })],
  ['the DC-DC converter assembled by hand soldering and flying probe', build(DCDC, {}, { mode: 'auto', thtSolder: 'hand', test: 'flying_probe' })],
];

describe('every PCB calculator input says where its value came from', () => {
  it.each(CASES)('%s', (_name, b) => {
    expect(b.routes.length).toBeGreaterThan(0);
    expect(sourceGaps(b.routes.flatMap((r) => [...r.lines, ...runsAsLines({ 'board material': r.material.run })]))).toEqual({ withoutRef: [], openingNothing: [] });
  });
});
