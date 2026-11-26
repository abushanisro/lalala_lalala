/**
 * The inputs of the plastic-molding cycle-time calculators (plastic-molding-calculators.json), seeded from what the cost engine already holds: the material's
 * reference thermal properties, the selected press's timing, the staged Plastic reference (variables and the injectionTimeAdjustmentFactors table), the CAD wall
 * and the route's shot volume. Each seed names its source, as the other domains' seeds do (reference-calculator.ts), so the cost dialog can show where every
 * number came from. The formulas are the calculator's, stored in the database; nothing here computes a time.
 *
 * What the engine decides stays here, not in a formula: whether an input exists, and whether the Menges equation has a solution (the eject temperature must lie
 * between the mold wall and the melt). Both come back as named missing inputs, never a default.
 *
 * Each seed also carries where it was read, structured (plastic-input-sources.ts), so the calculator dialog's eye opens it: a staged variable or lookup row,
 * the press's HR Rates record, the resin's Raw Materials record, the CAD faces or feature it was measured on, a row of the bundled reference package
 * (reference/*.csv, served as a lookup: served-reference-tables.ts), the location's electricity price, the part's costing inputs; a value the engine works
 * out from several facts (the shot melt volume, the resin per part, the cavity count, a cure time with none on file) is the calculation it is, step by step,
 * passed in by the engine that worked it out.
 */
import { dryerRef, dryingRef, type DryerModel, type DryingCondition, type InsertPullTestReference, type ReferenceValue, type WeightCheckReference } from '../reference/im-reference';
import type { CalcSeed } from '../../shared/calculators/reference-calculator';
import type { CalculationTraceStep, SourceRef } from '../../../dto/cost-breakdown.dto';
import { machineColumn, materialColumn, plasticLookup, plasticVariable, secondaryVariable, withRef, type MachineRecord, type MaterialRecord } from './plastic-input-sources';
import { SECONDARY_PROCESS_DOMAIN } from '../plastic-reference';
import { bracketFactor, hasMengesSolution, resinThermalProps, type CycleTimeInput } from '../process/cycle-time';

const positive = (v: number | null | undefined): v is number => v != null && Number.isFinite(v) && v > 0;

export const INJECTION_CALCULATOR = 'Injection Molding - Cycle Time';
export const STRUCTURAL_FOAM_CALCULATOR = 'Structural Foam Molding - Cycle Time';
export const LSR_CALCULATOR = 'Injection Molding - LSR Cycle Time';
export const COMPRESSION_CALCULATOR = 'Compression Molding - Cycle Time';
export const RIM_CALCULATOR = 'Reaction Injection Molding - Cycle Time';
export const DEFLASH_CALCULATOR = 'Injection Molding - Deflashing';

/** Seeds for the deflashing calculator: the CAD parting line length and the reference trimming rate, or the ones that are missing. */
export function deflashingSeeds(input: { partingLineLengthMm: number | null; partingLineFeatureId?: string | null; rateMmPerS: number | null }): SeedResult {
  const missing: string[] = [];
  if (!positive(input.partingLineLengthMm)) missing.push('parting line length (CAD PartingLine feature)');
  if (!positive(input.rateMmPerS)) missing.push('manual flash trimming rate (cmManualFlashTrimmingRate)');
  if (missing.length > 0) return { missing };
  return { seeds: {
    'Parting Line Length': {
      value: input.partingLineLengthMm!, source: 'CAD PartingLine feature: measured parting line length',
      // The PartingLine feature it was measured on (plastic feature graph id): its eye lights the parting line.
      ...(input.partingLineFeatureId ? { ref: { kind: 'features' as const, label: 'parting line', features: [{ featureId: input.partingLineFeatureId }] } } : {}),
    },
    'Manual Flash Trimming Rate': { value: input.rateMmPerS!, source: `${REF}/variables: cmManualFlashTrimmingRate (compression molding, borrowed for injection; read as mm/s)`, ref: plasticVariable('cmManualFlashTrimmingRate') },
  } };
}

export const GATE_TRIM_CALCULATOR = 'Injection Molding - Gate Trimming';

