import { describe, expect, it } from 'vitest';

import { explodeOffsets } from '@/lib/bom/assembly-explode';
import { buildTree, groupedParts, modelIdsUnder, selectionFor, type TreeItem } from '@/lib/bom/assembly-tree';

const treeOf = (rootId: string) => {
  const tree = buildTree(items, rootId);
  if (!tree) throw new Error(`no tree for ${rootId}`);
  return tree;
};

const item = (id: string, parentItemId?: string, file3dPath?: string): TreeItem => ({ id, parentItemId, file3dPath });
const items = [
  item('asm'), item('sub1', 'asm'), item('sub2', 'asm'), item('loose', 'asm', 'loose.stl'),
  item('a', 'sub1', 'a.stl'), item('b', 'sub1', 'b.stl'), item('c', 'sub2', 'c.stl'), item('other'),
];

describe('buildTree', () => {
  it('is the root with the items below it, and nothing of other trees', () => {
    const tree = treeOf('asm');
    expect(tree.children.map((c) => c.id)).toEqual(['sub1', 'sub2', 'loose']);
    expect(tree.children[0]?.children.map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('is null when the root is not among the items, and takes an item listed under itself once', () => {
    expect(buildTree(items, 'missing')).toBeNull();
    expect(buildTree([item('x', 'x')], 'x')?.children).toEqual([]);
  });
});

describe('groupedParts and modelIdsUnder', () => {
  const tree = treeOf('asm');

  it('groups every model by the root child it sits under: a sub-assembly, or the part itself', () => {
    expect(groupedParts(tree).map((g) => [g.part.id, g.groupId])).toEqual([['a', 'sub1'], ['b', 'sub1'], ['c', 'sub2'], ['loose', 'loose']]);
  });

  it('stands a selected sub-assembly for its models, and a part for itself', () => {
    const [sub1, , loose] = tree.children;
    expect(modelIdsUnder(sub1 ?? tree)).toEqual(['a', 'b']);
    expect(modelIdsUnder(loose ?? tree)).toEqual(['loose']);
    expect(modelIdsUnder(tree)).toEqual(['a', 'b', 'c', 'loose']);
  });
});

describe('explodeOffsets', () => {
  const parts = [
    { id: 'a', groupId: 'g1', center: [-10, 0, 0] as const },
    { id: 'b', groupId: 'g1', center: [-30, 0, 0] as const },
    { id: 'c', groupId: 'g2', center: [40, 0, 0] as const },
  ];

  it('moves nothing when assembled', () => {
    expect([...explodeOffsets(parts, 0).values()].every((o) => o.every((v) => v === 0))).toBe(true);
  });

  it('moves a group away from the assembly centre and its parts apart within it', () => {
    const o = explodeOffsets(parts, 1);
    // centre x = 0; g1 centre x = -20; a is 10 right of it, b 10 left
    expect(o.get('a')?.[0]).toBeCloseTo(-20 + 0.6 * 10);
    expect(o.get('b')?.[0]).toBeCloseTo(-20 - 0.6 * 10);
    expect(o.get('c')?.[0]).toBeCloseTo(40);
  });

  it('scales with the amount and is empty for no parts', () => {
    expect(explodeOffsets(parts, 0.5).get('c')?.[0]).toBeCloseTo(20);
    expect(explodeOffsets([], 1).size).toBe(0);
  });
});

describe('selectionFor', () => {
  const tree = treeOf('asm');

  it('stands a part for itself and a sub-assembly for every model below it, without repeats', () => {
    expect(selectionFor(tree, ['loose', 'sub2'])).toEqual(['loose', 'c']);
    expect(selectionFor(tree, ['sub1', 'a'])).toEqual(['a', 'b']);
  });

  it('ignores an id that is not in the tree, and gives nothing for no ids', () => {
    expect(selectionFor(tree, ['nope', 'c'])).toEqual(['c']);
    expect(selectionFor(tree, [])).toEqual([]);
  });
});
