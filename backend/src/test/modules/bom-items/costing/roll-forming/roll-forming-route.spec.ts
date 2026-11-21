// The Sheet Metal Roll Forming routes on the real memory/Sheet metal roll forming data and the line machines as migration 1112 rates them.
import { readFileSync } from 'fs';
import { join } from 'path';

import { GRADE_LABOUR, realRollFormingCatalog, realRollFormingReference, rollFormingMachines, rollFormingMaterial } from './roll-forming-test-data';
import { loadRollFormingCalculatorSpec, rollFormingCalculatorsByName } from '../../../../../modules/bom-items/costing/roll-forming/calculators/roll-forming-calculator-spec';
import { buildRollFormingCalculatorsMigrationSql } from '../../../../../modules/bom-items/costing/roll-forming/calculators/roll-forming-calculators-migration';
import { buildRollFormingCostSummary, ROLL_FORMING_NOT_COSTED } from '../../../../../modules/bom-items/costing/roll-forming/roll-forming-cost-summary';
import { rollFormingOverrides, type RollFormingCostResult } from '../../../../../modules/bom-items/costing/roll-forming/roll-forming-cost.service';
import { punchPlan } from '../../../../../modules/bom-items/costing/roll-forming/roll-forming-features';
import { partLengthToleranceRow } from '../../../../../modules/bom-items/costing/roll-forming/roll-forming-line';
import { rollFormPart, ROLL_FORM_EXTRACTION_VERSION, type RollFormPart } from '../../../../../modules/bom-items/costing/roll-forming/roll-forming-part';
import {
  buildRollFormingRoutes, chooseRollFormingRoute, requiredShaft, rollFormingRule, ROLL_FORMING_CLASS, ROLL_FORMING_PROCESS_GROUP,
  type RollFormingRoute, type RollFormingRouteInput,
} from '../../../../../modules/bom-items/costing/roll-forming/roll-forming-route';
import { rollFormingRouteFor } from '../../../../../modules/bom-items/costing/roll-forming/roll-forming-route-comparison';
import { bendLevels, stationPlan } from '../../../../../modules/bom-items/costing/roll-forming/roll-forming-stations';
import { routeToolingItems } from '../../../../../modules/bom-items/costing/shared/route-tooling';
import { realToolShop } from '../hydroforming/hydroforming-test-data';

import type { CostSummaryResponseDto, ProcessLineCost } from '../../../../../modules/bom-items/dto/cost-breakdown.dto';

const ZERO = { qairPerHr: 0, inspTimeMin: 0, samplingRate: 0, yieldPct: 1, netMatCost: 0, netWeightKg: 0, scrapPricePerKg: 0 };
const ref = realRollFormingReference();
const STEEL = rollFormingMaterial('Steel, Cold Worked, AISI 1008');

const hole = (diameter: number, station: number, face: number) =>
  ({ feature_type: 'SimpleHole', size_mm: diameter, perimeter_mm: Math.PI * diameter, area_mm2: (Math.PI * diameter * diameter) / 4, depth_mm: null, station_mm: station, face_ids: [face] });
const bend = (angle: number, before: number, level: number | null, faces: number[] = []) =>
  ({ angle_deg: angle, inner_radius_mm: 1.5, flange_before_mm: before, level, face_ids: faces });
/** A measurement as rollFormGeometry stores it (top level camelCase, the engine's objects snake_case). */
const measured = (over: Record<string, unknown>) => ({
  extractionVersion: ROLL_FORM_EXTRACTION_VERSION, axis: [1, 0, 0], axisSource: 'bends', constantSection: true, stockFraction: 0.998,
  thicknessMm: 1.5, curve: null, features: [],
  ends: [
    { end: 'start', kind: 'square', cut_angle_deg: 0, cut_perimeter_mm: 120, face_ids: [90] },
    { end: 'end', kind: 'square', cut_angle_deg: 0, cut_perimeter_mm: 120, face_ids: [91] },
  ],
  ...over,
});
const partOf = (g: Record<string, unknown>): RollFormPart => {
  const { part, missing } = rollFormPart(g);
  if (!part) throw new Error(missing.join('; '));
  return part;
};
// A C channel 2 m long, 1.5 mm, two 90° bends on its 50 mm web, 120 mm strip (at the neutral fibre), four Ø8 holes along it.
const CHANNEL_G = measured({
  lengthMm: 2000, section: { height_mm: 36.5, width_mm: 53, area_mm2: 181.2, perimeter_mm: 244, closed: false, stock_form: 'GENERIC_EXTRUSION' },
  stripWidthMm: 120.8, stripWidthNeutralMm: 120, stripWidthCheck: { flats_mm: 113.7, bend_arcs_mm: 7.07, agrees: true },
  bends: [bend(90, 33, 1, [1, 2]), bend(90, 47.7, 1, [3, 4])], lastFlangeMm: 33,
  features: [hole(8, 200, 11), hole(8, 700, 12), hole(8, 1300, 13), hole(8, 1800, 14)],
});
const CHANNEL = partOf(CHANNEL_G);
// A closed 40 x 40 square tube 1.5 m long, 1.5 mm, welded along its seam: four 90° bends, the two on its web level 1, the two beyond level 2.
const TUBE = partOf(measured({
  lengthMm: 1500, section: { height_mm: 40, width_mm: 40, area_mm2: 228, perimeter_mm: 302, closed: true, stock_form: 'SQUARE_TUBE' },
  stripWidthMm: 152, stripWidthNeutralMm: 150.7, bends: [bend(90, 37, 1), bend(90, 37, 2), bend(90, 37, 2), bend(90, 37, 1)], lastFlangeMm: 0,
  ends: [{ end: 'start', kind: 'square', cut_angle_deg: 0, cut_perimeter_mm: 150.7, face_ids: [] }, { end: 'end', kind: 'square', cut_angle_deg: 0, cut_perimeter_mm: 150.7, face_ids: [] }],
}));

