// Every calculator input on an additive (and Rapid Prototyping) line says where its value came from (SourceRef), so the eye beside it opens
// that source: this guard runs every route of both domains on the tee of the route tests and lists any input with no ref, or a ref that opens
// nothing (source-ref-guard.ts).
import { additiveMaterial, allAdditiveMachines, realAdditiveReference } from './additive-test-data';
import { allRapidPrototypingMachines, rapidPrototypingMaterial, realRapidPrototypingReference } from './rapid-prototyping-test-data';
import { ADDITIVE, RAPID_PROTOTYPING } from '../../../../../modules/bom-items/costing/additive/additive-domain';
import { buildAdditiveRoutes, type AdditivePart, type AdditiveRouteInput, type BuildCandidate } from '../../../../../modules/bom-items/costing/additive/additive-route';
import { additiveCalculatorsByName, loadAdditiveCalculatorSpec } from '../../../../../modules/bom-items/costing/additive/calculators/additive-calculator-spec';
import { loadRapidPrototypingCalculatorSpec, rapidPrototypingCalculatorsByName } from '../../../../../modules/bom-items/costing/additive/calculators/rapid-prototyping-calculator-spec';
import { runsAsLines, sourceGaps } from '../source-ref-guard';

import type { CleaningFeature } from '../../../../../modules/bom-items/costing/additive/feature-cleaning';

const ZERO = { qairPerHr: 0, inspTimeMin: 0, samplingRate: 0, yieldPct: 1, netMatCost: 0, netWeightKg: 0, scrapPricePerKg: 0 };
const angles = (overhang: number, support: number, contact: number, regions: number): BuildCandidate['byAngle'] => ({
  30: { overhangAreaMm2: overhang, overhangProjectedAreaMm2: overhang, supportVolumeMm3: support, plateContactAreaMm2: contact, overhangRegions: regions },
  45: { overhangAreaMm2: overhang, overhangProjectedAreaMm2: overhang, supportVolumeMm3: support, plateContactAreaMm2: contact, overhangRegions: regions },
});
const FEATURES: CleaningFeature[] = [
  { id: 'hole-1', type: 'SimpleHole', size: 5, depthMm: 25 },
  { id: 'void-1', type: 'ComplexHole', size: 40, depthMm: 15 },
  { id: 'void-2', type: 'Void', size: 3000, depthMm: 5 },
];
// Upright (+z) the flange needs support; on its side (+y) none: the routes are costed both ways across the materials.
const TEE: AdditivePart = {
  partVolumeMm3: 10 * 10 * 30 + 50 * 10 * 5, surfaceAreaMm2: 3400, measuredAxis: '+y', cleaningFeatures: FEATURES,
  candidates: {
    '+z': { buildHeightMm: 35, footprintMm: [50, 10], byAngle: angles(400, 12000, 500, 2) },
    '+y': { buildHeightMm: 10, footprintMm: [50, 35], byAngle: angles(0, 0, 650, 0) },
  },
};

const additive = (material: string, buildAxis: string | null): AdditiveRouteInput => ({
  domain: ADDITIVE, ref: realAdditiveReference(), spec: loadAdditiveCalculatorSpec(), calculators: additiveCalculatorsByName(), material: additiveMaterial(material),
  part: TEE, machinesByClass: allAdditiveMachines(), scenario: { batchSize: 100, route: null, buildAxis }, costContext: ZERO,
} as AdditiveRouteInput);
const rapid = (material: string, buildAxis: string | null): AdditiveRouteInput => ({
  domain: RAPID_PROTOTYPING, ref: realRapidPrototypingReference(), spec: loadRapidPrototypingCalculatorSpec(), calculators: rapidPrototypingCalculatorsByName(),
  material: rapidPrototypingMaterial(material), part: TEE, machinesByClass: allRapidPrototypingMachines(), scenario: { batchSize: 50, route: null, buildAxis }, costContext: ZERO,
} as AdditiveRouteInput);

const CASES: [string, AdditiveRouteInput][] = [
  ...['Stainless Steel, 17-4PH', 'Duraform EX', 'Objet Rigid VeroBlack 875', 'Accura 25'].flatMap((m) => [
    [`additive ${m}, chosen build`, additive(m, null)], [`additive ${m}, upright`, additive(m, '+z')],
  ] as [string, AdditiveRouteInput][]),
  ...['Polyamide 12', 'Accura 25', '830 White', 'A6 Metal', 'V-Flash'].flatMap((m) => [
    [`rapid prototyping ${m}, chosen build`, rapid(m, null)], [`rapid prototyping ${m}, upright`, rapid(m, '+z')],
  ] as [string, AdditiveRouteInput][]),
];

describe('every additive calculator input says where its value came from', () => {
  it.each(CASES)('%s', (_name, input) => {
    const { routes } = buildAdditiveRoutes(input);
    expect(routes.length).toBeGreaterThan(0);
    expect(sourceGaps(routes.flatMap((r) => [...r.lines, ...runsAsLines(r.material.runs)]))).toEqual({ withoutRef: [], openingNothing: [] });
  });
});
