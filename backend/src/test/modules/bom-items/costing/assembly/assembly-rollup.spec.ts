import { withRolledUpMass, type RollupItem } from '../../../../../modules/bom-items/costing/assembly/assembly-rollup';

const part = (id: string, weight: number | null, size: [number, number, number], quantity = 1): RollupItem =>
  ({ id, itemType: 'child_part', quantity, weight, maxLength: size[0], maxWidth: size[1], maxHeight: size[2] });
const assembly = (id: string, extra: Partial<RollupItem> = {}): RollupItem => ({ id, itemType: 'sub_assembly', quantity: 1, ...extra });

/** `tree` maps an assembly id to the items directly below it. */
const below = (tree: Record<string, RollupItem[]>) => (id: string) => Promise.resolve(tree[id] ?? []);

describe('withRolledUpMass', () => {
  it("gives a sub-assembly its parts' weight, counted by quantity, and the largest of their sizes on each axis", async () => {
    const [sub] = await withRolledUpMass([assembly('s')], below({ s: [part('a', 4, [300, 100, 10]), part('b', 1.5, [120, 200, 40], 2)] }));
    expect(sub).toMatchObject({ weight: 7, maxLength: 300, maxWidth: 200, maxHeight: 40 });
  });

  it('goes down through sub-assemblies of sub-assemblies', async () => {
    const [top] = await withRolledUpMass([assembly('top')], below({
      top: [assembly('mid'), part('p', 2, [50, 50, 50])],
      mid: [part('q', 3, [400, 20, 20])],
    }));
    expect(top).toMatchObject({ weight: 5, maxLength: 400 });
  });

  it('keeps a weight or size the BOM already holds, and fills only what is missing', async () => {
    const [sub] = await withRolledUpMass([assembly('s', { weight: 9, maxLength: 500 })], below({ s: [part('a', 4, [300, 100, 10])] }));
    expect(sub).toMatchObject({ weight: 9, maxLength: 500 });
    const [weightless] = await withRolledUpMass([assembly('w', { maxLength: 500, maxWidth: 1, maxHeight: 1 })], below({ w: [part('a', 4, [300, 100, 10])] }));
    expect(weightless).toMatchObject({ weight: 4, maxLength: 500 });
  });

  it('gives no weight when any part has none: a partial sum would understate it', async () => {
    const [sub] = await withRolledUpMass([assembly('s')], below({ s: [part('a', 4, [10, 10, 10]), part('b', null, [10, 10, 10])] }));
    expect(sub!.weight).toBeUndefined();
  });

  it('leaves a part, and an assembly with nothing below it, as they are', async () => {
    const p = part('p', null, [1, 1, 1]);
    const empty = assembly('e');
    const out = await withRolledUpMass([p, empty], below({}));
    expect(out).toEqual([p, empty]);
  });
});