const input = (part: RollFormPart, over: Partial<RollFormingRouteInput> = {}, scenario: Partial<RollFormingRouteInput['scenario']> = {}): RollFormingRouteInput => ({
  ref, spec: loadRollFormingCalculatorSpec(), calculators: rollFormingCalculatorsByName(), material: STEEL, part,
  machinesByClass: rollFormingMachines('USA'), costContext: ZERO, toolShop: realToolShop(), catalog: realRollFormingCatalog(),
  ...over,
  scenario: { batchSize: 1000, route: null, stations: null, welding: null, toolingMultiplier: null, amortizationParts: 100000, ...scenario },
});
const routesOf = (inp: RollFormingRouteInput) => {
  const { routes, missing } = buildRollFormingRoutes(inp);
  if (missing.length) throw new Error(missing.join('; '));
  return routes;
};
const route = (inp: RollFormingRouteInput, key: 'scissor' | 'blade') => routesOf(inp).find((r) => r.key === key)!;
const lineOf = (r: RollFormingRoute, process: string) => r.lines.find((l) => l.process === process);
/** The calculated fields of a line's calculator run, by name (its calculation trace). */
const runOf = (line: ProcessLineCost | undefined): Record<string, number> =>
  Object.fromEntries((line?.calculationTrace ?? []).filter((t) => t.kind === 'calculated' && typeof t.value === 'number').map((t) => [t.fieldName, t.value as number]));
const v = (name: string) => ref.number(name)!;

describe('the Sheet Metal Roll Forming calculators (migration 1113)', () => {
  it('are what migration 1113 creates (regenerate it after editing the spec)', () => {
    expect(readFileSync(join(__dirname, '../../../../../../migrations/1113_roll_forming_calculators.sql'), 'utf8')).toBe(buildRollFormingCalculatorsMigrationSql());
  });

  it('every variable they read is in memory/Sheet metal roll forming', () => {
    for (const c of loadRollFormingCalculatorSpec().calculators) {
      for (const f of c.fields) if (f.source && 'variable' in f.source) expect([c.name, f.source.variable, ref.number(f.source.variable) != null]).toEqual([c.name, f.source.variable, true]);
    }
  });

  it('compute the ten catalog processes of the group, are named "Roll Forming - ..." and never the user\'s own "Sheet Metal - Roll Forming"', () => {
    const spec = loadRollFormingCalculatorSpec();
    expect(spec.processGroup).toBe('Sheet Metal Roll Forming');
    expect(spec.calculators.flatMap((c) => c.operations).sort()).toEqual([
      'Coil Flattener', 'Coil Material Stock', 'Cut-Off Press', 'Integrated HFI Welding', 'Integrated Laser Welding', 'Integrated Rotary Spot Welding',
      'Integrated TIG Welding', 'Punch Press', 'Roll Forming Mill', 'Uncoiler',
    ]);
    expect(spec.calculators.every((c) => c.name.startsWith('Roll Forming - '))).toBe(true);
  });
});

