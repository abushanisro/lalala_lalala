// The sand-casting route steps that need the mould: moulding (cavities, flask), melting, pouring and cooling. Each step seeds its
// calculator from the declared source of every input (sand-seeds.ts), checks the machine against what the step needs, and returns the
// time and the calculator run, or the reasons it cannot be done. selectAndCost() picks the cheapest capable machine and costs the line
// with the shared casting line builder. Ported from the retired petrus-demo prototype (its design records, D-numbers, are archived outside the repo) (D122, D128-D130).
//
// Nothing is substituted: a missing input, an unstaged table or a machine without a rate is named in the reasons.
import type { CalculationTraceStep, MachineChoiceDto, SourceRef } from '../../../dto/cost-breakdown.dto';
import type { ProcessLineCost } from '../../../dto/cost-breakdown.dto';
import type { DomainCalculatorSpec } from '../../shared/calculators/domain-calculator-spec';
import { runReferenceCalculator, type CalcSeed, type ReferenceCalcRun, type ReferenceCalculatorDef } from '../../shared/calculators/reference-calculator';
import { gap, line, roundLineCost, roundSec, type CostContext } from '../casting-finishing';
import { machineChoice, roundPerPart, type ChoiceEval } from '../machine-choice';
import { asFinishingMachine, machineValue, type SandMachine } from './sand-machines';
import { pouringCoefficient } from './sand-gating';
import { stagedLookupKey, type SandReference } from './sand-reference';
import { SAND_DOMAIN, sandVariableSeed, seedsFor, valuesProvider, variableProvider, type SeedProvider, type SeedProviders } from './sand-seeds';
import { calculatedSeed, calculationRef, energySeed, inputStep, resultStep, seedStep } from '../casting-source-refs';

export const SAND_PROCESS_GROUP = 'Sand Casting';
export const MOULDING_LINE = 'Sand Casting - Moulding (automatic line)';
export const MOULDING_MANUAL = 'Sand Casting - Moulding (manual flask)';
export const MELTING = 'Sand Casting - Melting';
export const POUR = 'Sand Casting - Pour';
export const COOLING = 'Sand Casting - Cooling';

const LB_PER_KG = 1 / 0.45359237;
const r2 = (n: number) => Math.round(n * 100) / 100;

/** The part's sand-casting material, as the raw_materials row (columns by name). */
export interface SandMaterial {
  /** raw_materials.id: the record the calculator dialog opens for a material input. */
  id: string;
  name: string;
  materialType: string | null;
  /** raw_materials columns the calculators read (density_kg_m3, heat_of_fusion_j_kg, ...). */
  columns: Readonly<Record<string, number | null>>;
}

export interface SandPart {
  netKg: number;
  /** The casting's modulus (volume / surface), mm. */
  modulusMm: number;
  /** Length, width and height of the casting in the mould: height along the draw direction (mm). */
  dimsMm: readonly [number, number, number];
  /** Nominal wall (mm), which section-based pouring coefficients are read by. */
  wallNominalMm: number | null;
}

/** The plant's hot box settings (Cost Guide): the core box temperature and the binder's cure temperature (°C), and the depth of core that must be cured before it is stripped (mm). Each is null until set. */
export interface HotBoxSettings {
  coreboxTempC: number | null;
  cureTempC: number | null;
  curedDepthMm: number | null;
}

