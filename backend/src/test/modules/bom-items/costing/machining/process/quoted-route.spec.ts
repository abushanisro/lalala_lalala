// The Cost tab quotes a machined part on the route the route comparison recommends: one rule, through shared code.
//
// The comparison recommends the cheapest route that is capable, feasible, compatible with the part's features (the operation catalog)
// and fully costed, ties to the shorter cycle, then the route id (engine-kernel selectRecommendedRoute). The cost summary had a rule of
// its own, pickRecommendedRoute: the cheapest capable class, ties to fewer setups, with no test that the route was fully costed or that
// the catalog gave its machine the part's operations. It also priced a list of classes of its own, without the simultaneous turning
// centre the comparison prices. So the two could name different routes:
//
//   - a cheaper route with a data gap was quoted by the Cost tab and passed over by the comparison;
//   - on a tie the Cost tab took the first class it listed, the comparison the shorter cycle;
//   - a route the comparison recommended (simultaneous_turning) was one the Cost tab could not quote at all.
//
// Now each states every route it priced by the same facts (machiningRouteStanding), on the same machines (the service's
// primaryMachiningRates and milledRouteMachines), and the Cost tab quotes by selectQuotedRoute: the comparison's recommendation or, when
// it recommends none, the route Apply then writes (selectAppliableRoute).
import { readFileSync } from 'fs';
import { join } from 'path';

import { hasMachineRate, machiningRouteStanding } from '../../../../../../modules/bom-items/costing/machining/process/cost-machining-engine';
import { selectAppliableRoute, selectQuotedRoute, selectRecommendedRoute } from '../../../../../../modules/bom-items/costing/shared/core/engine-kernel';

import type { MHRRateInput } from '../../../../../../modules/bom-items/costing/shared/core/cost-engine';
import type { CostSummaryDto, ProcessLineCost } from '../../../../../../modules/bom-items/dto/cost-breakdown.dto';

/** A line with its time and setup resolved: nothing missing. */
const costed = (process: string): ProcessLineCost => ({ process, cycleTimeMin: 0.1, setupTimeMin: 30, totalCost: 1 } as ProcessLineCost);
/** A line no calculation could time: a data gap (engine-kernel lineDataGap). */
const gap = (process: string): ProcessLineCost => ({ process, cycleTimeMin: 0, setupTimeMin: 0, totalCost: 0 } as ProcessLineCost);
const quote = (totalCost: number, totalMin: number, lines: ProcessLineCost[] = [costed('Rough Turning')]) =>
  ({ totalCost, cycleTimes: { totalMin } as CostSummaryDto['cycleTimes'], processLines: lines });

// The real Lead Screw side shaft as Machining in the USA (local database, develop 7e2f985c): each lathe route's total and cycle. The two
// lathes with no live tool cannot drill its cross holes or mill its keyway.
const SHAFT_USA = [
  machiningRouteStanding('2_axis_bar_feed_lathe_with_sub_spindle', quote(7.25, 7.23), false),
  machiningRouteStanding('2_axis_lathe', quote(7.32, 7.36), false),
  machiningRouteStanding('3_axis_bar_feed_lathe_with_sub_spindle', quote(7.47, 7.23), true),
  machiningRouteStanding('3_axis_lathe', quote(7.47, 7.36), true),
  machiningRouteStanding('machining_millturn', quote(7.8, 7.21), true),
  machiningRouteStanding('simultaneous_turning', quote(8.02, 7.3), true),
];

