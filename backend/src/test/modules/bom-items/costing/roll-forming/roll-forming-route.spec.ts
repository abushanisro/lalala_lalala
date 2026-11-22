// The Sheet Metal Roll Forming routes on the real memory/Sheet metal roll forming data and the line machines as migration 1112 rates them.
import { readFileSync } from 'fs';
import { join } from 'path';

import { GRADE_LABOUR, realLookups, realRollFormingCatalog, realRollFormingReference, realVariables, rollFormingMachines, rollFormingMaterial } from './roll-forming-test-data';
import { resolveSandReference } from '../../../../../modules/bom-items/costing/casting/sand/sand-reference';
import { loadRollFormingCalculatorSpec, rollFormingCalculatorsByName } from '../../../../../modules/bom-items/costing/roll-forming/calculators/roll-forming-calculator-spec';
import { buildRollFormingCalculatorsMigrationSql } from '../../../../../modules/bom-items/costing/roll-forming/calculators/roll-forming-calculators-migration';
import { buildRollFormingCostSummary, ROLL_FORMING_NOT_COSTED } from '../../../../../modules/bom-items/costing/roll-forming/roll-forming-cost-summary';
import { RollFormingCostService, rollFormingOverrides, type RollFormingCostResult } from '../../../../../modules/bom-items/costing/roll-forming/roll-forming-cost.service';
import { punchPlan } from '../../../../../modules/bom-items/costing/roll-forming/roll-forming-features';
import { partLengthToleranceRow } from '../../../../../modules/bom-items/costing/roll-forming/roll-forming-line';
import { notAProfileReason, rollFormPart, ROLL_FORM_EXTRACTION_VERSION, type RollFormPart } from '../../../../../modules/bom-items/costing/roll-forming/roll-forming-part';
import {
  buildRollFormingRoutes, chooseRollFormingRoute, requiredShaft, rollFormingRule, ROLL_FORMING_CLASS, ROLL_FORMING_PROCESS_GROUP,
  type RollFormingRoute, type RollFormingRouteInput,
} from '../../../../../modules/bom-items/costing/roll-forming/roll-forming-route';
import { rollFormingRouteFor } from '../../../../../modules/bom-items/costing/roll-forming/roll-forming-route-comparison';
import { bendLevels, stationPlan, webIndex } from '../../../../../modules/bom-items/costing/roll-forming/roll-forming-stations';
import { toolLifeRow } from '../../../../../modules/bom-items/costing/roll-forming/roll-forming-tooling';
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

  it('a part measured as no profile says why: not a sheet part, a flat part, or bends that do not run one way', () => {
    // The Lead Screw side shaft, a turned part the sheet-metal measurement read as a 0.8 mm sheet of 36.6 mm² (4 "bends": its diameters).
    expect(rollFormPart(null, 0.8, { partVolumeMm3: 2625.5, flatPatternAreaMm2: 36.6, bendCount: 4 }).missing).toEqual([
      "the part is not a roll formed profile: the cad-engine found 1 % of the part's 2,626 mm³ as a 0.8 mm sheet (37 mm² flat, 89.67x); "
        + 'it is not a sheet part, or its sheet was not all measured (a curved sheet of B-spline faces is not found)']);
    // R_M-0230-039 STIFFNER 2: a 3 mm plate (its volume is 1.01x the sheet) with no bends.
    expect(rollFormPart(null, 3, { partVolumeMm3: 15208.89, flatPatternAreaMm2: 5015.2, bendCount: 0 }).missing).toEqual([
      'the part is not a roll formed profile: it is flat (no bends), so a roll forming line has nothing to form; a flat part is cut from a blank (Sheet Metal)']);
    // A sheet with bends that do not all run one way (a bracket folded two ways), or nothing known of the part beyond the measurement.
    const twoWays = 'the part is not a roll formed profile: the cad-engine found no cross-section swept along one axis (its bends do not all run one way)';
    expect(notAProfileReason(1.5, { partVolumeMm3: 30000, flatPatternAreaMm2: 20000, bendCount: 2 })).toBe(twoWays);
    expect(rollFormPart(null).missing).toEqual([twoWays]);
    // An unknown bend count is not taken for a flat part, and a sheet share it cannot work out is not a refusal.
    expect(notAProfileReason(1.5, { partVolumeMm3: null, flatPatternAreaMm2: 20000, bendCount: null })).toBe(twoWays);
  });
});