export interface SandRouteContext {
  ref: SandReference;
  spec: DomainCalculatorSpec;
  calculators: Readonly<Record<string, ReferenceCalculatorDef>>;
  material: SandMaterial;
  part: SandPart;
  /** Cavities per mould (decided by cavitiesPerMould for the chosen moulding machine). */
  cavities: number;
  /** How the cavity count was decided (cavitiesPerMould), for the eye of every Cavities input. */
  cavitiesRef: SourceRef;
  /** Cores in each casting; a mould has `cavities` times this many. */
  coresPerCasting: number;
  /** How the cores of a casting were counted (the measured cores less those left solid); absent before the cores are known. */
  coresRef?: SourceRef;
  /** Metal poured: the casting with its risers and gating (kg), per casting and per mould, and the calculation behind it once it is run. */
  poured: { perCastingKg: number; perMouldKg: number; ref?: SourceRef };
  /** USD per kWh: the Cost Guide's, else the location's sourced electricity price; null when neither exists (energy not charged). */
  energyPricePerKwh: number | null;
  /** Where the energy price comes from, for the trace. */
  energyPriceSource?: string | null;
  /** The record it was read from (the location's electricity price row, or the Cost Guide entry), for the trace's eye. */
  energyPriceRef?: SourceRef | null;
  hotBox: HotBoxSettings;
  /** The batch size of the scenario (the preparation of a coating or an oven is shared by it). */
  batchSize: number;
}

export type StepOutcome =
  | { ok: true; sec: number; run: ReferenceCalcRun; energyCostUsd: number; notes: string[]; /** Material used by the step (the refractory coating), USD per casting, added to the run cost. */ materialCostUsd?: number; /** The energy price the energy was charged at, and its source (energyBasisOf). */ energyBasis?: string }
  | { ok: false; reasons: string[] };

const fail = (...reasons: string[]): StepOutcome => ({ ok: false, reasons });

/** The metal poured, per casting or per mould, with the metal-per-casting calculation behind it (its ref) when it has been run. */
function pouredSeed(ctx: SandRouteContext, per: 'casting' | 'mould'): CalcSeed {
  return {
    value: per === 'casting' ? ctx.poured.perCastingKg : ctx.poured.perMouldKg,
    source: per === 'casting' ? 'metal per casting: net, risers and gating' : 'metal per casting x cavities',
    ...(ctx.poured.ref ? { ref: ctx.poured.ref } : {}),
  };
}

/** One calculator run: seed every input from its declared source, run it, or say what is missing. */
export function runStep(
  ctx: SandRouteContext,
  calculator: string,
  machine: SandMachine | null,
  engine: Record<string, CalcSeed>,
  extra: SeedProviders = {},
  output = 'Cycle Time',
): { run: ReferenceCalcRun } | { reasons: string[] } {
  const calc = ctx.spec.calculators.find((c) => c.name === calculator);
  if (!calc) return { reasons: [`${calculator} is not in the calculator spec`] };
  const materialProvider: SeedProvider = (key) => {
    const value = ctx.material.columns[key];
    return value == null ? null : {
      value, source: `${ctx.material.name}: ${key}`,
      ref: { kind: 'material', materialId: ctx.material.id, materialName: ctx.material.name, column: key },
    };
  };
  const machineProvider: SeedProvider = (key) => {
    const value = machine ? machineValue(machine, key) : null;
    return value == null || !machine ? null : {
      value, source: `machine ${machine.name}: ${key}`,
      ref: { kind: 'machine', machineId: machine.id, machineName: machine.name, machineClass: machine.machineClass, location: machine.location, column: key },
    };
  };
  const { seeds, missing } = seedsFor(calc, {
    variable: variableProvider(ctx.ref),
    material: materialProvider,
    machine: machineProvider,
    cad: valuesProvider({ modulus_mm: { value: ctx.part.modulusMm, source: 'casting modulus: volume / surface (mm)' } }),
    engine: valuesProvider(engine),
    ...extra,
  });
  if (missing.length) return { reasons: missing.map((m) => `${calculator}: ${m}`) };
  const run = runReferenceCalculator(ctx.calculators, calculator, seeds as Record<string, CalcSeed>, output);
  return run.value == null ? { reasons: run.missing } : { run };
}

export const cavitiesSource = (ctx: SandRouteContext): CalcSeed => ({ value: ctx.cavities, source: 'cavities that fit the flask (layoutNumCav, sand borders)', ref: ctx.cavitiesRef });

