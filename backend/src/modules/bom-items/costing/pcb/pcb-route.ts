// A printed circuit board's fabrication routes, priced on the staged memory/PCBA data (migrations 823, 1129, 1130) and the PCB calculators
// (pcb-calculators.json). Pure.
//
// The board (pcb-part.ts) is built up (pcb-stackup.ts), nested on the working panel (pcb-panel.ts) and taken through the reference's process
// chain: inner-layer imaging per core, lay-up and lamination, registration and circuit drilling (laser for microvias), desmear and through-hole
// plating, outer-layer imaging, pattern plating and etch, solder mask, legend, the surface finish, the profile and the electrical test, and a
// final vision inspection. Each step runs on the cheapest capable machine of the location (selectAndCost).
//
// The routes are the reference's real alternatives, priced each, the cheapest complete one quoted: the profile (Router or Stamp: a die is
// tooling) x the electrical test (Flying Probe, up to maxFlyingProbeProductionVolume a year, or Bed of Nails: a fixture is tooling). The
// surface finish is the board's specification (HASL, ENIG, OSP), never switched to a cheaper one; the other two are priced beside it.
import type { ProcessLineCost } from '../../dto/cost-breakdown.dto';
import type { DomainCalculatorSpec } from '../shared/calculators/domain-calculator-spec';
import { runOnLine, runReferenceCalculator, type CalcSeed, type ReferenceCalcRun, type ReferenceCalculatorDef } from '../shared/calculators/reference-calculator';
import type { CostContext } from '../casting/casting-finishing';
import { machineValue, type SandMachine } from '../casting/sand/sand-machines';
import type { SandReference } from '../casting/sand/sand-reference';
import { seedsFor, type SeedProvider, type SeedProviders } from '../casting/sand/sand-seeds';
import { selectAndCost, type CostedStep, type StepOutcome } from '../casting/sand/sand-steps';
import { nestPcb, type PcbNest } from './pcb-panel';
import { holeTotals, PCB_FINISH_LABEL, type PcbFinish, type PcbPart } from './pcb-part';
import { consumable, consumableForDiameter, fabYield, micronsOfPlating, processTime, saySourced, type SourcedValue } from './pcb-reference';
import { pcbStackup, prepregPlies, type PcbStackup } from './pcb-stackup';

export const PCB_DOMAIN = 'pcb';
export const PCB_PROCESS_GROUP = 'PCB';

/** The HR Rates machine class of each PCB process (migration 797; its India twins migration 1129). */
export const PCB_CLASS = {
  surfacePrep: 'surface_preparation', resist: 'apply_photo_resist', litho: 'photolithography', des: 'pcb_des', aoi: 'automated_optical_inspection',
  bench: 'pcb_bench_operation', laminate: 'oven_cure_layers', regDrill: 'drill_registration_holes', drill: 'drill_circuit_holes', laser: 'laser_drill_vias',
  pth: 'desmear_and_plate_through_holes', dissolve: 'dissolve_unexposed_photo_resist', plate: 'copper_plate_and_tin_coat', ses: 'pcb_ses',
  plug: 'plug_vias', plugCure: 'cure_plugged_vias', mask: 'wet_film_solder_mask', tackDry: 'tack_dry_solder_mask', film: 'film_imaging',
  develop: 'develop_solder_mask', maskCure: 'cure_solder_mask', legend: 'screen_printing', legendCure: 'silkscreen_cure',
  hasl: 'hot_air_solder_leveling', enig: 'electroless_nickel_immersion_gold', osp: 'organic_solderability_preservative',
  router: 'pcb_router', stamp: 'pcb_stamp', flyingProbe: 'flying_probe', bedOfNails: 'bed_of_nails', avi: 'automated_vision_inspection',
} as const;
export const PCB_ROUTE_CLASSES: readonly string[] = Object.values(PCB_CLASS);

const FINISH_CLASS: Readonly<Record<PcbFinish, string>> = { hasl: PCB_CLASS.hasl, enig: PCB_CLASS.enig, osp: PCB_CLASS.osp };

export type PcbProfile = 'router' | 'stamp';
export type PcbTest = 'flying_probe' | 'bed_of_nails';
export type PcbRouteKey = `${PcbProfile}_${PcbTest}`;
export const PCB_ROUTES: readonly { key: PcbRouteKey; label: string; profile: PcbProfile; test: PcbTest }[] = [
  { key: 'router_flying_probe', label: 'Routed, flying probe test', profile: 'router', test: 'flying_probe' },
  { key: 'router_bed_of_nails', label: 'Routed, bed of nails test', profile: 'router', test: 'bed_of_nails' },
  { key: 'stamp_flying_probe', label: 'Stamped, flying probe test', profile: 'stamp', test: 'flying_probe' },
  { key: 'stamp_bed_of_nails', label: 'Stamped, bed of nails test', profile: 'stamp', test: 'bed_of_nails' },
];

export const PCB_CALC = (process: string) => `PCB - ${process}`;
export const PCB_HELPER = {
  material: PCB_CALC('Board material'), core: PCB_CALC('Core price'), drilling: PCB_CALC('Drilling consumables'), mask: PCB_CALC('Solder mask material'),
  metal: PCB_CALC('Plating metal'), fixture: PCB_CALC('Bed of nails fixture'), yield: PCB_CALC('Fabrication yield'),
} as const;

const r2 = (n: number) => Math.round(n * 100) / 100;
const r4 = (n: number) => Math.round(n * 10000) / 10000;
const fail = (...reasons: string[]): StepOutcome => ({ ok: false, reasons });
const isGap = (l: ProcessLineCost) => l.physicsGap != null;

/** A laminate the reference prices (memory/PCBA/raw_materials.csv via raw_materials): a core or a copper foil, per square metre. */
export interface PcbLaminate {
  id: string;
  name: string;
  kind: 'double_core' | 'single_core' | 'foil' | 'panel';
  copperOz: number | null;
  usdPerM2: number | null;
  dielectricMm: number | null;
}

export interface PcbScenario {
  batchSize: number;
  annualVolume: number | null;
  /** Parts the tooling (die, fixture, test program) is spread over; null when the scenario gives none. */
  amortizationParts: number | null;
  route: PcbRouteKey | null;
}

export interface PcbRouteInput {
  ref: SandReference;
  spec: DomainCalculatorSpec;
  calculators: Readonly<Record<string, ReferenceCalculatorDef>>;
  part: PcbPart;
  laminates: readonly PcbLaminate[];
  machinesByClass: Readonly<Record<string, readonly SandMachine[]>>;
  scenario: PcbScenario;
  costContext: CostContext;
}

/** A tool the route needs (a stamping die, a test fixture, a test program): an investment kept out of the piece cost, spread over the job. */
export interface PcbTool { key: string; description: string; detail: string; costUsd: number | null; perPartUsd: number | null; /** The boards it is spread over (annual volume x production life); null with no volume. */ amortizationParts: number | null }

export interface PcbMaterialUse { name: string; usdPerM2: number; count: number; detail: string }

