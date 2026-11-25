// The files of a printed circuit board's board set: the Gerber layers, drill file and report, and the Pick Place and BOM tables that go
// with them (or all of them in one .zip). A BOM item keeps them as its board set; the CAD engine measures the board from them when the
// part is analysed. The board-file extensions are the file-role table's (memory/Electronics/gerber_file_roles.csv, mirrored by
// backend costing/pcb/board-graph/board-files.ts BOARD_SET_EXTENSIONS), which judges each file by its content on upload.
export const BOARD_FILE_EXTENSIONS: readonly string[] = ['gtl', 'gbl', 'gts', 'gbs', 'gto', 'gbo', 'gtp', 'gbp', 'gko', 'gpt', 'gpb', 'gd1', 'gg1', 'txt', 'drr'];
export const BOARD_TABLE_EXTENSIONS: readonly string[] = ['csv', 'tsv', 'xlsx', 'xlsm'];
/** Every extension the board set accepts, as the file picker takes it (".gtl"). */
export const BOARD_SET_ACCEPT: readonly string[] = [...BOARD_FILE_EXTENSIONS, ...BOARD_TABLE_EXTENSIONS, 'zip'].map((e) => `.${e}`);

const extensionOf = (name: string) => (name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '');

/** A file that belongs to a board set (a layer, drill data, a table that goes with them, or a .zip of them). */
export function isBoardSetFile(name: string): boolean {
  const ext = extensionOf(name);
  return BOARD_FILE_EXTENSIONS.includes(ext) || BOARD_TABLE_EXTENSIONS.includes(ext) || ext === 'zip';
}

export interface RejectedFile { name: string; tooLarge: boolean }

/** What to tell a person when the BOM item form refuses files they dropped: too large, or a type it does not take (with the types it takes). */
export function describeRejection(rejected: readonly RejectedFile[], maxMb: number): { title: string; description: string } {
  const names = rejected.map((r) => r.name).join(', ');
  const tooLarge = rejected.some((r) => r.tooLarge);
  return {
    title: tooLarge ? 'File too large' : 'File type not supported',
    description: `${names}: ${tooLarge
      ? `the limit is ${maxMb} MB per file.`
      : 'this form takes STEP (.step, .stp) for 3D parts, DXF or DWG for drawings, and a circuit board\'s Gerber, drill and Pick Place files (or one .zip of them).'}`,
  };
}