/** The cores in a casting, as counted (the measured cores less those left solid). */
export const coresSeed = (ctx: SandRouteContext, source: string): CalcSeed => ({
  value: ctx.coresPerCasting, source,
  ref: ctx.coresRef ?? calculationRef('Cores', [resultStep('Cores', null, ctx.coresPerCasting, 'No core measured')]),
});

/**
 * Cavities per mould: the chosen number; or on moulding lines the most of a layout in layoutNumCav that fits inside the flask's sand
 * borders; one on manual moulding, unless the user asks for more (without pattern costs more cavities would look free). Above
 * largePartThreshold only one fits.
 */
export function cavitiesPerMould(
  ref: SandReference,
  mould: SandMachine,
  [l, w, h]: readonly [number, number, number],
  netKg: number,
  chosen: number | null,
): { cavities: number; ref: SourceRef } | { reasons: string[] } {
  const miss = ref.absent({ numbers: ['largePartThreshold'], tables: ['layoutNumCav'] });
  const [fl, fw, fh] = [machineValue(mould, 'flask_length_mm'), machineValue(mould, 'flask_width_mm'), machineValue(mould, 'flask_height_mm')];
  if (fl == null || fw == null || fh == null) miss.push(`machine ${mould.name}: flask length, width and height`);
  if (miss.length) return { reasons: miss };
  const edge = machineValue(mould, 'sand_border_flask_edge_mm') ?? 0;
  const bottom = machineValue(mould, 'sand_border_flask_bottom_mm') ?? 0;
  const between = machineValue(mould, 'sand_border_between_impressions_mm') ?? 0;
  if (h + 2 * bottom > fh!) return { reasons: [`part height ${h.toFixed(0)} mm with sand borders exceeds the flask height ${fh!.toFixed(0)} mm`] };
  const [ul, uw] = [fl! - 2 * edge, fw! - 2 * edge];
  const row = (n: number, side: number) => n * side + (n - 1) * between;
  const fits = (nl: number, nw: number) => (row(nl, l) <= ul && row(nw, w) <= uw) || (row(nl, l) <= uw && row(nw, w) <= ul);
  const threshold = ref.number('largePartThreshold')!;
  const large = netKg > threshold;
  const layouts = ref.table('layoutNumCav').map((r) => [Number(r['Cavities Length Wise']), Number(r['Cavities Width Wise']), Number(r['Number of Cavities'])] as const);
  const possible = (n: number) => (n === 1 || !large) && layouts.some(([nl, nw, k]) => k === n && fits(nl, nw));
  const doesNotFit = `part ${l.toFixed(0)} x ${w.toFixed(0)} mm does not fit the flask ${fl!.toFixed(0)} x ${fw!.toFixed(0)} mm`;
  // How the count was decided, for the eye of every Cavities input: the part, the layoutNumCav row that fits the moulding machine's flask
  // with its sand borders, and the large-part limit. The flask is named by no machine (the moulding line shows which and checks the fit), so
  // the steps after moulding stay shared by the moulding machines that give the same count the same way.
  const fitSteps = (n: number): CalculationTraceStep[] => {
    const layout = layouts.find(([nl, nw, k]) => k === n && fits(nl, nw));
    return [
      inputStep('Part length', 'mm', l, 'CAD: the part across the draw direction, its longer side'),
      inputStep('Part width', 'mm', w, 'CAD: the part across the draw direction, its shorter side'),
      inputStep('Flask', null, 'holds the layout',
        "The moulding machine's flask less its sand borders (flask_length_mm, flask_width_mm, sand_border_flask_edge_mm, sand_border_between_impressions_mm): the moulding line's machine"),
      ...(layout ? [inputStep('Layout', null, `${layout[0]} × ${layout[1]}`, `layoutNumCav: ${layout[2]} cavit${layout[2] === 1 ? 'y' : 'ies'}`, {
        kind: 'lookup', domain: SAND_DOMAIN, table: stagedLookupKey('layoutNumCav'), column: 'Number of Cavities',
        row: { 'Cavities Length Wise': layout[0], 'Cavities Width Wise': layout[1], 'Number of Cavities': layout[2] },
      } as SourceRef)] : []),
      ...(n > 1 || large ? [
        inputStep('Part weight', 'kg', netKg, 'Part volume x the material density'),
        inputStep('largePartThreshold', 'kg', threshold, 'Sand casting variable largePartThreshold', { kind: 'variable', domain: SAND_DOMAIN, name: 'largePartThreshold' }),
      ] : []),
    ];
  };
  const decided = (n: number, first: CalculationTraceStep[], why: string) => ({
    cavities: n, ref: calculationRef('Cavities per mould', [...first, ...fitSteps(n), resultStep('Cavities', null, n, why)]),
  });
  if (chosen != null) {
    return possible(chosen)
      ? decided(chosen, [inputStep('Cavities set in the Cost Guide', null, chosen, "The part's Cost Guide (cavityCount)")], 'The Cost Guide count, its layout fitting the flask with its sand borders')
      : { reasons: [`${chosen} cavities do not fit the flask ${fl!.toFixed(0)} x ${fw!.toFixed(0)} mm`] };
  }
  const lineRate = machineValue(mould, 'mold_rate_no_core_cycles_per_hr') ?? 0;
  const isLine = lineRate > 0;
  if (!isLine) {
    return possible(1)
      ? decided(1, [inputStep('Moulding', null, 'manual flask', "The moulding machine has no automatic line rate (mold_rate_no_core_cycles_per_hr): a manual flask")],
        'One cavity on manual moulding, unless the Cost Guide asks for more')
      : { reasons: [doesNotFit] };
  }
  const most = Math.max(0, ...layouts.map(([, , k]) => k).filter(possible));
  return most > 0
    ? decided(most, [], large ? 'One cavity: the part is heavier than largePartThreshold' : 'The most cavities of a layoutNumCav layout that fits the flask with its sand borders')
    : { reasons: [doesNotFit] };
}