describe('the profile as the cad-engine measures it (rf_v1)', () => {
  it('reads rollFormGeometry as Refresh analysis writes it, the strip at the neutral fibre when measured', () => {
    expect(CHANNEL).toMatchObject({
      lengthMm: 2000, stripWidthMm: 120, stripWidthSource: 'neutral fibre', stripWidthMidMm: 120.8, thicknessMm: 1.5,
      section: { heightMm: 36.5, widthMm: 53, closed: false }, lastFlangeMm: 33, curve: null,
    });
    expect(CHANNEL.bends.map((b) => [b.angleDeg, b.level, b.faceIds])).toEqual([[90, 1, [1, 2]], [90, 1, [3, 4]]]);
    expect(CHANNEL.features).toHaveLength(4);
    expect(CHANNEL.ends.map((e) => [e.end, e.kind, e.cutPerimeterMm])).toEqual([['start', 'square', 120], ['end', 'square', 120]]);
    // The strip's order not read (a branched strip): the mid-line width, levels and flats null.
    const branched = partOf(measured({ ...CHANNEL_G, stripWidthNeutralMm: null, bends: [bend(90, 33, 1), { ...bend(90, 0, null), flange_before_mm: null }] }));
    expect(branched).toMatchObject({ stripWidthMm: 120.8, stripWidthSource: 'mid-line' });
    expect(branched.bends[1]).toMatchObject({ level: null, flangeBeforeMm: null });
  });

  it('an analysis from before the measurement asks for Refresh analysis; a part that is not a profile says so', () => {
    expect(rollFormPart(undefined).missing).toEqual(['the roll forming measurements: press Refresh analysis so the part is measured for roll forming']);
    expect(rollFormPart({ extractionVersion: 'rf_v0' }).missing[0]).toMatch(/press Refresh analysis/);
    expect(rollFormPart(null).missing[0]).toMatch(/^the part is not a roll formed profile: /);
    expect(rollFormPart({ ...CHANNEL_G, constantSection: false, stockFraction: 0.61 }).missing).toEqual(['the part is not a roll formed profile: its cross-section changes along its length (the section holds over 61 % of its length)']);
    expect(rollFormPart({ ...CHANNEL_G, stripWidthMm: null, stripWidthNeutralMm: null }).missing).toEqual(["the strip width (the section's stretch-out): the cad-engine could not measure it on this part"]);
  });
});

describe('the roll stations (bend levels x rollFormingLiftAngle, lead-in and finishing passes)', () => {
  it('a C channel: one level of two 90° bends is ceil(90 / 15) = 6 passes, and the Standard cross-section tolerance 1 finishing pass', () => {
    const plan = stationPlan(ref, CHANNEL);
    expect(plan).toMatchObject({ formingPasses: 6, liftAngleDeg: 15, panel: false, levelSource: 'cad' });
    expect(plan.levels).toEqual([{ level: 1, bends: 2, maxAngleDeg: 90, passes: 6 }]);
    expect(plan.toleranceRow?.['Number of Finishing Passes']).toBe(1);
    expect(route(input(CHANNEL), 'scissor').stations).toMatchObject({ forming: 6, leadIn: 0, finishing: 1, rule: 7, total: 7 });
  });

  it('each level takes its largest angle: the tube 6 + 6 forming passes; a 100° and a 40° bend on one level take ceil(100 / 15) = 7', () => {
    expect(stationPlan(ref, TUBE).levels.map((l) => l.passes)).toEqual([6, 6]);
    expect(route(input(TUBE), 'blade').stations.total).toBe(13);
    expect(stationPlan(ref, { bends: [{ ...CHANNEL.bends[0], angleDeg: 100 }, { ...CHANNEL.bends[1], angleDeg: 40 }], lastFlangeMm: 33 }).formingPasses).toBe(7);
  });

  it('a strip thicker than leadInRollStationThicknessThreshold (1.524 mm) takes a lead-in pass', () => {
    const thick = { ...CHANNEL, thicknessMm: 2 };
    expect(route(input(thick), 'scissor').stations).toMatchObject({ forming: 6, leadIn: 1, finishing: 1, total: 8 });
  });

  it('levels from the flats when the cad-engine gives none: k bends out from the widest flat', () => {
    // A hat: brim 20, wall 30, crown 60, wall 30, brim 20: the crown is the web, the walls' bends level 1, the brims' level 2.
    const hat = { bends: [20, 30, 60, 30].map((before) => ({ angleDeg: 90, innerRadiusMm: 1.5, flangeBeforeMm: before, level: null, faceIds: [] })), lastFlangeMm: 20 };
    expect(bendLevels(hat)).toEqual({ levels: [2, 1, 1, 2], source: 'flats' });
  });

  it('a profile of minNumBendsForPanelCrossSection (8) bends is a panel: a duplex mill and the panel tooling multiplier', () => {
    const angles = [45, 45, 90, 90, 90, 90, 45, 45];
    const panel = partOf(measured({
      lengthMm: 3000, section: { height_mm: 40, width_mm: 600, area_mm2: 1050, perimeter_mm: 1500, closed: false, stock_form: 'GENERIC_EXTRUSION' },
      stripWidthMm: 700, stripWidthNeutralMm: 698, thicknessMm: 0.7,
      bends: angles.map((a, i) => bend(a, 60, [4, 3, 2, 1, 1, 2, 3, 4][i])), lastFlangeMm: 60,
    }));
    const r = route(input(panel), 'scissor');
    expect(r.stations.panel).toBe(true);
    expect(r.mill).toMatchObject({ type: 'duplex' });
    expect(r.tooling[0]?.detail).toContain(`multiplier ${v('toolingMultiplier_Panel')}`);
  });

  it('the Cost Guide\'s rollFormStations replaces the rule\'s, and the mill must have them', () => {
    const r = route(input(CHANNEL, {}, { stations: 30 }), 'scissor');
    expect(r.stations).toMatchObject({ rule: 7, total: 30, override: 30 });
    expect(r.mill?.stands).toBeGreaterThanOrEqual(30);
  });
});

