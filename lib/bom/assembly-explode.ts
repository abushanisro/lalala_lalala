export type Vec3 = readonly [number, number, number];

export interface ExplodePart {
  id: string;
  groupId: string;
  /** The centre of the part's model, in the assembly's coordinates. */
  center: Vec3;
}

/** How far a group moves from the assembly's centre, and a part from its group's, per unit of explode. */
const GROUP_GAIN = 1;
const PART_GAIN = 0.6;

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const mean = (points: readonly Vec3[]): Vec3 => scale(points.reduce<Vec3>(add, [0, 0, 0]), 1 / points.length);

/**
 * Where each part moves to when the assembly is exploded by `amount` (0 = assembled, 1 = each group has moved as far from the centre
 * as it was). Two levels: a group (a sub-assembly) moves away from the assembly's centre, and its parts spread from the group's own,
 * so a sub-assembly stays recognisable as one. Pure: the offset to add to each part's position.
 */
export function explodeOffsets(parts: readonly ExplodePart[], amount: number): Map<string, Vec3> {
  const offsets = new Map<string, Vec3>();
  if (parts.length === 0) return offsets;
  const centre = mean(parts.map((p) => p.center));
  const groups = new Map<string, Vec3[]>();
  for (const p of parts) groups.set(p.groupId, [...(groups.get(p.groupId) ?? []), p.center]);
  const groupCentres = new Map([...groups].map(([id, centres]) => [id, mean(centres)] as const));
  for (const p of parts) {
    const group = groupCentres.get(p.groupId) ?? p.center;
    const out = add(scale(sub(group, centre), GROUP_GAIN), scale(sub(p.center, group), PART_GAIN));
    offsets.set(p.id, scale(out, amount));
  }
  return offsets;
}