const isPit = (m: SandMachine) => m.machineClass === 'sand_casting_manual_pit_moldmaking';

/** Moulding: an automatic line (slowed per core) or a manual flask (with the cure time of the process's sand). */
export function mouldStep(ctx: SandRouteContext, mould: SandMachine): StepOutcome {
  if ((machineValue(mould, 'mold_rate_no_core_cycles_per_hr') ?? 0) > 0) {
    const r = runStep(ctx, MOULDING_LINE, mould, {
      cavities: cavitiesSource(ctx),
      cores_per_mould: calculatedSeed(ctx.coresPerCasting * ctx.cavities, 'cores per casting x cavities', 'Cores per Mould', [
        seedStep('Cores per casting', null, coresSeed(ctx, 'the sand cores of one casting')),
        seedStep('Cavities', null, cavitiesSource(ctx)),
        resultStep('Cores per Mould', null, ctx.coresPerCasting * ctx.cavities, '{Cores per casting} x {Cavities}'),
      ]),
    });
    return 'run' in r ? { ok: true, sec: r.run.value!, run: r.run, energyCostUsd: 0, notes: [] } : fail(...r.reasons);
  }
  const cure = { sand_casting_manual_floor_moldmaking: 'sandCureTimeManualFloor', sand_casting_manual_pit_moldmaking: 'sandCureTimeManualPit' }[mould.machineClass] ?? 'sandCureTimeManualStd';
  const cureMin = ctx.ref.number(cure);
  if (cureMin == null) return fail(`sand variable ${cure}`);
  const r = runStep(ctx, MOULDING_MANUAL, mould, {
    cavities: cavitiesSource(ctx),
    poured_per_mould_kg: pouredSeed(ctx, 'mould'),
    sand_cure_min: sandVariableSeed(ctx.ref, cure, cureMin),
  });
  return 'run' in r ? { ok: true, sec: r.run.value!, run: r.run, energyCostUsd: 0, notes: [] } : fail(...r.reasons);
}