/** Seeds for the gate trimming calculator (F-38, formula registry): the part surface, the edge-gate width constant, the gates per cavity and the manual trim rate. */
export function gateTrimmingSeeds(input: {
  surfaceAreaMm2: number | null; gateConstant: { n: number; family: string; confidence: string; source: string; ref: SourceRef } | null;
  gatesPerCavity: number | null; rateMmPerS: number | null;
}): SeedResult {
  const missing: string[] = [];
  if (!positive(input.surfaceAreaMm2)) missing.push('the part surface area (CAD)');
  if (!input.gateConstant) missing.push('the edge gate width constant (reference/gate-sizing-reference.csv)');
  if (!positive(input.gatesPerCavity)) missing.push('the gates per cavity (defaultNumberOfGatesPerCavity)');
  if (!positive(input.rateMmPerS)) missing.push('the manual trim rate (manualTrimRate)');
  if (missing.length > 0 || !input.gateConstant) return { missing };
  const g = input.gateConstant;
  return { seeds: {
    'Part Surface Area': { value: input.surfaceAreaMm2!, source: 'CAD part surface area (the cavity surface the gate fills)', ref: { kind: 'cad', evidence: 'part_surface' } },
    'Gate Width Constant': { value: g.n, source: `reference/gate-sizing-reference.csv: ${g.family} n = ${g.n} (${g.confidence}; ${g.source})`, lookup: true, ref: g.ref },
    'Gates per Cavity': { value: input.gatesPerCavity!, source: `${REF}/variables: defaultNumberOfGatesPerCavity`, ref: plasticVariable('defaultNumberOfGatesPerCavity') },
    'Manual Trim Rate': { value: input.rateMmPerS!, source: `${REF}/variables: manualTrimRate (read as mm/s, its unit in memory/Roto & blow molding)`, ref: plasticVariable('manualTrimRate') },
  } };
}

export const SLIDE_MOVEMENT_CALCULATOR = 'Injection Molding - Slide Movement';

/** Seeds for the slide movement calculator (F-32): the longest CAD slide stroke, the reference slide speed and the cavities, or what is missing. */
export function slideMovementSeeds(input: { slideStrokeMm: number | null; slideStrokeBundleId?: string | null; rateMmPerS: number | null; cavities: number; cavitiesRef?: SourceRef | null }): SeedResult {
  const missing: string[] = [];
  if (!positive(input.slideStrokeMm)) missing.push('the slide stroke (CAD SlideBundle stroke)');
  if (!positive(input.rateMmPerS)) missing.push('the slide speed (slideCycleRate)');
  if (missing.length > 0) return { missing };
  return { seeds: {
    'Slide Stroke': {
      value: input.slideStrokeMm!, source: 'CAD SlideBundle: the longest stroke (the slides move out and back together each shot)',
      // The bundle it was measured on (plastic feature graph id): its eye lights that slide.
      ...(input.slideStrokeBundleId ? { ref: { kind: 'features' as const, label: 'slide bundle', features: [{ featureId: input.slideStrokeBundleId }] } } : {}),
    },
    'Slide Cycle Rate': { value: input.rateMmPerS!, source: `${REF}/variables: slideCycleRate (Velocity, read as mm/s)`, ref: plasticVariable('slideCycleRate') },
    'Cavities per Mold': withRef({ value: input.cavities, source: 'The costed cavity count' }, input.cavitiesRef ?? undefined),
  } };
}

// Formula registry (plastic-molding/formula-registry.ts): F-34 is the visual inspection calculator's formula.
export const VISUAL_INSPECTION_CALCULATOR = 'Injection Molding - Visual Inspection';

