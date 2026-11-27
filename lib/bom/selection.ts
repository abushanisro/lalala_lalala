// What a selection of BOM rows means for the select-all box and for a delete. Pure: the table renders these.

export type SelectionState = "none" | "some" | "all";

/** The select-all box over the rows shown: none, some or all of them selected. */
export function selectionState(shownIds: readonly string[], selected: ReadonlySet<string>): SelectionState {
  const count = shownIds.filter(id => selected.has(id)).length;
  return count === 0 ? "none" : count === shownIds.length ? "all" : "some";
}

/** One row's box. */
export function toggleOne(id: string, selected: ReadonlySet<string>): Set<string> {
  const next = new Set(selected);
  if (!next.delete(id)) next.add(id);
  return next;
}

/** The select-all box: every row shown becomes selected, unless they all are already (then none of them is). Rows not shown keep their state. */
export function toggleAll(shownIds: readonly string[], selected: ReadonlySet<string>): Set<string> {
  const next = new Set(selected);
  const all = selectionState(shownIds, selected) === "all";
  for (const id of shownIds) {
    if (all) next.delete(id);
    else next.add(id);
  }
  return next;
}

/**
 * The selected items in the order to delete them: the deepest first, so an assembly selected together with everything under it is
 * deleted after its children, and never before them.
 */
export function deletionOrder<T extends { id: string; parentItemId?: string | null }>(items: readonly T[], selected: ReadonlySet<string>): T[] {
  const byId = new Map(items.map(item => [item.id, item]));
  const depthOf = (item: T): number => {
    let depth = 0;
    const seen = new Set([item.id]);
    for (let parent = byId.get(item.parentItemId?.trim() ?? ""); parent && !seen.has(parent.id); parent = byId.get(parent.parentItemId?.trim() ?? "")) {
      seen.add(parent.id);
      depth++;
    }
    return depth;
  };
  return items
    .filter(item => selected.has(item.id))
    .map((item, index) => ({ item, index, depth: depthOf(item) }))
    .sort((a, b) => b.depth - a.depth || a.index - b.index)
    .map(entry => entry.item);
}

/** "Bracket", "Bracket and Shaft", "Bracket, Shaft and 3 more": the names in a sentence, a few of them in full. */
export function namesInWords(names: readonly string[], shown = 3): string {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length <= shown) return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1] ?? ""}`;
  return `${names.slice(0, shown - 1).join(", ")} and ${names.length - (shown - 1)} more`;
}