/**
 * Melting: the furnace must reach the pouring temperature (the material's injection temperature) and hold one mould's metal
 * (furnaceCapacitySafetyFactor). The energy price is the user's: unset, the energy is not charged and the line says so.
 */
export function meltStep(ctx: SandRouteContext, furnace: SandMachine): StepOutcome {
  const pourTemp = ctx.material.columns['injection_temp_c'];
  const density = ctx.material.columns['density_kg_m3'];
  const safety = ctx.ref.number('furnaceCapacitySafetyFactor');
  const reasons: string[] = [];
  if (pourTemp == null) reasons.push(`${ctx.material.name}: injection_temp_c (the pouring temperature)`);
  if (density == null || !(density > 0)) reasons.push(`${ctx.material.name}: density_kg_m3`);
  if (safety == null) reasons.push('sand variable furnaceCapacitySafetyFactor');
  const maxTemp = machineValue(furnace, 'max_temperature_c');
  const capacity = machineValue(furnace, 'furnace_capacity_m3');
  if (maxTemp == null) reasons.push(`machine ${furnace.name}: max_temperature_c`);
  if (capacity == null) reasons.push(`machine ${furnace.name}: furnace_capacity_m3`);
  if (reasons.length) return fail(...reasons);
  if (maxTemp! < pourTemp!) return fail(`reaches ${maxTemp!.toFixed(0)} °C, the metal is poured at ${pourTemp!.toFixed(0)} °C`);
  const needM3 = (safety! * ctx.poured.perMouldKg) / density!;
  if (capacity! < needM3) return fail(`holds ${capacity} m³, one mould needs ${needM3.toFixed(3)} m³`);
  const priced = ctx.energyPricePerKwh != null;
  const r = runStep(
    ctx, MELTING, furnace,
    { poured_kg: pouredSeed(ctx, 'casting') },
    { scenario: valuesProvider({ energy_price: energySeed(ctx) }) },
  );
  if (!('run' in r)) return fail(...r.reasons);
  const energy = r.run.outputs['Energy Cost'];
  if (energy == null) return fail(`${MELTING} has no Energy Cost`);
  return {
    ok: true, sec: r.run.value!, run: r.run, energyCostUsd: priced ? energy : 0, ...(priced ? { energyBasis: energyBasisOf(ctx) } : {}),
    notes: priced ? [] : ['Melting energy is not charged: the location has no electricity price (location_electricity_prices) and none is set in the Cost Guide.'],
  };
}

/** Pouring: the ladle must hold one mould; the coefficient is the material's row of tblPouringCoefficients for the poured weight or the section. */
export function pourStep(ctx: SandRouteContext, ladle: SandMachine): StepOutcome {
  const capacity = machineValue(ladle, 'ladle_weight_capacity_kg');
  if (capacity == null) return fail(`machine ${ladle.name}: ladle_weight_capacity_kg`);
  if (capacity < ctx.poured.perMouldKg) return fail(`ladle holds ${capacity} kg, one mould needs ${ctx.poured.perMouldKg.toFixed(1)} kg`);
  const coefficient = pouringCoefficient(ctx.ref, ctx.material.materialType, ctx.poured.perMouldKg * LB_PER_KG, ctx.part.wallNominalMm != null ? ctx.part.wallNominalMm / 25.4 : null);
  if ('missing' in coefficient) return fail(coefficient.missing);
  const r = runStep(
    ctx, POUR, ladle,
    { poured_per_mould_kg: pouredSeed(ctx, 'mould'), cavities: cavitiesSource(ctx) },
    { lookup: (key) => (key === 'tblPouringCoefficients.Coefficient' ? { value: coefficient.value, source: coefficient.source, lookup: true } : null) },
  );
  return 'run' in r ? { ok: true, sec: r.run.value!, run: r.run, energyCostUsd: 0, notes: [] } : fail(...r.reasons);
}