describe('the roll stations (bend levels, lift angle and flange length on the mill, lead-in and finishing passes)', () => {
  it('a C channel: one level of two 90° bends at rollFormingLiftAngle 15° a pass is 6 passes, and the Standard tolerance 1 finishing pass', () => {
    const plan = stationPlan(ref, CHANNEL, null);
    expect(plan).toMatchObject({ liftAngleDeg: 15, panel: false, levelSource: 'cad', flangeSource: 'open strip' });
    // Each bend carries its 33 mm flange out to the strip's edge.
    expect(plan.levels).toEqual([{ level: 1, bends: 2, maxAngleDeg: 90, flangeCarriedMm: 33 }]);
    expect(plan.toleranceRow?.['Number of Finishing Passes']).toBe(1);
    const r = route(input(CHANNEL), 'scissor');
    expect(r.stations).toMatchObject({ forming: 6, leadIn: 0, finishing: 1, rule: 7, total: 7, standSpacingMm: 381 });
    expect(r.stations.levels).toEqual([{ level: 1, bends: 2, maxAngleDeg: 90, flangeCarriedMm: 33, passes: 6, degreesPerPass: 15, governedBy: 'lift angle' }]);
  });

  it('a long flange takes more passes: no more than 3 t S² / (8 a³) a pass on the mill\'s stand spacing S (Bhattacharyya et al. 1984)', () => {
    // A 150 mm web with 100 mm flanges, 1.5 mm: on a 381 mm stand spacing a pass bends the 100 mm flange 4.68°, on 508 mm 8.32°.
    const wide = partOf(measured({
      lengthMm: 2000, section: { height_mm: 101.5, width_mm: 153, area_mm2: 531, perimeter_mm: 700, closed: false, stock_form: 'GENERIC_EXTRUSION' },
      stripWidthMm: 354.8, stripWidthNeutralMm: 354, bends: [bend(90, 100, 1), bend(90, 147.7, 1)], lastFlangeMm: 100,
    }));
    const deg = (S: number) => ((3 * 1.5 * S * S) / (8 * 100 ** 3)) * (180 / Math.PI);
    expect(deg(381)).toBeCloseTo(4.68, 2);
    const r = route(input(wide), 'scissor');
    const S = r.stations.standSpacingMm!;
    expect(r.stations.levels).toEqual([{ level: 1, bends: 2, maxAngleDeg: 90, flangeCarriedMm: 100, passes: Math.ceil(90 / deg(S) - 1e-6), degreesPerPass: expect.closeTo(deg(S), 6), governedBy: 'flange length' }]);
    // With its rolls weighed over the job, the line picks the 3.5" 12 stand: its 635 mm spacing takes the flange in 7 passes, 8 stations.
    expect(r.mill).toMatchObject({ name: 'Roll Former 3.5" Shaft Diameter 12 Stand', stands: 12 });
    expect(r.stations).toMatchObject({ forming: 7, total: 8, standSpacingMm: 635 });
    // On a mill of 381 mm spacing the same flange needs ceil(90 / 4.68) = 20 passes, so a 12 stand 2" mill is not capable.
    const reasons = lineOf(r, 'Roll Forming Mill')?.machineChoice?.candidates;
    expect(reasons?.[0]?.name).toBe('Roll Former 3.5" Shaft Diameter 12 Stand');
    expect(r.warnings.join(' ')).toMatch(/conservative \(later studies find the deformation length shorter\)/);
  });

  it('each level takes its largest angle; round a closed section a bend carries the strip to the seam, the shorter way', () => {
    const plan = stationPlan(ref, TUBE, null);
    expect(plan.flangeSource).toBe('closed section');
    // The web-side corners carry a 37 mm side, a corner and half the top; the far corners half the top: 18.5 mm.
    expect(plan.levels.map((l) => [l.level, Math.round(l.flangeCarriedMm! * 10) / 10])).toEqual([[1, 59], [2, 18.5]]);
    expect(route(input(TUBE), 'blade').stations).toMatchObject({ forming: 12, total: 13 });
    const r = route(input({ ...CHANNEL, bends: [{ ...CHANNEL.bends[0], angleDeg: 100 }, { ...CHANNEL.bends[1], angleDeg: 40 }] }), 'scissor');
    expect(r.stations.forming).toBe(7);
  });

  it('a strip thicker than leadInRollStationThicknessThreshold (1.524 mm) takes a lead-in pass', () => {
    const thick = { ...CHANNEL, thicknessMm: 2 };
    expect(route(input(thick), 'scissor').stations).toMatchObject({ forming: 6, leadIn: 1, finishing: 1, total: 8 });
  });

  it('levels from the flats when the cad-engine gives none: k bends out from the widest flat; measured levels name the web', () => {
    // A hat: brim 20, wall 30, crown 60, wall 30, brim 20: the crown is the web, the walls' bends level 1, the brims' level 2.
    const hat = { bends: [20, 30, 60, 30].map((before) => ({ angleDeg: 90, innerRadiusMm: 1.5, flangeBeforeMm: before, level: null, sharp: false, direction: null, faceIds: [] })), lastFlangeMm: 20 };
    expect(bendLevels(hat)).toEqual({ levels: [2, 1, 1, 2], source: 'flats' });
    // A channel deeper than its web: the measured levels (both 1) put the web between the bends, so each carries its 100 mm flange.
    expect(webIndex([bend(90, 100, 1), bend(90, 47.7, 1)].map((b) => ({ angleDeg: 90, innerRadiusMm: 1.5, flangeBeforeMm: b.flange_before_mm, level: 1, sharp: false, direction: null, faceIds: [] })), [100, 47.7, 100])).toBe(1);
  });

  it('a bend modelled sharp is priced at the material\'s minimum bend radius (minBendRadii x t), said, and is not warned as too tight', () => {
    const sharp = partOf({ ...CHANNEL_G, bends: [{ ...bend(90, 33, 1, [1]), inner_radius_mm: 0, sharp: true }, bend(90, 47.7, 1, [2])] });
    expect(sharp.bends[0]).toMatchObject({ sharp: true, innerRadiusMm: 0 });
    const r = route(input(sharp), 'scissor');
    // AISI 1008, 245 MPa yield: the 345 MPa row's 1 x t.
    expect(r.sharpBends).toMatchObject({ count: 1, pricedRadiusMm: 1.5 });
    expect(r.warnings.join(' ')).toContain("1 bend(s) modelled sharp: priced at the material's minimum bend radius 1 x t = 1.5 mm");
    expect(r.warnings.join(' ')).not.toMatch(/tighter than/);
    // The drawing's corners stay put: the radius takes (r + t/2) tan(θ/2) off each flat and adds θ(r + K t); the measurement counted the sharp
    // corner as θ 0.33 t less t tan(θ/2). So the strip changes by θ(r + K t) − θ 0.33 t − 2 r tan(θ/2): here θ r − 2 r = −0.64 mm, narrower.
    const change = (Math.PI / 2) * (1.5 + 0.33 * 1.5) - (Math.PI / 2) * 0.33 * 1.5 - 2 * 1.5 * Math.tan(Math.PI / 4);
    expect(change).toBeCloseTo(-0.6438, 4);
    expect(r.sharpBends!.stripChangeMm).toBeCloseTo(change, 9);
    expect(r.sharpBends!.basis).toContain('mm narrower for it');
    expect(r.material.stripWidthMm).toBeCloseTo(120 + change, 9);
    expect(r.material.stripKg).toBeCloseTo(((120 + change) * 2000 * 1.5 * 7850) / 1e9, 9);
    // At r = 2t and above the allowance takes K 0.41: a 1000 MPa-yield strip takes the 6 x t row (r = 9 mm).
    expect(route(input(sharp, { material: { ...STEEL, yieldMpa: 1000 } }), 'scissor').sharpBends!.stripChangeMm)
      .toBeCloseTo((Math.PI / 2) * (9 + 0.41 * 1.5) - (Math.PI / 2) * 0.33 * 1.5 - 2 * 9 * Math.tan(Math.PI / 4), 9);
  });

  it('a profile of minNumBendsForPanelCrossSection (8) bends is a panel: a duplex mill and the panel tooling multiplier', () => {
    const angles = [45, 45, 90, 90, 90, 90, 45, 45];
    const panel = partOf(measured({
      lengthMm: 3000, section: { height_mm: 40, width_mm: 120, area_mm2: 112, perimeter_mm: 330, closed: false, stock_form: 'GENERIC_EXTRUSION' },
      stripWidthMm: 160, stripWidthNeutralMm: 159, thicknessMm: 0.7,
      bends: angles.map((a, i) => bend(a, 15, [4, 3, 2, 1, 1, 2, 3, 4][i])), lastFlangeMm: 15,
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

describe('ribs: bends close together whose turns cancel', () => {
  // A 600 mm panel, 0.7 mm, with one trapezoid rib in the middle (up 45°, top, down 45°, back 45°: walls 12 mm, top 20 mm) and a 20 mm
  // flange on each edge; the web is the left panel flat, so the left flange and the rib's first bend are level 1, the far flange level 5.
  const rib = (directions: boolean) => partOf(measured({
    lengthMm: 3000, section: { height_mm: 25, width_mm: 600, area_mm2: 460, perimeter_mm: 1320, closed: false, stock_form: 'GENERIC_EXTRUSION' },
    stripWidthMm: 660, stripWidthNeutralMm: 658, thicknessMm: 0.7, lastFlangeMm: 20,
    bends: [
      [90, 20, 1, 1], [45, 280, 1, 1], [45, 12, 2, -1], [45, 20, 3, -1], [45, 12, 4, 1], [90, 280, 5, 1],
    ].map(([angle, before, level, dir]) => ({ ...bend(angle, before, level), ...(directions ? { direction: dir } : {}) })),
  }));

  it('a group whose signed turns cancel is a rib: formed as one unit at its inner bend\'s level, carrying only its own span', () => {
    const plan = stationPlan(ref, rib(true), null);
    expect(plan.groupGapMm).toBe(31.75);
    expect(plan.groups).toEqual([{ first: 1, last: 4, rib: true, signedTurnDeg: 0, level: 1, spanMm: expect.closeTo(12 + 20 + 12 + 2 * (Math.PI / 4) * (1.5 + 0.35), 6) }]);
    // The rib's four bends join level 1 and carry its 47 mm span, not the 300 mm of panel and flange beyond it; levels 2 to 4 are empty.
    expect(plan.levels.map((l) => [l.level, l.bends, l.maxAngleDeg, Math.round(l.flangeCarriedMm!)])).toEqual([[1, 5, 90, 47], [5, 1, 90, 20]]);
    const r = route(input(rib(true)), 'scissor');
    expect(r.stations.groups[0]).toMatchObject({ rib: true, level: 1 });
    expect(r.warnings.join(' ')).toMatch(/1 rib\(s\) .* formed each as one unit at its inner bend's level/);
  });

  it('without bend directions the group is formed as flanges, warned', () => {
    const plan = stationPlan(ref, rib(false), null);
    expect(plan).toMatchObject({ directionsMeasured: false, groups: [{ first: 1, last: 4, rib: false, signedTurnDeg: null, level: null }] });
    expect(plan.levels.find((l) => l.level === 1)?.flangeCarriedMm).toBeGreaterThan(300);
    expect(route(input(rib(false)), 'scissor').warnings.join(' ')).toMatch(/^.*Bend directions were not measured: 1 group\(s\) of bends within 31.75 mm are formed as flanges/);
  });
});

describe('the mill (preferred first, then the cheapest that has what the profile needs)', () => {
  it('its rolls are weighed in the line\'s choice over the job\'s parts, said in the choice note', () => {
    const wide = partOf(measured({
      lengthMm: 2000, section: { height_mm: 101.5, width_mm: 153, area_mm2: 531, perimeter_mm: 700, closed: false, stock_form: 'GENERIC_EXTRUSION' },
      stripWidthMm: 354.8, stripWidthNeutralMm: 354, bends: [bend(90, 100, 1), bend(90, 147.7, 1)], lastFlangeMm: 100,
    }));
    // With no volume the rolls are not weighed: the mill of the cheapest line, the 3" 12 stand (508 mm spacing, 12 stations).
    const unweighed = route(input(wide, {}, { amortizationParts: null }), 'scissor');
    expect(unweighed.mill?.name).toBe('Roll Former 3" Shaft Diameter 12 Stand');
    expect(lineOf(unweighed, 'Roll Forming Mill')!.machineChoice!.rule).toMatch(/The rolls are not weighed: the job has no volume/);
    // Weighed over 100,000 parts the 3.5" 12 stand wins: its longer spacing needs 8 stations, the rolls a third cheaper than the line costs more.
    const weighed = route(input(wide, {}, { amortizationParts: 100000 }), 'scissor');
    const choice = lineOf(weighed, 'Roll Forming Mill')!.machineChoice!;
    expect(choice.rule).toMatch(/The mill is weighed with its rolls spread over the job's 100,000 parts/);
    expect(choice.candidates[0]).toMatchObject({ name: 'Roll Former 3.5" Shaft Diameter 12 Stand', status: 'chosen' });
    expect(choice.candidates[0]?.reasons[0]).toMatch(/^line [0-9.]+ \+ rolls [0-9.]+ USD a part \(8 stations\)$/);
    expect(weighed.stations.total).toBeLessThan(unweighed.stations.total);
    expect(weighed.tooling[0].costUsd!).toBeLessThan(route(input(wide, {}, { amortizationParts: null }), 'scissor').tooling[0].costUsd!);
  });

  it('the C channel: a standard mill with the 2" shaft millShaftDiameters gives 1.5 mm, the section height, the roll space and the stands', () => {
    const r = route(input(CHANNEL), 'scissor');
    expect(requiredShaft(ref, 1.5, STEEL.utsMpa)).toMatchObject({ mm: 50.8 });
    expect(r.mill).toMatchObject({ name: 'Roll Former 2" Shaft Diameter 12 Stand', stands: 12, shaftDiameterMm: 50.8, type: 'standard' });
    expect(lineOf(r, 'Roll Forming Mill')?.machineChoice).toMatchObject({ chosen: 'Roll Former 2" Shaft Diameter 12 Stand', checkedCount: 37 });
    expect(lineOf(r, 'Roll Forming Mill')?.machineChoice?.criteria).toEqual([
      'The shaft the strip needs', 'Takes the stock thickness', 'Forms the section height', 'Its roll space takes the strip', 'A standard mill', 'Enough roll stands for the passes on its stand spacing',
    ]);
  });

  it('an ultra-high-strength material (UTS at or above ultraHighStrengthMaterialThresholdLow) takes a shaft a size up', () => {
    const s900 = rollFormingMaterial('Steel, Hot Worked, S900MC');
    expect(requiredShaft(ref, 1.5, s900.utsMpa)).toMatchObject({ mm: 63.5 });
    expect(route(input(CHANNEL, { material: s900 }), 'scissor').mill?.shaftDiameterMm).toBeGreaterThanOrEqual(63.5);
  });
});

describe('the line, chosen whole at one speed: the slowest of its limits, named', () => {
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

  it('the cheapest whole line: no other uncoiler makes the line cheaper (its coil change stops every machine)', () => {
    const r = route(input(CHANNEL), 'scissor');
    const machinesTotal = (x: RollFormingRoute) => x.lines.reduce((s, l) => s + l.totalCost, 0);
    const chosen = lineOf(r, 'Uncoiler')!.machineName;
    const preferred = rollFormingMachines('USA')[ROLL_FORMING_CLASS.uncoiler].filter((m) => m.preferred && m.name !== chosen);
    for (const u of preferred) {
      const only = { ...rollFormingMachines('USA'), [ROLL_FORMING_CLASS.uncoiler]: [u] };
      expect(machinesTotal(route(input(CHANNEL, { machinesByClass: only }), 'scissor'))).toBeGreaterThanOrEqual(machinesTotal(r) - 1e-6);
    }
    expect(lineOf(r, 'Uncoiler')?.machineChoice?.rule).toMatch(/^The cheapest whole line/);
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

  it('the welder\'s working envelope must take the section: a 90 mm tube is past the 100 kW welder\'s 76.2 mm, so the 200 kW welds it', () => {
    const big = partOf(measured({
      lengthMm: 1500, section: { height_mm: 90, width_mm: 90, area_mm2: 420, perimeter_mm: 560, closed: true, stock_form: 'ROUND_TUBE' },
      stripWidthMm: 278, stripWidthNeutralMm: 277, bends: [{ ...bend(180, 0, 1), flange_before_mm: 0 }, { ...bend(180, 0, 1), flange_before_mm: 0 }], lastFlangeMm: 0,
      tube: { outer_diameter_mm: 90, outer_width_mm: 90, outer_height_mm: 90, wall_mm: 1.5 },
    }));
    expect(big.tube).toEqual({ outerDiameterMm: 90, outerWidthMm: 90, outerHeightMm: 90, wallMm: 1.5 });
    const r = route(input(big), 'blade');
    expect(r.welding?.machine).toBe('HFI Welder 200kW');
    expect(route(input(TUBE), 'blade').welding?.machine).toBe('HFI Welder 100kW');
    // The 100 kW is under the tube, the 400 kW would hold the line to 500 mm/s: the 200 kW is the one capable at the line's 660.4 mm/s.
    expect(lineOf(r, 'Integrated HFI Welding')?.machineChoice).toMatchObject({ checkedCount: 3, capableCount: 1 });
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
    expect(r.coil).toMatchObject({ partsPerCoil: parts, changeTimeS: change, setupMethod: 'Let eMithran Decide' });
    expect(r.coil!.perPartS).toBeCloseTo(change / parts, 9);
    expect(r.coil!.method).toMatch(/^end weld/);
    // A strip at or under coilEndWeldingThicknessThreshold is threaded instead.
    const thin = route(input({ ...CHANNEL, thicknessMm: 1 }), 'scissor');
    const thinUncoiler = rollFormingMachines('USA')[ROLL_FORMING_CLASS.uncoiler].find((m) => m.name === lineOf(thin, 'Uncoiler')!.machineName)!;
    expect(thin.coil!.changeTimeS).toBe(v('coilThreadingTime') + Number(thinUncoiler.specs.coil_load_time_s));
  });

  it('coilSetupMethod: Threading and Welding force the method; an Accumulator stops the line only for the coil load (a double mandrel: not at all)', () => {
    const withSetup = (method: string) => {
      const variables = realVariables().map((x) => (x.key === 'coilSetupMethod' ? { ...x, value: method } : x));
      const own = resolveSandReference({ variables, lookups: realLookups() });
      return route(input(CHANNEL, { ref: own }), 'scissor');
    };
    const threading = withSetup('Threading');
    const load = (r: RollFormingRoute) => Number(rollFormingMachines('USA')[ROLL_FORMING_CLASS.uncoiler].find((m) => m.name === lineOf(r, 'Uncoiler')!.machineName)!.specs.coil_load_time_s);
    expect(threading.coil).toMatchObject({ setupMethod: 'Threading', changeTimeS: v('coilThreadingTime') + load(threading) });
    const welding = withSetup('Welding');
    expect(welding.coil?.changeTimeS).toBe(v('coilEndWeldTime') + load(welding));
    const accumulator = withSetup('Accumulator');
    const mandrel = rollFormingMachines('USA')[ROLL_FORMING_CLASS.uncoiler].find((m) => m.name === lineOf(accumulator, 'Uncoiler')!.machineName)!;
    expect(accumulator.coil?.changeTimeS).toBe(mandrel.specs.has_double_mandrel === true ? 0 : load(accumulator));
    expect(accumulator.warnings.join(' ')).toMatch(/coilSetupMethod Accumulator/);
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

  it('the coil as supplied (Coil Material Stock) is the material only: no line, no machine time', () => {
    expect(lineOf(route(input(CHANNEL), 'scissor'), 'Coil Material Stock')).toBeUndefined();
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
    expect(quoted?.lines.map((l) => l.process)).toEqual(['Uncoiler', 'Roll Forming Mill', 'Integrated HFI Welding', 'Cut-Off Press']);
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

describe('the flanges: a short free flange is warned, a long one only costs passes', () => {
  it('a free edge flange under minBendFlapSizeThicknessMultiplier x t is warned; no maximum applies to a roll formed flange', () => {
    expect(route(input(CHANNEL), 'scissor').warnings.join(' ')).not.toMatch(/free flange/);
    const short = partOf({ ...CHANNEL_G, bends: [bend(90, 3, 1), bend(90, 47.7, 1)], lastFlangeMm: 120 });
    const w = route(input(short), 'scissor').warnings.join(' ');
    expect(w).toContain('The free flange(s) of 3 mm are shorter than minBendFlapSizeThicknessMultiplier 3 x t (4.5 mm)');
    expect(w).not.toMatch(/maxBendFlapSizeThicknessMultiplier|120 mm/);
  });

  it('a round tube (two 180° bends) carries half its strip to the seam on each bend', () => {
    const tube = partOf(measured({
      lengthMm: 1500, section: { height_mm: 50, width_mm: 50, area_mm2: 228, perimeter_mm: 310, closed: true, stock_form: 'ROUND_TUBE' },
      stripWidthMm: 152.4, stripWidthNeutralMm: 152, bends: [{ ...bend(180, 0, 1), flange_before_mm: 0 }, { ...bend(180, 0, 1), flange_before_mm: 0 }], lastFlangeMm: 0,
      tube: { outer_diameter_mm: 50, outer_width_mm: 50, outer_height_mm: 50, wall_mm: 1.5 },
    }));
    const plan = stationPlan(ref, tube, null);
    expect(plan).toMatchObject({ flangeSource: 'tube', levels: [{ level: 1, bends: 2, maxAngleDeg: 180, flangeCarriedMm: 76 }] });
    const r = route(input(tube), 'blade');
    const deg = ((3 * 1.5 * r.stations.standSpacingMm! ** 2) / (8 * 76 ** 3)) * (180 / Math.PI);
    expect(r.stations.levels[0]).toMatchObject({ passes: Math.ceil(180 / Math.min(15, deg) - 1e-6), governedBy: deg < 15 ? 'flange length' : 'lift angle' });
  });
});

describe('the tooling: the rolls and the press dies, spread over the job', () => {
  it('the rolls\' life by the material\'s type, brass and the other copper alloys as copper; only an unmatched type is warned', () => {
    expect(toolLifeRow(ref, 'Brass')).toMatchObject({ row: { 'Material Type': 'Copper' }, mappedFrom: 'Brass' });
    expect(toolLifeRow(ref, 'Galv. Steel')?.row['Material Type']).toBe('Galvanized Steel');
    expect(toolLifeRow(ref, 'Steel')).toMatchObject({ row: { 'Material Type': 'Steel' }, mappedFrom: null });
    const brass = route(input(CHANNEL, { material: rollFormingMaterial('Brass, UNS C36000') }), 'scissor');
    expect(brass.tooling[0]).toMatchObject({ toolLife: 17500000 });
    expect(brass.tooling[0]?.detail).toContain('toolLifeByMaterial Copper, the family of Brass');
    expect(brass.warnings.join(' ')).not.toMatch(/toolLifeByMaterial has no row/);
    expect(toolLifeRow(ref, 'Unobtainium')).toBeNull();
  });

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

/** A PostgREST client over rows in memory: the filters getMaterial uses (eq, neq, ilike, or on name/grade, not null, in, order, limit). */
function rowsClient(tables: Record<string, Record<string, unknown>[]>): never {
  const unquote = (v: string) => v.replace(/^"|"$/g, '').replace(/\\(.)/g, '$1').toLowerCase();
  return {
    from: (table: string) => {
      let rows = [...(tables[table] ?? [])];
      const b = {
        select: () => b,
        eq: (c: string, v: unknown) => { rows = rows.filter((r) => r[c] === v); return b; },
        neq: (c: string, v: unknown) => { rows = rows.filter((r) => r[c] !== v); return b; },
        ilike: (c: string, v: string) => { rows = rows.filter((r) => String(r[c]).toLowerCase() === unquote(v)); return b; },
        or: (expr: string) => {
          const want = unquote(/ilike\.("(?:[^"\\]|\\.)*")/.exec(expr)![1]);
          rows = rows.filter((r) => String(r.name).toLowerCase() === want || String(r.grade).toLowerCase() === want);
          return b;
        },
        not: (c: string) => { rows = rows.filter((r) => r[c] != null); return b; },
        in: (c: string, vs: unknown[]) => { rows = rows.filter((r) => vs.includes(r[c])); return b; },
        order: (c: string) => { rows.sort((x, y) => String(x[c]).localeCompare(String(y[c]))); return b; },
        limit: (n: number) => { rows = rows.slice(0, n); return b; },
        then: (resolve: (v: { data: unknown[]; error: null }) => unknown) => resolve({ data: rows, error: null }),
      };
      return b;
    },
  } as never;
}

describe('the material: the roll forming group\'s own, priced at the location', () => {
  const name = 'Steel, Cold Worked, AISI 1008';
  const tables = {
    raw_materials: [
      { id: 'rf-1008', name, grade: `Generic ${name}`, material_group: 'Sheet Metal Roll Forming', material_type: 'Steel', density_kg_m3: 7850, cost_usa: 1.751, cost_india: null },
      { id: 'fnf-1008', name, grade: `Generic ${name}`, material_group: 'Ferrous & Non-Ferrous', material_type: 'Steel', density_kg_m3: 7850, cost_usa: 1.6, cost_india: 0.87 },
    ],
    raw_material_properties: [
      { raw_material_id: 'rf-1008', property_key: 'ultimate_tensile_strength', value_num: 350 },
      { raw_material_id: 'rf-1008', property_key: 'tensile_yield_strength', value_num: 245 },
      { raw_material_id: 'rf-1008', property_key: 'shear_strength', value_num: 229 },
    ],
  };
  const service = new RollFormingCostService({} as never, {} as never, {} as never, {} as never);

  it('in the USA: its cost_usa, with its strengths', async () => {
    const r = await service.getMaterial(rowsClient(tables), name, 'USA');
    expect(r).toMatchObject({ material: { costPerKgUsd: 1.751, utsMpa: 350, yieldMpa: 245, shearStrengthMpa: 229, priceSource: 'Sheet Metal Roll Forming cost_usa' }, warning: null });
  });

  it('in India: cost_india of the same material in another group (held in USD), said; else the USA price, warned', async () => {
    const india = await service.getMaterial(rowsClient(tables), name, 'India');
    expect(india?.material).toMatchObject({ costPerKgUsd: 0.87, priceSource: `India: cost_india of ${name} in Ferrous & Non-Ferrous` });
    expect(india?.warning).toMatch(/^The material price in India is cost_india of Steel, Cold Worked, AISI 1008 in the Ferrous & Non-Ferrous group \(0.87 USD\/kg\)/);
  });

  it('in India with no material of its name priced: cost_india of the closest priced material of its type (nearest density, then USA price), named', async () => {
    const others = [
      { id: 'a', name: 'Steel, Hot Worked, AISI 1020', material_group: 'Ferrous & Non-Ferrous', material_type: 'Steel', density_kg_m3: 7870, cost_usa: 1.7, cost_india: 0.81 },
      { id: 'b', name: 'Steel, Cold Worked, AISI 1010', material_group: 'Ferrous & Non-Ferrous', material_type: 'Steel', density_kg_m3: 7850, cost_usa: 2.4, cost_india: 0.95 },
      { id: 'c', name: 'Steel, Cold Worked, AISI 1012', material_group: 'Ferrous & Non-Ferrous', material_type: 'Steel', density_kg_m3: 7850, cost_usa: 1.8, cost_india: 0.9 },
      { id: 'd', name: 'Aluminum, AA 1100', material_group: 'Ferrous & Non-Ferrous', material_type: 'Aluminum', density_kg_m3: 7850, cost_usa: 1.75, cost_india: 2.87 },
    ];
    const closest = await service.getMaterial(rowsClient({ ...tables, raw_materials: [tables.raw_materials[0], ...others] }), name, 'India');
    // Same type and density (7850): AISI 1012's 1.8 USA price is nearest 1.751.
    expect(closest?.material).toMatchObject({ costPerKgUsd: 0.9, priceSource: 'India: cost_india of Steel, Cold Worked, AISI 1012 (Ferrous & Non-Ferrous), the closest priced Steel material' });
    expect(closest?.warning).toMatch(/^No group prices Steel, Cold Worked, AISI 1008 in India: priced at cost_india of Steel, Cold Worked, AISI 1012/);
    const unpriced = await service.getMaterial(rowsClient({ ...tables, raw_materials: [tables.raw_materials[0], others[3]] }), name, 'India');
    expect(unpriced?.material.costPerKgUsd).toBe(1.751);
    expect(unpriced?.warning).toBe("The material price is the reference's USA price (cost_usa 1.751 USD/kg): no Steel material is priced in India.");
  });
});

describe('a part the line cannot make', () => {
  it('a sheet thicker than maxCoilThickness, a yield above maxCoilYieldStrength or a curve tighter than the curving unit: No Cost Feature lines', () => {
    const thick = route(input({ ...CHANNEL, thicknessMm: 6 }), 'scissor');
    expect(thick).toMatchObject({ feasible: false, complete: false, totalUsd: null });
    expect(thick.lines.map((l) => [l.process, l.operation])).toEqual([['No Cost Feature', 'Not roll formed: the 6 mm sheet is thicker than a coil is roll formed (maxCoilThickness 5.08 mm)']]);
    expect(route(input(CHANNEL, { material: rollFormingMaterial('Inconel 718') }), 'scissor').infeasible[0]).toMatch(/1017 MPa yield is above .* \(maxCoilYieldStrength 965.26 MPa\)/);
    // The profile wraps the 150 mm top roller: its inner face (the centroid radius less half the 36.5 mm section) may be no tighter than 75 mm.
    expect(route(input({ ...CHANNEL, curve: { radiusMm: 90, angleDeg: 90 } }), 'scissor').infeasible[0])
      .toBe("the profile is curved to a 71.75 mm radius at its inner face (90 mm at its centroid less half its 36.5 mm depth), tighter than it wraps the curving unit's top roller (curveUnitTopRollerDiameter 150 mm: 75 mm radius)");
    expect(route(input({ ...CHANNEL, curve: { radiusMm: 100, angleDeg: 90 } }), 'scissor').feasible).toBe(true);
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