export interface PcbRoute {
  key: PcbRouteKey;
  label: string;
  profile: PcbProfile;
  test: PcbTest;
  lines: ProcessLineCost[];
  /** The laminate the board takes. Its cost is the route's Material Stock line (the reference's Material Stock: Layer Material), so Apply writes it with the process lines; costUsd repeats it for the breakdown. */
  material: { costUsd: number; run: ReferenceCalcRun | null; uses: PcbMaterialUse[] };
  tooling: PcbTool[];
  totalUsd: number | null;
  complete: boolean;
  warnings: string[];
}

export interface PcbRouteGap { key: PcbRouteKey; label: string; reason: string }

/** The other two finishes, priced beside the specified one (never quoted in its place). */
export interface PcbFinishOption { finish: PcbFinish; label: string; totalUsd: number | null; reason: string | null }

export interface PcbBuild {
  routes: PcbRoute[];
  gaps: PcbRouteGap[];
  missing: string[];
  stackup: PcbStackup | null;
  nest: PcbNest | null;
  finishOptions: PcbFinishOption[];
}

/** Every route of the board (each complete or with its gaps), the routes it cannot take and why, and what keeps any route from being built. */
export function buildPcbRoutes(input: PcbRouteInput): PcbBuild {
  const { ref, part, scenario } = input;
  const none = (...missing: string[]): PcbBuild => ({ routes: [], gaps: [], missing, stackup: null, nest: null, finishOptions: [] });
  const num = (name: string) => ref.number(name);

  // ── The stack-up, the working panel and the nest ──────────────────────────────────────────────────────────────────────────────────
  const layers = part.layers.value;
  const { stackup, missing: stackMissing } = pcbStackup(ref, layers, part.thicknessMm.value, part.outerCopperOz.value, part.innerCopperOz?.value ?? null, part.stackupPreference.value);
  if (!stackup) return none(...stackMissing);
  const panelIn = processTime(ref, 'working_panel_in');
  if (!panelIn) return none('the working panel size (memory/PCBA/process_times.csv working_panel_in)');
  const panel = { lengthMm: r2(Math.max(panelIn.min, panelIn.max) * 25.4), widthMm: r2(Math.min(panelIn.min, panelIn.max) * 25.4) };
  const multi = layers > 2;
  const arrayOn = ref.flag('defaultEnableArrayDepanelization') === true;
  const arrayL = num('defaultArrayLength');
  const arrayW = num('defaultArrayWidth');
  const { nest, reason: nestReason } = nestPcb(part.lengthMm.value, part.widthMm.value, part.areaMm2.value, {
    panel, array: arrayOn && arrayL && arrayW ? { lengthMm: Math.max(arrayL, arrayW), widthMm: Math.min(arrayL, arrayW) } : null,
    edgeMarginLengthMm: num(multi ? 'defaultPanelSheetPerimeterLengthMultiLayer' : 'defaultPanelSheetPerimeterLengthNonMultiLayer') ?? 0,
    edgeMarginWidthMm: num(multi ? 'defaultPanelSheetPerimeterWidthMultiLayer' : 'defaultPanelSheetPerimeterWidthNonMultiLayer') ?? 0,
    spacingMm: num('defaultPanelSheetRectangularNestingSpacing') ?? 0,
  }, null);
  if (!nest) return { ...none(nestReason ?? 'the board does not fit the working panel'), stackup };
  const perPanel = nest.boardsPerPanel;

  // ── Seeding: every input from its declared source; the key before a " (" note is the value's name ───────────────────────────────────
  const named = (values: Readonly<Record<string, CalcSeed | undefined>>): SeedProvider => (key) => values[key.split(' (')[0]!.trim()] ?? null;
  const seed = (value: number, source: string): CalcSeed => ({ value, source });
  const sourced = (v: SourcedValue, what: string): CalcSeed => ({ value: v.mid, source: `${what}: ${saySourced(v)} (${v.sources.map((s) => s.url).join(', ')})` });
  const variableSeed = (name: string): CalcSeed | null => {
    const value = num(name);
    return value == null ? null : { value, source: `PCB variable ${name}${ref.unit(name) ? ` (${ref.unit(name)})` : ''}`, ref: { kind: 'variable', domain: PCB_DOMAIN, name } };
  };
  const common: Record<string, CalcSeed | undefined> = {
    boards_per_panel: seed(perPanel, `${perPanel} board(s) per panel: ${nest.note}`),
    panel_length_mm: seed(r2(panel.lengthMm), `the ${panelIn.min} x ${panelIn.max} in working panel (process_times.csv working_panel_in)`),
    panel_width_mm: seed(r2(panel.widthMm), `the ${panelIn.min} x ${panelIn.max} in working panel`),
    arrays_per_panel: seed(nest.arraysPerPanel, `${nest.arraysPerPanel} array(s) per panel`),
    board_thickness: seed(part.thicknessMm.value, `${part.thicknessMm.value} mm (${part.thicknessMm.source})`),
    board_length: seed(r2(part.lengthMm.value), `${r2(part.lengthMm.value)} mm (${part.lengthMm.source})`),
    board_area_mm2: seed(r2(part.areaMm2.value), `${r2(part.areaMm2.value)} mm² (${part.areaMm2.source})`),
  };
  type Run = { run: ReferenceCalcRun } | { reasons: string[] };
  const run = (calculator: string, machine: SandMachine | null, engine: Record<string, CalcSeed | undefined>): Run => {
    const calc = input.spec.calculators.find((c) => c.name === calculator);
    if (!calc) return { reasons: [`${calculator} is not in the calculator spec`] };
    const providers: SeedProviders = {
      variable: (name) => variableSeed(name), engine: named({ ...common, ...engine }),
      machine: (key) => {
        const value = machine ? machineValue(machine, key) : null;
        return value == null || !machine ? null : {
          value, source: `machine ${machine.name}: ${key}`,
          ref: { kind: 'machine', machineId: machine.id, machineName: machine.name, machineClass: machine.machineClass, location: machine.location, column: key },
        };
      },
    };
    const { seeds, missing } = seedsFor(calc, providers);
    if (missing.length) return { reasons: missing.map((m) => `${calculator}: ${m}`) };
    const result = runReferenceCalculator(input.calculators, calculator, seeds, calc.output ?? 'Cycle Time');
    return result.value == null ? { reasons: result.missing } : { run: result };
  };
  const timed = (process: string, m: SandMachine, engine: Record<string, CalcSeed | undefined> = {}): StepOutcome => {
    const r = run(PCB_CALC(process), m, engine);
    return 'run' in r ? { ok: true, sec: r.run.value!, run: r.run, energyCostUsd: 0, notes: [] } as StepOutcome : fail(...r.reasons);
  };
  const step = (process: string, machineClass: string, evaluate: (m: SandMachine) => StepOutcome, criteria: string[]): CostedStep =>
    selectAndCost({
      process, machineClass, machines: input.machinesByClass[machineClass] ?? [], evaluate, criteria,
      batchSize: scenario.batchSize, costContext: input.costContext, ref, partName: 'board', processGroup: PCB_PROCESS_GROUP,
    });
  // The panel must fit the machine: its stated panel, table, exposure or print limits, in either orientation.
  const fits = (m: SandMachine, lengthKey: string, widthKey: string, what: string): string | null => {
    const l = machineValue(m, lengthKey);
    const w = machineValue(m, widthKey);
    if (l == null || w == null) return null;
    const [a, b] = [Math.max(l, w), Math.min(l, w)];
    return panel.lengthMm <= a + 1e-6 && panel.widthMm <= b + 1e-6 ? null : `the ${r2(panel.lengthMm)} x ${r2(panel.widthMm)} mm panel is larger than its ${l} x ${w} mm ${what}`;
  };
  const thick = (m: SandMachine, key: string): string | null => {
    const t = machineValue(m, key);
    return t != null && part.thicknessMm.value > t + 1e-9 ? `the ${part.thicknessMm.value} mm board is thicker than the ${t} mm it takes` : null;
  };
  const guard = (...reasons: (string | null)[]) => reasons.filter((r): r is string => r != null);
  const passesSeed = (n: number, why: string) => ({ passes: seed(n, why) });

  // ── The steps every route shares ──────────────────────────────────────────────────────────────────────────────────────────────────
  const steps: CostedStep[] = [];
  const consumableLines: ProcessLineCost[] = [];
  const warnings: string[] = [];
  const imagingPasses = stackup.innerCores + 1;
  const imagingWhy = stackup.innerCores > 0 ? `${stackup.innerCores} inner-layer core(s) and the outer layers` : 'the outer layers';
  const resistSpeed = Math.max(0, ...(input.machinesByClass[PCB_CLASS.resist] ?? []).map((m) => machineValue(m, 'conveyor_speed_mm_per_s') ?? 0));
  steps.push(step('Surface Preparation', PCB_CLASS.surfacePrep, (m) => {
    const why = guard(fits(m, 'max_panel_width_mm', 'max_panel_width_mm', 'panel width'));
    if (why.length) return fail(...why);
    if (!(resistSpeed > 0)) return fail('no photo-resist line speed to run the prep conveyor at');
    return timed('Surface Preparation', m, { ...passesSeed(imagingPasses, imagingWhy), conveyor_speed_mm_per_s: seed(resistSpeed, `${resistSpeed} mm/s: the photo-resist line it feeds (no speed on file for the prep line)`) });
  }, ['Its width takes the panel']));
  steps.push(step('Apply Photo Resist', PCB_CLASS.resist, (m) => {
    const why = guard(fits(m, 'max_panel_length_mm', 'max_panel_width_mm', 'laminator'), thick(m, 'max_panel_thickness_mm'));
    return why.length ? fail(...why) : timed('Apply Photo Resist', m, passesSeed(imagingPasses, imagingWhy));
  }, ['The panel fits its laminator']));
  steps.push(step('Photolithography', PCB_CLASS.litho, (m) => {
    const why = guard(fits(m, 'max_expose_length_mm', 'max_expose_width_mm', 'exposure area'));
    return why.length ? fail(...why) : timed('Photolithography', m, { ...passesSeed(imagingPasses, imagingWhy), sides: seed(num('defaultNumFilmImagingSides') ?? 2, 'defaultNumFilmImagingSides') });
  }, ['The panel fits its exposure area']));
  if (stackup.innerCores > 0 || layers === 1) {
    const etchPasses = layers === 1 ? 1 : stackup.innerCores;
    steps.push(step('DES', PCB_CLASS.des, (m) => {
      const why = guard(thick(m, 'max_panel_thickness_mm'), fits(m, 'usable_width_mm', 'usable_width_mm', 'conveyor width'));
      return why.length ? fail(...why) : timed('DES', m, passesSeed(etchPasses, layers === 1 ? 'the one layer, printed and etched' : `${stackup.innerCores} inner-layer core(s)`));
    }, ['Its conveyor takes the panel']));
  }
  steps.push(step('Automated Optical Inspection', PCB_CLASS.aoi, (m) => {
    const why = guard(fits(m, 'usable_length_mm', 'usable_width_mm', 'inspection area'));
    return why.length ? fail(...why) : timed('Automated Optical Inspection', m, passesSeed(imagingPasses, imagingWhy));
  }, ['The panel fits its inspection area']));

  if (stackup.laminated) {
    const plies = stackup.prepregSpaces > 0 ? prepregPlies(ref, stackup.prepregPerSpaceMm) : null;
    const laminates = stackup.doubleCores + stackup.singleCores + stackup.foils + (plies ? plies.plies * stackup.prepregSpaces : 0);
    steps.push(step('Bench Operation', PCB_CLASS.bench, (m) => timed('Bench Operation', m, {
      laminates: seed(laminates, `${stackup.doubleCores + stackup.singleCores} core(s), ${stackup.foils} foil(s)${plies ? `, ${plies.plies * stackup.prepregSpaces} prepreg ply(ies) (${plies.plies} x ${plies.style} in each of ${stackup.prepregSpaces} space(s))` : ''}`),
    }), ['A lay-up bench']));
    steps.push(step('Oven Cure Layers', PCB_CLASS.laminate, (m) => {
      const why = guard(fits(m, 'max_panel_length_mm', 'max_panel_width_mm', 'press platen'));
      return why.length ? fail(...why) : timed('Oven Cure Layers', m);
    }, ['The panel fits its platens']));
  }

  // Holes: laser vias (small, shallow), mechanically drilled hits, and holes too large to drill (routed with the outline).
  const viaLimit = num('viaDrillingUpperDiameterLimit') ?? 0;
  const viaDepth = num('viaMaxDepthNumberOfLayers') ?? 0;
  const maxDrill = num('maxDrilledHoleSize') ?? Infinity;
  const holes = part.holes.value;
  // A laser drills a hole of at most viaDrillingUpperDiameterLimit through at most viaMaxDepthNumberOfLayers layers. The drill file's holes go
  // through the whole board, so a hole is laser-drilled only on a board no deeper than that; any other hole is drilled mechanically.
  const laserable = (d: number) => d <= viaLimit && layers <= viaDepth;
  const vias = holes.filter((h) => laserable(h.diameterMm)).reduce((s, h) => s + h.count, 0);
  const drilled = holes.filter((h) => !laserable(h.diameterMm) && h.diameterMm <= maxDrill);
  const routedHoles = holes.filter((h) => h.diameterMm > maxDrill);
  const totals = holeTotals(drilled);
  steps.push(step('Drill Registration Holes', PCB_CLASS.regDrill, (m) => {
    const why = guard(fits(m, 'table_length_mm', 'table_width_mm', 'table'));
    return why.length ? fail(...why) : timed('Drill Registration Holes', m);
  }, ['The panel fits its table']));
  if (totals.hits > 0) {
    steps.push(step('Drill Circuit Holes', PCB_CLASS.drill, (m) => {
      const why = guard(fits(m, 'table_length_mm', 'table_width_mm', 'table'));
      return why.length ? fail(...why) : timed('Drill Circuit Holes', m, {
        hits_per_board: seed(totals.hits, `${totals.hits} drilled hits (${part.holes.source})`), tools: seed(totals.tools, `${totals.tools} drill diameter(s)`),
      });
    }, ['The panel fits its table']));
    const drillCost = drillingConsumables(ref, drilled, panel, perPanel);
    if ('reasons' in drillCost) warnings.push(`Drilling consumables are not priced: ${drillCost.reasons.join('; ')}.`);
    else {
      const r = run(PCB_HELPER.drilling, null, {
        drill_bits_usd: seed(r4(drillCost.bitsUsd), drillCost.bitsDetail), drill_boards_usd_per_panel: seed(r4(drillCost.boardsUsdPerPanel), drillCost.boardsDetail),
      });
      if ('run' in r) consumableLines.push(consumableLine('Drilling consumables', PCB_CLASS.drill, r.run, `${drillCost.bitsDetail}; ${drillCost.boardsDetail}`));
    }
  }
  if (vias > 0) {
    steps.push(step('Laser Drill Vias', PCB_CLASS.laser, (m) => {
      const why = guard(fits(m, 'table_length_mm', 'table_width_mm', 'table'));
      return why.length ? fail(...why) : timed('Laser Drill Vias', m, { vias_per_board: seed(vias, `${vias} hole(s) of at most ${viaLimit} mm`) });
    }, ['The panel fits its table']));
  }
  const plated = holes.filter((h) => h.plated).reduce((s, h) => s + h.count, 0);
  if (layers >= 2 && plated > 0) {
    steps.push(step('Desmear and Plate Through Holes', PCB_CLASS.pth, (m) => {
      const depth = machineValue(m, 'usable_tank_depth_mm');
      if (depth != null && panel.widthMm > depth) return fail(`the ${r2(panel.widthMm)} mm panel is deeper than its ${depth} mm tank`);
      return timed('Desmear and Plate Through Holes', m);
    }, ['The panel hangs within its tank depth']));
  }

  // Outer layers: develop, pattern plate and tin, strip-etch-strip (a one-layer board was printed and etched above).
  if (layers >= 2) {
    steps.push(step('Dissolve Unexposed Photo Resist', PCB_CLASS.dissolve, (m) => {
      const why = guard(thick(m, 'max_panel_thickness_mm'), fits(m, 'usable_length_mm', 'usable_width_mm', 'conveyor'));
      return why.length ? fail(...why) : timed('Dissolve Unexposed Photo Resist', m, passesSeed(1, 'the outer layers'));
    }, ['Its conveyor takes the panel']));
    const copperUm = micronsOfPlating(ref.text('defaultHolesPlatingThicknessExternalLayers'));
    const tin = processTime(ref, 'tin_thickness_um');
    const tinRate = processTime(ref, 'tin_rate_um_per_min');
    steps.push(step('Copper Plate and Tin Coat', PCB_CLASS.plate, (m) => {
      const depth = machineValue(m, 'usable_cell_depth_mm');
      if (depth != null && panel.widthMm > depth) return fail(`the ${r2(panel.widthMm)} mm panel is deeper than its ${depth} mm cells`);
      if (copperUm == null) return fail('the external hole plating thickness (defaultHolesPlatingThicknessExternalLayers)');
      if (!tin || !tinRate) return fail('the etch-resist tin thickness and rate (process_times.csv tin_thickness_um, tin_rate_um_per_min)');
      return timed('Copper Plate and Tin Coat', m, {
        copper_plating_thickness: seed(copperUm, `${copperUm} µm (defaultHolesPlatingThicknessExternalLayers)`),
        tin_thickness: sourced(tin, 'etch-resist tin'), tin_deposition_rate: sourced(tinRate, 'tin deposition rate'),
      });
    }, ['The panel hangs within its cell depth']));
    const tinPrice = consumable(ref, 'tin_usd_per_kg');
    const tinDensity = consumable(ref, 'tin_density_g_cm3');
    if (tin && tinPrice && tinDensity) {
      const area = platedArea(part);
      const r = run(PCB_HELPER.metal, null, {
        plated_area_mm2: seed(r2(area.mm2), area.why), thickness_um: sourced(tin, 'etch-resist tin'), density_g_cm3: sourced(tinDensity, 'tin density'),
        price_usd_per_g: { value: tinPrice.mid / 1000, source: `tin: ${saySourced(tinPrice)} / 1000 g` },
      });
      if ('run' in r) consumableLines.push(consumableLine('Tin (etch resist)', PCB_CLASS.plate, r.run, `${r2(area.mm2)} mm² ${area.why} at ${saySourced(tin)}`));
    }
    steps.push(step('SES', PCB_CLASS.ses, (m) => {
      const why = guard(thick(m, 'max_panel_thickness_mm'), fits(m, 'usable_width_mm', 'usable_width_mm', 'conveyor width'));
      return why.length ? fail(...why) : timed('SES', m, passesSeed(1, 'the outer layers'));
    }, ['Its conveyor takes the panel']));
  }
  if (part.viaPlugging.value) {
    steps.push(step('Plug Vias', PCB_CLASS.plug, (m) => {
      const why = guard(fits(m, 'max_print_length_mm', 'max_print_width_mm', 'print area'), thick(m, 'max_substrate_thickness_mm'));
      return why.length ? fail(...why) : timed('Plug Vias', m);
    }, ['The panel fits its print area']));
    steps.push(step('Cure Plugged Vias', PCB_CLASS.plugCure, (m) => {
      const why = guard(fits(m, 'max_panel_length_mm', 'max_panel_width_mm', 'conveyor'), thick(m, 'max_panel_thickness_mm'));
      return why.length ? fail(...why) : timed('Cure Plugged Vias', m);
    }, ['The panel fits its conveyor']));
  }

  // Solder mask and legend.
  const maskSides = part.soldermaskSides.value;
  if (maskSides > 0) {
    const sides = { solder_mask_sides: seed(maskSides, `${maskSides} masked side(s) (${part.soldermaskSides.source})`) };
    steps.push(step('Wet Film Solder Mask', PCB_CLASS.mask, (m) => {
      const why = guard(fits(m, 'max_print_length_mm', 'max_print_width_mm', 'print area'), thick(m, 'max_substrate_thickness_mm'));
      return why.length ? fail(...why) : timed('Wet Film Solder Mask', m, sides);
    }, ['The panel fits its print area']));
    steps.push(step('Tack Dry Solder Mask', PCB_CLASS.tackDry, (m) => ovenStep('Tack Dry Solder Mask', m), ['Its bed holds a case of panels']));
    steps.push(step('Film Imaging', PCB_CLASS.film, (m) => {
      const why = guard(fits(m, 'max_expose_length_mm', 'max_expose_width_mm', 'exposure area'));
      return why.length ? fail(...why) : timed('Film Imaging', m, sides);
    }, ['The panel fits its exposure area']));
    steps.push(step('Develop Solder Mask', PCB_CLASS.develop, (m) => {
      const why = guard(thick(m, 'max_panel_thickness_mm'), fits(m, 'usable_width_mm', 'usable_width_mm', 'conveyor width'));
      return why.length ? fail(...why) : timed('Develop Solder Mask', m, passesSeed(num('defaultNumPassesDevelopSolderMask') ?? 1, 'defaultNumPassesDevelopSolderMask'));
    }, ['Its conveyor takes the panel']));
    steps.push(step('Cure Solder Mask', PCB_CLASS.maskCure, (m) => ovenStep('Cure Solder Mask', m), ['Its bed holds a case of panels']));
    const solids = processTime(ref, 'solder_mask_solids_pct');
    const price = consumable(ref, 'solder_mask_usd_per_kg');
    if (solids && price) {
      const r = run(PCB_HELPER.mask, null, { ...sides, solder_mask_solids_pct: sourced(solids, 'solids'), solder_mask_usd_per_kg: sourced(price, 'LPI solder mask') });
      if ('run' in r) consumableLines.push(consumableLine('Solder mask', PCB_CLASS.mask, r.run, `${maskSides} side(s) of ${r2(part.areaMm2.value)} mm² at ${saySourced(price)}`));
    } else warnings.push('The solder mask ink is not priced: its sourced solids or price is missing.');
  }
  function ovenStep(process: 'Tack Dry Solder Mask' | 'Cure Solder Mask', m: SandMachine): StepOutcome {
    const out = timed(process, m);
    if (!out.ok) return out;
    const load = out.run.outputs['Panels Per Load'] ?? 0;
    return load >= 1 ? out : fail(`its bed does not hold a case of ${num('defaultNumberOfPanelsPerCase_cureSolderMask')} panels of ${r2(panel.lengthMm)} x ${r2(panel.widthMm)} mm within its spacing`);
  }
  const legendSides = part.silkscreenSides.value;
  if (legendSides > 0) {
    steps.push(step('Screen Printing', PCB_CLASS.legend, (m) => {
      const why = guard(fits(m, 'max_print_length_mm', 'max_print_width_mm', 'print area'), thick(m, 'max_substrate_thickness_mm'));
      return why.length ? fail(...why) : timed('Screen Printing', m, { legend_sides: seed(legendSides, `${legendSides} legend side(s) (${part.silkscreenSides.source})`) });
    }, ['The panel fits its print area']));
    steps.push(step('Silkscreen Cure', PCB_CLASS.legendCure, (m) => {
      const why = guard(fits(m, 'max_panel_length_mm', 'max_panel_width_mm', 'conveyor'), thick(m, 'max_panel_thickness_mm'));
      return why.length ? fail(...why) : timed('Silkscreen Cure', m);
    }, ['The panel fits its conveyor']));
    warnings.push('The legend ink is not priced: its coverage is not measured and no USD price was sourced.');
  }

  // The surface finish the board specifies (and the other two, priced beside it).
  const finishSteps = (finish: PcbFinish): { steps: CostedStep[]; lines: ProcessLineCost[] } => {
    const process = PCB_FINISH_LABEL[finish];
    const cls = FINISH_CLASS[finish];
    if (finish === 'hasl') {
      return { steps: [step(process, cls, (m) => {
        const why = guard(fits(m, 'max_panel_length_mm', 'max_panel_width_mm', 'solder pot'));
        return why.length ? fail(...why) : timed(process, m);
      }, ['The panel fits its solder pot'])], lines: [] };
    }
    if (finish === 'osp') {
      return { steps: [step(process, cls, (m) => {
        const why = guard(thick(m, 'max_panel_thickness_mm'), fits(m, 'usable_width_mm', 'usable_width_mm', 'conveyor width'));
        return why.length ? fail(...why) : timed(process, m, passesSeed(num('defaultNumPassesOSP') ?? 1, 'defaultNumPassesOSP'));
      }, ['Its conveyor takes the panel'])], lines: [] };
    }
    const gold = processTime(ref, 'gold_dwell_min');
    const s = step(process, cls, (m) => {
      const why = guard(fits(m, 'max_panel_length_mm', 'max_panel_width_mm', 'fly bar'));
      if (why.length) return fail(...why);
      if (!gold) return fail('the immersion gold dwell (process_times.csv gold_dwell_min)');
      return timed(process, m, { gold_dwell: { value: gold.mid * 60, source: `immersion gold dwell: ${saySourced(gold)} x 60 s` } });
    }, ['The panel fits its fly bars']);
    const lines: ProcessLineCost[] = [];
    const area = pasteArea(part);
    for (const [label, thicknessKey, densityKey, priceKey, perGram] of [
      ['Electroless nickel', 'nickel_thickness_um', 'nickel_density_g_cm3', 'nickel_usd_per_kg', 1 / 1000], ['Immersion gold', 'gold_thickness_um', 'gold_density_g_cm3', 'gold_usd_per_g', 1],
    ] as const) {
      const t = processTime(ref, thicknessKey);
      const d = consumable(ref, densityKey);
      const p = consumable(ref, priceKey);
      if (!area) { warnings.push(`${label} is not priced: the pad area is not measured (the board files have no paste layer).`); continue; }
      if (!t || !d || !p) { warnings.push(`${label} is not priced: its sourced thickness, density or price is missing.`); continue; }
      const r = run(PCB_HELPER.metal, null, {
        plated_area_mm2: seed(r2(area.mm2), area.why), thickness_um: sourced(t, label), density_g_cm3: sourced(d, `${label} density`),
        price_usd_per_g: { value: p.mid * perGram, source: `${label}: ${saySourced(p)}${perGram !== 1 ? ' / 1000 g' : ''}` },
      });
      if ('run' in r) lines.push(consumableLine(label, cls, r.run, `${r2(area.mm2)} mm² ${area.why} at ${saySourced(t)}`));
    }
    return { steps: [s], lines };
  };
  const finish = part.finish.value;
  const finished = finishSteps(finish);
  steps.push(...finished.steps);
  consumableLines.push(...finished.lines);
  if (finish === 'hasl') warnings.push('The HASL solder is not priced: no consumption per area was sourced.');

  // ── The routes: the profile x the electrical test, each with its tooling ─────────────────────────────────────────────────────────────
  const shared = steps;
  const routes: PcbRoute[] = [];
  const gaps: PcbRouteGap[] = [];
  const parts = scenario.amortizationParts;
  const tool = (key: string, description: string, costUsd: number | null, detail: string): PcbTool =>
    ({ key, description, detail, costUsd: costUsd != null ? r2(costUsd) : null, perPartUsd: costUsd != null && parts ? r4(costUsd / parts) : null, amortizationParts: parts });
  const outline = part.perimeterMm.value + routedHoles.reduce((s, h) => s + Math.PI * h.diameterMm * h.count, 0);
  const fpLimit = num('maxFlyingProbeProductionVolume');
  const tested = part.testPoints;
  for (const r of PCB_ROUTES) {
    if (r.test === 'flying_probe' && fpLimit != null && scenario.annualVolume != null && scenario.annualVolume > fpLimit) {
      gaps.push({ key: r.key, label: r.label, reason: `${scenario.annualVolume.toLocaleString('en-US')} boards a year is more than a flying probe tests (maxFlyingProbeProductionVolume ${fpLimit.toLocaleString('en-US')})` });
      continue;
    }
    const own: CostedStep[] = [];
    const tooling: PcbTool[] = [];
    const routeLines: ProcessLineCost[] = [];
    if (r.profile === 'router') {
      const routed = step('Router', PCB_CLASS.router, (m) => {
        const why = guard(fits(m, 'max_panel_length_mm', 'max_panel_width_mm', 'table'));
        return why.length ? fail(...why) : timed('Router', m, {
          rout_length_per_board: seed(r2(outline), `${r2(part.perimeterMm.value)} mm outline (${part.perimeterMm.source})${routedHoles.length ? ` and ${routedHoles.reduce((s, h) => s + h.count, 0)} hole(s) larger than maxDrilledHoleSize routed round` : ''}`),
        });
      }, ['The panel fits its table']);
      own.push(routed);
      // A bit routs the whole stack at once: its wear is shared by the boards stacked under it.
      const stack = routed.outcome?.run.outputs['Stack'] ?? 1;
      const bitPrice = consumable(ref, 'router_bit_usd');
      const bitLife = consumable(ref, 'router_bit_life_mm');
      if (bitPrice && bitLife) {
        const usd = (outline / bitLife.mid) * bitPrice.mid / Math.max(1, stack);
        routeLines.push(perPartLine('Router bits', PCB_CLASS.router, usd, `${r2(outline)} mm routed per board / ${saySourced(bitLife)} per bit x ${saySourced(bitPrice)}, shared by the ${stack} panel(s) stacked`));
      }
    } else {
      own.push(step('Stamp', PCB_CLASS.stamp, (m) => {
        const pieceL = nest.array?.lengthMm ?? part.lengthMm.value;
        const pieceW = nest.array?.widthMm ?? part.widthMm.value;
        const l = machineValue(m, 'max_panel_length_mm');
        const w = machineValue(m, 'max_panel_width_mm');
        if (l != null && w != null && (Math.max(pieceL, pieceW) > Math.max(l, w) || Math.min(pieceL, pieceW) > Math.min(l, w))) {
          return fail(`the ${r2(pieceL)} x ${r2(pieceW)} mm ${nest.array ? 'array' : 'board'} is larger than its ${l} x ${w} mm die area`);
        }
        const h = machineValue(m, 'max_panel_height_mm');
        if (h != null && part.thicknessMm.value > h) return fail(`the ${part.thicknessMm.value} mm board is thicker than the ${h} mm it punches`);
        return timed('Stamp', m);
      }, ['The array fits its die area', 'It punches the board\'s thickness']));
      const die = consumable(ref, 'stamp_die_usd');
      tooling.push(tool('stamp-die', 'Stamping die', die?.mid ?? null, die ? `${saySourced(die, 0)} (${die.sources.map((s) => s.url).join(', ')})` : 'no die price sourced'));
    }
    if (r.test === 'flying_probe') {
      if (!tested) {
        own.push({ line: gapLine('Flying Probe', PCB_CLASS.flyingProbe, 'the test points: the board files give no nets (no copper or drill layers traced); set Test points in the Cost Guide'), machine: null, outcome: null, warnings: [] });
      } else {
        own.push(step('Flying Probe', PCB_CLASS.flyingProbe, (m) => {
          const why = guard(fits(m, 'max_board_length_mm', 'max_board_width_mm', 'test area'));
          return why.length ? fail(...why) : timed('Flying Probe', m, { test_points_per_board: seed(tested.value, `${tested.value} test points (${tested.source})`) });
        }, ['The panel fits its test area']));
      }
      const program = consumable(ref, 'flying_probe_program_usd');
      tooling.push(tool('flying-probe-program', 'Flying probe test program', program?.mid ?? null, program ? saySourced(program, 0) : 'no program price sourced'));
    } else {
      const testPiece = nest.array ?? { lengthMm: part.lengthMm.value, widthMm: part.widthMm.value };
      const bon = step('Bed of Nails', PCB_CLASS.bedOfNails, (m) => {
        const l = machineValue(m, 'max_board_length_mm');
        const w = machineValue(m, 'max_board_width_mm');
        if (l != null && w != null && (Math.max(testPiece.lengthMm, testPiece.widthMm) > Math.max(l, w) || Math.min(testPiece.lengthMm, testPiece.widthMm) > Math.min(l, w))) {
          return fail(`the ${r2(testPiece.lengthMm)} x ${r2(testPiece.widthMm)} mm ${nest.array ? 'array' : 'board'} is larger than its ${l} x ${w} mm fixture area`);
        }
        return timed('Bed of Nails', m);
      }, ['The array fits its fixture area']);
      own.push(bon);
      const fixture = consumable(ref, 'bed_of_nails_fixture_usd');
      const rate = bon.machine ? (bon.machine.machineRatePerHr ?? 0) + (bon.machine.labourRatePerHr ?? 0) * (bon.machine.operators ?? 0) : null;
      const built = fixture && rate != null ? run(PCB_HELPER.fixture, null, { tester_usd_per_h: seed(r2(rate), `${bon.machine!.name}: machine and labour rate`), fixture_usd: sourced(fixture, 'fixture') }) : null;
      tooling.push(tool('bed-of-nails-fixture', 'Bed of nails test fixture', built && 'run' in built ? built.run.value! : null,
        built && 'run' in built ? `build ${num('defaultProberAssemblyTime')} h (defaultProberAssemblyTime) at ${r2(rate!)} USD/h + parts ${saySourced(fixture!, 0)}` : 'not priced: no fixture price or tester rate'));
    }
    const avi = step('Automated Vision Inspection', PCB_CLASS.avi, (m) => {
      const l = machineValue(m, 'max_board_length_mm');
      const w = machineValue(m, 'max_board_width_mm');
      const minL = machineValue(m, 'min_board_length_mm');
      const minW = machineValue(m, 'min_board_width_mm');
      const [bl, bw] = [part.lengthMm.value, part.widthMm.value];
      if (l != null && w != null && (bl > Math.max(l, w) || bw > Math.min(l, w))) return fail(`the ${r2(bl)} x ${r2(bw)} mm board is larger than its ${l} x ${w} mm`);
      if (minL != null && minW != null && (bl < Math.min(minL, minW) || bw < Math.min(minL, minW))) return fail(`the board is smaller than its ${minL} x ${minW} mm minimum`);
      return timed('Automated Vision Inspection', m);
    }, ['The board fits its inspection limits']);
    const allSteps = [...shared, ...own, avi];
    const lines: ProcessLineCost[] = allSteps.map((s) => ({ ...s.line, actsOnWholePart: true }));
    lines.push(...consumableLines, ...routeLines);

    // The board's material (the reference's Material Stock process: its Layer Material), and the scrap the fabrication yield charges on the good boards.
    const material = boardMaterial(input, stackup, run);
    if (material.run) {
      lines.unshift({ ...consumableLine('Material Stock', 'material_stock', material.run, material.uses.map((u) => `${u.count} x ${u.detail}`).join('; ')), formsPartFeatures: false });
    } else {
      lines.unshift(gapLine('Material Stock', 'material_stock', `the board's laminate cannot be priced: ${material.warnings.join('; ') || 'no laminate price'}`));
    }
    const complete = !lines.some(isGap);
    const boardUsd = lines.reduce((s, l) => s + l.totalCost, 0);
    const y = fabYield(ref, layers);
    if (y) {
      const scrap = run(PCB_HELPER.yield, null, { board_cost_usd: seed(r4(boardUsd), 'the board\'s material, process and consumables'), fab_yield_pct: sourced(y, `first-pass yield at ${y.layersRead} layers${y.layersRead !== layers ? ` (the nearest count the source gives for ${layers})` : ''}`) });
      if ('run' in scrap) lines.push(consumableLine('Fabrication yield', PCB_CLASS.avi, scrap.run, `${saySourced(y, 2)} first-pass yield at ${y.layersRead} layers: the scrapped boards charged on the good ones`));
    } else warnings.push('No fabrication yield is applied: memory/PCBA/yield.csv has no keyed row.');
    routes.push({
      key: r.key, label: r.label, profile: r.profile, test: r.test, lines, material: { costUsd: material.costUsd, run: material.run, uses: material.uses },
      tooling, totalUsd: complete ? r2(lines.reduce((s, l) => s + l.totalCost, 0)) : null, complete,
      warnings: [...warnings, ...material.warnings, ...allSteps.flatMap((s) => s.warnings)],
    });
  }

  // The finishes the board does not specify, priced beside it on the cheapest route's other steps.
  const finishOptions: PcbFinishOption[] = (['hasl', 'enig', 'osp'] as const).filter((f) => f !== finish).map((f) => {
    const other = finishSteps(f);
    const gapped = other.steps.find((s) => isGap(s.line));
    const own = finished.steps.reduce((s, x) => s + x.line.totalCost, 0) + finished.lines.reduce((s, l) => s + l.totalCost, 0);
    const best = routes.filter((x) => x.complete).sort((a, b) => a.totalUsd! - b.totalUsd!)[0];
    if (gapped || !best) return { finish: f, label: PCB_FINISH_LABEL[f], totalUsd: null, reason: gapped?.line.physicsGap ? ('reason' in gapped.line.physicsGap ? gapped.line.physicsGap.reason : gapped.line.physicsGap.requiredAction) : 'no complete route to price it on' };
    const total = best.totalUsd! - own + other.steps.reduce((s, x) => s + x.line.totalCost, 0) + other.lines.reduce((s, l) => s + l.totalCost, 0);
    return { finish: f, label: PCB_FINISH_LABEL[f], totalUsd: r2(total), reason: null };
  });
  return { routes, gaps, missing: [], stackup, nest, finishOptions };

  // ── Lines that are not machine time ──────────────────────────────────────────────────────────────────────────────────────────────
  function consumableLine(process: string, machineClass: string, r: ReferenceCalcRun, detail: string): ProcessLineCost {
    return { ...perPartLine(process, machineClass, r.value!, detail), ...runOnLine(r) };
  }
  function perPartLine(process: string, machineClass: string, usd: number, detail: string): ProcessLineCost {
    return {
      process, processGroup: PCB_PROCESS_GROUP, processRoute: process, operation: process,
      setupCost: 0, runCost: usd, totalCost: usd, cycleTimeMin: 0, hourlyRate: 0, rateSource: 'consumable_allowance',
      machineClass, machineName: null, commodityCode: null, labourRate: null, actsOnWholePart: true,
      featureBreakdown: [{ name: detail, featureType: 'Part', timeSec: 0, count: 1 }],
    } as ProcessLineCost;
  }
  function gapLine(process: string, machineClass: string, reason: string): ProcessLineCost {
    return {
      process, processGroup: PCB_PROCESS_GROUP, processRoute: process, operation: process, setupCost: 0, runCost: 0, totalCost: 0, cycleTimeMin: 0,
      hourlyRate: 0, rateSource: 'no_db_rate', machineClass, machineName: null, commodityCode: null, labourRate: null,
      physicsGap: { gapType: 'unsupported_operation', process, machineClass, reason },
    } as ProcessLineCost;
  }
}

