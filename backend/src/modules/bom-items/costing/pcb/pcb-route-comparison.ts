// A printed circuit board's entries in the route comparison: each fabrication route (routed or stamped x flying probe or bed of nails), its
// cost summary priced on that route (the same lines, the same totals, the same code path as the quote). Apply saves a route's lines as the
// item's process records. Pure.
import type { CostSummaryResponseDto } from '../../dto/cost-breakdown.dto';
import type { RouteResultDto } from '../../dto/route-comparison.dto';
import { findRouteDataGaps, unpricedReason } from '../shared/core/engine-kernel';
import { PCB_NOT_COSTED } from './pcb-cost-summary';
import { PCB_ROUTES, type PcbRouteKey } from './pcb-route';

/** The route id of a PCB route ("pcb-router_flying_probe", ...). */
export const pcbRouteId = (key: string) => `pcb-${key}`;
export const PCB_ROUTE_IDS: readonly string[] = PCB_ROUTES.map((r) => pcbRouteId(r.key));

/** The route of `key` from the summary priced on it; a summary that quotes another route (this one is not a route for the board) says why. */
export function pcbRouteFor(key: PcbRouteKey, summary: CostSummaryResponseDto): RouteResultDto {
  const pcb = summary.pcb;
  const label = PCB_ROUTES.find((r) => r.key === key)!.label;
  const isThis = pcb?.route === key;
  const unpriced = unpricedReason(summary);
  const feasible = !unpriced && isThis && pcb!.complete && summary.totalCost != null;
  const gaps = isThis ? findRouteDataGaps(summary.processLines) : [];
  const option = pcb?.options.find((o) => o.route === key);
  const why = !pcb?.route ? gaps[0]?.reason ?? summary.warnings.find((w) => w.startsWith(PCB_NOT_COSTED)) ?? 'the board could not be costed'
    : !isThis ? option?.reason ?? 'not a route for this board'
    : 'the route is incomplete: a step has no capable machine or data';
  return {
    routeId: pcbRouteId(key),
    routeLabel: isThis && pcb?.nest ? `${label} · ${pcb.nest.boardsPerPanel} per panel` : label,
    processFamily: 'cutting',
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
