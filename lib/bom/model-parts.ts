/**
 * The 3D models an assembly's picture is drawn from: those of the parts below it. A part's model is already placed in its assembly
 * (the parts of one STEP assembly share its coordinates), so the models are drawn together as they are, with no layout of their own.
 * An item with a model of its own draws that; only an item with none is drawn from its descendants.
 */
export interface ModelNode {
  file3dPath?: string | undefined;
  children?: readonly ModelNode[] | undefined;
}

/** `P` is the item type the caller holds (the nodes below are items of that type). */
export function modelPartsOf<P extends ModelNode>(node: ModelNode): P[] {
  if (node.file3dPath) return [];
  return (node.children ?? []).flatMap((child) => (child.file3dPath ? [child as P] : modelPartsOf<P>(child)));
}
