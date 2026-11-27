import { describe, expect, it } from 'vitest';

import { modelPartsOf, type ModelNode } from '@/lib/bom/model-parts';

interface Node extends ModelNode { id: string; children: Node[] }
const node = (id: string, file3dPath?: string, children: Node[] = []): Node => ({ id, file3dPath, children });

describe('modelPartsOf', () => {
  it('is every model below an assembly, through its sub-assemblies, in order', () => {
    const tree = node('asm', undefined, [
      node('sub1', undefined, [node('a', 'a.stl'), node('b', 'b.stl')]),
      node('sub2', undefined, [node('c', 'c.stl')]),
      node('d', 'd.stl'),
    ]);
    expect(modelPartsOf<Node>(tree).map((n) => n.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('is nothing for an item that has a model of its own: it draws itself', () => {
    expect(modelPartsOf<Node>(node('p', 'p.stl', [node('x', 'x.stl')]))).toEqual([]);
  });

  it('is nothing for a part with no model or an assembly with no models below it', () => {
    expect(modelPartsOf<Node>(node('p'))).toEqual([]);
    expect(modelPartsOf<Node>(node('asm', undefined, [node('sub', undefined, [node('x')])]))).toEqual([]);
  });

  it('does not go below a part that has a model: that model is the part', () => {
    expect(modelPartsOf<Node>(node('asm', undefined, [node('p', 'p.stl', [node('inner', 'inner.stl')])])).map((n) => n.id)).toEqual(['p']);
  });
});