describe('the mill (preferred first, then the cheapest that has what the profile needs)', () => {
  it('the C channel: a standard mill with the stands, the 2" shaft millShaftDiameters gives 1.5 mm, the section height and the roll space', () => {
    const r = route(input(CHANNEL), 'scissor');
    expect(requiredShaft(ref, 1.5, STEEL.utsMpa)).toMatchObject({ mm: 50.8 });
    expect(r.mill).toMatchObject({ name: 'Roll Former 2" Shaft Diameter 12 Stand', stands: 12, shaftDiameterMm: 50.8, type: 'standard' });
    expect(lineOf(r, 'Roll Forming Mill')?.machineChoice).toMatchObject({ chosen: 'Roll Former 2" Shaft Diameter 12 Stand', checkedCount: 37 });
    expect(lineOf(r, 'Roll Forming Mill')?.machineChoice?.criteria).toEqual(['Enough roll stands', 'The shaft the strip needs', 'Takes the stock thickness', 'Forms the section height', 'Its roll space takes the strip', 'A standard mill']);
  });

  it('an ultra-high-strength material (UTS at or above ultraHighStrengthMaterialThresholdLow) takes a shaft a size up', () => {
    const s900 = rollFormingMaterial('Steel, Hot Worked, S900MC');
    expect(requiredShaft(ref, 1.5, s900.utsMpa)).toMatchObject({ mm: 63.5 });
    expect(route(input(CHANNEL, { material: s900 }), 'scissor').mill?.shaftDiameterMm).toBeGreaterThanOrEqual(63.5);
  });
});

describe('the line speed: the slowest of its limits, named', () => {
  it('a 2 m channel runs at the part-length tolerance\'s 660.4 mm/s (Encoder Open Loop, +/-0.762 mm; the variable\'s "+/- " spelling matched)', () => {
    expect(partLengthToleranceRow(ref).row?.['Maximum Line Speed (mm / s)']).toBe(660.4);
    const r = route(input(CHANNEL), 'scissor');
    expect(r.lineSpeed?.mmPerS).toBeCloseTo(660.4, 6);
    expect(r.lineSpeed?.limiting).toMatch(/^the part-length tolerance/);
    // Every machine on the line is busy the feed at that speed, plus the line's stoppages.
    const mill = runOf(lineOf(r, 'Roll Forming Mill'));
    expect(mill['Run Time']).toBeCloseTo(2000 / 660.4, 3);
    expect(mill['Cycle Time']).toBeCloseTo(2000 / 660.4 + r.coil!.perPartS + r.dieSharpeningPerPartS, 3);
  });

  it('a short part is held to its presses\' strokes: strokes a minute x stationaryDieLineSpeedFactor x the feed / 60', () => {
    const short = { ...CHANNEL, lengthMm: 150, features: CHANNEL.features.slice(0, 1) };
    const r = route(input(short), 'scissor');
    const punch = lineOf(r, 'Punch Press')!;
    const cutoff = lineOf(r, 'Cut-Off Press')!;
    const spm = Math.min(...[punch, cutoff].map((l) => Number(rollFormingMachines('USA')[l.machineClass === ROLL_FORMING_CLASS.punch ? ROLL_FORMING_CLASS.punch : ROLL_FORMING_CLASS.cutoff].find((m) => m.name === l.machineName)!.specs.strokes_per_minute)));
    expect(r.lineSpeed?.mmPerS).toBeCloseTo((spm * v('stationaryDieLineSpeedFactor') * 150) / 60, 6);
    expect(r.lineSpeed?.limiting).toMatch(/strokes a minute/);
  });

  it('a closed tube of 3.2 mm is held to its HFI welder (the 400 kW welder takes 3.2 mm, at 500 mm/s)', () => {
    const tube = { ...TUBE, thicknessMm: 3.2 };
    const r = route(input(tube), 'blade');
    expect(r.welding).toMatchObject({ process: 'Integrated HFI Welding', machine: 'HFI Welder 400kW', source: 'rule' });
    expect(r.lineSpeed).toMatchObject({ mmPerS: 500, limiting: 'Integrated HFI Welding HFI Welder 400kW' });
  });

  it('a curved profile runs at profileRollBendingSpeed (85 mm/s) on a mill with a curving unit', () => {
    const curved = { ...CHANNEL, curve: { radiusMm: 2000, angleDeg: 57.3 } };
    const r = route(input(curved), 'scissor');
    expect(r.lineSpeed).toMatchObject({ mmPerS: 85, limiting: 'profile bending on the curving unit (profileRollBendingSpeed)' });
    expect(r.mill).toMatchObject({ curveUnit: true });
  });
});

