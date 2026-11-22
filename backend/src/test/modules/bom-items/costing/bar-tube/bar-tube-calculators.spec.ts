import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { normalizeFieldName } from '../../../../../modules/calculators/calculator-formula-evaluator';
import { barTubeCalculatorsByName, loadBarTubeCalculatorSpec } from '../../../../../modules/bom-items/costing/bar-tube/calculators/bar-tube-calculator-spec';
import { buildBarTubeCalculatorsMigrationSql, buildBarTubeSawBundleMigrationSql } from '../../../../../modules/bom-items/costing/bar-tube/calculators/bar-tube-calculators-migration';
import { runReferenceCalculator, type CalcSeed } from '../../../../../modules/bom-items/costing/shared/calculators/reference-calculator';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { readCsv, specKey } = require('../../../../../../migrations/scripts/lib/memory-machine-seed.js');
const MIGRATIONS = join(__dirname, '../../../../../../migrations');
const DIR = join(__dirname, '../../../../../../../memory/Bar and tube fab');
const all = loadBarTubeCalculatorSpec().calculators;
const byName = barTubeCalculatorsByName();

const variables: Record<string, number> = Object.fromEntries(
  readCsv(join(DIR, 'bar_and_tube_variables.csv')).rows.map((r: Record<string, string>) => [r['Variable Name'], Number(r['String Value'])]),
);
/** Runs a calculator on `values` (by field name); every variable input is seeded from memory/Bar and tube fab/bar_and_tube_variables.csv. */
function run(name: string, values: Record<string, number>, output?: string) {
  const def = byName[name]!;
  const spec = all.find((c) => c.name === name)!;
  const seeds: Record<string, CalcSeed> = {};
  for (const f of spec.fields) {
    if (f.formula) continue;
    const v = f.source && 'variable' in f.source ? variables[f.source.variable] : values[f.name];
    if (v === undefined) throw new Error(`${name}: no value for ${f.name}`);
    seeds[f.name] = { value: v, source: 'test' };
  }
  return runReferenceCalculator({ [name]: def }, name, seeds, output ?? spec.output ?? 'Cycle Time');
}

describe('bar and tube calculator spec', () => {
  it('is what migration 1091 creates (regenerate the migration after editing the spec)', () => {
    expect(readFileSync(join(MIGRATIONS, '1091_bar_tube_calculators.sql'), 'utf8')).toBe(buildBarTubeCalculatorsMigrationSql());
  });

  // 1091 divided the whole saw cycle, cutting included, by the parts in a bundle. 1117 ships version 2, which shares only the index and the
  // handling; the superseded entry stays only so 1091 regenerates as applied.
  it('the saw cut is what migration 1117 creates, and the engine reads only that version', () => {
    expect(readFileSync(join(MIGRATIONS, '1117_bar_tube_saw_bundle.sql'), 'utf8')).toBe(buildBarTubeSawBundleMigrationSql());
    const saw = all.filter((c) => c.name === 'Bar and Tube - Saw cut');
    expect(saw).toHaveLength(1);
    expect(saw[0]).toMatchObject({ migration: 1117, version: 2 });
    expect(byName['Bar and Tube - Saw cut']!.version).toBe(2);
    expect(loadBarTubeCalculatorSpec({ includeSuperseded: true }).calculators.filter((c) => c.name === 'Bar and Tube - Saw cut')).toHaveLength(2);
  });

  it('every operation it computes is a process of memory/Bar and tube fab, each costed process has one, none twice', () => {
    const catalog = new Set<string>(readCsv(join(DIR, 'Processes/processes_default_machines.csv')).rows.map((r: Record<string, string>) => r['Process Name']));
    const ops = all.flatMap((c) => c.operations);
    expect(ops.filter((o) => !catalog.has(o))).toEqual([]);
    expect(new Set(ops).size).toBe(ops.length);
    // Material Stock and Sheet Stock are the purchased stock (non_mfg): the stock and plate helpers price them. No Cost Feature and
    // User-Defined Process are catalog placeholders, as in every domain.
    const uncomputed = new Set(['Material Stock', 'Sheet Stock', 'No Cost Feature', 'User-Defined Process']);
    expect([...catalog].filter((p) => !ops.includes(p) && !uncomputed.has(p))).toEqual([]);
  });

  it('field names never collide once normalized', () => {
    for (const c of all) {
      const names = c.fields.map((f) => normalizeFieldName(f.name));
      expect({ calc: c.name, dup: names.filter((n, i) => names.indexOf(n) !== i) }).toEqual({ calc: c.name, dup: [] });
    }
  });

  describe('every source resolves to real data', () => {
    const sources = all.flatMap((c) => c.fields.flatMap((f) => (f.source ? [{ at: `${c.name}/${f.name}`, source: f.source as Record<string, string> }] : [])));
    const of = (kind: string) => sources.filter((s) => kind in s.source).map((s) => ({ at: s.at, key: s.source[kind]! }));

    it('variables are in bar_and_tube_variables.csv', () => {
      expect(of('variable').filter((s) => !(s.key in variables))).toEqual([]);
    });

    it('lookups are a table and header of memory/Bar and tube fab/lookup', () => {
      const headers = new Map<string, string[]>(readdirSync(join(DIR, 'lookup')).filter((f) => f.endsWith('.csv')).map((f) => [f.replace(/\.csv$/, ''), readCsv(join(DIR, 'lookup', f)).columns as string[]]));
      expect(of('lookup').filter((s) => !headers.get(s.key.slice(0, s.key.indexOf('.')))?.includes(s.key.slice(s.key.indexOf('.') + 1)))).toEqual([]);
    });

    it('machine columns are specs of the bar and tube machines (migration 862 keys their file headers with specKey)', () => {
      const keys = new Set(readdirSync(join(DIR, 'Machines')).flatMap((f) => (readCsv(join(DIR, 'Machines', f)).columns as string[]).map((h) => specKey(h) as string)));
      expect(of('machine').map((s) => ({ ...s, key: s.key.split(' (')[0]! })).filter((s) => !keys.has(s.key))).toEqual([]);
    });

    it('material columns are raw_materials columns (exit speed: migration 1090)', () => {
      expect(of('material').filter((s) => !['cost', 'density_kg_m3', 'specific_heat_rt_j_kg_k', 'extrusion_exit_speed_max_mm_s'].includes(s.key))).toEqual([]);
    });
  });
});

