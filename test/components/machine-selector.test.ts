import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { MachineSelector } from '@/components/features/manufacturing-intelligence/MachineSelector';
import type { MachineCandidate, MachineSelectionResult } from '@/lib/api/hooks/useBOMItems';

// The machine panel of a cost line on a small milled part: memory/Machining's 3 Axis Mills, chosen technically first (all can do the part),
// then the virtual machines the part fits (preferVirtualMachines), then the lowest machine hour rate.
const mill = (machineName: string, hourlyRate: number): MachineCandidate => ({
  machineId: machineName, machineName, commodityCode: null, processGroup: 'Machining', machineClass: '3_axis_mill', hourlyRate,
  utilizationPct: 85, scheduledLoadPct: null, availabilityStatus: 'available', nextAvailableAt: null, maintenanceWindowStart: null,
  maintenanceWindowEnd: null, capability: {} as MachineCandidate['capability'], capabilitySource: 'imported', capabilityVersion: null,
});
const small = mill('Virtual 3 Axis Mill - Small', 27.8);
const medium = mill('Virtual 3 Axis Mill - Medium', 30);
const makino = mill('Makino V22', 25.24);
const entry = (c: MachineCandidate, flags: boolean, inPool: boolean) => ({
  machineId: c.machineId, machineName: c.machineName, hourlyRate: c.hourlyRate, preferred: flags, virtual: flags, inPool, fit: 0.3,
});
const SELECTION: MachineSelectionResult = {
  balanced: { candidate: small, score: 0.3, reasons: ['Part 80×60×30 mm in 584×406×432 mm envelope'] },
  cheapest: { candidate: makino, score: 0.3, reasons: [] },
  alternatives: [medium, makino],
  confidence: 30,
  requirement: { kind: 'vmc' },
  allowOverride: true,
  overridden: false,
  ranking: [entry(small, true, true), entry(medium, true, true), entry(makino, false, false)],
  rejected: [{ machineId: 'tiny', machineName: 'Too small', reasons: ['Part 80 mm > 50 mm travel'] }],
  steps: [
    { rule: 'capable', count: 3, text: '3 machines of 4 can do the part' },
    { rule: 'virtual', count: 2, text: '2 virtual machines the part fits come first (preferVirtualMachines)' },
    { rule: 'cheapest', count: 1, text: 'the lowest machine hour rate of those 2' },
  ],
  decision: { winnerId: small.machineId, runnerUpId: medium.machineId, decidingFactor: 'cost' },
};
const html = (selection: MachineSelectionResult) => renderToStaticMarkup(
  createElement(QueryClientProvider, { client: new QueryClient() },
    createElement(MachineSelector, { itemId: 'item', processKey: '3_axis_mill', selection, currencySymbol: '$', location: 'USA' })),
);

describe('the machine panel of a cost line', () => {
  it('says how the machine was chosen: the capable machines, the reference data\'s order, then the lowest rate against the next one', () => {
    const out = html(SELECTION);
    expect(out).toContain('Virtual 3 Axis Mill - Small');
    expect(out).toContain('3 machines of 4 can do the part; 2 virtual machines the part fits come first (preferVirtualMachines); the lowest machine hour rate of those 2');
    expect(out).toContain('($27.80/hr against $30.00/hr on Virtual 3 Axis Mill - Medium)');
    expect(out).toContain('Show machines (3 capable, 1 rejected)');
  });

  it('offers the next machines, and names the cheapest capable machine the order set aside', () => {
    const out = html(SELECTION);
    expect(out).toContain('Virtual 3 Axis Mill - Medium');
    expect(out).toContain('Makino V22');
    expect(out).toContain('lowest rate of all capable');
    expect(out).not.toContain('fastest');
    expect(out).not.toContain('Balanced weights');
  });

  it('a selection with no steps (a line costed before the rule changed) shows its machine and reasons, and no choice text', () => {
    const { steps: _steps, ...old } = SELECTION;
    const out = html(old);
    expect(out).toContain('Virtual 3 Axis Mill - Small');
    expect(out).toContain('Part 80×60×30 mm in 584×406×432 mm envelope');
    expect(out).not.toContain('Chosen:');
  });

  it('an engineer\'s machine is shown as set by hand, with no choice text', () => {
    const out = html({ ...SELECTION, overridden: true, decision: { winnerId: small.machineId, runnerUpId: null, decidingFactor: 'override' } });
    expect(out).not.toContain('Chosen:');
    expect(out).toContain('Reset to recommended');
  });
});