/** Seeds for the visual inspection calculator (F-34): the CAD surface area and the secondary-process inspection rate and share, or what is missing. */
export function visualInspectionSeeds(input: { surfaceAreaMm2: number | null; minPerM2: number | null; percent: number | null }): SeedResult {
  const missing: string[] = [];
  if (!positive(input.surfaceAreaMm2)) missing.push('the part surface area (CAD)');
  if (!positive(input.minPerM2)) missing.push('the visual inspection rate (memory/Secondary process visualInspectTimeStandard)');
  if (!positive(input.percent)) missing.push('the share of parts inspected (memory/Secondary process defaultPercentToBeTested)');
  if (missing.length > 0) return { missing };
  return { seeds: {
    'Part Surface Area': { value: input.surfaceAreaMm2!, source: 'CAD part surface area', ref: { kind: 'cad', evidence: 'part_surface' } },
    'Visual Inspection Rate': {
      value: input.minPerM2!, source: 'memory/Secondary process/variables_inherited: visualInspectTimeStandard (average time per surface area to visually inspect a part)',
      ref: secondaryVariable('visualInspectTimeStandard'),
    },
    'Percent Inspected': { value: input.percent!, source: 'memory/Secondary process/variables_inherited: defaultPercentToBeTested', ref: secondaryVariable('defaultPercentToBeTested') },
  } };
}

// Formula registry (plastic-molding/formula-registry.ts): F-35 is the weight check calculator's formula.
export const WEIGHT_CHECK_CALCULATOR = 'Injection Molding - Weight Check';

/** Seeds for the weight check calculator (F-35) from the reference package, or what is missing. Each input says its confidence and source. */
export function weightCheckSeeds(ref: WeightCheckReference): SeedResult {
  const fields: Array<[string, keyof WeightCheckReference]> = [
    ['Time Per Check', 'timePerCheckS'], ['Sampling Interval', 'samplingInterval'], ['Scale Price', 'scalePriceUsd'], ['Equipment Life', 'lifeYr'],
    ['Salvage Factor', 'salvagePct'], ['Maintenance Factor', 'maintenancePct'], ['Installation Factor', 'installationPct'], ['Scheduled Hours', 'scheduledHours'],
    ['Uptime', 'uptimePct'], ['Utilization', 'utilization'],
  ];
  const missing = fields.filter(([, k]) => ref[k] == null).map(([name]) => `${name} (reference package)`);
  if (missing.length > 0) return { missing };
  return { seeds: Object.fromEntries(fields.map(([name, k]) => {
    const v = ref[k]!;
    return [name, { value: v.value, source: `${v.source} (${v.confidence})`, lookup: true, ref: v.ref }];
  })) };
}

// Formula registry (plastic-molding/formula-registry.ts): F-40 is the insert pull test calculator's formula.
export const INSERT_PULL_TEST_CALCULATOR = 'Injection Molding - Insert Pull Test';

export interface InsertPullTestInput {
  ref: InsertPullTestReference;
  insertsPerPart: number | null;
  batchSize: number;
  /** The reference's AQL sample sizes (memory/Secondary process CMMInspection at defaultCMMInspection), or null when not staged. */
  aql: { inspectionType: string; rows: ReadonlyArray<{ batch: number; sample: number }> } | null;
  /** What one tested (scrapped) part has cost by then: its material and its molding lines, USD. */
  testedPartUsd: number | null;
  /** How the tested part's cost was summed (its material and each line so far), for that input's eye; absent when not given. */
  testedPartRef?: SourceRef | null;
  /** Where the inserts per part were counted (the BOM, the Cost Guide or the CAD insert candidates), for that input's eye; absent when not given. */
  insertsRef?: SourceRef | null;
}