/** Cooling in the mould (Chvorinov's rule), with the exponent for pit moulds or the others. */
export function coolStep(ctx: SandRouteContext, machine: SandMachine, pit: boolean): StepOutcome {
  const name = pit ? 'modulusConstantManualPitMoldmaking' : 'modulusConstant';
  const exponent = ctx.ref.number(name);
  if (exponent == null) return fail(`sand variable ${name}`);
  const r = runStep(ctx, COOLING, machine, {
    cavities: cavitiesSource(ctx),
    modulus_exponent: sandVariableSeed(ctx.ref, name, exponent),
  });
  return 'run' in r ? { ok: true, sec: r.run.value!, run: r.run, energyCostUsd: 0, notes: [] } : fail(...r.reasons);
}

/** Ranks a capable machine outside the ones chosen from (the virtual, the preferred) after every one of those, whatever it costs. */
const NOT_PREFERRED_RANK = 1e12;

export interface CostedStep {
  line: ProcessLineCost;
  machine: SandMachine | null;
  outcome: Extract<StepOutcome, { ok: true }> | null;
  warnings: string[];
}

/** The energy price a step's energy is charged at, with where it comes from, for the line (the trace has it too). */
export function energyBasisOf(ctx: Pick<SandRouteContext, 'energyPricePerKwh' | 'energyPriceSource'>): string | undefined {
  return ctx.energyPricePerKwh != null ? `${ctx.energyPricePerKwh} USD/kWh (${ctx.energyPriceSource ?? 'energy price'})` : undefined;
}

/**
 * The machine of a step, chosen technically first and then by cost, and costed as a casting line: only the machines `evaluate` finds capable
 * (each technical criterion the step states) are compared; of them the virtual machines when one is capable and the data's
 * preferVirtualMachines says so (Assembly: "first try to select a virtual machine, if present and feasible"), then the plant's preferred
 * machines when one is capable and usePreferredMachines says so; then the cheapest cost per part. With no capable machine the line is a
 * named gap carrying every machine's reason.
 */
