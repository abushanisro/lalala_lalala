/** What decides which of a project's BOMs is its main one. */
export interface BomSummary {
  id: string;
  projectId: string;
  itemCount: number;
  /** Whether the BOM holds an assembly item. */
  hasAssembly: boolean;
  createdAt: string;
}

/**
 * The BOM to open for a project: the one that holds its main assembly, else the one with the most items; of equal standing the earliest
 * created, then the lowest id, so the choice does not change when something is added elsewhere. Returns project id to BOM id. Pure.
 */
export function pickMainBoms(boms: readonly BomSummary[]): Map<string, string> {
  const better = (a: BomSummary, b: BomSummary): boolean => {
    if (a.hasAssembly !== b.hasAssembly) return a.hasAssembly;
    if (a.itemCount !== b.itemCount) return a.itemCount > b.itemCount;
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt;
    return a.id < b.id;
  };
  const best = new Map<string, BomSummary>();
  for (const bom of boms) {
    const current = best.get(bom.projectId);
    if (!current || better(bom, current)) best.set(bom.projectId, bom);
  }
  return new Map([...best].map(([projectId, bom]) => [projectId, bom.id]));
}
