import { describe, expect, it } from 'vitest';

import { PCB_ROUTE_OPTIONS, basisLabel, isPcbItem, numberOf, pcbRouteOf } from '@/lib/costing/pcb-view';
import { pcbRouteKeyOf } from '@/lib/routing/pcb-route-id';
import { routePickKeyOf, routePicksOf } from '@/lib/routing/route-pick';

// A printed circuit board's Cost Guide: its four routes, the route picked in the Workflow Builder carried as pcbRoute, and each board value's
// origin said so a default is never read as measured.
describe('a PCB in the Cost Guide', () => {
  it('stores a picked route under pcbRoute, read from the route id', () => {
    expect(pcbRouteKeyOf('pcb-stamp_bed_of_nails')).toBe('stamp_bed_of_nails');
    expect(pcbRouteKeyOf('roto-blow-blow')).toBeUndefined();
    const item = { itemType: 'child_part', scenarioOverrides: { processGroup: 'PCB' } } as never;
    expect(isPcbItem(item)).toBe(true);
    expect(routePickKeyOf(item, 'sheet_metal')).toBe('pcbRoute');
    expect(routePicksOf({ routeId: 'pcb-router_flying_probe', routeLabel: 'Routed, flying probe test' }, 'pcb')).toEqual({ pcbRoute: 'router_flying_probe' });
  });

  it('reads only a known route and a number set in the Cost Guide', () => {
    expect(PCB_ROUTE_OPTIONS).toHaveLength(4);
    expect(pcbRouteOf({ pcbRoute: 'stamp_flying_probe' })).toBe('stamp_flying_probe');
    expect(pcbRouteOf({ pcbRoute: 'laser' })).toBeNull();
    expect(numberOf({ pcbLayers: '4' }, 'pcbLayers')).toBe(4);
    expect(numberOf({ pcbLayers: '' }, 'pcbLayers')).toBeNull();
  });

  it('says where each board value came from', () => {
    expect(basisLabel('board_files')).toBe('measured from the board files');
    expect(basisLabel('reference_default')).toBe('reference default');
  });
});