export function selectAndCost(input: {
  process: string;
  machineClass: string;
  machines: readonly SandMachine[];
  evaluate: (machine: SandMachine) => StepOutcome;
  batchSize: number;
  costContext: CostContext;
  ref: SandReference;
  criteria: string[];
  /** The process group of the line; sand casting when absent (the other casting routes that cost their steps the same way name their own). */
  processGroup?: string;
  /** What one part of the route is called in the line's breakdown ("12 s per casting"); a casting when absent, a forging for the forging route. */
  partName?: string;
  /** The line's process route when it is not the process itself (memory's Hydroform:Hydroform Deep Draw); the process when absent. */
  processRoute?: string;
}): CostedStep {
  const processGroup = input.processGroup ?? SAND_PROCESS_GROUP;
  const warnings: string[] = [];
  const evaluated = input.machines.map((m) => {
    if (m.machineRatePerHr == null) return { m, outcome: fail('no machine hour rate on file, and the HR Rates engine could not price it') as StepOutcome, costed: null as ProcessLineCost | null };
    const outcome = input.evaluate(m);
    if (!outcome.ok) return { m, outcome, costed: null };
    const base = line({
      process: input.process, processGroup, processRoute: input.processRoute ?? input.process, machineClass: input.machineClass,
      machine: asFinishingMachine(m), sec: outcome.sec, batchSize: input.batchSize, costContext: input.costContext, warnings: [], run: outcome.run,
      breakdown: `${input.process}: ${roundSec(outcome.sec)} s per ${input.partName ?? 'casting'}${m.rateSource === 'engine' ? ' (machine hour rate from the HR Rates engine)' : ''}`,
    });
    // Charged beyond time: the step's energy and material, its own figure on the line (stored and shown), kept below a cent.
    const material = outcome.materialCostUsd ?? 0;
    const other = outcome.energyCostUsd + material;
    const detail = [outcome.energyCostUsd ? `energy ${roundPerPart(outcome.energyCostUsd)}` : '', material ? `material ${roundPerPart(material)}` : ''].filter(Boolean).join(' + ');
    const costed: ProcessLineCost = other
      ? { ...base, runCost: roundLineCost(base.runCost + other), totalCost: roundLineCost(base.totalCost + other), otherCostPerPartUsd: roundPerPart(other), otherCostDetail: `${detail} USD per ${input.partName ?? 'casting'}${outcome.energyBasis ? ` at ${outcome.energyBasis}` : ''}` }
      : base;
    return { m, outcome, costed };
  });
  const capable = evaluated.filter((e) => e.costed);
  // The data writes the switch as true/false (every memory domain: true), so it is read as a flag: read as a number it was never on.
  const virtualOnly = input.ref.flag('preferVirtualMachines') === true && capable.some((e) => e.m.virtual);
  const afterVirtual = virtualOnly ? capable.filter((e) => e.m.virtual) : capable;
  const preferOnly = input.ref.flag('usePreferredMachines') === true && afterVirtual.some((e) => e.m.preferred);
  const pool = preferOnly ? afterVirtual.filter((e) => e.m.preferred) : afterVirtual;
  // The line's cost is rounded to the cent, so two machines can tie on it while one costs less: the cycle's machine and labour cost per part,
  // kept finer, decides between them before the name does.
  const fine = (c: ProcessLineCost) => (c.machineCostPerPart ?? 0) + (c.laborCostPerPart ?? 0);
  const best = [...pool].sort((a, b) => a.costed!.totalCost - b.costed!.totalCost || fine(a.costed!) - fine(b.costed!) || a.m.name.localeCompare(b.m.name))[0];
  // A capable machine that is not preferred, when the choice is among the preferred ones: it stays counted as capable (it met every
  // technical criterion), listed after the preferred machines and said to be outside them.
  const evals: ChoiceEval[] = evaluated.map((e) => {
    if (!e.outcome.ok || !e.costed) return { name: e.m.name, reasons: e.outcome.ok ? [] : e.outcome.reasons, cost: null };
    const note = virtualOnly && !e.m.virtual ? 'capable, not a virtual machine (preferVirtualMachines)'
      : preferOnly && !e.m.preferred ? 'capable, not a preferred machine (usePreferredMachines)' : null;
    return {
      name: e.m.name, reasons: [], cost: e.costed.totalCost,
      ...(note ? { note, rank: NOT_PREFERRED_RANK + e.costed.totalCost } : {}),
    };
  });
  const choice: MachineChoiceDto = machineChoice({
    rule: `Technical first, then cost: only the machines that meet every criterion below,${virtualOnly ? ' of them the virtual machines (preferVirtualMachines),' : ''}${preferOnly ? ` of ${virtualOnly ? 'those' : 'them'} the plant's preferred machines (usePreferredMachines),` : ''} then the cheapest cost per part (machine rate, crew, setup and energy)`,
    criteria: input.criteria,
    evals,
    chosen: best?.m.name ?? null,
  });
  if (!best) {
    const first = evaluated.find((e) => !e.outcome.ok);
    const why = first && !first.outcome.ok ? `${first.m.name}: ${first.outcome.reasons.join('; ')}` : `no machines of class ${input.machineClass}`;
    return {
      line: { ...gap(input.process, processGroup, input.machineClass, `no ${input.process} machine fits (${why})`), processRoute: input.processRoute ?? input.process, machineChoice: choice },
      machine: null, outcome: null, warnings,
    };
  }
  const outcome = best.outcome as Extract<StepOutcome, { ok: true }>;
  warnings.push(...outcome.notes);
  if (best.m.rateSource === 'engine' && best.m.assumedDefaults.length) {
    warnings.push(`${best.m.name}: the machine hour rate comes from the HR Rates engine, which assumed its defaults for ${best.m.assumedDefaults.join(', ')}.`);
  }
  return { line: { ...best.costed!, machineChoice: choice }, machine: best.m, outcome, warnings };
}