describe('the coil: its change shared by the parts a coil makes', () => {
  it('the annulus of stockCoilInnerDiameter / stockCoilOuterDiameter as wide as the strip (capped by the uncoiler), end welded above 1.143 mm', () => {
    const r = route(input(CHANNEL), 'scissor');
    const uncoiler = rollFormingMachines('USA')[ROLL_FORMING_CLASS.uncoiler].find((m) => m.name === lineOf(r, 'Uncoiler')!.machineName)!;
    const full = (Math.PI / 4) * (v('stockCoilOuterDiameter') ** 2 - v('stockCoilInnerDiameter') ** 2) * 120 * 7850 / 1e9;
    const coilKg = Math.min(full, Number(uncoiler.specs.max_coil_capacity_kg));
    const stripKg = (120 * 2000 * 1.5 * 7850) / 1e9;
    const parts = Math.floor(coilKg / stripKg);
    const change = v('coilEndWeldTime') + Number(uncoiler.specs.coil_load_time_s);
    expect(r.coil).toMatchObject({ partsPerCoil: parts, changeTimeS: change });
    expect(r.coil!.perPartS).toBeCloseTo(change / parts, 9);
    expect(r.coil!.method).toMatch(/^end weld/);
    // A strip at or under coilEndWeldingThicknessThreshold is threaded instead.
    expect(route(input({ ...CHANNEL, thicknessMm: 1 }), 'scissor').coil!.changeTimeS).toBe(v('coilThreadingTime') + Number(uncoiler.specs.coil_load_time_s));
  });

  it('die re-sharpening stops the line stationaryDieChangeoverTime every numHitsPerDieChange hits of each press die', () => {
    expect(route(input(CHANNEL), 'scissor').dieSharpeningPerPartS).toBeCloseTo(v('stationaryDieChangeoverTime') * (1 / v('numHitsPerDieChangePunchPress') + 1 / v('numHitsPerDieChangeCutOffPress')), 9);
    expect(route(input(TUBE), 'blade').dieSharpeningPerPartS).toBeCloseTo(v('stationaryDieChangeoverTime') / v('numHitsPerDieChangeCutOffPress'), 9);
  });

  it('the cut-off bands the parts: packBandingTime over partBandedPackSize, on its line only', () => {
    const r = route(input(CHANNEL), 'scissor');
    expect(runOf(lineOf(r, 'Cut-Off Press'))['Banding per Part']).toBeCloseTo(v('packBandingTime') / v('partBandedPackSize'), 9);
    expect(runOf(lineOf(r, 'Roll Forming Mill'))['Banding per Part']).toBeUndefined();
  });

  it('the coil is flattened at or above coilFlatteningThickness, or of a yield at or above coilFlatteningYieldStrength', () => {
    expect(lineOf(route(input(CHANNEL), 'scissor'), 'Coil Flattener')).toBeUndefined();
    expect(route(input({ ...CHANNEL, thicknessMm: 2.6 }), 'scissor').flattener.needed).toBe(true);
    const r = route(input(CHANNEL, { material: rollFormingMaterial('Steel, Hot Worked, S900MC') }), 'scissor');
    expect(lineOf(r, 'Coil Flattener')?.physicsGap).toBeUndefined();
    expect(r.flattener.reason).toMatch(/coilFlatteningYieldStrength/);
  });
});

