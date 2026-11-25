// A Sheet Metal Roll Forming route's id in the route comparison is "roll-forming-<key>" (backend roll-forming-route-comparison.ts
// rollFormingRouteId); the key (scissor, blade) is what the scenario's rollFormCutOff holds, so the quote follows the route picked in the
// Workflow Builder.
const PREFIX = 'roll-forming-';

/** The ROLL_FORMING_ROUTES key (scissor, blade) of a roll forming route id, or undefined for any other route. */
export function rollFormingRouteKeyOf(routeId: string): string | undefined {
  return routeId.startsWith(PREFIX) && routeId.length > PREFIX.length ? routeId.slice(PREFIX.length) : undefined;
}
