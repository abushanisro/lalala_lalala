import { describe, expect, it } from 'vitest';

import {
  PCB_ASSEMBLY_OPTIONS, PCB_ASSEMBLY_TEST_OPTIONS, PCB_ROUTE_OPTIONS, PCB_SCENARIO_KEYS, PCB_THT_SOLDER_OPTIONS, basisLabel, choiceOf, isPcbItem, numberOf, pcbRouteOf,
  processesIncluded, type PcbAssemblyView,
} from '@/lib/costing/pcb-view';
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

// The assembly a board's quote includes: Auto unless the Cost Guide sets it, and the processes included said one group a line.
describe('a PCB assembly in the Cost Guide', () => {
  it('reads a known choice only, else Auto', () => {
    expect(choiceOf({ [PCB_SCENARIO_KEYS.assembly]: 'bare' }, PCB_SCENARIO_KEYS.assembly, PCB_ASSEMBLY_OPTIONS)).toBe('bare');
    expect(choiceOf({ [PCB_SCENARIO_KEYS.assembly]: 'sometimes' }, PCB_SCENARIO_KEYS.assembly, PCB_ASSEMBLY_OPTIONS)).toBe('');
    expect(choiceOf({ pcbThtSolder: 'wave' }, PCB_SCENARIO_KEYS.thtSolder, PCB_THT_SOLDER_OPTIONS)).toBe('wave');
    expect(choiceOf(null, PCB_SCENARIO_KEYS.assemblyTest, PCB_ASSEMBLY_TEST_OPTIONS)).toBe('');
  });

  it('lists the processes included, marking the ones the user set', () => {
    const a = {
      included: true, mode: 'auto', basis: 'Assembly included automatically', counts: {} as never, thtSolder: null, test: null,
      processes: [
        { group: 'Bare board fab', steps: ['22 steps'], basis: 'auto' },
        { group: 'SMT top', steps: ['Stencil Print', 'Pick and Place'], basis: 'auto' },
        { group: 'THT', steps: ['THT Insertion', 'Hand Solder'], basis: 'user' },
      ],
    } as PcbAssemblyView;
    expect(processesIncluded(a)).toEqual(['Bare board fab: 22 steps', 'SMT top: Stencil Print, Pick and Place', 'THT: THT Insertion, Hand Solder (set)']);
    expect(processesIncluded(null)).toEqual([]);
  });
});