/** The pad area the ENIG metals cover: the paste openings the board files measure (SMD pads), else nothing to price them on. */
function pasteArea(part: PcbPart): { mm2: number; why: string } | null {
  const p = part.pasteAreaMm2;
  return p && p > 0 ? { mm2: p, why: 'the paste openings (SMD pads) the board files measure' } : null;
}

/** The copper the etch-resist tin covers: the copper area the board files measure, else the whole board on each outer side (said). */
function platedArea(part: PcbPart): { mm2: number; why: string } {
  if (part.copperAreaMm2 && part.copperAreaMm2 > 0) return { mm2: part.copperAreaMm2, why: 'the outer copper the board files measure' };
  return { mm2: part.areaMm2.value * 2, why: 'both outer sides of the board (no copper area measured: the whole board, an upper bound)' };
}

/** What drilling wears out: each diameter's hits at its bit's price over its life, and the entry and backup boards a panel takes. */
function drillingConsumables(ref: SandReference, holes: readonly { diameterMm: number; count: number }[], panel: { lengthMm: number; widthMm: number }, perPanel: number):
  { bitsUsd: number; bitsDetail: string; boardsUsdPerPanel: number; boardsDetail: string } | { reasons: string[] } {
  const price = consumable(ref, 'drill_bit_usd');
  const entry = consumable(ref, 'entry_board_usd_per_sheet');
  const backup = consumable(ref, 'backup_board_usd_per_sheet');
  const sheet = consumable(ref, 'drill_board_sheet_in');
  const reasons: string[] = [];
  if (!price) reasons.push('no drill bit price');
  if (!entry || !backup || !sheet) reasons.push('no entry or backup board price or sheet size');
  let bitsUsd = 0;
  const per: string[] = [];
  for (const h of holes) {
    const life = consumableForDiameter(ref, 'drill_hit_life_hits', h.diameterMm);
    const repoints = consumableForDiameter(ref, 'drill_repoints', h.diameterMm);
    if (!life) { reasons.push(`no hit life for a ${h.diameterMm} mm drill`); continue; }
    const hitsPerBit = life.mid * (1 + (repoints?.mid ?? 0));
    bitsUsd += price ? (h.count * price.mid) / hitsPerBit : 0;
    per.push(`${h.count} x ${h.diameterMm} mm (${Math.round(hitsPerBit)} hits a bit)`);
  }
  if (reasons.length) return { reasons };
  const sheetL = Math.max(sheet!.min, sheet!.max) * 25.4;
  const sheetW = Math.min(sheet!.min, sheet!.max) * 25.4;
  const panelsPerSheet = Math.max(1, Math.floor(sheetL / panel.lengthMm) * Math.floor(sheetW / panel.widthMm), Math.floor(sheetL / panel.widthMm) * Math.floor(sheetW / panel.lengthMm));
  const boardsUsdPerPanel = (entry!.mid + backup!.mid) / panelsPerSheet;
  return {
    bitsUsd, bitsDetail: `bits: ${per.join(', ')} at ${saySourced(price!, 2)} a bit`,
    boardsUsdPerPanel, boardsDetail: `entry ${saySourced(entry!, 2)} + backup ${saySourced(backup!, 2)} a ${sheet!.min} x ${sheet!.max} in sheet, ${panelsPerSheet} panel(s) from it, shared by ${perPanel} board(s)`,
  };
}

