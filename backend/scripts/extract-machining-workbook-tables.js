/**
 * Extracts the cutting-data tables of the machining workbook into CSVs:
 *   node scripts/extract-machining-workbook-tables.js
 *
 * Source: memory/Machining - Calculator Database (1).xlsx (the user's reference workbook, 23 sheets). Each table is read from its cells
 * as the workbook lays it out; a range written as text ("20 – 40", "90 -450", "2--4", "0,05-0,10") becomes a Min and a Max column.
 * Output: memory/machining/workbook/<table>.csv, the files generate-machining-workbook-reference-migration.js stages. The tables that
 * exist only as pictures pasted into the workbook (the Uddeholm Corrax tables) and the authored ones (tool prices, the material group
 * map) are written by hand in the same folder, each row with its source.
 *
 * CI does not have the workbook (its memory/ is the private reference-data repo): the CSVs are what CI reads, and this script is how
 * they were made.
 */
const ExcelJS = require('exceljs');
const { mkdirSync, writeFileSync } = require('fs');
const { join } = require('path');

const MEMORY = join(__dirname, '../../memory');
const WORKBOOK = join(MEMORY, 'Machining - Calculator Database (1).xlsx');
const OUT = join(MEMORY, 'machining/workbook');

const text = (v) => {
  if (v == null) return '';
  if (typeof v === 'object' && v.richText) return v.richText.map((t) => t.text).join('');
  if (typeof v === 'object' && 'result' in v) return String(v.result ?? '');
  return String(v);
};
/** One cell's text, whitespace (and the workbook's line breaks) collapsed. */
const cellText = (ws, address) => text(ws.getCell(address).value).replace(/\s+/g, ' ').trim();
/** "20 – 40" -> [20, 40]; "0,05-0,10" -> [0.05, 0.1]; "OVER 38" -> [38, null]; a single number -> [n, n]. */
function range(raw) {
  const s = String(raw).replace(/,/g, '.').replace(/\s+/g, ' ').trim();
  const over = /^over\s+([\d.]+)$/i.exec(s);
  if (over) return [Number(over[1]), null];
  const parts = s.split(/\s*[–-]+\s*/).filter(Boolean).map((p) => Number(p.replace(/\s/g, '')));
  if (parts.length === 1 && Number.isFinite(parts[0])) return [parts[0], parts[0]];
  if (parts.length !== 2 || !parts.every(Number.isFinite)) throw new Error(`not a range: "${raw}"`);
  return parts;
}
const num = (raw) => {
  const n = Number(String(raw).trim());
  if (String(raw).trim() === '' || !Number.isFinite(n)) throw new Error(`not a number: "${raw}"`);
  return n;
};
const csvCell = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
function writeTable(name, columns, rows) {
  const lines = [columns.join(','), ...rows.map((r) => columns.map((c) => csvCell(r[c])).join(','))];
  writeFileSync(join(OUT, `${name}.csv`), lines.join('\n') + '\n');
  console.log(`${name}.csv: ${rows.length} rows`);
}
const col = (letter, offset) => String.fromCharCode(letter.charCodeAt(0) + offset);

