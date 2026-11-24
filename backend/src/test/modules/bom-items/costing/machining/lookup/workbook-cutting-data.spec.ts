// The machining workbook's cutting data (migration 1137, memory/machining/workbook/*.csv) and the cutting machines' spindle limits
// (migration 1136), and the resolvers the workbook-form calculators read them through.
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';

import {
  boringFeed, drillReamData, hssHoleSpeed, materialGroup, millingConditions, thermalCutFeed, toolCost, turningConditions, valueInRange,
  WORKBOOK_TABLES,
  type BoringFeedRow, type DrillReamRow, type HssHoleSpeedRow, type MaterialGroupRow, type MillingConditionsRow, type ThermalCutFeedRow,
  type ToolCostRow, type TurningConditionsRow,
} from '../../../../../../modules/bom-items/costing/machining/lookup/workbook-cutting-data';
import { mhrRateFromCandidate } from '../../../../../../modules/bom-items/costing/shared/capability/machine-selection/rate-from-candidate';
import { fetchMachinePool } from '../../../../../../modules/bom-items/costing/shared/capability/machine-selection/selector';

import type { MaterialClass } from '../../../../../../modules/bom-items/costing/machining/process/cost-machining-engine';


// eslint-disable-next-line @typescript-eslint/no-require-imports
const { readCsv } = require('../../../../../../../migrations/scripts/lib/memory-machine-seed.js') as { readCsv: (path: string) => { rows: any[] } };

const BACKEND = join(__dirname, '../../../../../../..');
const MIGRATIONS = join(BACKEND, 'migrations');
const WORKBOOK = join(BACKEND, '../memory/machining/workbook');
const table = <T>(key: string): T[] => readCsv(join(WORKBOOK, `${key}.csv`)).rows as T[];

const groups = table<MaterialGroupRow>('tblCuttingMaterialGroup');
const turning = table<TurningConditionsRow>('tblTurningConditions');
const drillReam = table<DrillReamRow>('tblDrillReamData');
const hss = table<HssHoleSpeedRow>('tblHssHoleSpeeds');
const boring = table<BoringFeedRow>('tblBoringFeed');
const milling = table<MillingConditionsRow>('tblMillingConditions');
const tools = table<ToolCostRow>('tblCuttingToolCost');
const thermal = table<ThermalCutFeedRow>('tblThermalCutFeed');

describe('the machining workbook cutting data (migration 1137)', () => {
  const file = join(MIGRATIONS, '1137_machining_workbook_cutting_data.sql');

  it('is what the generator writes from memory/machining/workbook (it checks the material map against every table)', () => {
    const committed = readFileSync(file, 'utf8');
    execFileSync('node', [join(BACKEND, 'scripts/generate-machining-workbook-reference-migration.js')], { stdio: 'ignore' });
    expect(readFileSync(file, 'utf8')).toBe(committed);
  });

  it('stages every table the resolvers read, each as one lookup_table row', () => {
    const sql = readFileSync(file, 'utf8');
    for (const key of WORKBOOK_TABLES) expect(sql).toContain(`'lookup_table', 'USA', '2026-03', '${key}',`);
  });

  it('keeps the workbook sizes: 11 turning groups x 2 tools x 4 depth bands, 27 materials x 2 operations x 9 hole bands', () => {
    expect(turning).toHaveLength(88);
    expect(drillReam).toHaveLength(486);
    expect(milling).toHaveLength(27);
    expect(boring).toHaveLength(12);
  });
});

describe('the cutting machines spindle limits (migration 1136)', () => {
  const file = join(MIGRATIONS, '1136_machining_spindle_limits.sql');

  it('is what the generator writes from memory/machining/machine', () => {
    const committed = readFileSync(file, 'utf8');
    execFileSync('node', [join(BACKEND, 'scripts/generate-machining-spindle-limits-migration.js')], { stdio: 'ignore' });
    expect(readFileSync(file, 'utf8')).toBe(committed);
  });

  it('writes each machine its own limit by class and name, for every location, and the driven-tool limit only where there is one', () => {
    const sql = readFileSync(file, 'utf8');
    expect(sql).toContain('($str$2_axis_bar_feed_lathe_with_sub_spindle$str$, $str$Haas DS-30 with BAR3010SS Feeder$str$, 4000, NULL::numeric)');
    expect(sql).toContain('($str$3_axis_lathe$str$, $str$Daewoo Puma MX 2000/2500S$str$,');
    expect(sql).toMatch(/\$str\$Daewoo Puma MX 2000\/2500S\$str\$, \d+, 10000\)/);
    expect(sql).not.toMatch(/m\.location/);
    // bench cells, deburr cells and bevel gear cutters have no spindle a calculator times
    expect(sql).not.toContain('Manual Bench Cell');
    expect(sql).not.toContain('Gleason');
  });
});

