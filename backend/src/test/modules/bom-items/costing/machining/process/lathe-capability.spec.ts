// Which lathe can make a turned part (checkLatheCapability): the machine's envelope and, for the part's cross and off-axis holes, milled
// keyways and slots, its live tool. The cost summary and the route comparison both ask this one function, so the lathe the Cost tab quotes
// is one the comparison calls capable. Before, the summary checked the envelope only: for a shaft with cross holes it quoted the cheapest
// lathe (a 2-axis bar-feed lathe, no live tool) while the comparison ruled that lathe out and recommended a 3-axis one.
import { readFileSync } from 'fs';
import { join } from 'path';

import { liveToolHoles, liveToolMilledFeatures, type LiveToolWork } from '../../../../../../modules/bom-items/costing/machining/capability/live-tooling';
import {
  checkLatheCapability,
  checkMachiningCapability,
  machiningRouteStanding,
  type MachineClassId,
} from '../../../../../../modules/bom-items/costing/machining/process/cost-machining-engine';
import { EMPTY_CAPABILITY, type MachineCapability } from '../../../../../../modules/bom-items/costing/shared/capability/machine-selection/seed-registry';
import { selectQuotedRoute, selectRecommendedRoute } from '../../../../../../modules/bom-items/costing/shared/core/engine-kernel';

const mc = (s: string) => s as MachineClassId;
const cap = (overrides: Partial<MachineCapability>): MachineCapability => ({ ...EMPTY_CAPABILITY, ...overrides });

// Lead Screw side shaft, 32 x 14 x 14 mm: two Ø2.529 cross holes and, once the CAD engine recognises it, a closed keyway.
const SHAFT = { maxLength: 32, maxWidth: 14, maxHeight: 14, weightKg: 0.007 };
const CROSS_HOLES = liveToolHoles([
  { type: 'SimpleHole', variant: 'cross', params: { diameter_mm: 2.529 } },
  { type: 'SimpleHole', variant: 'cross', params: { diameter_mm: 2.529 } },
]);
const KEYWAY = liveToolMilledFeatures([{ id: 'Keyway-default_c1', feature_type: 'Keyway', variant: 'default', occurrences: [{ material_removed_mm3: 107.91 }] }]);
const NOTHING: LiveToolWork = { holes: [], milled: [] };

// The four lathes the USA quotes the shaft on (HR Rates, local database): the machine chosen in each class, its live-tool spindle and the
// route's total.
const LATHES = [
  { cls: '2_axis_bar_feed_lathe_with_sub_spindle', name: 'Haas DS-30 with BAR3010SS Feeder', liveToolingPowerKw: 0, totalCost: 7.30 },
  { cls: '2_axis_lathe', name: 'Mazak 6G', liveToolingPowerKw: 0, totalCost: 7.40 },
  { cls: '3_axis_bar_feed_lathe_with_sub_spindle', name: 'Haas DS-30Y with BAR3010SS Feeder', liveToolingPowerKw: 14.9, totalCost: 7.52 },
  { cls: '3_axis_lathe', name: 'Miyano BNC-20', liveToolingPowerKw: 11.2, totalCost: 7.55 },
] as const;
const lathe = (l: (typeof LATHES)[number]) =>
  ({ name: l.name, capability: cap({ maxDiameterMm: 200, maxLengthMm: 500, liveToolingPowerKw: l.liveToolingPowerKw }), capabilitySource: 'imported' as const });