describe("the cut-off and memory's rule", () => {
  it('an open channel is cut off by scissor: no slug, and the Scissor route is quoted; the Blade route is costed and shown', () => {
    const routes = routesOf(input(CHANNEL));
    const rule = rollFormingRule(ref, CHANNEL);
    expect(rule).toMatchObject({ route: 'scissor', closed: false });
    const { route: quoted, note } = chooseRollFormingRoute(routes, rule, null);
    expect(quoted?.key).toBe('scissor');
    expect(quoted?.material).toMatchObject({ slugMm: 0, feedLengthMm: 2000 });
    expect(note).toMatch(/Roll Forming - Blade Cut-Off \d+\.\d\d USD/);
    expect(routes.find((r) => r.key === 'blade')!.material).toMatchObject({ slugMm: v('slugDieCutOffLength'), feedLengthMm: 2010 });
  });

  it('a closed tube is cut off by blade (a slugDieCutOffLength slug) and welded along its seam by Integrated HFI Welding', () => {
    const routes = routesOf(input(TUBE));
    const { route: quoted } = chooseRollFormingRoute(routes, rollFormingRule(ref, TUBE), null);
    expect(quoted?.key).toBe('blade');
    expect(quoted?.lines.map((l) => l.process)).toEqual(['Coil Material Stock', 'Uncoiler', 'Roll Forming Mill', 'Integrated HFI Welding', 'Cut-Off Press']);
    expect(quoted?.complete).toBe(true);
  });

  it('the Cost Guide sets the cut-off (rollFormCutOff) and the welding (rollFormWelding)', () => {
    expect(chooseRollFormingRoute(routesOf(input(TUBE)), rollFormingRule(ref, TUBE), 'scissor').route?.key).toBe('scissor');
    const r = route(input(TUBE, {}, { welding: 'rotary-spot' }), 'blade');
    expect(lineOf(r, 'Integrated Rotary Spot Welding')?.machineName).toMatch(/^Rotary Spot Welder/);
    expect(rollFormingOverrides({ rollFormCutOff: 'Blade', rollFormWelding: 'tig', rollFormStations: '14', rollFormToolingMultiplier: 20 }))
      .toEqual({ cutOff: 'blade', welding: 'tig', stations: 14, toolingMultiplier: 20 });
    expect(rollFormingOverrides({ rollFormCutOff: 'auto', rollFormWelding: 'auto' })).toEqual({ cutOff: null, welding: null, stations: null, toolingMultiplier: null });
  });
});

describe('the punch press: one progressive die before the mill', () => {
  it('a die station per kind of feature; memory\'s catalog rows name the features and their faces', () => {
    const r = route(input(CHANNEL), 'scissor');
    expect(r.punching).toMatchObject({ dieStations: ['Pre Punching SimpleHole'], punched: 4, notPunched: [] });
    expect(lineOf(r, 'Punch Press')?.catalogOperations?.[0]).toMatchObject({ operations: ['Pre Punching'], featureType: 'SimpleHole', count: 4, featureFaceIds: [[11], [12], [13], [14]] });
    expect(lineOf(r, 'Roll Forming Mill')?.catalogOperations?.[0]).toMatchObject({ operations: ['Bending'], featureType: 'StraightBend', featureFaceIds: [[1, 2], [3, 4]] });
    expect(lineOf(r, 'Cut-Off Press')?.catalogOperations?.[0]).toMatchObject({ operations: ['Scissor Cut-Off'], featureType: 'End', featureFaceIds: [[90], [91]] });
  });

  it('holes too small to punch (under minHoleDiameterRatios at the UTS x t) are a No Cost Feature, and nothing is left for the press', () => {
    const small = { ...CHANNEL, features: partOf({ ...CHANNEL_G, features: [hole(2, 300, 21), hole(2, 900, 22)] }).features };
    const plan = punchPlan(ref, small, STEEL.utsMpa);
    // AISI 1008, 350 MPa UTS: the 655 MPa row's 2 x t (the first row at or above it), over minPunchingThicknessFactor 0.8 x t: 3 mm.
    expect(plan.minHoleMm).toBeCloseTo(3, 9);
    const r = route(input(small), 'scissor');
    const ncf = r.lines.filter((l) => l.process === 'No Cost Feature');
    expect(ncf).toHaveLength(1);
    expect(ncf[0]).toMatchObject({ totalCost: 0, processGroup: ROLL_FORMING_PROCESS_GROUP });
    expect(ncf[0].operation).toMatch(/^2 SimpleHoles of 2 mm: too small to punch in the 1.5 mm strip: under the 3 mm smallest hole/);
    expect(lineOf(r, 'Punch Press')).toBeUndefined();
    expect(r.complete).toBe(true);
  });

  it('a form deeper than maxFormDepthInlinePunching is a No Cost Feature; a shallow one is punched', () => {
    const forms = partOf({ ...CHANNEL_G, features: [
      { feature_type: 'Form', size_mm: 20, perimeter_mm: 60, area_mm2: 0, depth_mm: 12, station_mm: 500, face_ids: [31] },
      { feature_type: 'Form', size_mm: 20, perimeter_mm: 60, area_mm2: 0, depth_mm: 3, station_mm: 900, face_ids: [32] },
    ] });
    const r = route(input(forms), 'scissor');
    expect(r.punching).toMatchObject({ dieStations: ['Pre Forming Form'], punched: 1 });
    expect(r.lines.find((l) => l.process === 'No Cost Feature')?.operation).toMatch(/12 mm deep, deeper than the inline press forms \(maxFormDepthInlinePunching 7.94 mm\)/);
  });
});