describe('machiningRouteStanding: a route as the ranking reads it', () => {
  it('capable is the route\'s feasibility too; fully costed is no line a data gap, on the lines as quoted', () => {
    const complete = machiningRouteStanding('3_axis_mill', quote(10, 9, [costed('Band Saw'), costed('3 Axis Mill')]), true);
    expect(complete).toMatchObject({
      routeId: '3_axis_mill', totalCost: 10, cycleTimes: { totalMin: 9 }, capability: { overallCapable: true }, isFeasible: true, dataComplete: true, dataGaps: [],
    });
    const short = machiningRouteStanding('3_axis_mill', quote(10, 9, [gap('Band Saw'), costed('3 Axis Mill')]), true);
    expect(short.dataComplete).toBe(false);
    expect(short.dataGaps.map((g) => g.process)).toEqual(['Band Saw']);
    expect(machiningRouteStanding('2_axis_lathe', quote(7, 7), false)).toMatchObject({ capability: { overallCapable: false }, isFeasible: false });
  });

  it('carries the operation catalog\'s verdict only where the caller read one', () => {
    expect('compatibility' in machiningRouteStanding('2_axis_lathe', quote(7, 7), true)).toBe(false);
    expect(machiningRouteStanding('3_axis_mill', quote(7, 7), true, { status: 'incompatible' }).compatibility).toEqual({ status: 'incompatible' });
  });

  it('a class with no machine rate on file is priced at 0 per hour, and is not a machine the part can be quoted on', () => {
    const rate = (source: MHRRateInput['source']) => ({ rate: 0, source, machineClass: '3_axis_mill', machineName: null, commodityCode: null }) as MHRRateInput;
    expect(hasMachineRate(rate('no_db_rate'))).toBe(false);
    expect(hasMachineRate(rate('mhr_database'))).toBe(true);
  });
});

describe('the Cost tab quotes the route the comparison recommends', () => {
  it('the real shaft: both take the 3-axis bar-feed lathe, the cheaper 2-axis lathes having no live tool', () => {
    expect(selectRecommendedRoute(SHAFT_USA)?.routeId).toBe('3_axis_bar_feed_lathe_with_sub_spindle');
    expect(selectQuotedRoute(SHAFT_USA)?.routeId).toBe('3_axis_bar_feed_lathe_with_sub_spindle');
  });

  it('a tie at 7.47 goes to the shorter cycle (7.23 min against 7.36), whatever order the classes are listed in', () => {
    // The old Cost tab rule broke a tie on setups (one each here) and then took the first class listed.
    const reversed = [...SHAFT_USA].reverse();
    expect(selectQuotedRoute(reversed)?.routeId).toBe('3_axis_bar_feed_lathe_with_sub_spindle');
    expect(selectRecommendedRoute(reversed)?.routeId).toBe('3_axis_bar_feed_lathe_with_sub_spindle');
  });

  it('a cheaper route that is not fully costed is passed over for the cheapest one that is', () => {
    // Simultaneous turning at 6.90 with its parting not timed: the old Cost tab rule quoted it, the comparison recommends 7.47.
    const routes = [...SHAFT_USA.filter((r) => r.routeId !== 'simultaneous_turning'),
      machiningRouteStanding('simultaneous_turning', quote(6.9, 7.3, [costed('Rough Turning'), gap('Parting')]), true)];
    expect(selectQuotedRoute(routes)?.routeId).toBe('3_axis_bar_feed_lathe_with_sub_spindle');
  });

  it('simultaneous turning, when it is the cheapest complete route, is quoted as the comparison recommends it', () => {
    const routes = [...SHAFT_USA.filter((r) => r.routeId !== 'simultaneous_turning'), machiningRouteStanding('simultaneous_turning', quote(7.1, 7.3), true)];
    expect(selectRecommendedRoute(routes)?.routeId).toBe('simultaneous_turning');
    expect(selectQuotedRoute(routes)?.routeId).toBe('simultaneous_turning');
  });

  it('a machine the operation catalog rules out is never quoted while one it allows can make the part', () => {
    const routes = [
      machiningRouteStanding('3_axis_lathe', quote(9, 9), true, { status: 'incompatible' }),
      machiningRouteStanding('3_axis_mill', quote(12, 9), true, { status: 'compatible' }),
    ];
    expect(selectQuotedRoute(routes)?.routeId).toBe('3_axis_mill');
  });

  it('a route automatic routing may not take is not recommended, and so not quoted while another is', () => {
    const routes = [machiningRouteStanding('a', quote(5, 5), true), machiningRouteStanding('b', quote(6, 5), true)];
    expect(selectQuotedRoute(routes, (r) => r.routeId !== 'a')?.routeId).toBe('b');
  });
});