// Hand-worked: a 1 m length of 25 x 1.5 mm round tube, steel (cut-code family 1), on the DoAll 3613-1 Vert band saw (axial feed 75 mm/s,
// load + unload 60 s), one per bundle. Metal area π/4 (25² − 22²) = 110.74 mm²; saw_cut_rate Band Saw family 1, width 50 mm: 6,451.60 mm²/min.
describe('bar and tube calculators, worked by hand', () => {
  it('saw cut: cut 110.74 / 6451.6 × 60 = 1.03 s, index 1000 / 75 = 13.33 s, + 60 s handling = 74.36 s', () => {
    const area = (Math.PI / 4) * (25 ** 2 - 22 ** 2);
    const r = run('Bar and Tube - Saw cut', {
      'Cut Area': area, 'Cutting Rate': 6451.6, 'Cut Length': 1000, 'Axial Feed Rate': 75, 'Load and Unload': 60, 'Parts per Bundle': 1, 'Cuts per Part': 1,
    });
    expect(r.value).toBeCloseTo(area / 6451.6 * 60 + 1000 / 75 + 60, 4);
    expect(r.value).toBeCloseTo(74.363, 2);
  });

  // The same tube, 18 to a bundle: the blade still cuts every tube's section (1.03 s each, at the bundle's rate), and the bundle shares one
  // index and one load and unload: (13.33 + 60) / 18 = 4.07 s. Version 1 divided the cut by 18 as well and gave 4.13 s in all.
  it('saw cut in a bundle of 18: cut 1.03 s for each part, + (13.33 + 60) / 18 = 4.07 s of shared handling = 5.10 s', () => {
    const area = (Math.PI / 4) * (25 ** 2 - 22 ** 2);
    const r = run('Bar and Tube - Saw cut', {
      'Cut Area': area, 'Cutting Rate': 6451.6, 'Cut Length': 1000, 'Axial Feed Rate': 75, 'Load and Unload': 60, 'Parts per Bundle': 18, 'Cuts per Part': 1,
    });
    expect(r.outputs['Cut Time']).toBeCloseTo(1.0299, 3);
    expect(r.outputs['Handling per Part']).toBeCloseTo(4.0741, 3);
    expect(r.value).toBeCloseTo(5.104, 2);
  });

  it('two angled ends are two cuts of each part, bundled or not', () => {
    const area = (Math.PI / 4) * (25 ** 2 - 22 ** 2);
    const r = run('Bar and Tube - Saw cut', {
      'Cut Area': area, 'Cutting Rate': 6451.6, 'Cut Length': 1000, 'Axial Feed Rate': 75, 'Load and Unload': 60, 'Parts per Bundle': 18, 'Cuts per Part': 2,
    });
    expect(r.value).toBeCloseTo(2 * 1.0299 + 4.0741, 2);
  });
});