/** The laminate the board takes: its cores (the reference's, or built from it for another dielectric), copper foils and prepreg. */
function boardMaterial(input: PcbRouteInput, stackup: PcbStackup, run: (calculator: string, m: SandMachine | null, e: Record<string, CalcSeed | undefined>) => { run: ReferenceCalcRun } | { reasons: string[] }):
  { costUsd: number; run: ReferenceCalcRun | null; uses: PcbMaterialUse[]; warnings: string[] } {
  const { ref, part, laminates } = input;
  const warnings: string[] = [];
  const uses: PcbMaterialUse[] = [];
  const oz = (o: number) => laminates.filter((l) => l.copperOz === o);
  const outer = part.outerCopperOz.value;
  const inner = part.innerCopperOz?.value ?? outer;
  const tolerance = ref.number('coreLayerThicknessSnapTolerance') ?? 0;
  const coreOf = (kind: 'double_core' | 'single_core', copper: number, dielectric: number | null): { usd: number; name: string; detail: string } | null => {
    const candidates = oz(copper).filter((l) => l.kind === kind && l.usdPerM2 != null);
    const exact = dielectric == null ? candidates[0] : candidates.find((l) => l.dielectricMm != null && Math.abs(l.dielectricMm - dielectric) <= tolerance + 1e-9);
    if (exact) return { usd: exact.usdPerM2!, name: exact.name, detail: `${exact.name} ${exact.usdPerM2} USD/m² (raw_materials)` };
    const reference = candidates.find((l) => l.dielectricMm != null);
    const foil = oz(copper).find((l) => l.kind === 'foil' && l.usdPerM2 != null);
    if (!reference || !foil || dielectric == null) return null;
    const r = run(PCB_HELPER.core, null, {
      reference_core_usd_per_m2: { value: reference.usdPerM2!, source: `${reference.name} (raw_materials)` },
      reference_dielectric_mm: { value: reference.dielectricMm!, source: `${reference.name}: dielectric` },
      foil_usd_per_m2: { value: foil.usdPerM2!, source: `${foil.name} (raw_materials)` },
      core_dielectric_mm: { value: dielectric, source: 'tblDielectricThickness' },
    });
    if (!('run' in r)) return null;
    return { usd: r.run.value!, name: `${kind === 'double_core' ? '2Ply' : '1Ply'}-${copper}ozCu-FR4 at ${dielectric} mm`, detail: `built from ${reference.name} and ${foil.name} (${PCB_HELPER.core}): ${r2(r.run.value!)} USD/m²` };
  };
  let cores = 0;
  const coreCount = stackup.doubleCores + stackup.singleCores;
  if (coreCount > 0) {
    const kind = stackup.doubleCores > 0 ? 'double_core' : 'single_core';
    const copper = stackup.layers <= 2 ? outer : inner;
    const core = coreOf(kind, copper, stackup.coreDielectricMm);
    if (!core) warnings.push(`No ${copper} oz core of ${stackup.coreDielectricMm ?? '?'} mm dielectric can be priced from raw_materials.`);
    else { cores = core.usd * coreCount; uses.push({ name: core.name, usdPerM2: r4(core.usd), count: coreCount, detail: core.detail }); }
  }
  let foils = 0;
  if (stackup.foils > 0) {
    const foil = oz(outer).find((l) => l.kind === 'foil' && l.usdPerM2 != null);
    if (!foil) warnings.push(`No ${outer} oz copper foil in raw_materials.`);
    else { foils = foil.usdPerM2! * stackup.foils; uses.push({ name: foil.name, usdPerM2: foil.usdPerM2!, count: stackup.foils, detail: `${foil.name} ${foil.usdPerM2} USD/m² (raw_materials)` }); }
  }
  const plies = stackup.prepregSpaces > 0 ? prepregPlies(ref, stackup.prepregPerSpaceMm) : null;
  const prepregMm = plies ? plies.plies * plies.nominalMm * stackup.prepregSpaces : 0;
  const prepregPrice = consumable(ref, 'prepreg_usd_per_kg');
  if (prepregMm > 0 && !prepregPrice) warnings.push('The prepreg is not priced: no sourced price per kg.');
  if (plies) uses.push({ name: `Prepreg ${plies.style}`, usdPerM2: 0, count: plies.plies * stackup.prepregSpaces, detail: `${plies.plies} x ${plies.style} (${plies.nominalMm} mm pressed) in each of ${stackup.prepregSpaces} space(s)` });
  if (warnings.length && cores === 0) return { costUsd: 0, run: null, uses, warnings };
  const r = run(PCB_HELPER.material, null, {
    cores_usd_per_m2: { value: r4(cores), source: uses.filter((u) => u.name.includes('FR4')).map((u) => `${u.count} x ${u.detail}`).join('; ') || 'no cores' },
    foils_usd_per_m2: { value: r4(foils), source: uses.filter((u) => u.name.endsWith('ozCu')).map((u) => `${u.count} x ${u.detail}`).join('; ') || 'no foils' },
    prepreg_mm: { value: r4(prepregMm), source: plies ? `${plies.plies * stackup.prepregSpaces} x ${plies.style} at ${plies.nominalMm} mm` : 'no prepreg (one core)' },
    prepreg_usd_per_kg: prepregPrice ? { value: prepregPrice.mid, source: `prepreg: ${saySourced(prepregPrice)}` } : { value: 0, source: 'no prepreg' },
  });
  if (!('run' in r)) return { costUsd: 0, run: null, uses, warnings: [...warnings, ...r.reasons] };
  return { costUsd: r.run.value!, run: r.run, uses, warnings };
}