(async () => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(WORKBOOK);
  const sheet = (name) => {
    const ws = wb.worksheets.find((w) => w.name.trim() === name);
    if (!ws) throw new Error(`no sheet "${name}"`);
    return ws;
  };
  mkdirSync(OUT, { recursive: true });

  // Turning!A27:F59 "Turning cutting conditions": work material x tool material, four depth-of-cut bands (C32:F32) each with a feed
  // band (C36:F36) and a cutting speed range per row.
  {
    const ws = sheet('Turning');
    const bands = [0, 1, 2, 3].map((i) => ({ depth: range(cellText(ws, `${col('C', i)}32`)), feed: range(cellText(ws, `${col('C', i)}36`)) }));
    const rows = [];
    for (let r = 38; r <= 59; r++) {
      const group = cellText(ws, `A${r}`);
      const tool = cellText(ws, `B${r}`);
      bands.forEach((b, i) => {
        const [vMin, vMax] = range(cellText(ws, `${col('C', i)}${r}`));
        rows.push({
          WorkGroup: group, ToolMaterial: tool, DepthMinMm: b.depth[0], DepthMaxMm: b.depth[1],
          FeedMinMmPerRev: b.feed[0], FeedMaxMmPerRev: b.feed[1], SpeedMinMPerMin: vMin, SpeedMaxMPerMin: vMax,
        });
      });
    }
    writeTable('tblTurningConditions', ['WorkGroup', 'ToolMaterial', 'DepthMinMm', 'DepthMaxMm', 'FeedMinMmPerRev', 'FeedMaxMmPerRev', 'SpeedMinMPerMin', 'SpeedMaxMPerMin'], rows);
  }

  // Reaming!J1:U61: work material x operation (Drilling / Reaming), a cutting speed range, and a feed per rev for nine hole diameter
  // bands (M5:U5).
  {
    const ws = sheet('Reaming');
    const bands = [...Array(9).keys()].map((i) => range(cellText(ws, `${col('M', i)}5`)));
    const rows = [];
    for (let r = 8; r <= 61; r++) {
      const material = cellText(ws, `J${r}`);
      const operation = cellText(ws, `K${r}`);
      const [vMin, vMax] = range(cellText(ws, `L${r}`));
      bands.forEach(([dMin, dMax], i) => rows.push({
        WorkMaterial: material, Operation: operation, SpeedMinMPerMin: vMin, SpeedMaxMPerMin: vMax,
        DiameterMinMm: dMin, DiameterMaxMm: dMax, FeedMmPerRev: num(cellText(ws, `${col('M', i)}${r}`)),
      }));
    }
    writeTable('tblDrillReamData', ['WorkMaterial', 'Operation', 'SpeedMinMPerMin', 'SpeedMaxMPerMin', 'DiameterMinMm', 'DiameterMaxMm', 'FeedMmPerRev'], rows);
  }

  // Tapping!A33:D58: HSS cutting speed for drilling, reaming and tapping per work material (each material on two merged rows).
  {
    const ws = sheet('Tapping');
    const ops = { B: 'Drilling', C: 'Reaming', D: 'Tapping' };
    const rows = [];
    for (let r = 37; r <= 58; r += 2) {
      const group = cellText(ws, `A${r}`);
      for (const [c, op] of Object.entries(ops)) {
        const [vMin, vMax] = range(cellText(ws, `${c}${r}`));
        rows.push({ WorkGroup: group, Operation: op, SpeedMinMPerMin: vMin, SpeedMaxMPerMin: vMax });
      }
    }
    writeTable('tblHssHoleSpeeds', ['WorkGroup', 'Operation', 'SpeedMinMPerMin', 'SpeedMaxMPerMin'], rows);
  }

  // Boring!K26:L49: boring feed per rev by hole diameter band (each band on two merged rows; the last is "OVER 38").
  {
    const ws = sheet('Boring');
    const rows = [];
    for (let r = 26; r <= 49; r += 2) {
      const [dMin, dMax] = range(cellText(ws, `K${r}`));
      const [fMin, fMax] = range(cellText(ws, `L${r}`));
      rows.push({ DiameterMinMm: dMin, DiameterMaxMm: dMax, FeedMinMmPerRev: fMin, FeedMaxMmPerRev: fMax });
    }
    writeTable('tblBoringFeed', ['DiameterMinMm', 'DiameterMaxMm', 'FeedMinMmPerRev', 'FeedMaxMmPerRev'], rows);
  }

  // End Milling and Sawing!O8:Q61: milling cutting speed and feed per tooth per work material (each material on two merged rows).
  {
    const ws = sheet('End Milling and Sawing');
    const rows = [];
    for (let r = 8; r <= 61; r += 2) {
      const [vMin, vMax] = range(cellText(ws, `P${r}`));
      const [fMin, fMax] = range(cellText(ws, `Q${r}`));
      rows.push({ WorkMaterial: cellText(ws, `O${r}`), SpeedMinMPerMin: vMin, SpeedMaxMPerMin: vMax, FeedPerToothMinMm: fMin, FeedPerToothMaxMm: fMax });
    }
    writeTable('tblMillingConditions', ['WorkMaterial', 'SpeedMinMPerMin', 'SpeedMaxMPerMin', 'FeedPerToothMinMm', 'FeedPerToothMaxMm'], rows);
  }

  // Laser Cutting!H2:L32 (the Plasma Cutting sheet holds the same table): feed rate and kerf by machine and material thickness.
  // Row 33 ("Saw Band", 2500 Sq. mm/min) is an area rate, not a feed by thickness: it is the band saw's row of tblSawCutRate.
  {
    const ws = sheet('Laser Cutting');
    const rows = [];
    for (let r = 2; r <= 32; r++) {
      rows.push({ Machine: cellText(ws, `I${r}`), ThicknessMm: num(cellText(ws, `J${r}`)), FeedMmPerMin: num(cellText(ws, `K${r}`)), KerfMm: num(cellText(ws, `L${r}`)) });
    }
    writeTable('tblThermalCutFeed', ['Machine', 'ThicknessMm', 'FeedMmPerMin', 'KerfMm'], rows);
    const saw = /^([\d.]+)\s*Sq\.?\s*mm\s*\/\s*min$/i.exec(cellText(ws, 'K33'));
    if (cellText(ws, 'I33') !== 'Saw Band' || !saw) throw new Error(`Laser Cutting row 33 is not the band saw rate: "${cellText(ws, 'I33')}" "${cellText(ws, 'K33')}"`);
    writeTable('tblSawCutRate', ['Machine', 'AreaRateMm2PerMin'], [{ Machine: 'Saw Band', AreaRateMm2PerMin: Number(saw[1]) }]);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
