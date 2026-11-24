/** Against the REAL local stack that local:load built: migrations ran, the data API answers with a token the backend signs, files round-trip. */
import * as fs from 'fs';
import { parseEnv } from 'util';

import { DbTokenMinter } from '../../src/common/db/db-token';
import { S3ObjectStore } from '../../src/common/storage/s3-object-store';

const env = parseEnv(fs.readFileSync(process.env.LOCAL_ENV_FILE as string, 'utf8'));
let failed = false;
async function check(name: string, run: () => Promise<void>): Promise<void> {
  try { await run(); console.log(`ok   ${name}`); } catch (e) { failed = true; console.log(`FAIL ${name}  ${e instanceof Error ? e.message : String(e)}`); }
}
const must = (c: boolean, m: string) => { if (!c) throw new Error(m); };

async function main(): Promise<void> {
  const minter = new DbTokenMinter(env.DB_JWT_SECRET as string);
  const api = async (path: string, token: string, init: RequestInit = {}) =>
    fetch(`${env.POSTGREST_URL}${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) } });

  await check('the data API answers a service-role token and shows the migrations that ran after the baseline', async () => {
    const res = await api('/schema_migrations?select=name&order=name', minter.forService());
    must(res.ok, `HTTP ${res.status}`);
    const names = ((await res.json()) as { name: string }[]).map((r) => r.name);
    must(names.some((n) => n.startsWith('918_')) && names.some((n) => n.startsWith('932_')), `got ${names.join(',')}`);
  });
  await check('migration 975 linked the injection calculator to its Plastic Molding row, and 978 gave the seeded plastic its cut code', async () => {
    const map = await (await api('/process_calculator_mappings?process_group=eq.Plastic%20Molding&operation=eq.Injection%20Molding&select=calculator_name,calculator_id', minter.forService())).json() as { calculator_name: string; calculator_id: string | null }[];
    must(map.length === 1 && map[0]!.calculator_name === 'Injection Molding - Cycle Time' && map[0]!.calculator_id !== null, `mapping ${JSON.stringify(map)}`);
    const mat = await (await api('/raw_materials?name=eq.Generic%20Nylon%2C%20Type%2011%2040%25%20Glass&select=cut_code', minter.forService())).json() as { cut_code: number | string | null }[];
    must(mat.length === 1 && Number(mat[0]!.cut_code) === 41.11, `material ${JSON.stringify(mat)}`);
  });
  await check('migration 984 restored the counterbore, countersink, PEM and tapping catalog rows, each bound to its calculator', async () => {
    const rows = await (await api('/process_calculator_mappings?machine_class=in.(drill_press,pem_press,tapping)&select=operation,calculator_id', minter.forService())).json() as { operation: string; calculator_id: string | null }[];
    // The five rows 984 restores. The class holds other calculator rows too (migration 1030 gives the Drill Press its own), so only these are counted.
    const restored = new Set(['Counterboring', 'Countersinking', 'PEM Insertion', 'Tapping']);
    const bound = rows.filter((r) => r.calculator_id !== null && restored.has(r.operation)).map((r) => r.operation).sort();
    must(JSON.stringify(bound) === JSON.stringify(['Counterboring', 'Countersinking', 'PEM Insertion', 'Tapping', 'Tapping']), `rows ${JSON.stringify(rows)}`);
  });
  await check('migration 981 gave the Black Oxide machine the labor rate its wage grade carries', async () => {
    const rows = await (await api('/mhr_records?machine_class=eq.surface_black_oxide&select=usd_labor_rate_per_hr,usd_lhr_total', minter.forService())).json() as { usd_labor_rate_per_hr: number | string | null; usd_lhr_total: number | string | null }[];
    must(rows.length === 1 && Number(rows[0]!.usd_labor_rate_per_hr) === 29.95 && Number(rows[0]!.usd_lhr_total) === 29.95, `rows ${JSON.stringify(rows)}`);
  });
  await check('migration 1094 added the Multi-Spindle Machining row with Machining\'s material groups, and 1095 bound it to the cycle calculator', async () => {
    const rows = await (await api('/process_calculator_mappings?process_group=eq.Multi-Spindle%20Machining&select=operation,calculator_name,is_active', minter.forService())).json() as { operation: string; calculator_name: string | null; is_active: boolean }[];
    must(rows.length === 1 && rows[0]!.operation === 'Simultaneous Turning' && rows[0]!.calculator_name === 'Multi-Spindle Machining - Cycle' && rows[0]!.is_active, `rows ${JSON.stringify(rows)}`);
    const groups = await (await api('/process_material_groups?process_group=eq.Multi-Spindle%20Machining&select=material_group&order=material_group', minter.forService())).json() as { material_group: string }[];
    must(JSON.stringify(groups.map((g) => g.material_group)) === JSON.stringify(['Ferrous & Non-Ferrous', 'Machining']), `groups ${JSON.stringify(groups)}`);
  });
  await check('migration 1099 gave the 9 Part Assembly rows their machine classes, and 1100 bound each one to its calculator', async () => {
    const rows = await (await api('/process_calculator_mappings?process_group=eq.Part%20Assembly&select=operation,machine_class,calculator_name,is_active&order=operation', minter.forService())).json() as { operation: string; machine_class: string | null; calculator_name: string | null; is_active: boolean }[];
    const bad = rows.filter((r) => !r.machine_class || !r.is_active || !r.calculator_name?.startsWith('Part Assembly - '));
    must(rows.length === 9 && bad.length === 0, `rows ${JSON.stringify(rows)}`);
  });
  await check('migration 1101 twinned the 16 Powder Metal machines in India at memory\'s crews, and 1102 linked the process to its powders', async () => {
    const rows = await (await api('/mhr_records?process_group=eq.Powder%20Metal&location=eq.India&select=machine_name,operators,usd_labor_rate_per_hr', minter.forService())).json() as { machine_name: string; operators: number | string; usd_labor_rate_per_hr: number | string }[];
    const press = rows.find((r) => r.machine_name === 'Gasbarre DSP - 100 ton');
    must(rows.length === 16 && Number(press?.operators) === 0.5 && rows.every((r) => Number(r.usd_labor_rate_per_hr) === 2.3), `rows ${JSON.stringify(rows)}`);
    const groups = await (await api('/process_material_groups?process_group=eq.Powder%20Metal&select=material_group', minter.forService())).json() as { material_group: string }[];
    must(JSON.stringify(groups) === JSON.stringify([{ material_group: 'Powder Metal' }]), `groups ${JSON.stringify(groups)}`);
  });
  await check('migrations 1103 and 1106 twinned every Rapid Prototyping and Roto & Blow Molding machine in India, and 1105 and 1108 bound their calculators', async () => {
    for (const group of ['Rapid Prototyping', 'Roto & Blow Molding']) {
      const q = encodeURIComponent(group);
      const machines = await (await api(`/mhr_records?process_group=eq.${q}&select=location`, minter.forService())).json() as { location: string }[];
      const usa = machines.filter((m) => m.location === 'USA').length;
      must(usa > 0 && machines.filter((m) => m.location === 'India').length === usa, `${group} machines ${JSON.stringify(machines)}`);
      const rows = await (await api(`/process_calculator_mappings?process_group=eq.${q}&select=operation,calculator_name`, minter.forService())).json() as { operation: string; calculator_name: string | null }[];
      must(rows.length === 5 && rows.every((r) => r.calculator_name?.startsWith(`${group} - `)), `${group} catalog ${JSON.stringify(rows)}`);
    }
  });
  await check('migration 1109 rated the hydroform presses (Netherlands overheads, 36.30 labour, forming time) and twinned all 56 Hydroforming machines in India', async () => {
    const q = encodeURIComponent('Sheet Metal - Hydroforming');
    const rows = await (await api(`/mhr_records?process_group=eq.${q}&select=location,machine_class,machine_name,mhr_usd_per_hour,usd_labor_rate_per_hr,specs`, minter.forService())).json() as
      { location: string; machine_class: string; machine_name: string; mhr_usd_per_hour: number | string | null; usd_labor_rate_per_hr: number | string | null; specs: Record<string, unknown> | null }[];
    const press = (location: string) => rows.find((r) => r.location === location && r.machine_name === 'Hydroform Press - Deep Draw - 456 Dia');
    must(rows.filter((r) => r.location === 'India').length === 56, `India rows ${rows.filter((r) => r.location === 'India').length}`);
    must(Number(press('USA')?.mhr_usd_per_hour) === 87.9 && Number(press('USA')?.usd_labor_rate_per_hr) === 36.3 && Number(press('USA')?.specs?.machine_forming_cycle_time_s) === 45,
      `USA press ${JSON.stringify(press('USA'))}`);
    must(Number(press('India')?.mhr_usd_per_hour) === 54.02 && Number(press('India')?.usd_labor_rate_per_hr) === 1.73, `India press ${JSON.stringify(press('India'))}`);
  });
  await check('migration 1112 rated the Roll Forming machines (Netherlands overheads, 43.21 / 36.30 labour), twinned all 125 in India and linked its material group', async () => {
    const q = encodeURIComponent('Sheet Metal Roll Forming');
    const rows = await (await api(`/mhr_records?process_group=eq.${q}&select=location,machine_name,mhr_usd_per_hour,usd_labor_rate_per_hr`, minter.forService())).json() as
      { location: string; machine_name: string; mhr_usd_per_hour: number | string | null; usd_labor_rate_per_hr: number | string | null }[];
    const mill = (location: string) => rows.find((r) => r.location === location && r.machine_name === 'Bradbury 2.5" Shaft Diameter 12 stand');
    must(rows.filter((r) => r.location === 'India').length === 125, `India rows ${rows.filter((r) => r.location === 'India').length}`);
    must(Number(mill('USA')?.mhr_usd_per_hour) === 40.01 && Number(mill('USA')?.usd_labor_rate_per_hr) === 43.21, `USA mill ${JSON.stringify(mill('USA'))}`);
    must(Number(mill('India')?.mhr_usd_per_hour) === 19.23 && Number(mill('India')?.usd_labor_rate_per_hr) === 2.3, `India mill ${JSON.stringify(mill('India'))}`);
    const groups = await (await api(`/process_material_groups?process_group=eq.${q}&select=material_group`, minter.forService())).json() as { material_group: string }[];
    must(groups.length === 1 && groups[0]?.material_group === 'Sheet Metal Roll Forming', `material groups ${JSON.stringify(groups)}`);
  });
  await check('migration 1110 bound the Hydroform and Offline Blank catalog rows to their hydroforming calculators', async () => {
    const q = encodeURIComponent('Sheet Metal - Hydroforming');
    const rows = await (await api(`/process_calculator_mappings?process_group=eq.${q}&select=operation,calculator_name&order=operation`, minter.forService())).json() as { operation: string; calculator_name: string | null }[];
    must(JSON.stringify(rows.map((r) => [r.operation, r.calculator_name])) === JSON.stringify([['Hydroform', 'Hydroforming - Hydroform'], ['Offline Blank', 'Hydroforming - Offline blank']]),
      `rows ${JSON.stringify(rows)}`);
  });
  await check('migration 1113 bound the ten Sheet Metal Roll Forming catalog rows to their roll forming calculators', async () => {
    const q = encodeURIComponent('Sheet Metal Roll Forming');
    const rows = await (await api(`/process_calculator_mappings?process_group=eq.${q}&select=operation,calculator_name&order=operation`, minter.forService())).json() as { operation: string; calculator_name: string | null }[];
    const welding = (o: string) => o.startsWith('Integrated ');
    must(rows.length === 10 && rows.every((r) => r.calculator_name === (welding(r.operation) ? 'Roll Forming - Integrated Welding' : `Roll Forming - ${r.operation}`)),
      `rows ${JSON.stringify(rows)}`);
  });
  await check("migration 1114 staged the rest of Stock Machining's reference data, added its Material Stock machine in USA and India and classed its catalog rows", async () => {
    const q = encodeURIComponent('Stock Machining');
    const staged = await (await api('/machining_reference_data?source_version=eq.2026-Stock-Machining&select=category,key,value&order=category,key', minter.forService())).json() as
      { category: string; key: string; value: string | null }[];
    const tables = Object.fromEntries(staged.filter((r) => r.category === 'lookup_table').map((r) => [r.key, Number(r.value)]));
    must(tables.tblPreferredSizes === 814 && tables.tblPartingRingWidth === 3 && tables.tblPartSpacing === 199 && tables.validationDisplayControls === 11, `lookup tables ${JSON.stringify(tables)}`);
    must(staged.filter((r) => r.category === 'process').length === 3 && staged.filter((r) => r.category === 'operation').length === 3, `staged ${staged.length} rows`);
    const stock = await (await api(`/mhr_records?process_group=eq.${q}&machine_class=eq.stock_machining_material_stock&select=location,machine_name,mhr_usd_per_hour,wage_grade,specs&order=location`, minter.forService())).json() as
      { location: string; machine_name: string; mhr_usd_per_hour: number | string | null; wage_grade: string | null; specs: { standard_stock_length_mm?: number } | null }[];
    must(JSON.stringify(stock.map((r) => r.location)) === JSON.stringify(['India', 'USA']), `Material Stock rows ${JSON.stringify(stock)}`);
    must(stock.every((r) => r.machine_name === 'Default Material Stock' && Number(r.mhr_usd_per_hour) === 0 && r.wage_grade === '0 - Metal' && r.specs?.standard_stock_length_mm === 6096),
      `Material Stock ${JSON.stringify(stock)}`);
    const rows = await (await api(`/process_taxonomy?process_group=eq.${q}&select=process_name,machine_class&order=process_name`, minter.forService())).json() as { process_name: string; machine_class: string | null }[];
    must(JSON.stringify(rows.map((r) => [r.process_name, r.machine_class])) === JSON.stringify([['Band Saw', 'band_saw'], ['Material Stock', 'stock_machining_material_stock'], ['User-Defined Process', null]]),
      `catalog rows ${JSON.stringify(rows)}`);
  });
  await check('migration 1115 classed the two Stock Machining catalog mappings, and 1116 bound each to its calculator and made it active', async () => {
    const q = encodeURIComponent('Stock Machining');
    const rows = await (await api(`/process_calculator_mappings?process_group=eq.${q}&select=operation,machine_class,calculator_name,is_active&order=operation`, minter.forService())).json() as
      { operation: string; machine_class: string | null; calculator_name: string | null; is_active: boolean }[];
    must(JSON.stringify(rows.map((r) => [r.operation, r.machine_class, r.calculator_name, r.is_active])) === JSON.stringify([
      ['Band Saw', 'band_saw', 'Stock Machining - Band Saw', true], ['Material Stock', 'stock_machining_material_stock', 'Stock Machining - Material Stock', true]]),
      `rows ${JSON.stringify(rows)}`);
  });
  await check('the carried user directory is readable through migration 932 (same id as the source)', async () => {
    const res = await api('/rpc/directory_find_by_email', minter.forService(), { method: 'POST', body: JSON.stringify({ p_email: 'Alice@Example.com' }) });
    must(res.ok && (await res.json()) === '11111111-1111-4111-8111-111111111111', `HTTP ${res.status}`);
  });
  await check('a signed-in user token is subject to row-level security (Alice sees her project, Bob does not)', async () => {
    const alice = await (await api('/projects?select=name', minter.forUser('11111111-1111-4111-8111-111111111111'))).json() as { name: string }[];
    const bob = await (await api('/projects?select=name', minter.forUser('22222222-2222-4222-8222-222222222222'))).json() as { name: string }[];
    must(alice.length === 1 && bob.length === 0, `alice ${alice.length}, bob ${bob.length}`);
  });
  // The PCB catalog's assembly processes (migration 1133).
  const PCB_ASSEMBLY = ['Stencil Print', 'Solder Paste Inspection', 'Pick and Place', 'Reflow Solder', 'Assembly AOI', 'Wave Solder', 'Selective Solder', 'In-Circuit Test',
    'Assembly Flying Probe', 'Depanel Router', 'THT Insertion', 'Hand Solder'];
  await check('migration 1129 twinned the 98 PCB fabrication machines in India at the 3 - Metal / 4 - Metal India labour, and 1130 staged the sourced PCB reference', async () => {
    // The fabrication machines (migration 1133 adds the assembly ones, classes pcba_*, beside them).
    const india = (await (await api('/mhr_records?process_group=eq.PCB&location=eq.India&select=machine_class,machine_name,usd_labor_rate_per_hr', minter.forService())).json() as
      { machine_class: string; machine_name: string; usd_labor_rate_per_hr: number | string | null }[]).filter((r) => !r.machine_class.startsWith('pcba_'));
    must(india.length === 98, `India PCB rows ${india.length}`);
    must(india.every((r) => [0, 1.73, 2.3].includes(Number(r.usd_labor_rate_per_hr))), `India labour ${JSON.stringify([...new Set(india.map((r) => r.usd_labor_rate_per_hr))])}`);
    must(india.some((r) => r.machine_class === 'cure_plugged_vias' && r.machine_name === 'Tampprinter PCB Drying Oven'), 'the dryer is twinned under its USA name');
    const staged = await (await api('/machining_reference_data?source_version=eq.2026-PCB&category=eq.lookup_table&select=key,value&order=key', minter.forService())).json() as { key: string; value: string | null }[];
    const tables = Object.fromEntries(staged.map((r) => [r.key, Number(r.value)]));
    must(tables.consumables > 0 && tables.process_times > 0 && tables.yield > 0, `staged ${JSON.stringify(tables)}`);
  });
  await check('migration 1132 linked the PCB calculators to every PCB catalog row but Material Stock and made each active', async () => {
    const rows = await (await api('/process_calculator_mappings?process_group=eq.PCB&select=operation,calculator_name,is_active&order=operation', minter.forService())).json() as
      { operation: string; calculator_name: string | null; is_active: boolean }[];
    const linked = rows.filter((r) => r.operation !== 'Material Stock' && !PCB_ASSEMBLY.includes(r.operation));
    must(linked.length === 31 && linked.every((r) => r.calculator_name === `PCB - ${r.operation}` && r.is_active), `rows ${JSON.stringify(rows.filter((r) => !r.is_active || !r.calculator_name))}`);
  });
  await check('migration 1133 seeded the 24 PCB assembly machines in USA and India, staged the assembly reference and added 12 catalog processes, and 1134 bound each', async () => {
    const machines = await (await api('/mhr_records?process_group=eq.PCB&machine_class=like.pcba_*&select=location,machine_class,mhr_usd_per_hour,usd_labor_rate_per_hr', minter.forService())).json() as
      { location: string; machine_class: string; mhr_usd_per_hour: number | string | null; usd_labor_rate_per_hr: number | string | null }[];
    const at = (loc: string) => machines.filter((m) => m.location === loc);
    must(at('USA').length === 24 && at('India').length === 24, `USA ${at('USA').length}, India ${at('India').length}`);
    must(machines.every((m) => Number(m.mhr_usd_per_hour) > 0), 'every assembly machine has its machine hour rate');
    must(at('India').every((m) => [1.73, 2.3].includes(Number(m.usd_labor_rate_per_hr))), `India labour ${JSON.stringify([...new Set(at('India').map((m) => m.usd_labor_rate_per_hr))])}`);
    const staged = await (await api('/machining_reference_data?source_version=eq.2026-PCB&category=eq.lookup_table&key=in.(assembly_rates,assembly_costs)&select=key,value', minter.forService())).json() as { key: string; value: string | null }[];
    must(staged.length === 2 && staged.every((r) => Number(r.value) > 0), `staged ${JSON.stringify(staged)}`);
    const rows = await (await api('/process_calculator_mappings?process_group=eq.PCB&select=operation,calculator_name,machine_class,is_active', minter.forService())).json() as
      { operation: string; calculator_name: string | null; machine_class: string | null; is_active: boolean }[];
    const assembly = rows.filter((r) => PCB_ASSEMBLY.includes(r.operation));
    must(assembly.length === 12 && assembly.every((r) => r.calculator_name === `PCB - ${r.operation}` && r.machine_class && r.is_active), `rows ${JSON.stringify(assembly.filter((r) => !r.is_active || !r.calculator_name))}`);
  });
  await check("migration 1121 lets a signed-in user read the consumable prices (a waterjet's garnet), and not write them", async () => {
    const bob = minter.forUser('22222222-2222-4222-8222-222222222222');
    const rows = await (await api('/consumable_prices?consumable_type=eq.garnet_abrasive&select=location,price_per_unit', bob)).json() as { location: string; price_per_unit: number | string }[];
    must(rows.length === 2 && Number(rows.find((r) => r.location === 'India')?.price_per_unit) === 0.48, `rows ${JSON.stringify(rows)}`);
    const write = await api('/consumable_prices', bob, { method: 'POST', body: JSON.stringify({ consumable_type: 'garnet_abrasive', location: 'X', price_per_unit: 1 }) });
    must(write.status === 401 || write.status === 403, `a user's write answered HTTP ${write.status}`);
  });
  await check('migration 1123 stated the two material prices entered in rupees and yuan in USD per kg, at the INR budget rate', async () => {
    const rows = await (await api('/raw_materials?name=in.(304,%22Generic%20Aluminum%2C%20ANSI%206101%22)&select=name,cost,cost_usa,cost_india,cost_china&order=name', minter.forService())).json() as Record<string, number | string | null>[];
    const n = (v: number | string | null | undefined) => (v == null ? null : Number(v));
    const [ss304, al6101] = rows;
    must(rows.length === 2 && n(ss304?.cost_india) === 2.0228 && n(ss304?.cost) === 3.4 && n(al6101?.cost_india) === 3.1513 && n(al6101?.cost_china) === 2.7, `rows ${JSON.stringify(rows)}`);
  });
  await check('the data API refuses an anonymous request to a protected function', async () => {
    const res = await fetch(`${env.POSTGREST_URL}/rpc/link_identity`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ p_provider: 'auth0', p_sub: 'x', p_email: 'alice@example.com', p_email_verified: true, p_connection: 'company-sso', p_trusted_connections: ['company-sso'] }) });
    must(res.status === 401 || res.status === 403 || res.status === 404, `HTTP ${res.status}`);
  });
  await check('files round-trip through the local bucket the script created', async () => {
    const store = new S3ObjectStore({ bucket: env.S3_BUCKET as string, region: env.S3_REGION as string, endpoint: env.S3_ENDPOINT as string, accessKeyId: env.S3_ACCESS_KEY_ID as string, secretAccessKey: env.S3_SECRET_ACCESS_KEY as string, forcePathStyle: true });
    await store.put('bom-files', 'smoke/a.step', Buffer.from([1, 2, 3, 255]), { upsert: true });
    must(Buffer.compare((await store.get('bom-files', 'smoke/a.step')) as Buffer, Buffer.from([1, 2, 3, 255])) === 0, 'bytes differ');
    await store.remove('bom-files', ['smoke/a.step']);
  });
  process.exit(failed ? 1 : 0);
}
void main();