describe('the cutting machines rapid traverse rates (migration 1141)', () => {
  const file = join(MIGRATIONS, '1141_machining_rapid_traverse_rates.sql');

  it('is what the generator writes from memory/machining/machine', () => {
    const committed = readFileSync(file, 'utf8');
    execFileSync('node', [join(BACKEND, 'scripts/generate-machining-rapid-traverse-migration.js')], { stdio: 'ignore' });
    expect(readFileSync(file, 'utf8')).toBe(committed);
  });

  it('writes each machine its own rate by class and name, for every location, the machines 1136 gave a spindle limit', () => {
    const sql = readFileSync(file, 'utf8');
    expect(sql).toContain('($str$2_axis_bar_feed_lathe_with_sub_spindle$str$, $str$Haas DS-30 with BAR3010SS Feeder$str$, 24000)');
    expect(sql).toContain('198 machines in 16 classes');
    expect(sql).not.toMatch(/m\.location/);
    expect(sql).not.toContain('Manual Bench Cell');
    // Every machine of those classes must end with one: the migration stops otherwise.
    expect(sql).toContain('Cutting machines still without a rapid traverse rate');
  });
});

describe('the machine pool and line rate carry the spindle limits (mhr_records.specs, migrations 1093 / 1136)', () => {
  const selects: string[] = [];
  const rows = [
    { id: 'a', machine_name: 'Haas DS-30Y with BAR3010SS Feeder', machine_class: '3_axis_bar_feed_lathe_with_sub_spindle', process_group: 'Machining', total_machine_hour_rate: 60, spindle_speed_rpm: 4000, live_tooling_speed_rpm: 3000, rapid_traverse_mm_per_min: 12000 },
    { id: 'b', machine_name: 'Lathe with nothing on file', machine_class: '2_axis_lathe', process_group: 'Machining', total_machine_hour_rate: 50 },
  ];
  const client = {
    from: () => ({ select: (columns: string) => { selects.push(columns); return { eq: () => ({ order: () => ({ range: async () => ({ data: rows, error: null }) }) }) }; } }),
  };

  it('reads only the two specs keys, and a machine with none staged has no limit (not a made-up one)', async () => {
    const pool = await fetchMachinePool(client as never, `spindle-limit-test-${Date.now()}`);
    expect(selects[0]).toContain('spindle_speed_rpm:specs->spindle_speed_rpm, live_tooling_speed_rpm:specs->live_tooling_speed_rpm');
    expect(selects[0]).toContain('rapid_traverse_mm_per_min:specs->rapid_traverse_mm_per_min');
    expect(selects[0]).not.toMatch(/(^|, )specs(,|$)/);
    const haas = pool.find((c) => c.machineName?.startsWith('Haas'))!;
    expect([haas.maxSpindleRpm, haas.liveToolingMaxRpm]).toEqual([4000, 3000]);
    const bare = pool.find((c) => c.machineName?.startsWith('Lathe'))!;
    expect([bare.maxSpindleRpm, bare.liveToolingMaxRpm]).toEqual([null, null]);
    const rate = mhrRateFromCandidate(haas, '3_axis_bar_feed_lathe_with_sub_spindle', 1);
    expect([rate.maxSpindleRpm, rate.liveToolingMaxRpm]).toEqual([4000, 3000]);
    // The rapid traverse rate (migration 1141) the same way; none staged is none.
    expect([haas.rapidTraverseMmPerMin, bare.rapidTraverseMmPerMin, rate.rapidTraverseMmPerMin]).toEqual([12000, null, 12000]);
  });
});

describe('the material map', () => {
  const classes: MaterialClass[] = ['aluminum', 'mild_steel', 'stainless', 'copper_alloy', 'titanium', 'tool_steel', 'plastic'];

  it('maps every material class the engine detects', () => {
    for (const c of classes) expect(materialGroup(groups, c)).not.toBeNull();
  });

  it('points only tool steel at the Uddeholm Corrax data (measured on that one tool steel)', () => {
    expect(classes.filter((c) => materialGroup(groups, c)!.CorraxData)).toEqual(['tool_steel']);
  });

  it('leaves plastic without a turning or HSS group: the workbook has none, so the line names the gap', () => {
    const plastic = materialGroup(groups, 'plastic')!;
    expect(plastic.TurningGroup).toBeNull();
    expect(plastic.HssGroup).toBeNull();
    expect(plastic.DrillReamMaterial).toBe('PLASTIC');
  });
});

