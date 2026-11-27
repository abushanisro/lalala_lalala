import { describe, expect, it } from 'vitest';

import { componentIdsUnder, type ProcessTreeNode } from '@/lib/features/process-tree';

const node = (id: string, extra: Partial<ProcessTreeNode> = {}): ProcessTreeNode => ({ id, kind: 'feature', label: id, ...extra });

describe('componentIdsUnder', () => {
  it("is a component row's own ids", () => {
    expect(componentIdsUnder(node('row', { componentIds: ['floor'] }))).toEqual(['floor']);
  });

  it('is every component below an operation row, in order, for a row that stands for them all', () => {
    const operation = node('pick', { kind: 'operation', children: [
      node('r1', { componentIds: ['floor'] }), node('r2', { componentIds: ['roof'] }), node('unload'),
    ] });
    expect(componentIdsUnder(operation)).toEqual(['floor', 'roof']);
  });

  it('is nothing for a row with no components, or no row', () => {
    expect(componentIdsUnder(node('unload'))).toEqual([]);
    expect(componentIdsUnder(null)).toEqual([]);
  });
});
