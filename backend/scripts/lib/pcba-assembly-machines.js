/**
 * The PCB assembly machines as migration 1133 seeds them (scripts/generate-pcba-assembly-migration.js has the why): memory/PCBA/Assembly's
 * new, priced SMT line, through-hole and test machines, each at the USA and India rates the reference's own overhead rule gives its price,
 * power and floor area, with the crew, setup and wage grade of the reference's analogous fabrication machine. Shared by the generator and the
 * PCB tests, so the engine is tested on exactly the machines the migration writes.
 */
const { readdirSync } = require('fs');
const { join } = require('path');
const { readCsv } = require('../../migrations/scripts/lib/memory-machine-seed.js');

const ASSEMBLY = 'PCBA/Assembly';

function pcbaAssemblyMachines(MEMORY) {
  // The assembly processes of the PCB catalog: machine class, the research's machine type, and the fabrication process whose machine is the analog.
  const PROCESSES = [
    { process: 'Stencil Print', line: true, cls: 'pcba_stencil_printer', type: 'printer', analog: 'Screen Printing', file: 'screen_printing_machines.csv' },
    { process: 'Solder Paste Inspection', line: true, cls: 'pcba_solder_paste_inspection', type: 'spi', analog: 'Automated Vision Inspection', file: 'avi_machines.csv' },
    { process: 'Pick and Place', line: true, cls: 'pcba_pick_and_place', type: 'placer', analog: 'Drill Circuit Holes', file: 'drilling_machines.csv' },
    { process: 'Reflow Solder', line: true, cls: 'pcba_reflow', type: 'reflow', analog: 'Silkscreen Cure', file: 'silkscreen_cure_machines.csv' },
    { process: 'Assembly AOI', line: true, cls: 'pcba_aoi', type: 'aoi', analog: 'Automated Optical Inspection', file: 'aoi_machines.csv' },
    { process: 'Wave Solder', cls: 'pcba_wave_solder', type: 'wave_solder', analog: 'Hot Air Solder Leveling', file: 'hasl_machines.csv' },
    { process: 'Selective Solder', cls: 'pcba_selective_solder', type: 'selective_solder', analog: 'Hot Air Solder Leveling', file: 'hasl_machines.csv' },
    { process: 'In-Circuit Test', cls: 'pcba_in_circuit_test', type: 'tester:ict', analog: 'Bed of Nails', file: 'bed_of_nails_machines.csv' },
    { process: 'Assembly Flying Probe', cls: 'pcba_flying_probe', type: 'tester:flying_probe_assembly', analog: 'Flying Probe', file: 'flying_probe_machines.csv' },
    { process: 'Depanel Router', cls: 'pcba_depanel_router', type: 'depaneler', analog: 'Router', file: 'router_machines.csv' },
  ];
  // Bench work (insertion, hand soldering) runs on the PCB benches HR Rates already holds (pcb_bench_operation, migrations 797 and 1129).
  const BENCH = [
    { process: 'THT Insertion', cls: 'pcb_bench_operation' },
    { process: 'Hand Solder', cls: 'pcb_bench_operation' },
  ];
  // India labour by wage grade (USD/hr), as migration 1129: the rates the India rows of each grade carry in HR Rates.
  const INDIA_LABOUR = { '3 - Metal': 1.73, '4 - Metal': 2.3 };
  // The reference's machine economics: every SMT machine takes them, as the fitted rule assumes.
  const ECONOMICS = { 'Machine Life (yr)': 10, 'Machine Uptime (%)': 80, 'Installation Factor (%)': 20, 'Annual Maintenance Factor (%)': 5, 'Footprint Allowance Factor': 1 };

  const num = (v) => { const n = Number(String(v ?? '').replace(/[$,\s]/g, '')); return String(v ?? '').trim() === '' || !Number.isFinite(n) ? null : n; };
  const r2 = (n) => Math.round(n * 100) / 100;
  const q = (s) => `$str$${s}$str$`;

  // ── The reference's overhead rule, fitted per country ──────────────────────────────────────────────────────────────────────────────────
  /** Least squares of y on [x..., 1] (normal equations, Gaussian elimination). */
  function fit(xs, ys) {
    const k = xs[0].length + 1;
    const a = Array.from({ length: k }, () => Array(k + 1).fill(0));
    xs.forEach((x, i) => {
      const row = [...x, 1];
      for (let r = 0; r < k; r++) { for (let c = 0; c < k; c++) a[r][c] += row[r] * row[c]; a[r][k] += row[r] * ys[i]; }
    });
    for (let c = 0; c < k; c++) {
      const p = a.reduce((best, row, r) => (r >= c && Math.abs(row[c]) > Math.abs(a[best][c]) ? r : best), c);
      [a[c], a[p]] = [a[p], a[c]];
      for (let r = 0; r < k; r++) if (r !== c && a[c][c] !== 0) { const f = a[r][c] / a[c][c]; for (let j = c; j <= k; j++) a[r][j] -= f * a[c][j]; }
    }
    return a.map((row, i) => (row[i] === 0 ? 0 : row[k] / row[i]));
  }
  const apply = (coef, x) => [...x, 1].reduce((s, v, i) => s + v * coef[i], 0);

  function overheadRule(label, machines) {
    const direct = fit(machines.map((m) => [m.price, m.kw]), machines.map((m) => m.direct));
    const indirect = fit(machines.map((m) => [m.area]), machines.map((m) => m.indirect));
    const worst = Math.max(...machines.map((m) => Math.max(Math.abs(apply(direct, [m.price, m.kw]) - m.direct), Math.abs(apply(indirect, [m.area]) - m.indirect))));
    if (worst > 0.01) throw new Error(`${label}: the overhead rule does not reproduce the reference's PCB machines (worst ${worst.toFixed(4)} USD/hr)`);
    return { label, direct, indirect, n: machines.length, worst };
  }
  const usaFab = [];
  for (const f of readdirSync(join(MEMORY, 'PCBA/Machine'))) {
    for (const m of readCsv(join(MEMORY, 'PCBA/Machine', f)).rows) {
      if (num(m['Installation Factor (%)']) !== 20 || num(m['Machine Uptime (%)']) !== 80 || num(m['Machine Life (yr)']) !== 10 || num(m['Annual Maintenance Factor (%)']) !== 5) continue;
      const price = num(m['Machine Price (USD)']);
      const direct = num(m['Direct Overhead Rate (USD / hr)']);
      const indirect = num(m['Indirect Overhead Rate (USD / hr)']);
      if (price == null || direct == null || indirect == null) continue;
      usaFab.push({ price, kw: num(m['Machine Power (kW)']) ?? 0, area: ((num(m['Machine Length (mm)']) ?? 0) * (num(m['Machine Width (mm)']) ?? 0) / 1e6) * (num(m['Footprint Allowance Factor']) ?? 1), direct, indirect });
    }
  }
  const indiaFab = readCsv(join(MEMORY, 'Countries data/India_XML_Data_.csv')).rows
    .filter((m) => m['Commodity'] === 'PCB' && num(m['installationFactor']) === 0.2 && num(m['machineUptime']) === 0.8 && num(m['machineLife']) === 10 && num(m['annualMaintenanceFactor']) === 0.05)
    .map((m) => ({
      price: num(m['machinePrice']), kw: num(m['machinePower']) ?? 0,
      area: ((num(m['machineLength']) ?? 0) * (num(m['machineWidth']) ?? 0) / 1e6) * (num(m['footprintAllowanceFactor']) ?? 1),
      direct: num(m['customWorkCenterDirectOverheadRate']), indirect: num(m['customWorkCenterIndirectOverheadRate']),
    }))
    .filter((m) => m.price != null && m.direct != null && m.indirect != null);
  const RULE = { USA: overheadRule('USA (memory/PCBA/Machine)', usaFab), India: overheadRule('India (India_XML_Data_.csv, PCB)', indiaFab) };
  const sayRule = (r) => `direct = ${r.direct[0].toExponential(4)} x price + ${r.direct[1].toFixed(4)} x kW + ${r.direct[2].toFixed(4)}; indirect = ${r.indirect[0].toFixed(5)} x m² + ${r.indirect[1].toFixed(4)}`;

  // ── The analogs' crew, setup and labour ────────────────────────────────────────────────────────────────────────────────────────────────
  const grades = Object.fromEntries(readCsv(join(MEMORY, 'PCBA/wage_grade_associations (4).csv')).rows.map((g) => [g['Process Name'], g['Wage Grade Name']]));
  for (const p of PROCESSES) {
    const rows = readCsv(join(MEMORY, 'PCBA/Machine', p.file)).rows;
    if (!rows.length) throw new Error(`${p.file}: no machine`);
    p.operators = Math.min(...rows.map((r) => num(r['Number of Operators']) ?? 0));
    // An SMT line machine has no setup of its own: the line's changeover, priced once per populated side (the SMT line changeover line), is it.
    p.setup = p.line ? 0 : num(rows[0]['Setup Time (hr)']) ?? 0;
    p.usaLabour = num(rows[0]['Labor Rate (USD / hr)']);
    p.grade = grades[p.analog];
    if (!p.grade || INDIA_LABOUR[p.grade] == null || p.usaLabour == null) throw new Error(`${p.process}: no wage grade or labour for its analog ${p.analog}`);
  }

  // ── The machines ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  const placement = readCsv(join(MEMORY, ASSEMBLY, 'smt_placement_rates.csv')).rows;
  const ovens = readCsv(join(MEMORY, ASSEMBLY, 'reflow_ovens.csv')).rows;
  const ipcOfMax = readCsv(join(MEMORY, ASSEMBLY, 'assembly_rates.csv')).rows.find((r) => r.item_key === 'placement_ipc_pct_of_max');
  if (!ipcOfMax) throw new Error('assembly_rates.csv: no placement_ipc_pct_of_max row');
  const baseName = (n) => n.replace(/\s*\(listing price (low|high)\)$/, '').trim();
  const typeOf = (m) => (m.machine_type === 'tester' ? `tester:${(/Requested type: ([a-z_]+)/.exec(m.source_note) ?? [])[1]}` : m.machine_type);
  const isUsed = (m) => /(^|\. )used listing/i.test(m.source_note);
  const skipped = { used: [], unpriced: [], other: [] };
  const groups = new Map();
  for (const m of readCsv(join(MEMORY, ASSEMBLY, 'smt_machines.csv')).rows) {
    const p = PROCESSES.find((x) => x.type === typeOf(m));
    if (!p) { skipped.other.push(m.machine_name); continue; }
    if (isUsed(m)) { skipped.used.push(m.machine_name); continue; }
    if (num(m.machine_price_usd) == null) { skipped.unpriced.push(m.machine_name); continue; }
    const key = `${p.cls}|${baseName(m.machine_name)}`;
    if (!groups.has(key)) groups.set(key, { p, name: baseName(m.machine_name), rows: [] });
    groups.get(key).rows.push(m);
  }
  const machines = [...groups.values()].map(({ p, name, rows }) => {
    const prices = rows.map((r) => num(r.machine_price_usd));
    const price = (Math.min(...prices) + Math.max(...prices)) / 2;
    const first = rows[0];
    const kw = num(first.machine_power_kw) ?? 0;
    const length = num(first.machine_length_mm);
    const width = num(first.machine_width_mm);
    const area = length && width ? (length * width) / 1e6 : 0;
    const specs = {
      manufacturer: first.manufacturer || null, source_url: first.source_url, source_date: first.source_date, source_note: first.source_note,
      price_basis: prices.length > 1 ? `midpoint of the listing range ${Math.min(...prices)}-${Math.max(...prices)} USD` : 'the listed price',
      ...(kw ? {} : { power_note: 'no power stated: no energy in its direct overhead' }),
      ...(area ? {} : { footprint_note: 'no size stated: no floor area in its indirect overhead' }),
    };
    if (p.type === 'placer') {
      const rate = placement.find((r) => baseName(r.machine_name) === name);
      if (!rate) throw new Error(`${name}: no row in smt_placement_rates.csv`);
      const stated = /IPC9850 ([\d,]+) CPH/.exec(rate.conditions);
      specs.rated_cph = num(rate.rated_cph);
      specs.ipc_cph = stated ? num(stated[1]) : r2(num(rate.rated_cph) * num(ipcOfMax.value_min) / 100);
      specs.ipc_basis = stated ? 'the IPC-9850 rate the maker states' : `${ipcOfMax.value_min} % of the rated speed (IPC speed is 60 % of maximum: ${ipcOfMax.source_url})`;
      specs.placement_class = rate.package_class;
    }
    if (p.type === 'reflow') {
      const oven = ovens.find((o) => baseName(o.machine_name) === name);
      if (oven) {
        specs.conveyor_speed_min_mm_per_min = num(oven.conveyor_speed_min_mm_per_min);
        specs.conveyor_speed_max_mm_per_min = num(oven.conveyor_speed_max_mm_per_min);
        specs.max_board_width_mm = num(oven.max_board_width_mm);
        specs.zones = num(oven.zones);
      }
    }
    const rate = (loc) => ({ direct: r2(apply(RULE[loc].direct, [price, kw])), indirect: r2(apply(RULE[loc].indirect, [area])) });
    return { p, name, price, kw, length, width, specs, usa: rate('USA'), india: rate('India') };
  }).sort((a, b) => (a.p.cls + a.name).localeCompare(b.p.cls + b.name));
  for (const p of PROCESSES) if (!machines.some((m) => m.p === p)) throw new Error(`${p.process}: no priced new machine`);

  return { PROCESSES, BENCH, INDIA_LABOUR, ECONOMICS, RULE, machines, skipped, sayRule, r2 };
}

module.exports = { pcbaAssemblyMachines, ASSEMBLY };
