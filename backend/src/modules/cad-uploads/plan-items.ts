import { BOMItemType } from '../bom-items/dto/bom-items.dto';

import type { AssemblyNode, AssemblyPart, AssemblyReport } from './assembly-report';

export interface PlannedItem {
  /** Position in the tree ("0", "0.1", ...); a child's parent is the key before its last dot. */
  key: string;
  parentKey: string | null;
  name: string;
  itemType: BOMItemType;
  quantity: number;
  partNumber: string;
  /** The uploaded file that is exactly this part (a single-part STEP), to attach as its 3D file; null for parts inside an assembly file. */
  ownFile: string | null;
  /** The part's definition id (what /assembly/parts exports); null for assemblies. */
  definition: string | null;
  /** What the engine measured for a part (mm, mm², mm³; bounding box sorted longest first); absent when it could not. */
  measured: { volume: number; surfaceArea: number; maxLength: number; maxWidth: number; maxHeight: number } | null;
}

/** What the upload's file name stands for: the main assembly's name when the file holds several top-level parts. */
export function packName(fileName: string): string {
  return fileName.replace(/\.(zip|step|stp)$/i, '').replace(/[\\/]/g, ' ').trim() || 'Uploaded assembly';
}

/** The folder a zip entry sits in, at the top of the archive ('' for a file at the top). */
const topFolder = (file: string): string => (file.includes('/') ? file.split('/')[0] : '');

/**
 * A pack of loose parts has no assembly of its own, yet a BOM needs a main assembly to hang them from. When the engine reports several
 * top-level nodes, they become the children of one assembly named after the upload; a single top-level node (a real assembly, or one part)
 * is left exactly as reported. A zip that keeps all its parts in folders says how they group: each folder is a sub-assembly. Idempotent:
 * the result has one root.
 */
export function withPackRoot(report: AssemblyReport, fileName: string): AssemblyReport {
  if (report.assembly.length < 2) return report;
  const name = packName(fileName);
  const folders = new Map<string, AssemblyNode[]>();
  for (const node of report.assembly) folders.set(topFolder(node.file), [...(folders.get(topFolder(node.file)) ?? []), node]);
  const inFolders = folders.size > 1 && !folders.has('');
  const children: AssemblyNode[] = inFolders
    ? [...folders].map(([folder, nodes]) => ({ definition: `folder:${folder}`, name: folder, kind: 'assembly', quantity: 1, file: '', children: nodes }))
    : report.assembly;
  const root: AssemblyNode = { definition: `pack:${name}`, name, kind: 'assembly', quantity: 1, file: '', children };
  return { ...report, assembly: [root] };
}

/** The uploaded file's name without its folders and extension. */
const fileStem = (file: string): string => (file.split(/[\\/]/).pop() ?? '').replace(/\.(step|stp)$/i, '');

/**
 * FreeCAD writes a lone body as an assembly named after the file around one part. That wrapper says nothing the file name does not,
 * so the file's part stands alone. An assembly that merely holds one part, under any other name, is kept as the assembly it is.
 */
function unwrapFileAssemblies(node: AssemblyNode): AssemblyNode {
  const children = node.children.map(unwrapFileAssemblies);
  const only = children.length === 1 ? children[0] : undefined;
  if (node.kind !== 'part' && only?.kind === 'part' && only.quantity === 1 && node.name === fileStem(node.file)) return { ...only, quantity: node.quantity };
  return { ...node, children };
}

/**
 * The BOM lines an engine report becomes: one per tree node, parents before children. Pure.
 * A part that is a whole uploaded file (the only part it holds) is named after the file: its STEP product name is whatever the CAD tool wrote (FreeCAD
 * names it after the last feature, "Chamfer" or "Hole003").
 */
export function planItems(report: AssemblyReport, uploadTag: string): PlannedItem[] {
  const partById = new Map(report.parts.map((p) => [p.id, p]));
  const tree = report.assembly.map(unwrapFileAssemblies);
  // A part is a whole uploaded file when no assembly came from that file: parts inside an assembly file name the assembly's file.
  const assemblyFiles = new Set<string>();
  const collect = (nodes: AssemblyNode[]): void => nodes.forEach((n) => { if (n.kind !== 'part') assemblyFiles.add(n.file); collect(n.children); });
  collect(tree);
  const ownFiles = new Map<string, string>();
  const partsPerFile = new Map<string, number>();
  const claim = (nodes: AssemblyNode[]): void => nodes.forEach((n) => {
    if (n.kind === 'part' && !assemblyFiles.has(n.file)) { ownFiles.set(n.definition, n.file); partsPerFile.set(n.file, (partsPerFile.get(n.file) ?? 0) + 1); }
    claim(n.children);
  });
  claim(tree);
  const items: PlannedItem[] = [];
  const walk = (node: AssemblyNode, key: string, parentKey: string | null) => {
    const ownFile = node.kind === 'part' ? (ownFiles.get(node.definition) ?? null) : null;
    const name = ownFile && partsPerFile.get(ownFile) === 1 ? fileStem(ownFile) || node.name : node.name;
    items.push({
      key,
      parentKey,
      name,
      itemType: node.kind === 'part' ? BOMItemType.CHILD_PART : parentKey === null ? BOMItemType.ASSEMBLY : BOMItemType.SUB_ASSEMBLY,
      quantity: node.quantity,
      partNumber: `${slug(name)}-${uploadTag}-${items.length + 1}`,
      ownFile,
      definition: node.kind === 'part' ? node.definition : null,
      measured: node.kind === 'part' ? measured(partById.get(node.definition)) : null,
    });
    node.children.forEach((child, i) => walk(child, `${key}.${i}`, key));
  };
  tree.forEach((root, i) => walk(root, String(i), null));
  return items;
}

function measured(part: AssemblyPart | undefined): PlannedItem['measured'] {
  if (!part || part.volume_mm3 === null || part.surface_area_mm2 === null || part.bounding_box === null) return null;
  const { length, width, height } = part.bounding_box;
  return { volume: part.volume_mm3, surfaceArea: part.surface_area_mm2, maxLength: length, maxWidth: width, maxHeight: height };
}

function slug(name: string): string {
  const s = name.toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20);
  return s || 'PART';
}
