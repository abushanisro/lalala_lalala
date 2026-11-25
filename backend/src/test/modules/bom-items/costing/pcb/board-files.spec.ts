// A BOM item's board set: what it may hold, each file's role by its content, loose files packed into one zip.
import JSZip from 'jszip';

import { boardSetFiles, isBoardSetName, MAX_BOARD_FILES, prepareBoardUpload } from '../../../../../modules/bom-items/costing/pcb/board-graph/board-files';

const GERBER = Buffer.from('%FSLAX24Y24*%\n%MOMM*%\nD10*\nM02*\n');
const EXCELLON = Buffer.from('M48\nMETRIC\nT01C0.500\n%\nT01\nX1000Y1000\nM30\n');
const PICK_PLACE = Buffer.from('Designator,Comment,Layer,Footprint,Center-X(mm),Center-Y(mm),Rotation\nR1,10k,TopLayer,OPT-0805,1,1,0\n');

describe('a board set', () => {
  it('reads each board file\'s role from its content and the file-role table, and a table with none', () => {
    const { files, skipped } = boardSetFiles([
      { name: 'board.GKO', bytes: GERBER }, { name: 'board.GTL', bytes: GERBER }, { name: 'board.TXT', bytes: EXCELLON },
      { name: 'notes.txt', bytes: Buffer.from('a plain note') }, { name: 'Pick Place.csv', bytes: PICK_PLACE }, { name: 'drawing.pdf', bytes: Buffer.from('%PDF-1.4') },
    ]);
    expect(files.map((f) => [f.name, f.role])).toEqual([['board.GKO', 'board_outline'], ['board.GTL', 'copper_top'], ['board.TXT', 'drill_data'], ['notes.txt', null], ['Pick Place.csv', null]]);
    expect(skipped).toEqual([{ name: 'drawing.pdf', reason: 'not a board file or a table: kept in the set, not read' }]);
  });

  it('leaves out a layer whose content is not a Gerber layer, and says why', () => {
    const { files, skipped } = boardSetFiles([{ name: 'board.GTL', bytes: Buffer.from('not a gerber') }]);
    expect(files).toEqual([]);
    expect(skipped[0].reason).toBe('File content does not match .gtl.');
  });

  it('packs loose board files into one zip named after the part, and keeps a .zip as it came', async () => {
    const packed = await prepareBoardUpload([{ name: 'board.GKO', bytes: GERBER }, { name: 'board.TXT', bytes: EXCELLON }], 'FL285182 / rev A');
    expect(packed).toMatchObject({ ok: true, name: 'FL285182-rev-A-board-set.zip', packed: true });
    const zip = await JSZip.loadAsync((packed as { bytes: Buffer }).bytes);
    expect(Object.keys(zip.files).sort()).toEqual(['board.GKO', 'board.TXT']);
    const asIs = await prepareBoardUpload([{ name: 'set.zip', bytes: (packed as { bytes: Buffer }).bytes }], 'P-1');
    expect(asIs).toMatchObject({ ok: true, name: 'set.zip', packed: false });
  });

  it('refuses the upload, naming each file, when a file is not a board file or a table', async () => {
    const refused = await prepareBoardUpload([{ name: 'board.GKO', bytes: GERBER }, { name: 'photo.png', bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]) }], 'P-1');
    expect(refused).toMatchObject({ ok: false });
    expect((refused as { message: string }).message).toMatch(/^These files were not accepted as board files: photo\.png: not a board file/);
    expect(await prepareBoardUpload([{ name: 'x.zip', bytes: Buffer.from('PK') }, { name: 'board.GKO', bytes: GERBER }], 'P-1')).toMatchObject({ ok: false });
    expect(await prepareBoardUpload(Array.from({ length: MAX_BOARD_FILES + 1 }, (_, i) => ({ name: `l${i}.GTL`, bytes: GERBER })), 'P-1')).toMatchObject({ ok: false });
  });

  it('accepts the board-file and table extensions in the upload', () => {
    expect(['a.gtl', 'a.GBL', 'a.drr', 'a.txt', 'pp.csv', 'bom.xlsx'].every(isBoardSetName)).toBe(true);
    expect(['a.step', 'a.pdf', 'a.zip'].some(isBoardSetName)).toBe(false);
  });
});