describe('the resolvers, on the workbook rows', () => {
  it('turning conditions: the depth-of-cut band holding the depth, with its feed and speed ranges', () => {
    expect(turningConditions(turning, 'Mild steels', 'Carbide', 2)).toEqual({ speed: { min: 120, max: 200 }, feed: { min: 0.2, max: 0.3 }, depth: { min: 0.5, max: 2 } });
    expect(turningConditions(turning, 'Mild steels', 'Carbide', 3)!.speed).toEqual({ min: 80, max: 150 });
    expect(turningConditions(turning, 'Aluminium alloys', 'Carbide', 1)!.speed).toEqual({ min: 90, max: 450 });
    expect(turningConditions(turning, 'Mild steels', 'Carbide', 12)).toBeNull();
    expect(turningConditions(turning, 'Mild steels', 'Carbide', 0.05)).toBeNull();
  });

  it('drill and ream data: one band per hole diameter across the workbook gaps (1-3, 4-6, 6-9 ...)', () => {
    const al = 'ALUMINUM ALLOY CAST AND WROUGHT';
    expect(drillReamData(drillReam, al, 'Drilling', 6.5)).toEqual({ speed: { min: 75, max: 110 }, feedMmPerRev: 0.18, band: { min: 6, max: 9 } });
    expect(drillReamData(drillReam, al, 'Drilling', 3.5)!.feedMmPerRev).toBe(0.13); // in the gap 3-4: the band above
    expect(drillReamData(drillReam, al, 'Drilling', 6)!.band).toEqual({ min: 4, max: 6 });
    expect(drillReamData(drillReam, al, 'Reaming', 20)!.feedMmPerRev).toBe(0.41);
    expect(drillReamData(drillReam, al, 'Drilling', 40)).toBeNull();
    expect(drillReamData(drillReam, al, 'Drilling', 0.5)).toBeNull();
  });

  it('HSS hole speeds: drilling, reaming and tapping per group', () => {
    expect(hssHoleSpeed(hss, 'Aluminium alloys', 'Tapping')).toEqual({ min: 14, max: 18 });
    expect(hssHoleSpeed(hss, 'Stainless steels', 'Reaming')).toEqual({ min: 9, max: 25 });
    expect(hssHoleSpeed(hss, 'Plastics', 'Tapping')).toBeNull();
  });

  it('boring feed: the diameter band, the last one open ("over 38")', () => {
    expect(boringFeed(boring, 32)).toEqual({ min: 0.28, max: 0.41 });
    expect(boringFeed(boring, 50)).toEqual({ min: 0.3, max: 0.41 });
    expect(boringFeed(boring, 2.7)).toEqual({ min: 0.05, max: 0.1 });
    expect(boringFeed(boring, 1)).toBeNull();
  });

  it('milling conditions per material', () => {
    expect(millingConditions(milling, 'ALUMINUM ALLOY CAST AND WROUGHT')).toEqual({ speed: { min: 300, max: 600 }, feedPerTooth: { min: 0.1, max: 0.2 } });
  });

  it('tool price and life from the workbook, with where the price came from', () => {
    expect(toolCost(tools, 'HSS extended twist drill')).toMatchObject({ PriceInr: 624.8, ToolLifeParts: 600 });
    expect(toolCost(tools, 'Knurling tool')!.PriceSource).toMatch(/no source/);
  });

  it('thermal cutting: the row at the thickness or the next thicker one, none past the table', () => {
    expect(thermalCutFeed(thermal, 'Plasma Cutting Machine', 3.5)).toMatchObject({ ThicknessMm: 4, FeedMmPerMin: 2400, KerfMm: 1.2 });
    expect(thermalCutFeed(thermal, 'Laser 2 Axis', 12)).toMatchObject({ FeedMmPerMin: 1600, KerfMm: 3 });
    expect(thermalCutFeed(thermal, 'Laser 2 Axis', 13)).toBeNull();
  });

  it('a range position picks inside the range: 0 the low end, 1 the high end, 0.5 the middle', () => {
    expect(valueInRange({ min: 120, max: 200 }, 0.5)).toBe(160);
    expect(valueInRange({ min: 120, max: 200 }, 0)).toBe(120);
    expect(valueInRange({ min: 120, max: 200 }, 2)).toBe(200);
  });
});