/** The route to quote: the one set in the Cost Guide when it is a route for the board, else the cheapest complete one; and a note saying which and why. */
export function choosePcbRoute(routes: readonly PcbRoute[], gaps: readonly PcbRouteGap[], chosen: PcbRouteKey | null): { route: PcbRoute | null; note: string | null } {
  if (routes.length === 0) return { route: null, note: null };
  const money = (n: number) => `${n.toFixed(2)} USD`;
  const said = (r: PcbRoute) => (r.complete ? `${r.label} ${money(r.totalUsd!)}` : `${r.label} incomplete (${r.lines.filter(isGap).map((l) => l.process).join(', ') || 'material'})`);
  const others = (pick: PcbRoute) => [...routes.filter((r) => r !== pick).map(said), ...gaps.map((g) => `${g.label} not a route for this board (${g.reason})`)].join('; ');
  const user = chosen ? routes.find((r) => r.key === chosen) : undefined;
  if (user) return { route: user, note: `PCB: ${user.label} is set in the Cost Guide. ${others(user)}.` };
  const complete = routes.filter((r) => r.complete).sort((a, b) => a.totalUsd! - b.totalUsd!);
  const pick = complete[0] ?? [...routes].sort((a, b) => a.lines.filter(isGap).length - b.lines.filter(isGap).length)[0]!;
  const why = complete[0] ? 'the cheapest complete route (material, process and consumables per board; its tooling is shown apart)' : 'no route is complete: the one with the fewest gaps';
  return { route: pick, note: `PCB: ${pick.label} is quoted${pick.complete ? ` (${money(pick.totalUsd!)} per board)` : ''}, ${why}.${others(pick) ? ` ${others(pick)}.` : ''}` };
}