/** Seeds for the insert pull test calculator (F-40): the sample of the batch pulled to failure, its time and tester, and the parts it destroys. */
export function insertPullTestSeeds(input: InsertPullTestInput): SeedResult {
  const r = input.ref;
  const fields: Array<[string, keyof InsertPullTestReference]> = [
    ['Sample Handling Time', 'sampleHandlingS'], ['Insert Seat Time', 'insertSeatS'], ['Pull Displacement', 'pullDisplacementMm'], ['Pull Speed', 'pullSpeedMmPerMin'],
    ['Approach and Return Time', 'approachReturnS'], ['Record Time', 'recordS'], ['Tester Price', 'testerPriceUsd'], ['Equipment Life', 'lifeYr'],
    ['Salvage Factor', 'salvagePct'], ['Maintenance Factor', 'maintenancePct'], ['Installation Factor', 'installationPct'], ['Scheduled Hours', 'scheduledHours'],
    ['Uptime', 'uptimePct'], ['Utilization', 'utilization'],
  ];
  const missing = fields.filter(([, k]) => r[k] == null).map(([name]) => `${name} (reference package)`);
  if (!positive(input.insertsPerPart)) missing.push('the inserts per part');
  if (!positive(input.batchSize)) missing.push('the batch size');
  const row = input.aql?.rows.find((x) => input.batchSize <= x.batch);
  if (!row) missing.push('the AQL sample size for the batch (memory/Secondary process CMMInspection)');
  if (input.testedPartUsd == null || !(input.testedPartUsd >= 0)) missing.push('the cost of a tested part');
  if (missing.length > 0 || !row || !input.aql) return { missing };
  return { seeds: {
    ...Object.fromEntries(fields.map(([name, k]) => [name, { value: r[k]!.value, source: `${r[k]!.source} (${r[k]!.confidence})`, lookup: true, ref: r[k]!.ref }])),
    'Inserts per Part': withRef({ value: input.insertsPerPart!, source: "The part's inserts (BOM, Cost Guide or CAD insert candidates)" }, input.insertsRef ?? undefined),
    'Batch Size': { value: input.batchSize, source: 'Scenario: batch size', ref: { kind: 'costingInput', field: 'batchSize' } },
    'Sample Size': sampleSizeSeed(input.aql, row, input.batchSize),
    'Tested Part Cost': withRef({ value: input.testedPartUsd!, source: "The part's material and molding cost per part, scrapped with each sample" }, input.testedPartRef ?? undefined),
  } };
}

/** The AQL sample of the batch: the CMMInspection row's sample, or the whole batch when it is smaller (the calculation then shows both). */
function sampleSizeSeed(aql: NonNullable<InsertPullTestInput['aql']>, row: { batch: number; sample: number }, batchSize: number): CalcSeed {
  const source = `memory/Secondary process/lookup/CMMInspection: ${aql.inspectionType}, batch up to ${row.batch} -> ${row.sample} (defaultCMMInspection; a destructive test samples at a special level, ISO 2859-1)`;
  const rowRef: SourceRef = { kind: 'lookup', domain: SECONDARY_PROCESS_DOMAIN, table: 'CMMInspection', column: 'Sample Size', row: { 'Inspection Type': aql.inspectionType, 'Batch Size': row.batch } };
  if (row.sample <= batchSize) return { value: row.sample, source, lookup: true, ref: rowRef };
  return {
    value: batchSize, source, lookup: true,
    ref: calc('Sample Size: the AQL sample, at most the batch', [
      inputStep('AQL sample', null, row.sample, source, rowRef),
      inputStep('Batch size', null, batchSize, "The part's batch", { kind: 'costingInput', field: 'batchSize' }),
      resultStep('Sample Size', null, batchSize, 'min({AQL sample}, {Batch size})'),
    ]),
  };
}

// Formula registry (plastic-molding/formula-registry.ts): F-36 is the material drying calculator's formula.
export const MATERIAL_DRYING_CALCULATOR = 'Injection Molding - Material Drying';

export interface MaterialDryingInput {
  grade: string | null;
  condition: DryingCondition | null;
  resinPerPartKg: number | null;
  pressTimePerPartSec: number | null;
  /** The cycle calculation the press time per part comes from (its steps), for that input's source; absent when not given. */
  pressTimeRef?: SourceRef | null;
  /** How the resin per part was worked out (the shot weight per part), for that input's eye; absent when not given. */
  resinPerPartRef?: SourceRef | null;
  dryers: readonly DryerModel[];
  electricity: { usdPerKwh: number; source: string; ref?: SourceRef } | null;
  economics: Record<'lifeYr' | 'maintenancePct' | 'installationPct' | 'salvagePct' | 'uptimePct' | 'utilization' | 'scheduledHours', ReferenceValue | null>;
}

/**
 * Seeds for the material drying calculator (F-36), or what is missing. The dryer is the smallest model whose nylon throughput covers the press's resin
 * demand; its price is the priced model of a throughput at least as large (the only published price, used); a demand no priced model covers is a gap.
 */