describe('with no route both capable and fully costed, the Cost tab quotes the route Apply writes', () => {
  it('the route with the fewest operations that cannot be costed, then the cheapest: never a route the part cannot be made on', () => {
    const routes = [
      machiningRouteStanding('cheap_but_incapable', quote(3, 5), false),
      machiningRouteStanding('two_gaps', quote(4, 5, [gap('Rough Turning'), gap('Parting')]), true),
      machiningRouteStanding('one_gap', quote(9, 5, [costed('Rough Turning'), gap('Parting')]), true),
    ];
    expect(selectRecommendedRoute(routes)).toBeNull();
    expect(selectQuotedRoute(routes)?.routeId).toBe('one_gap');
    expect(selectQuotedRoute(routes)).toBe(selectAppliableRoute(routes));
  });

  it('when no machine can make the part, the closest one is quoted (and the quote says so)', () => {
    const routes = [machiningRouteStanding('2_axis_lathe', quote(7.32, 7.36), false), machiningRouteStanding('2_axis_bar_feed_lathe_with_sub_spindle', quote(7.25, 7.23), false)];
    expect(selectQuotedRoute(routes)?.routeId).toBe('2_axis_bar_feed_lathe_with_sub_spindle');
  });

  it('no route at all: nothing', () => {
    expect(selectQuotedRoute([])).toBeNull();
  });
});

// The costing service is where the two meet: the Cost tab's candidates, the two comparisons' routes and the recommendation each go
// through the shared functions, and none keeps a rule or a class list of its own.
describe('the costing service', () => {
  const source = readFileSync(join(__dirname, '..', '..', '..', '..', '..', '..', 'modules', 'bom-items', 'bom-item-costing.service.ts'), 'utf8');
  const methodOf = (signature: string) => {
    const from = source.indexOf(signature);
    return source.slice(from, source.indexOf('\n  private ', from + 1));
  };
  const costSummary = source.slice(source.indexOf('const costedRoutes = candidateClasses.map('), source.indexOf('const cncResult = { ...recommended.cost'));

  it('the Cost tab states its candidates by machiningRouteStanding and quotes by the comparison\'s rule', () => {
    expect(costSummary).toContain('machiningRouteStanding(');
    expect(costSummary).toContain('quotedMachiningRoute(costedRoutes)');
    expect(source).toContain('selectQuotedRoute(routes, isRecommendable)');
    expect(source).toContain('selectRecommendedRoute(normalized.routes.filter(isRecommendable))');
    expect(source).not.toContain('pickRecommendedRoute');
  });

  it('both comparisons state their routes by machiningRouteStanding and badge the route they recommend', () => {
    for (const builder of ['private async buildMilledRoutes(', 'private async buildTurnedRoutes(']) {
      const body = methodOf(builder);
      expect(body).toContain('machiningRouteStanding(');
      expect(body).toContain('BomItemCostingService.badgeLowestCost(routes)');
      expect(body).toContain('this.primaryMachiningRates(mhrRates)');
    }
    expect(methodOf('private async buildMilledRoutes(')).toContain('this.milledRouteMachines(');
  });

  it('one map of machine classes, with the simultaneous turning centre, for the Cost tab and both comparisons', () => {
    expect(methodOf('private primaryMachiningRates(')).toContain("['simultaneous_turning', mhrRates.simultaneousTurning]");
    // Each machining class is mapped to its rate once: there is no second list to drift from it.
    for (const entry of ["['simultaneous_turning', mhrRates.simultaneousTurning]", "['3_axis_bar_feed_lathe_with_sub_spindle', mhrRates.latheBarFeed3ax]", "['3_axis_mill', mhrRates.mill3ax]"]) {
      expect(source.split(entry)).toHaveLength(2);
    }
    expect(source).toContain('this.milledRouteMachines(fg, location, accessToken, primaryRateByClass)');
  });
});
