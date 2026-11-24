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