describe('the tooling: the rolls and the press dies, spread over the job', () => {
  it('the rolls: toolingMultiplier_Standard x the strip width x the stations, with profit and SG&A, one set a toolLifeByMaterial life', () => {
    const r = route(input(CHANNEL), 'scissor');
    const rolls = r.tooling.find((t) => t.key === 'roll-tooling')!;
    const cost = v('toolingMultiplier_Standard') * 120 * 7 * (1 + v('percentProfit') + v('percentSGandA'));
    expect(rolls.costUsd).toBeCloseTo(cost, 2);
    expect(rolls).toMatchObject({ toolLife: 3000000, copies: 1, amortizationParts: 100000 });
    expect(rolls.perPartUsd).toBeCloseTo(cost / 100000, 4);
    // 7 million parts wear out ceil(7e6 / 3e6) = 3 sets; the Cost Guide's multiplier replaces the data's.
    const long = route(input(CHANNEL, {}, { amortizationParts: 7000000, toolingMultiplier: 20 }), 'scissor').tooling[0];
    expect(long).toMatchObject({ copies: 3 });
    expect(long.investmentUsd).toBeCloseTo(20 * 120 * 7 * 1.2 * 3, 2);
  });

  it('the dies: the compact model at the tool shop\'s rates, a die lasting numPartsPerTool parts', () => {
    const r = route(input(CHANNEL), 'scissor');
    const shop = realToolShop();
    const punch = r.tooling.find((t) => t.key === 'punch-die')!;
    const out = punch.run!.outputs;
    expect(out['Design Cost']).toBeCloseTo((v('punchPressDesignPreparationHrs') + v('punchPressDieBaseDesignHrs')) * shop.designUsdPerHr, 6);
    expect(out['Assembly Cost']).toBeCloseTo(v('punchPressToolingAssemblyHrs') * shop.assemblyUsdPerHr, 6);
    expect(out['Component Cost']).toBe(4 * (125 + 125 + 75 + 5));
    expect(out['Heat Treat Cost']).toBe(0);
    expect(punch.costUsd).toBeCloseTo(out['Die Subtotal'] * (1 + v('percentProfit') + v('percentSGandA')), 2);
    const cut = r.tooling.find((t) => t.key === 'cut-off-die')!;
    expect(cut.run!.outputs['Die Cost']).toBeCloseTo(cut.run!.outputs['Die Subtotal'] * (1 + v('percentTuning')) * (1 + v('percentProfit') + v('percentSGandA')), 6);
    expect(cut.run!.outputs['Insert Cost']).toBeGreaterThan(0);
    expect(route(input(CHANNEL, {}, { amortizationParts: 10000000 }), 'scissor').tooling.find((t) => t.key === 'cut-off-die')).toMatchObject({ copies: 4, toolLife: v('numPartsPerTool') });
  });

  it('are written on Apply over the parts the engine spread them', () => {
    const r = route(input(CHANNEL), 'scissor');
    const items = routeToolingItems({
      family: 'sheet_metal',
      rollFormingTooling: r.tooling.map((t) => ({ key: t.key, description: t.description, detail: t.detail, costUsd: t.investmentUsd, toolCostUsd: t.costUsd, perPartUsd: t.perPartUsd, amortizationParts: t.amortizationParts })),
    });
    expect(items.map((i) => [i.key, i.amortizationParts])).toEqual([['roll-forming-roll-tooling', 100000], ['roll-forming-punch-die', 100000], ['roll-forming-cut-off-die', 100000]]);
  });
});

describe('the line in the USA and in India', () => {
  it('each machine at its location\'s rate: the USA rows at the Netherlands overheads and USA labour, the India twins at the India export\'s', () => {
    const usa = route(input(CHANNEL), 'scissor');
    const india = route(input(CHANNEL, { machinesByClass: rollFormingMachines('India') }), 'scissor');
    expect(lineOf(usa, 'Roll Forming Mill')?.labourRate).toBe(GRADE_LABOUR['4 - Metal'].USA);
    expect(lineOf(india, 'Roll Forming Mill')?.labourRate).toBe(GRADE_LABOUR['4 - Metal'].India);
    expect(lineOf(india, 'Uncoiler')?.labourRate).toBe(GRADE_LABOUR['3 - Metal'].India);
    expect(india.totalUsd!).toBeLessThan(usa.totalUsd!);
    // The same strip and material either way (priced in USD; the service converts the currency).
    expect(india.material.costUsd).toBeCloseTo(usa.material.costUsd, 9);
    // Every line is costed by its calculator, the run on the line.
    for (const l of [...usa.lines, ...india.lines]) expect(l.calculatorId).toMatch(/^Roll Forming - /);
  });
});

