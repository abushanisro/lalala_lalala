import { describe, expect, it } from 'vitest';

import { componentIdsUnder, findComponentNode, type ProcessTreeNode } from '@/lib/features/process-tree';

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

describe('findComponentNode', () => {
  const tree = node('root', { kind: 'part', children: [
    node('pick', { kind: 'operation', children: [
      node('floor-row', { componentIds: ['floor'] }),
      node('sub-row', { componentIds: ['sub'] }),
    ] }),
    node('screws', { kind: 'operation', children: [node('screw-row', { componentIds: ['floor'] })] }),
  ] });

  it("is the first row that stands for the part", () => {
    expect(findComponentNode(tree, ['floor'])?.id).toBe('floor-row');
  });

  it('falls to the sub-assembly above the part when the part has no row of its own, nearest first', () => {
    expect(findComponentNode(tree, ['inner', 'sub', 'outer'])?.id).toBe('sub-row');
    expect(findComponentNode(tree, ['sub', 'floor'])?.id).toBe('sub-row');
  });

  it('is null when no row stands for any of them', () => {
    expect(findComponentNode(tree, ['nope'])).toBeNull();
    expect(findComponentNode(tree, [])).toBeNull();
  });
});
