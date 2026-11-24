// A PCB route's id in the route comparison is "pcb-<key>" (backend pcb-route-comparison.ts pcbRouteId); the key is what the scenario's pcbRoute
// holds, so the quote follows the route picked in the Workflow Builder.
const PREFIX = 'pcb-';

/** The PCB_ROUTES key (router_flying_probe, ...) of a PCB route id, or undefined for any other route. */
export function pcbRouteKeyOf(routeId: string): string | undefined {
  return routeId.startsWith(PREFIX) && routeId.length > PREFIX.length ? routeId.slice(PREFIX.length) : undefined;
}
