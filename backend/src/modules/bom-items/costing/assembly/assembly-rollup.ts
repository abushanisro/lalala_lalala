/**
 * A sub-assembly is one component of the assembly above it, and the engine loads it by its weight and size. Those are rarely stored on
 * an assembly: they are its parts', so they are read from what is below it. Weight is the quantity-weighted sum of its parts (known only
 * when every part has one). Size is the largest of its parts' on each axis: an assembly is at least as big as its biggest part, and the
 * parts' positions, which would give the exact envelope, are not in the BOM. A weight or size the BOM already holds is kept.
 */
export interface RollupItem {
  id: string;
  itemType?: string | undefined;
  quantity?: number | null | undefined;
  weight?: number | null | undefined;
  maxLength?: number | null | undefined;
  maxWidth?: number | null | undefined;
  maxHeight?: number | null | undefined;
}

const positive = (v: number | null | undefined): number | undefined => (v != null && Number.isFinite(v) && v > 0 ? v : undefined);
const hasSize = (i: RollupItem): boolean => [i.maxLength, i.maxWidth, i.maxHeight].some((d) => positive(d) !== undefined);

/** Each assembly among `items` without a weight or a size, completed from the parts `below` it (a part is left as it is). */
export async function withRolledUpMass<T extends RollupItem>(items: readonly T[], below: (id: string) => Promise<RollupItem[]>): Promise<T[]> {
  return Promise.all(items.map(async (item) => {
    const isAssembly = item.itemType === 'assembly' || item.itemType === 'sub_assembly';
    if (!isAssembly || (positive(item.weight) !== undefined && hasSize(item))) return item;
    const parts = await withRolledUpMass(await below(item.id), below);
    if (parts.length === 0) return item;
    const weights = parts.map((p) => positive(p.weight));
    const known = weights.filter((w): w is number => w !== undefined);
    const rolledWeight = known.length === parts.length ? parts.reduce((sum, p) => sum + (positive(p.weight) ?? 0) * (positive(p.quantity) ?? 1), 0) : undefined;
    const largest = (axis: 'maxLength' | 'maxWidth' | 'maxHeight') => Math.max(0, ...parts.map((p) => positive(p[axis]) ?? 0)) || undefined;
    const own = hasSize(item);
    return {
      ...item,
      weight: positive(item.weight) ?? rolledWeight,
      ...(own ? {} : { maxLength: largest('maxLength'), maxWidth: largest('maxWidth'), maxHeight: largest('maxHeight') }),
    };
  }));
}