export function materialDryingSeeds(input: MaterialDryingInput): SeedResult {
  const missing: string[] = [];
  if (!input.condition) missing.push(`the drying conditions of ${input.grade ?? 'the resin'} (reference/material-drying-reference.csv has no row for it)`);
  if (!positive(input.resinPerPartKg)) missing.push('the resin per part (shot weight)');
  if (!positive(input.pressTimePerPartSec)) missing.push('the press time per part (cycle time)');
  if (!input.electricity) missing.push('the location electricity price (location_electricity_prices)');
  const econ = Object.entries(input.economics).filter(([, v]) => v == null).map(([k]) => `equipment economics: ${k}`);
  missing.push(...econ);
  const demand = positive(input.resinPerPartKg) && positive(input.pressTimePerPartSec) ? (input.resinPerPartKg! * 3600) / input.pressTimePerPartSec! : null;
  const sized = [...input.dryers].filter((d) => d.ratedKw != null).sort((a, b) => a.throughputKgH - b.throughputKgH);
  const priced = [...input.dryers].filter((d) => d.priceUsd != null).sort((a, b) => a.throughputKgH - b.throughputKgH);
  const dryer = demand != null ? sized.find((d) => d.throughputKgH >= demand) ?? null : null;
  const price = dryer ? priced.find((d) => d.throughputKgH >= dryer.throughputKgH) ?? null : null;
  if (demand != null && !dryer) missing.push(`a dryer for ${demand.toFixed(1)} kg/h (the largest reference model dries ${sized[sized.length - 1]?.throughputKgH ?? 0} kg/h)`);
  if (dryer && !price) missing.push(`a dryer price for the ${dryer.throughputKgH} kg/h class (reference/dryer-models-reference.csv holds none)`);
  if (missing.length > 0) return { missing };
  const c = input.condition!;
  const e = input.economics;
  const econSeed = (v: ReferenceValue): CalcSeed => ({ value: v.value, source: `${v.source} (${v.confidence})`, lookup: true, ref: v.ref });
  return { seeds: {
    // The upper end of the row's range (the slower drying): the row's _max column.
    'Drying Temperature': { value: Number(c.tempC.split('-').pop()), source: `${c.source}: ${c.material} (${c.grade}) ${c.tempC} degC (${c.confidence})`, lookup: true, ref: dryingRef(c, 'drying_temp_c_max') },
    'Drying Time': {
      value: Number(c.timeH.split('-').pop()), source: `${c.source}: ${c.material} (${c.grade}) ${c.timeH} h (${c.confidence}); the dryer's nylon throughput is rated at a 5-6 h residence`,
      lookup: true, ref: dryingRef(c, 'drying_time_h_max'),
    },
    'Resin Per Part': withRef({ value: input.resinPerPartKg!, source: 'The shot weight per part, runner included' }, input.resinPerPartRef ?? undefined),
    'Press Time Per Part': withRef({ value: input.pressTimePerPartSec!, source: 'The press cycle per good part (the dryer runs with the press)' }, input.pressTimeRef ?? undefined),
    'Dryer Throughput': {
      value: dryer!.throughputKgH, source: `${dryer!.source}: ${dryer!.model}, the smallest covering ${demand!.toFixed(1)} kg/h (${dryer!.confidence})`, lookup: true,
      ref: dryerRef(dryer!, 'nylon_throughput_kg_h'),
    },
    'Dryer Power': { value: dryer!.ratedKw!, source: `${dryer!.source}: ${dryer!.model} rated power (heaters cycle: an upper bound) (${dryer!.confidence})`, lookup: true, ref: dryerRef(dryer!, 'rated_kw') },
    'Dryer Price': { value: price!.priceUsd!, source: `${price!.source}: ${price!.model}, ${price!.priceBasis} (${price!.confidence}: replace with a quotation)`, lookup: true, ref: dryerRef(price!, 'price_usd') },
    'Electricity Price': withRef({ value: input.electricity!.usdPerKwh, source: input.electricity!.source, lookup: true }, input.electricity!.ref),
    'Equipment Life': econSeed(e.lifeYr!), 'Salvage Factor': econSeed(e.salvagePct!), 'Maintenance Factor': econSeed(e.maintenancePct!),
    'Installation Factor': econSeed(e.installationPct!), 'Scheduled Hours': econSeed(e.scheduledHours!), 'Uptime': econSeed(e.uptimePct!), 'Utilization': econSeed(e.utilization!),
  } };
}

