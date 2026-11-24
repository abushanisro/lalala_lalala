// A board set on a BOM item: the Gerber layers, drill file and report, Pick Place and BOM tables a board is made from. Uploaded as
// a .zip or as loose files, it is kept as one zip (bom_items.file_board_path) and read by the CAD engine's board routes when the part
// is analysed. Each file's role comes from its content and the file-role table (memory/Electronics/gerber_file_roles.csv): a Gerber
// layer must carry its format statement, a drill file must be Excellon.
import JSZip from 'jszip';

import { RESOURCE_LIMITS } from '../../../../../common/resource-limits';
import { validateDesignFile } from '../../../../electronics-costing/application/validate-design-file';
import { FILE_ROLES } from '../../../../electronics-costing/domain/lookups/file-roles.generated';
import { MAX_UPLOAD_BYTES, validateUpload } from '../../../../electronics-costing/domain/uploads/validate-upload';

import type { ArchiveLimits, ArchiveEntry } from '../../../../../common/archive/expand-archive';
import type { EngineFile } from '../../../../electronics-costing/infrastructure/cad-engine/board-extraction.client';

/** Files a board set may send the engine (it refuses more: cad-engine MAX_BOARD_FILES). */
export const MAX_BOARD_FILES = 40;

/** What a stored board set may unpack to: each file within the per-file limit, the whole within the one archive budget. */
export const BOARD_ARCHIVE_LIMITS: ArchiveLimits = {
  maxEntries: 500,
  maxEntryBytes: MAX_UPLOAD_BYTES,
  maxTotalBytes: RESOURCE_LIMITS.archiveMaxExpandedBytes,
  maxRatio: 100,
};

/** Table files (Pick Place, BOM workbook) a board set carries beside its layers. */
const TABLE_EXTENSIONS = new Set(['csv', 'tsv', 'txt', 'xlsx', 'xlsm']);

/** The extensions of board files (layers, drill data, reports) and of the tables that go with them: what the upload accepts. */
export const BOARD_SET_EXTENSIONS: readonly string[] = [...new Set([...FILE_ROLES.map((r) => r.extension), ...TABLE_EXTENSIONS])].sort();

const extensionOf = (name: string) => {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
};

/** True when a file name is a board file or a table that goes with one (the upload sends it as part of the board set). */
export function isBoardSetName(name: string): boolean {
  return BOARD_SET_EXTENSIONS.includes(extensionOf(name));
}

export interface BoardSetFiles {
  files: EngineFile[];
  /** Files left out of the set, with why (a document, a file whose content is not its kind, a nested archive). */
  skipped: { name: string; reason: string }[];
}

/**
 * The files of a set the engine reads: each board file with its role (judged by its content), each table without one. Anything else
 * (a drawing PDF, a photo) is left out and listed. The names are the files' own, made unique when two folders hold the same name.
 */
export function boardSetFiles(entries: readonly { name: string; bytes: Buffer }[]): BoardSetFiles {
  const files: EngineFile[] = [];
  const skipped: BoardSetFiles['skipped'] = [];
  const taken = new Set<string>();
  for (const e of entries) {
    const ext = extensionOf(e.name);
    if (!BOARD_SET_EXTENSIONS.includes(ext)) {
      skipped.push({ name: e.name, reason: 'not a board file or a table: kept in the set, not read' });
      continue;
    }
    const verdict = validateUpload(e.name, e.bytes);
    if (!verdict.ok) {
      skipped.push({ name: e.name, reason: verdict.message });
      continue;
    }
    let name = e.name;
    for (let i = 2; taken.has(name.toLowerCase()); i++) name = e.name.replace(/(\.[^.]+)?$/, ` (${i})$1`);
    taken.add(name.toLowerCase());
    // A board file carries its role; a table (Pick Place, BOM workbook, a .txt that is not Excellon) carries none.
    files.push({ name, bytes: e.bytes, role: verdict.role ?? null });
  }
  return { files, skipped };
}

/** Loose board files packed into the one zip the item keeps (their names at its root). */
export async function packBoardSet(files: readonly { name: string; bytes: Buffer }[]): Promise<Buffer> {
  const zip = new JSZip();
  const taken = new Set<string>();
  for (const f of files) {
    const base = f.name.replace(/[\\/]/g, '_');
    let name = base;
    for (let i = 2; taken.has(name.toLowerCase()); i++) name = base.replace(/(\.[^.]+)?$/, ` (${i})$1`);
    taken.add(name.toLowerCase());
    zip.file(name, f.bytes, { createFolders: false });
  }
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}

/** The entries of an unpacked set as the engine takes them (the file name, not the archive path). */
export function entriesOf(archive: readonly ArchiveEntry[]): { name: string; bytes: Buffer }[] {
  return archive.map((e) => ({ name: e.name, bytes: e.bytes }));
}

export type BoardUpload = { ok: true; name: string; bytes: Buffer; packed: boolean } | { ok: false; message: string };

/**
 * What a board upload stores: a .zip as it came (after the archive gate measured it from its central directory), or loose board files
 * and tables packed into one zip named after the part. A file that is not a board file or a table, or whose content is not its kind,
 * refuses the upload by name: nothing is stored half.
 */
export async function prepareBoardUpload(files: readonly { name: string; bytes: Buffer }[], partName: string): Promise<BoardUpload> {
  if (files.length === 0) return { ok: false, message: 'No board files were sent.' };
  const [only, ...others] = files;
  if (others.length === 0 && /\.zip$/i.test(only.name)) {
    const verdict = validateDesignFile(only.name, only.bytes, BOARD_ARCHIVE_LIMITS);
    return verdict.ok ? { ok: true, name: only.name, bytes: only.bytes, packed: false } : { ok: false, message: `${only.name}: ${verdict.message}` };
  }
  const refused: string[] = [];
  for (const f of files) {
    if (/\.zip$/i.test(f.name)) { refused.push(`${f.name}: send a .zip on its own, or the board files without it`); continue; }
    if (!isBoardSetName(f.name)) { refused.push(`${f.name}: not a board file (${BOARD_SET_EXTENSIONS.map((e) => `.${e}`).join(', ')})`); continue; }
    const verdict = validateUpload(f.name, f.bytes);
    if (!verdict.ok) refused.push(`${f.name}: ${verdict.message}`);
  }
  if (refused.length) return { ok: false, message: `These files were not accepted as board files: ${refused.join('; ')}` };
  if (files.length > MAX_BOARD_FILES) return { ok: false, message: `A board set holds at most ${MAX_BOARD_FILES} files; ${files.length} were sent.` };
  const stem = partName.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'board';
  return { ok: true, name: `${stem}-board-set.zip`, bytes: await packBoardSet(files), packed: true };
}
