import { modelPartsOf } from './model-parts';

/** What an assembly view needs of a BOM item. */
export interface TreeItem {
  id: string;
  parentItemId?: string | undefined;
  file3dPath?: string | undefined;
}

export type TreeNode<T extends TreeItem> = T & { children: TreeNode<T>[] };

/** The BOM items below `rootId`, as a tree. Null when the root is not among them. An item listed under itself or twice is taken once. */
export function buildTree<T extends TreeItem>(items: readonly T[], rootId: string): TreeNode<T> | null {
  const below = new Map<string, T[]>();
  for (const item of items) {
    if (item.parentItemId) below.set(item.parentItemId, [...(below.get(item.parentItemId) ?? []), item]);
  }
  const seen = new Set<string>();
  const grow = (item: T): TreeNode<T> => {
    seen.add(item.id);
    return { ...item, children: (below.get(item.id) ?? []).filter((child) => !seen.has(child.id)).map(grow) };
  };
  const root = items.find((item) => item.id === rootId);
  return root ? grow(root) : null;
}

/** A part with a model, and the group it explodes with: the root's own child it sits under (a sub-assembly, or the part itself). */
export interface GroupedPart<N> {
  part: N;
  groupId: string;
}

export function groupedParts<T extends TreeItem>(root: TreeNode<T>): GroupedPart<TreeNode<T>>[] {
  return root.children.flatMap((child) =>
    (child.file3dPath ? [child] : modelPartsOf<TreeNode<T>>(child)).map((part) => ({ part, groupId: child.id })));
}

/** The ids of the models a selection of `node` stands for: its own, else every model below it. */
export function modelIdsUnder<T extends TreeItem>(node: TreeNode<T>): string[] {
  return node.file3dPath ? [node.id] : modelPartsOf<TreeNode<T>>(node).map((part) => part.id);
}

/** The models a set of item ids stands for in the assembly: a part its own, a sub-assembly every model below it; an id not in the tree is ignored. */
export function selectionFor<T extends TreeItem>(root: TreeNode<T>, ids: readonly string[]): string[] {
  const find = (node: TreeNode<T>, id: string): TreeNode<T> | null =>
    node.id === id ? node : node.children.reduce<TreeNode<T> | null>((found, child) => found ?? find(child, id), null);
  return [...new Set(ids.flatMap((id) => { const node = find(root, id); return node ? modelIdsUnder(node) : []; }))];
}

/** An item and the sub-assemblies above it, nearest first, up to the root's own child (the root is not in it); empty when the id is not under the root. */
export function ancestorChain<T extends TreeItem>(root: TreeNode<T>, id: string): string[] {
  const find = (node: TreeNode<T>): string[] | null => {
    if (node.id === id) return [node.id];
    for (const child of node.children) {
      const below = find(child);
      if (below) return [...below, node.id];
    }
    return null;
  };
  for (const child of root.children) {
    const chain = find(child);
    if (chain) return chain;
  }
  return [];
}