export type SeedResult = { seeds: Record<string, CalcSeed> } | { missing: string[] };

const r4 = (v: number) => (Math.abs(v) >= 100 ? Math.round(v * 100) / 100 : Math.round(v * 10000) / 10000);
/** An input step of a calculation ref: a value and where it came from, with its own ref when it has one. */
export const inputStep = (label: string, unit: string | null, value: number | string, source: string, ref?: SourceRef): CalculationTraceStep => ({
  fieldName: label, displayLabel: unit ? `${label} (${unit})` : label, kind: 'input', value: typeof value === 'number' ? r4(value) : value, unit, source, ...(ref ? { ref } : {}),
});
/** The calculated step of a calculation ref: its value and the formula that gives it. */
export const resultStep = (label: string, unit: string | null, value: number, formula: string): CalculationTraceStep => ({
  fieldName: label, displayLabel: unit ? `${label} (${unit})` : label, kind: 'calculated', value: r4(value), unit, formula, stepType: 'physics',
});
/** A calculation ref: the value worked out step by step (each step with its own source), and the CAD faces it rests on when there are any. */
export const calc = (name: string, steps: CalculationTraceStep[], evidence: 'part_volume' | null = null): SourceRef => ({ kind: 'calculation', name, evidence, steps });

const REF = 'memory/Plastic Modeling';

/** The seeds shared by the injection, structural foam and LSR calculators: wall, shot volume, press rate and dry cycle, the two fill factors and the global factor. */
function commonSeeds(input: CycleTimeInput, missing: string[]): Record<string, CalcSeed> {
  const seeds: Record<string, CalcSeed> = {};
  if (positive(input.wallMm)) seeds['Nominal Wall Thickness'] = { value: input.wallMm, source: 'CAD nominal wall thickness', ref: { kind: 'cad', evidence: 'wall_thickness' } };
  else missing.push('nominal wall thickness (CAD)');

  const rate = input.press?.injectionRateMm3PerS ?? null;
  if (positive(rate)) {
    seeds['Press Injection Rate'] = withRef({ value: rate, source: 'Press reference record: rates.injectionRateMm3PerS' }, machineColumn(input.press?.record, 'injection_rate_mm3_per_s'));
  }
  else missing.push('press injection rate (injectionRateMm3PerS)');

  const dry = input.press?.dryCycleTimeS ?? null;
  if (positive(dry)) {
    seeds['Press Dry Cycle Time'] = withRef(
      { value: dry, source: 'Press reference record: time.dryCycleTimeS (Euromap 6, mold open and close)' }, machineColumn(input.press?.record, 'press_cycle_time_s'),
    );
  }
  else missing.push('press dry cycle time (dryCycleTimeS)');

  // Computed by the engine from the CAD volume, the runner allowance, the cavities and the melt density: its eye opens that calculation (shotMeltVolumeRef).
  if (positive(input.shotMeltVolumeMm3)) {
    seeds['Shot Melt Volume'] = withRef({ value: input.shotMeltVolumeMm3, source: 'CAD part volume x cavities + runner, at the material melt density' }, input.shotMeltVolumeRef ?? undefined);
  }
  else missing.push('shot melt volume (part volume and melt density)');

  const cavities = Math.max(input.cavityCount, 1);
  const gates = Math.max(input.gatesPerCavity, 1);
  const cavityRow = input.model.fillFactorByCavities.find((r) => cavities <= r.upTo) ?? input.model.fillFactorByCavities[input.model.fillFactorByCavities.length - 1]!;
  const gateRow = input.model.fillFactorByGates.find((r) => gates <= r.upTo) ?? input.model.fillFactorByGates[input.model.fillFactorByGates.length - 1]!;
  const cavityMatch = { table: 'injectionTimeAdjustmentFactors', row: { attribute: 'Cavities Per Mold', number: cavityRow.upTo } };
  const gateMatch = { table: 'injectionTimeAdjustmentFactors', row: { attribute: 'Gates Per Cavity', number: gateRow.upTo } };
  seeds['Fill Factor for Cavities'] = {
    value: bracketFactor(input.model.fillFactorByCavities, cavities), lookup: true,
    source: `${REF}/lookup/injectionTimeAdjustmentFactors: Cavities Per Mold, ${cavities} cavities`,
    match: cavityMatch, ref: plasticLookup(cavityMatch.table, 'adjustment_factor', cavityMatch.row),
  };
  seeds['Fill Factor for Gates'] = {
    value: bracketFactor(input.model.fillFactorByGates, gates), lookup: true,
    source: `${REF}/lookup/injectionTimeAdjustmentFactors: Gates Per Cavity, ${gates} gates per cavity`,
    match: gateMatch, ref: plasticLookup(gateMatch.table, 'adjustment_factor', gateMatch.row),
  };
  seeds['Cycle Time Adjustment Factor'] = { value: input.model.cycleTimeAdjustmentFactor, source: `${REF}/variables: cycleTimeAdjustmentFactor`, ref: plasticVariable('cycleTimeAdjustmentFactor') };
  return seeds;
}

