/** A BOM item that has a stored picture (the BOM page draws and stores one when it shows the item). */
export interface DrawnItem {
  id: string;
  projectId: string;
  itemType: string;
  createdAt: string;
}

/** The main assembly says most about a project, then a sub-assembly, then a part. */
const RANK: Record<string, number> = { assembly: 0, sub_assembly: 1, child_part: 2 };

/**
 * One item's picture per project: its main assembly's, else a sub-assembly's, else a part's; of equal rank the earliest created, so the
 * picture does not change when another item is drawn. Returns project id to item id. Pure.
 */
export function pickThumbnailItems(items: readonly DrawnItem[]): Map<string, string> {
  const rankOf = (item: DrawnItem) => RANK[item.itemType] ?? 3;
  const best = new Map<string, DrawnItem>();
  for (const item of items) {
    const current = best.get(item.projectId);
    const better = !current
      || rankOf(item) < rankOf(current)
      || (rankOf(item) === rankOf(current) && (item.createdAt < current.createdAt || (item.createdAt === current.createdAt && item.id < current.id)));
    if (better) best.set(item.projectId, item);
  }
  return new Map([...best].map(([projectId, item]) => [projectId, item.id]));
}