describe('checkLatheCapability: the envelope and the live tool, one verdict', () => {
  const noLiveTool = lathe(LATHES[0]);
  const liveTool = lathe(LATHES[2]);

  it('a part that needs no live tool: the verdict is the envelope\'s, on a lathe with or without one', () => {
    for (const machine of [noLiveTool, liveTool]) {
      const envelope = checkMachiningCapability(mc('2_axis_lathe'), 32, 14, 14, 0.007, machine.capability, machine.capabilitySource);
      expect(checkLatheCapability(mc('2_axis_lathe'), { ...SHAFT, liveTool: NOTHING }, machine)).toEqual({ ...envelope, liveToolWarnings: [] });
      expect(envelope.overallCapable).toBe(true);
    }
  });

  it('cross holes: a lathe with no live-tool spindle is not capable, and its warnings say why', () => {
    const verdict = checkLatheCapability(mc('2_axis_bar_feed_lathe_with_sub_spindle'), { ...SHAFT, liveTool: { holes: CROSS_HOLES, milled: [] } }, noLiveTool);
    expect(verdict.overallCapable).toBe(false);
    expect(verdict.liveToolWarnings).toEqual([
      'Haas DS-30 with BAR3010SS Feeder has no live-tool spindle (memory/Machining/machine): it cannot drill the part\'s 2 cross holes (2x Ø2.529); '
      + 'a lathe with live tooling (C/Y axis) or a mill is needed.',
    ]);
    expect(verdict.machineCapabilityWarnings).toEqual(verdict.liveToolWarnings);
  });

  it('a milled keyway alone rules the same lathe out, and a lathe with a live tool makes both', () => {
    const keywayOnly = { ...SHAFT, liveTool: { holes: [], milled: KEYWAY } };
    expect(checkLatheCapability(mc('2_axis_bar_feed_lathe_with_sub_spindle'), keywayOnly, noLiveTool)).toMatchObject({
      overallCapable: false, liveToolWarnings: [expect.stringContaining('it cannot mill the part\'s 1 keyway;')],
    });
    const both = { ...SHAFT, liveTool: { holes: CROSS_HOLES, milled: KEYWAY } };
    expect(checkLatheCapability(mc('3_axis_bar_feed_lathe_with_sub_spindle'), both, liveTool)).toEqual({ overallCapable: true, machineCapabilityWarnings: [], liveToolWarnings: [] });
  });

  it('flats alone rule a lathe with no live tool out (a 2-axis lathe), and a lathe with one makes them', () => {
    const flats = { ...SHAFT, liveTool: { holes: [], milled: liveToolMilledFeatures([{ id: 'Flat-default_c2', feature_type: 'Flat', variant: 'default', occurrences: [{}, {}] }]) } };
    expect(checkLatheCapability(mc('2_axis_lathe'), flats, lathe(LATHES[1]))).toMatchObject({
      overallCapable: false,
      liveToolWarnings: ['Mazak 6G has no live-tool spindle (memory/Machining/machine): it cannot mill the part\'s 2 flats; a lathe with live tooling (C/Y axis) or a mill is needed.'],
    });
    expect(checkLatheCapability(mc('3_axis_lathe'), flats, lathe(LATHES[3]))).toEqual({ overallCapable: true, machineCapabilityWarnings: [], liveToolWarnings: [] });
  });

  it('a lathe too small for the part is not capable whatever its live tool, and both reasons are listed', () => {
    const small = { ...liveTool, capability: cap({ maxDiameterMm: 10, maxLengthMm: 500, liveToolingPowerKw: 0 }) };
    const verdict = checkLatheCapability(mc('2_axis_lathe'), { ...SHAFT, liveTool: { holes: CROSS_HOLES, milled: [] } }, small);
    expect(verdict.overallCapable).toBe(false);
    expect(verdict.machineCapabilityWarnings).toHaveLength(2);
    expect(verdict.machineCapabilityWarnings[0]).toContain('swing capacity');
    expect(verdict.machineCapabilityWarnings[1]).toBe(verdict.liveToolWarnings[0]);
    // With a live tool it is still too small.
    expect(checkLatheCapability(mc('2_axis_lathe'), { ...SHAFT, liveTool: NOTHING }, small).overallCapable).toBe(false);
  });
});

describe('the Cost tab and the route comparison choose the same lathe', () => {
  // Each asks checkLatheCapability and states each route by the same facts (machiningRouteStanding); the comparison recommends by
  // selectRecommendedRoute, and the summary quotes by selectQuotedRoute, which is that recommendation (quoted-route.spec.ts).
  const choose = (liveTool: LiveToolWork) => {
    const routes = LATHES.map((l) => machiningRouteStanding(l.cls, {
      totalCost: l.totalCost, cycleTimes: { totalMin: 7 } as never,
      processLines: [{ process: 'Rough Turning', cycleTimeMin: 0.01, setupTimeMin: 30 } as never],
    }, checkLatheCapability(mc(l.cls), { ...SHAFT, liveTool }, lathe(l)).overallCapable));
    return { summary: selectQuotedRoute(routes)?.routeId, comparison: selectRecommendedRoute(routes)?.routeId };
  };

  it('the shaft\'s cross holes: both pass over the two cheaper lathes with no live tool, for the 3-axis bar-feed lathe at 7.52', () => {
    expect(choose({ holes: CROSS_HOLES, milled: [] })).toEqual({
      summary: '3_axis_bar_feed_lathe_with_sub_spindle', comparison: '3_axis_bar_feed_lathe_with_sub_spindle',
    });
  });

  it('the shaft\'s keyway and cross holes: the same lathe', () => {
    expect(choose({ holes: CROSS_HOLES, milled: KEYWAY })).toEqual({
      summary: '3_axis_bar_feed_lathe_with_sub_spindle', comparison: '3_axis_bar_feed_lathe_with_sub_spindle',
    });
  });

  it('a shaft with nothing for a live tool: both take the cheapest lathe, the 2-axis bar-feed lathe at 7.30', () => {
    expect(choose(NOTHING)).toEqual({ summary: '2_axis_bar_feed_lathe_with_sub_spindle', comparison: '2_axis_bar_feed_lathe_with_sub_spindle' });
  });

  // The costing service is where the two meet. Both of its lathe capability checks are this function, and it holds no verdict of its own.
  it('the cost summary and the turned route comparison both call checkLatheCapability, and neither the live-tool verdict directly', () => {
    const source = readFileSync(join(__dirname, '..', '..', '..', '..', '..', '..', 'modules', 'bom-items', 'bom-item-costing.service.ts'), 'utf8');
    const turnedRoutes = source.slice(source.indexOf('private async buildTurnedRoutes('));
    const costSummary = source.slice(source.indexOf('const costedRoutes = candidateClasses.map('), source.indexOf('const recommended = quotedMachiningRoute(costedRoutes)'));
    expect(costSummary).toContain('checkLatheCapability(');
    expect(turnedRoutes.slice(0, turnedRoutes.indexOf('\n  private ', 1))).toContain('checkLatheCapability(');
    expect(source).not.toContain('liveToolingVerdict');
  });
});