describe('a part the line cannot make', () => {
  it('a sheet thicker than maxCoilThickness, a yield above maxCoilYieldStrength or a curve tighter than the curving unit: No Cost Feature lines', () => {
    const thick = route(input({ ...CHANNEL, thicknessMm: 6 }), 'scissor');
    expect(thick).toMatchObject({ feasible: false, complete: false, totalUsd: null });
    expect(thick.lines.map((l) => [l.process, l.operation])).toEqual([['No Cost Feature', 'Not roll formed: the 6 mm sheet is thicker than a coil is roll formed (maxCoilThickness 5.08 mm)']]);
    expect(route(input(CHANNEL, { material: rollFormingMaterial('Inconel 718') }), 'scissor').infeasible[0]).toMatch(/1017 MPa yield is above .* \(maxCoilYieldStrength 965.26 MPa\)/);
    expect(route(input({ ...CHANNEL, curve: { radiusMm: 100, angleDeg: 90 } }), 'scissor').infeasible[0]).toMatch(/tighter than the curving unit bends \(curveUnitTopRollerDiameter 150 mm\)/);
  });
});

describe('the summary and the route comparison', () => {
  const routes = routesOf(input(CHANNEL));
  const rule = rollFormingRule(ref, CHANNEL);
  const { route: quoted, note } = chooseRollFormingRoute(routes, rule, null);
  const result: RollFormingCostResult = { route: quoted, routes, rule, part: CHANNEL, material: STEEL, note, missing: [], warnings: [] };
  const summary = buildRollFormingCostSummary({ rollForming: result, materialGrade: STEEL.name, materialCostPerKg: 1.751, materialSource: 'db', batchSize: 1000, warnings: [], ratesSource: 't' }) as CostSummaryResponseDto;

  it('quotes the Scissor line; Apply\'s material record is the strip, its tooling the rolls and dies', () => {
    expect(summary.rollForming).toMatchObject({ route: 'scissor', rule: { route: 'scissor', closed: false }, stations: { total: 7 }, strip: { widthMm: 120, feedLengthMm: 2000 } });
    expect(summary.blankSpec).toMatchObject({ form: 'sheet', grossWeightKg: Math.round(quoted!.material.stripKg * 1000) / 1000 });
    expect(summary.blankSpec?.sizeLabel).toBe('120 mm x 2000 mm strip, 1.5 mm coil');
    expect(summary.totalCost).toBeCloseTo(quoted!.totalUsd!, 2);
    expect(summary.rollFormingTooling?.map((t) => t.key)).toEqual(['roll-tooling', 'punch-die', 'cut-off-die']);
    expect(Object.keys(summary.calculatorRuns ?? {})).toEqual(['Roll forming material', 'Roll forming strip', 'Roll forming stations', 'Roll forming line speed', 'Roll forming coil change']);
  });

  it('its route is feasible in the comparison; the other is not a route for this quote', () => {
    expect(rollFormingRouteFor('scissor', summary)).toMatchObject({ routeId: 'roll-forming-scissor', isFeasible: true, processFamily: 'forming' });
    expect(rollFormingRouteFor('blade', summary)).toMatchObject({ routeId: 'roll-forming-blade', isFeasible: false, totalCost: null });
  });

  it('an uncosted part is one named gap line, and both routes say why', () => {
    const none: RollFormingCostResult = { route: null, routes: [], rule: null, part: null, material: null, note: null, missing: rollFormPart(undefined).missing, warnings: [] };
    const s = buildRollFormingCostSummary({ rollForming: none, materialGrade: 'x', materialCostPerKg: 0, materialSource: 'default', batchSize: 1, warnings: [], ratesSource: 't' }) as CostSummaryResponseDto;
    expect(s.processLines).toHaveLength(1);
    expect(s.processLines[0]?.physicsGap).toMatchObject({ reason: `${ROLL_FORMING_NOT_COSTED}: the roll forming measurements: press Refresh analysis so the part is measured for roll forming` });
    expect(s.totalCost).toBe(0);
    expect(rollFormingRouteFor('scissor', s)).toMatchObject({ isFeasible: false, totalCost: null });
    expect(rollFormingRouteFor('scissor', s).capability.warnings[0]).toMatch(/press Refresh analysis/);
  });
});