/** The calculator that computes this input's cycle, by name: the LSR variant for a liquid silicone, otherwise the process's own (injection, or structural foam). */
export function injectionCalculatorName(isLsr: boolean, process: 'injection' | 'structural_foam'): string {
  return isLsr ? LSR_CALCULATOR : process === 'structural_foam' ? STRUCTURAL_FOAM_CALCULATOR : INJECTION_CALCULATOR;
}

/** Seeds for the injection / structural foam / LSR cycle-time calculators, or the inputs that are missing (each named). */
export function injectionCycleTimeSeeds(input: CycleTimeInput): SeedResult {
  const missing: string[] = [];
  const seeds = commonSeeds(input, missing);
  if (!input.isLsr) {
    const thermal = resinThermalProps(input.real, input.model.moldTemperatureIncreaseC);
    if ('missing' in thermal) {
      missing.push(...thermal.missing.map((m) => `material ${m}`));
    } else {
      const r = input.real!;
      if (positive(input.wallMm) && !hasMengesSolution(input.wallMm, thermal.props)) {
        missing.push('material temperatures give no Menges solution (eject must lie between mold and melt)');
      }
      const material = 'Material reference (raw_materials)';
      // Each property is the raw_materials column material-resolution.service.ts reads it from.
      const property = (value: number, label: string, column: string): CalcSeed => withRef({ value, source: `${material}: ${label}` }, materialColumn(input.material, column));
      seeds['Melt Temperature'] = property(r.meltingTempC!, 'melting temperature', 'melting_temp_c');
      seeds['Mold Temperature'] = property(r.moldTempC!, 'mold temperature', 'mold_temp_c');
      seeds['Mold Temperature Increase'] = { value: input.model.moldTemperatureIncreaseC, source: `${REF}/variables: defaultMoldTemperatureIncrease`, ref: plasticVariable('defaultMoldTemperatureIncrease') };
      seeds['Ejection Temperature'] = property(r.ejectionTempC!, 'eject temperature', 'eject_deflection_temp_c');
      seeds['Specific Heat of Melt'] = property(r.specificHeatMeltJgC!, 'specific heat of melt', 'specific_heat_melt');
      seeds['Thermal Conductivity of Melt'] = property(r.thermalConductivityMeltWMK!, 'thermal conductivity of melt', 'thermal_conductivity_melt');
      seeds['Melt Density'] = property(r.densityOfMeltKgM3!, 'density of melt', 'im_density_of_melt_kg_m3');
    }
  }
  return missing.length > 0 ? { missing } : { seeds };
}

/**
 * Seeds for the compression calculator: the machine's press open/close time and the material's cure time in minutes. A grade with no cure time on file is seeded 0, as
 * the engine always has (it then costs the press motion alone and says the cycle is understated): never a typical value.
 */
