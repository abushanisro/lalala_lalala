// A roll formed part's entries in the route comparison: the Scissor Cut-Off and the Blade Cut-Off line, each its cost summary priced on that
// route (the same lines, the same totals, the same code path as the quote, so the comparison cannot disagree with it). Apply saves a route's
// lines as the item's process records. Pure.
import { ROLL_FORMING_NOT_COSTED } from './roll-forming-cost-summary';
import { ROLL_FORMING_ROUTE_LABEL, ROLL_FORMING_ROUTES, type RollFormingRouteKey } from './roll-forming-route';
import { findRouteDataGaps, unpricedReason } from '../shared/core/engine-kernel';

import type { CostSummaryResponseDto } from '../../dto/cost-breakdown.dto';
import type { RouteResultDto } from '../../dto/route-comparison.dto';

/** The route id of a roll forming route ("roll-forming-scissor", "roll-forming-blade"). */
export const rollFormingRouteId = (key: string) => `roll-forming-${key}`;
export const ROLL_FORMING_ROUTE_IDS: readonly string[] = ROLL_FORMING_ROUTES.map((r) => rollFormingRouteId(r.key));

/** The route of `key` from the summary priced on it; a summary whose route could not be built, or is not feasible, says why. */
export function rollFormingRouteFor(key: RollFormingRouteKey, summary: CostSummaryResponseDto): RouteResultDto {
  const rf = summary.rollForming;
  const label = ROLL_FORMING_ROUTE_LABEL[key];
  const isThis = rf?.route === key;
  // Priced on a summary that priced nothing (no material grade): not feasible, and the missing input is the reason.
  const unpriced = unpricedReason(summary);
  const feasible = !unpriced && isThis && rf.complete;
  const gaps = isThis ? findRouteDataGaps(summary.processLines) : [];
  const option = rf?.options.find((o) => o.route === key);
  const why = !rf ? gaps.at(0)?.reason ?? summary.warnings.find((w) => w.startsWith(ROLL_FORMING_NOT_COSTED)) ?? 'the part could not be costed'
    : !isThis ? option?.reason ?? 'not a route for this part'
    : !rf.feasible ? `not feasible: ${option?.reason ?? 'the part cannot be roll formed'}`
    : 'the route is incomplete: a step has no capable machine or data';
  const detail = isThis ? ` · ${rf.stations.total} stations${rf.lineSpeed ? ` · ${Math.round(rf.lineSpeed.mmPerS)} mm/s` : ''}` : '';
  return {
    routeId: rollFormingRouteId(key),
    routeLabel: `${label}${detail}`,
    processFamily: 'forming',
    toolingVolumeNote: null,
    autoRoutable: true,
    processLines: isThis ? summary.processLines : [],
    materialCost: isThis ? summary.materialCost : 0,
    abrasiveCost: 0,
    totalProcessCost: isThis ? summary.totalProcessCost : 0,
    totalCost: feasible ? summary.totalCost : null,
    isFeasible: feasible,
    dataComplete: isThis && gaps.length === 0,
    dataGaps: gaps,
    cycleTimes: { cuttingMin: 0, pressBrakeMin: 0, tappingMin: 0, deburrMin: 0, totalMin: isThis ? summary.cycleTimes.totalMin : 0 },
    badges: { lowestCost: false, fastest: false, bestQuality: false },
    capability: {
      cuttingCapable: feasible, pressBrakeCapable: feasible, overallCapable: feasible, confidence: 'high',
      estimatedTonnage: null, reasonCodes: unpriced ? ['INPUT_MISSING'] : [], warnings: feasible ? [] : [unpriced ?? why],
    },
    warnings: isThis ? summary.warnings : [],
    ratesSource: summary.ratesSource,
  };
}