export function pressCycleTimeSeeds(input: { pressCycleTimeS: number | null; cureTimeMin: number | null; machine?: MachineRecord | null; material?: MaterialRecord | null }): SeedResult {
  if (!positive(input.pressCycleTimeS)) return { missing: ['press open/close time (press_cycle_time_s)'] };
  return {
    seeds: {
      'Press Open/Close Time': withRef({ value: input.pressCycleTimeS, source: 'Machine record: press_cycle_time_s' }, machineColumn(input.machine, 'press_cycle_time_s')),
      'Material Cure Time': cureSeed(input.cureTimeMin, input.material),
    },
  };
}

/**
 * The material's cure time. A grade without one is seeded 0: its eye opens that statement, the material record's empty cure_time_min cell
 * and the 0 it gives (never a typical value).
 */
function cureSeed(cureTimeMin: number | null, material: MaterialRecord | null | undefined): CalcSeed {
  if (positive(cureTimeMin)) return withRef({ value: cureTimeMin!, source: 'Material reference (raw_materials.cure_time_min)' }, materialColumn(material, 'cure_time_min'));
  const source = 'No cure time on file for this material grade: not included, so the cycle is understated (not a default)';
  return {
    value: 0, source,
    ref: calc('Material Cure Time: none on file', [
      inputStep('Cure time on file', 'min', 'none', `${material?.name ?? 'The material'}: raw_materials.cure_time_min is empty`, materialColumn(material, 'cure_time_min')),
      resultStep('Material Cure Time', 'min', 0, 'No cure time on file: 0, so the cycle is the press motion alone (understated)'),
    ]),
  };
}

/**
 * Seeds for the reaction injection calculator: the machine's dry cycle (s), the part volume (mm3), the machine's injection rate (mm3/s) and the material's cure time (min).
 * Units are the staged ones and are stated on the fields: the shot volume in mm3 over the rate in mm3/s gives seconds. A missing, zero, negative or non-finite volume,
 * rate or dry cycle is named, never defaulted: the fill time has no value without them. No runner volume is staged for RIM, so none is added.
 */
export function rimCycleTimeSeeds(input: {
  machineCycleTimeS: number | null; partVolumeMm3: number | null; injectionRateMm3PerS: number | null; cureTimeMin: number | null;
  /** The machine and material records the rate and the cure time were read from; absent when not known. */
  machine?: MachineRecord | null; material?: MaterialRecord | null;
}): SeedResult {
  const missing: string[] = [];
  if (!positive(input.machineCycleTimeS)) missing.push('machine dry cycle time (press_cycle_time_s)');
  if (!positive(input.partVolumeMm3)) missing.push('part volume (CAD volume, mm3)');
  if (!positive(input.injectionRateMm3PerS)) missing.push('machine injection rate (injectionRateMm3PerS, mm3/s)');
  if (missing.length > 0) return { missing };
  return {
    seeds: {
      'Machine Dry Cycle Time': withRef({ value: input.machineCycleTimeS!, source: 'Machine record: press_cycle_time_s (time.dryCycleTimeS)' }, machineColumn(input.machine, 'press_cycle_time_s')),
      'Part Volume': { value: input.partVolumeMm3!, source: 'CAD net part volume (mm3)', ref: { kind: 'cad', evidence: 'part_volume' } },
      'Cavities per Mold': {
        value: 1, source: 'Cost engine: the RIM engine prices one part per press cycle',
        ref: calc('Cavities per Mold: one part per press cycle', [
          resultStep('Cavities per Mold', null, 1, 'The reaction injection engine molds one part per press cycle (cost-reaction-injection-molding-engine.ts): no cavity layout is staged for RIM'),
        ]),
      },
      'Machine Injection Rate': withRef(
        { value: input.injectionRateMm3PerS!, source: `Machine record: ${REF}/machine/reaction_injection_molding_machines.csv rates.injectionRateMm3PerS (mm3/s)` },
        machineColumn(input.machine, 'injection_rate_mm3_per_s'),
      ),
      'Material Cure Time': cureSeed(input.cureTimeMin, input.material),
    },
  };
}
