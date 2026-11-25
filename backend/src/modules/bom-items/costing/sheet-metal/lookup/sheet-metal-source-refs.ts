import type { CalculationTraceStep, LookupResolution, SheetMetalSourceTable, SourceRef } from '../../../dto/cost-breakdown.dto';
import type { MaterialSourceColumns } from '../../../services/material-resolution.service';
import type { InspectionInput, InspectionPlan } from '../../shared/process/inspection-engine';
import type { TurretPunchMachineParams } from '../../shared/core/manufacturing-process.types';

/**
 * Where each sheet-metal calculator input was read (SourceRef), built at the point the engine seeds the calculator: the row of the
 * sm_lookup_* table or machine-library table the value came from, the sheet-metal variable, or the raw_materials record. The calculator
 * dialog's eye opens exactly that table with that row outlined. A value with no single source row (an interpolated stroke time, a value
 * read from a staged export no endpoint serves) gets no ref: nothing is invented to point at. CAD-measured inputs are not listed here:
 * their ref comes from their evidence key (sourceRefOfSeed).
 */

/** The reference-data domain of sm_reference_data (processes/reference-domains.ts): its variables are listed by GET /processes/variables. */
export const SHEET_METAL_DOMAIN = 'sheet_metal';

type RowKeys = Record<string, string | number>;

/** The part's batch (its costing inputs): every calculator's lot size. */
export const BATCH: SourceRef = { kind: 'costingInput', field: 'batchSize' };

export const smTableRef = (table: SheetMetalSourceTable, column: string, row: RowKeys | null): SourceRef => ({ kind: 'smTable', table, column, row });

/** A numeric sheet-metal variable (sm_reference_data category 'variable', SheetMetalLookupService.getNumericVariables). */
export const smVariableRef = (name: string): SourceRef => ({ kind: 'variable', domain: SHEET_METAL_DOMAIN, name });

/** The raw_materials record the quote priced from, and the column each property was read from (resolveMaterialForFamily). */
export interface MaterialRecord {
  id: string;
  name: string;
  columns: MaterialSourceColumns;
}

/** The material record's column holding `property`; undefined when no record matched or the record does not hold it. */
export function materialRef(record: MaterialRecord | null | undefined, property: keyof MaterialSourceColumns): SourceRef | undefined {
  const column = record?.columns[property];
  return record && column ? { kind: 'material', materialId: record.id, materialName: record.name, column } : undefined;
}

/** Drops the fields with no ref, so a seedRefs map only names real sources. */
function defined(refs: Record<string, SourceRef | undefined>): Record<string, SourceRef> {
  return Object.fromEntries(Object.entries(refs).filter((e): e is [string, SourceRef] => e[1] !== undefined));
}

/** Calculator fields read from the material record (field -> property): each with its record column, when the record holds it. */
export function materialSeedRefs(
  record: MaterialRecord | null | undefined,
  fields: Record<string, keyof MaterialSourceColumns>,
): Record<string, SourceRef> {
  return defined(Object.fromEntries(Object.entries(fields).map(([field, property]) => [field, materialRef(record, property)])));
}

/** Laser Cutting: Cutting Speed and Piercing Time Per Start, both from the one sm_lookup_laser_cut row getLaserParams matched. */
export function laserCutSeedRefs(params: { dataFound: boolean; row?: RowKeys } | null | undefined): Record<string, SourceRef> {
  if (!params?.dataFound || !params.row) return {};
  return {
    'Cutting Speed': smTableRef('sm_lookup_laser_cut', 'cutting_speed_m_per_min', params.row),
    'Piercing Time Per Start': smTableRef('sm_lookup_laser_cut', 'pierce_time_min', params.row),
  };
}

/**
 * Press brake Time Per Stroke: the sm_lookup_manual_stroke row it was read from. None when the value is the machine's own bend cycle time
 * (machine library, no endpoint serves it) or was interpolated/extrapolated between rows (no single row holds it).
 */
export function manualStrokeRef(stroke: { dataFound: boolean; fromMachineSpec?: boolean; resolution: LookupResolution }): SourceRef | undefined {
  const cols = stroke.resolution.matchedRow?.columns;
  if (!stroke.dataFound || stroke.fromMachineSpec || !cols) return undefined;
  if ('interpolated_between_thickness_mm' in cols || 'extrapolated_from_thickness_mm' in cols) return undefined;
  return smTableRef('sm_lookup_manual_stroke', 'stroke_time_sec', { thickness_mm: cols.thickness_mm!, tonnage: cols.tonnage!, complexity: cols.complexity! });
}

/**
 * Press brake Time Per Stroke, wherever it was read: the selected machine's bend cycle time (its row of the press brake machine library),
 * the sm_lookup_manual_stroke row, or, between two rows (or beyond the last two), the calculation that interpolated it from both rows.
 */
export function strokeTimeRef(
  stroke: { dataFound: boolean; fromMachineSpec?: boolean; secondsPerBend: number; resolution: LookupResolution },
  machineName: string | null | undefined,
): SourceRef | undefined {
  if (!stroke.dataFound) return undefined;
  if (stroke.fromMachineSpec) return machineName ? smTableRef('press_brake_machines', 'bend_cycle_time_s', { machine_name: machineName }) : undefined;
  const exact = manualStrokeRef(stroke);
  if (exact) return exact;
  const cols = stroke.resolution.matchedRow?.columns;
  const [a, b] = stroke.resolution.nearestRows;
  if (!cols || !a || !b) return undefined;
  const rowOf = (r: typeof a) => ({ thickness_mm: r.columns.thickness_mm!, tonnage: r.columns.tonnage!, complexity: r.columns.complexity! });
  const extrapolated = 'extrapolated_from_thickness_mm' in cols;
  const [t1, t2, s1, s2] = [Number(a.columns.thickness_mm), Number(b.columns.thickness_mm), Number(a.columns.stroke_time_sec), Number(b.columns.stroke_time_sec)];
  const t = Number(cols.thickness_mm);
  return calc(`Time Per Stroke: ${extrapolated ? 'extrapolated' : 'interpolated'} between two sm_lookup_manual_stroke rows`, [
    step('Sheet thickness', 'mm', t, 'The sheet thickness of the part'),
    step(`Stroke time at ${t1} mm`, 's', s1, `sm_lookup_manual_stroke: ${t1} mm, ${a.columns.tonnage} T, ${a.columns.complexity}`, smTableRef('sm_lookup_manual_stroke', 'stroke_time_sec', rowOf(a))),
    step(`Stroke time at ${t2} mm`, 's', s2, `sm_lookup_manual_stroke: ${t2} mm, ${b.columns.tonnage} T, ${b.columns.complexity}`, smTableRef('sm_lookup_manual_stroke', 'stroke_time_sec', rowOf(b))),
    result('Time Per Stroke', 's', Math.round(stroke.secondsPerBend * 10000) / 10000,
      `{Stroke time at ${t1} mm} + ({Sheet thickness} - ${t1}) / (${t2} - ${t1}) * ({Stroke time at ${t2} mm} - {Stroke time at ${t1} mm})${extrapolated ? ' (the line through the two nearest rows, beyond them)' : ''}`),
  ]);
}

/**
 * The sheet thickness the part is costed at (resolveEffectiveSheetThicknessMm): the part's scenario override when set, else the thickness the
 * CAD analysis measured, else the BOM item's own; a route that needs one when none is known says so (`fallbackMm`). Each candidate is a step.
 */
export function sheetThicknessRef(input: {
  scenarioOverrides: Record<string, unknown> | null | undefined;
  detectedMm: number | null | undefined;
  bomMm: number | null | undefined;
  /** The thickness a route uses when the part has none (route comparison's 2.0 mm), when that applies. */
  fallbackMm?: number;
}): SourceRef {
  const raw = input.scenarioOverrides?.['sheetThicknessMm'];
  const override = typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : null;
  const effective = override ?? input.detectedMm ?? input.bomMm ?? 0;
  const used = effective > 0 ? effective : input.fallbackMm ?? 0;
  const shown = (v: number | null | undefined) => (v != null ? v : 'none');
  return calc('Sheet thickness of the part', [
    step('Scenario sheet thickness', 'mm', shown(override), "The part's scenario (Cost Guide): sheetThicknessMm, when set"),
    step('CAD sheet thickness', 'mm', shown(input.detectedMm), 'CAD: the sheet thickness the analysis measured on the part'),
    step('BOM sheet thickness', 'mm', shown(input.bomMm), "The BOM item's own sheet thickness"),
    ...(effective > 0 || input.fallbackMm == null ? [] : [step('Thickness when none is known', 'mm', input.fallbackMm, 'The route comparison prices a part with no sheet thickness at this thickness')]),
    result('Thickness', 'mm', used, effective > 0 || input.fallbackMm == null
      ? "{Scenario sheet thickness}, else {CAD sheet thickness}, else {BOM sheet thickness}"
      : '{Thickness when none is known}: the part has none'),
  ]);
}

/** The press brake die shoulder width: 8 x the sheet thickness (the standard V-die shoulder rule the bend force is sized with). */
export function shoulderWidthRef(thicknessMm: number, thicknessRef: SourceRef): SourceRef {
  return calc('Shoulder Width: the standard V-die shoulder rule', [
    step('Thickness', 'mm', thicknessMm, 'The sheet thickness of the part', thicknessRef),
    step('Shoulder width per thickness', null, 8, 'The standard V-die shoulder rule: the die shoulder is 8 sheet thicknesses wide'),
    result('Shoulder Width', 'mm', 8 * thicknessMm, '{Shoulder width per thickness} * {Thickness}'),
  ]);
}

/** Press Brake (Bending) calculator inputs read from a table or record. */
export function pressBrakeSeedRefs(input: {
  stroke: Parameters<typeof strokeTimeRef>[0];
  handling: { dataFound: boolean; row?: RowKeys };
  toolSetup: { dataFound: boolean; row?: RowKeys };
  material: MaterialRecord | null | undefined;
  /** True when UTS is the material record's own value; an approved-family default is not read from the record. */
  utsFromRecord: boolean;
  /** The selected press brake, whose own bend cycle time is the stroke time when it has one. */
  machineName?: string | null;
  /** The sheet thickness the bend is costed at, and where it came from (sheetThicknessRef). */
  thickness?: { mm: number; ref: SourceRef };
  /** The UTS seeded and the grade it is of: an approved-family value (not the record's) is shown as that value of the grade. */
  uts?: { mpa: number | null; grade: string | null };
}): Record<string, SourceRef> {
  return defined({
    'Time Per Stroke': strokeTimeRef(input.stroke, input.machineName),
    Thickness: input.thickness?.ref,
    'Shoulder Width': input.thickness ? shoulderWidthRef(input.thickness.mm, input.thickness.ref) : undefined,
    'Lot Size': BATCH,
    'Sheet Loading Time': input.handling.dataFound && input.handling.row ? smTableRef('sm_lookup_handling_time', 'handling_min', input.handling.row) : undefined,
    'Tool Loading Time': input.toolSetup.dataFound && input.toolSetup.row ? smTableRef('sm_lookup_tool_setup', 'loading_time_min', input.toolSetup.row) : undefined,
    UTS: utsRef({ material: input.material, fromRecord: input.utsFromRecord, mpa: input.uts?.mpa ?? null, grade: input.uts?.grade ?? null }),
  });
}

/**
 * A material's UTS: its Raw Materials record's column when read from it; else the approved value for its grade (MATERIAL_UTS_MPA via
 * resolveUtsMpa), shown as that. Undefined when no UTS was seeded.
 */
export function utsRef(input: { material: MaterialRecord | null | undefined; fromRecord: boolean; mpa: number | null; grade: string | null }): SourceRef | undefined {
  const record = input.fromRecord ? materialRef(input.material, 'utsMpa') : undefined;
  if (record) return record;
  if (input.mpa == null) return undefined;
  return calc('UTS: the approved value of the grade', [
    step('Material grade', null, input.grade ?? 'none', "The part's material grade"),
    result('UTS', 'MPa', input.mpa, 'MATERIAL_UTS_MPA: the approved ultimate tensile strength of the grade or its family (resolveUtsMpa)'),
  ]);
}

/** Inspection calculator check times -> the inspection_operation_defaults feature each is read for. */
const INSPECTION_FEATURE_BY_FIELD = {
  'Visual Pass Base': 'visual_base',
  'Hole Check Time': 'hole',
  'Bend Check Time': 'bend',
  'Thread Gauge Time': 'thread',
  'Thickness Check Time': 'thickness',
  'Dimension Check Time': 'dimension',
} as const;

/** The sample counts and checks a time is taken for: a check time with none to take is 0 for that reason, not a table value. */
const INSPECTION_COUNT_BY_FIELD: Partial<Record<keyof typeof INSPECTION_FEATURE_BY_FIELD, 'holesToInspect' | 'bendsToInspect' | 'threadsToInspect' | 'hasThicknessCheck' | 'hasDimensionCheck'>> = {
  'Hole Check Time': 'holesToInspect',
  'Bend Check Time': 'bendsToInspect',
  'Thread Gauge Time': 'threadsToInspect',
  'Thickness Check Time': 'hasThicknessCheck',
  'Dimension Check Time': 'hasDimensionCheck',
};

const INSPECTION_COUNT_LABEL = {
  holesToInspect: 'Holes to Inspect', bendsToInspect: 'Bends to Inspect', threadsToInspect: 'Threads to Inspect',
  hasThicknessCheck: 'Has Thickness Check', hasDimensionCheck: 'Has Dimension Check',
} as const;

const step = (label: string, unit: string | null, value: number | string, source: string, ref?: SourceRef): CalculationTraceStep => ({
  fieldName: label, displayLabel: unit ? `${label} (${unit})` : label, kind: 'input', value, unit, source, ...(ref ? { ref } : {}),
});
const result = (label: string, unit: string | null, value: number, formula: string): CalculationTraceStep => ({
  fieldName: label, displayLabel: unit ? `${label} (${unit})` : label, kind: 'calculated', value, unit, formula, stepType: 'physics',
});
const calc = (name: string, steps: CalculationTraceStep[]): SourceRef => ({ kind: 'calculation', name, evidence: null, steps });

/**
 * Inspection: each check time from the inspection_operation_defaults row (feature + method) the plan read it from; a check with nothing to
 * check (no threads, no sheet thickness) is 0 for that reason, shown as such; one timed by the fallback constant (no row on file) opens the
 * table with no row outlined. With the plan's input, each sample count is the calculation it is: the features on the part times the
 * sampling plan's fraction for the batch (sm_lookup_sampling_plan), at least one; each check flag the CAD fact it rests on.
 */
export function inspectionSeedRefs(
  plan: Pick<InspectionPlan, 'sourceRows' | 'method'> & Partial<Pick<InspectionPlan, 'holesToInspect' | 'bendsToInspect' | 'threadsToInspect' | 'hasThicknessCheck' | 'hasDimensionCheck'>>,
  input?: Pick<InspectionInput, 'holes' | 'bends' | 'threads' | 'samplingRate' | 'batchSize' | 'sheetThicknessMm' | 'hasOverallDimensions' | 'inspectionStrategy'>,
): Record<string, SourceRef> {
  const times = Object.fromEntries(Object.entries(INSPECTION_FEATURE_BY_FIELD).map(([field, feature]) => {
    const row = plan.sourceRows[feature];
    if (row) return [field, smTableRef('inspection_operation_defaults', 'cycle_time_sec', { feature: row.feature, method: row.method })];
    const countKey = INSPECTION_COUNT_BY_FIELD[field as keyof typeof INSPECTION_FEATURE_BY_FIELD];
    const count = countKey ? Number(plan[countKey] ?? 0) : null;
    if (countKey && count === 0) {
      return [field, calc(`${field}: nothing to check`, [
        step(INSPECTION_COUNT_LABEL[countKey], null, 0, 'Nothing of this kind to check on the part'),
        result(field, 's', 0, 'No check of this kind: 0 s'),
      ])];
    }
    // Timed by the fallback constant: the table, which has no row for this feature and method.
    return [field, smTableRef('inspection_operation_defaults', 'cycle_time_sec', null)];
  }));
  if (!input) return defined(times);
  const sampling = 'sm_lookup_sampling_plan: the sample quantity for the batch (sample_qty_l2) over the batch';
  const samplingStep = step('Sampling fraction', null, Math.round(input.samplingRate * 10000) / 10000, sampling, smTableRef('sm_lookup_sampling_plan', 'sample_qty_l2', null));
  const batchStep = step('Batch size', null, input.batchSize, "The part's batch", { kind: 'costingInput', field: 'batchSize' });
  const everyOne = input.inspectionStrategy === '100pct' || input.inspectionStrategy === 'first_article';
  const sampled = (label: string, features: number, featureSource: string, value: number): SourceRef => calc(`${label}: the sampling plan`, [
    step(`${label.replace(' to Inspect', '')} on the part`, null, features, featureSource),
    ...(everyOne ? [] : [samplingStep, batchStep]),
    result(label, null, value, everyOne ? `Every one (${input.inspectionStrategy})` : 'ceil(features x Sampling fraction), at least 1 when there are any'),
  ]);
  const threadCount = input.threads.reduce((n, t) => n + t.count, 0);
  return defined({
    ...times,
    'Holes to Inspect': sampled('Holes to Inspect', input.holes.length, 'CAD: the holes the part has (feature recognition)', plan.holesToInspect ?? 0),
    'Bends to Inspect': sampled('Bends to Inspect', input.bends.length, 'CAD: the bends the part has (feature recognition)', plan.bendsToInspect ?? 0),
    'Threads to Inspect': sampled('Threads to Inspect', threadCount, 'CAD/drawing: the threads the part has', plan.threadsToInspect ?? 0),
    'Has Thickness Check': calc('Has Thickness Check', [
      step('Sheet thickness', 'mm', input.sheetThicknessMm, 'CAD: the sheet thickness'),
      result('Has Thickness Check', null, plan.hasThicknessCheck ? 1 : 0, '1 when the part has a sheet thickness, else 0'),
    ]),
    'Has Dimension Check': calc('Has Dimension Check', [
      step('Overall dimensions known', null, input.hasOverallDimensions ? 'yes' : 'no', 'CAD: the blank length and width and the part height are all measured'),
      result('Has Dimension Check', null, plan.hasDimensionCheck ? 1 : 0, '1 when the overall dimensions are known, else 0'),
    ]),
  });
}

/** Turret Punching: the machine's row of the Turret Press machine table, and the Lookup Table 1 row its stroke rate factor came from. */
export function turretSeedRefs(machineName: string | null | undefined, params: TurretPunchMachineParams): Record<string, SourceRef> {
  const machine = machineName ? { machine_name: machineName } : null;
  return defined({
    'Punch Rate (hits/min)': machine ? smTableRef('turret_machines', 'punch_rate_cycles_min', machine) : undefined,
    'Tool Change Time (s)': machine ? smTableRef('turret_machines', 'tool_change_time_s', machine) : undefined,
    'Nibble Speed (mm/min)': machine ? smTableRef('turret_machines', 'nibble_speed_mm_per_min', machine) : undefined,
    'Stroke Rate Factor': params.strokeRateFactorRow
      ? smTableRef('stroke_rate_factor', params.strokeRateFactorRow.column, { tonnage_t: params.strokeRateFactorRow.tonnageT })
      : undefined,
    'Lot size': BATCH,
  });
}

/**
 * Waterjet Cutting: the machine's nozzle delay, the two sheet-metal variables, and the cutting speed — not a table value but the
 * sm_lookup_waterjet_cut speed scaled by the machine's mixing tube against the reference machine's, so it is shown as that calculation.
 */
export function waterjetSeedRefs(input: {
  machineName: string;
  referenceMachineName: string;
  cutRow: RowKeys | undefined;
  tableSpeedMmPerMin: number;
  machineTubeMm: number;
  referenceTubeMm: number;
  speedFactor: number;
  material: string;
  thicknessMm: number;
}): Record<string, SourceRef> {
  const steps: CalculationTraceStep[] = [
    {
      fieldName: 'Table Cutting Speed', displayLabel: 'Table Cutting Speed', kind: 'input', value: input.tableSpeedMmPerMin, unit: 'mm/min',
      source: `sm_lookup_waterjet_cut — ${input.material}, ${input.thicknessMm}mm sheet`,
      ...(input.cutRow ? { ref: smTableRef('sm_lookup_waterjet_cut', 'cutting_speed_mm_per_min', input.cutRow) } : {}),
    },
    {
      fieldName: 'Mixing Tube', displayLabel: 'Mixing Tube', kind: 'input', value: input.machineTubeMm, unit: 'mm',
      source: `${input.machineName} — mixing_tube_diameter_mm (machine library)`,
      ref: smTableRef('waterjet_machines', 'mixing_tube_diameter_mm', { machine_name: input.machineName }),
    },
    {
      fieldName: 'Reference Mixing Tube', displayLabel: 'Reference Mixing Tube', kind: 'input', value: input.referenceTubeMm, unit: 'mm',
      source: `${input.referenceMachineName} — mixing_tube_diameter_mm (machine library, the cut-speed table's reference machine)`,
      ref: smTableRef('waterjet_machines', 'mixing_tube_diameter_mm', { machine_name: input.referenceMachineName }),
    },
    { fieldName: 'Speed Factor', displayLabel: 'Speed Factor', kind: 'calculated', value: input.speedFactor, formula: '{Mixing Tube} / {Reference Mixing Tube}' },
    {
      fieldName: 'Cutting Speed', displayLabel: 'Cutting Speed', kind: 'calculated', value: input.tableSpeedMmPerMin * input.speedFactor,
      unit: 'mm/min', formula: '{Table Cutting Speed} * {Speed Factor}',
    },
  ];
  return {
    'Cutting Speed': { kind: 'calculation', name: `Waterjet cutting speed for ${input.machineName}`, evidence: null, steps },
    'Lead In Per Start': smVariableRef('standardWaterjetCutLeadInAmount'),
    'Cut Time Adjustment Factor': smVariableRef('waterjetCutTimeAdjustmentFactor'),
    'Pierce Delay Per Start': smTableRef('waterjet_machines', 'nozzle_delay_s', { machine_name: input.machineName }),
    'Lot Size': BATCH,
  };
}

/**
 * Deburring's time per mm: a Deslag machine's perimeter allowance, its row of the Deslag machine table; a Manual Deburr rate, the calculation
 * it is (the passes per edge over the tblDeburring linear speed: manualDeburrRef), carried on the requirement.
 */
export function deburrTimeRef(
  candidate: { machineClass: string; machineName: string | null },
  manualDeburr?: { ref?: SourceRef } | null,
): SourceRef | undefined {
  if (candidate.machineClass === 'manual_deburr') return manualDeburr?.ref;
  if (!candidate.machineName) return undefined;
  return smTableRef('deslag_allowance', 'perimeter_allowance_s_per_mm', { machine_name: candidate.machineName });
}

/** Manual Deburr's time per mm of edge: the passes per edge (machining variable) over the tblDeburring linear speed for the material. */
export function manualDeburrRef(input: {
  linearSpeedMmPerSec: number; materialCutCode: string | null | undefined; match: { table: string; row: Record<string, string | number> } | null | undefined; passes: number;
}): SourceRef {
  return calc('Deburr Time Per mm: Manual Deburr', [
    step('Linear speed', 'mm/s', input.linearSpeedMmPerSec, `tblDeburring: material code ${input.materialCutCode ?? '?'}`,
      { kind: 'lookup', domain: 'machining', table: input.match?.table ?? 'tblDeburring', column: 'linear_speed_mm_s', row: input.match?.row ?? null }),
    step('Passes per edge', null, input.passes, 'Machining variable defaultNumDeburrPassesEdge', { kind: 'variable', domain: 'machining', name: 'defaultNumDeburrPassesEdge' }),
    result('Deburr Time Per mm', 's/mm', input.passes / input.linearSpeedMmPerSec, '{Passes per edge} / {Linear speed}'),
  ]);
}

/** The part's holes as the CAD analysis found them (their diameters and counts): the eye lights the holes. */
export const CAD_HOLES: SourceRef = { kind: 'cad', evidence: 'hole_diameters' };

/** A drilling-style secondary hole operation's surface speed: the material family's HSS drilling speed (x the operation's factor). */
export function drillingSpeedRef(input: { materialFamily: string; baseSpeedMMin: number; speedFactor?: number; speedMMin: number; operation: string }): SourceRef {
  const factor = input.speedFactor != null && input.speedFactor !== 1 ? input.speedFactor : null;
  return calc(`${input.operation} surface speed, ${input.materialFamily}`, [
    step('Material family', null, input.materialFamily, "The material grade's family (classifyMaterialFamily)"),
    step('HSS drilling surface speed', 'm/min', input.baseSpeedMMin,
      'DRILL_SURFACE_SPEED_M_MIN_BY_MATERIAL: AIMS Industrial Cutting Speeds & Feeds Reference and the Slugger Tool drill speed chart, by material family'),
    ...(factor ? [step('Countersink speed factor', null, factor, 'COUNTERSINK_SPEED_FACTOR: a countersink runs at 25% of the drill speed (Melin Tool, MA Ford and SuperTool countersink speed and feed sheets)')] : []),
    result('Cutting Speed', 'm/min', input.speedMMin, factor ? '{HSS drilling surface speed} * {Countersink speed factor}' : '{HSS drilling surface speed} of the family'),
  ]);
}

/** The HSS drilling/counterboring feed per rev (DRILL_FEED_MM_PER_REV): the midpoint of the published 0.005-0.010 in/rev range. */
export function drillingFeedRef(feedMmPerRev: number): SourceRef {
  return calc('HSS drilling feed per rev', [
    step('Published feed range', 'in/rev', '0.005-0.010', 'SuperTool Counterbore Feeds and Speeds; AIMS Industrial HSS guideline 0.05-0.2 mm/rev'),
    result('Feed per Rev', 'mm/rev', feedMmPerRev, 'The midpoint of the range, in mm (DRILL_FEED_MM_PER_REV)'),
  ]);
}

/** A counterbore's depth: no counterbore depth is measured, so the sheet thickness it is cut through (3 mm when the part has none). */
export function counterboreDepthRef(sheetThicknessMm: number, depthMm: number, thicknessRef?: SourceRef): SourceRef {
  return calc('Counterbore depth (no CAD depth)', [
    step('Sheet thickness', 'mm', sheetThicknessMm, sheetThicknessMm > 0 ? 'The sheet thickness of the part' : 'No sheet thickness on the part', thicknessRef),
    result('Depth', 'mm', depthMm, 'The sheet thickness (3 mm when none): the counterbore can be no deeper than the sheet'),
  ]);
}

/** A countersink's depth: the cone of a standard 90 degree countersink at the hole's diameter. */
export function countersinkDepthRef(diameterMm: number, depthMm: number): SourceRef {
  return calc('Countersink depth (cone geometry)', [
    step('Diameter', 'mm', diameterMm, 'CAD: the countersunk hole diameter', CAD_HOLES),
    step('Included angle', 'deg', 90, 'The standard ISO/ASME flat-head screw countersink (no angle is measured on the part)'),
    result('Depth', 'mm', Math.round(depthMm * 10000) / 10000, '({Diameter} / 2) / tan({Included angle} / 2)'),
  ]);
}

/** The inputs of a counterboring/countersinking group: the CAD holes, their depth, and the drilling speed and feed of the material. */
export function holeOperationSeedRefs(input: { depthRef: SourceRef; speedRef: SourceRef; feedRef: SourceRef }): Record<string, SourceRef> {
  return { Diameter: CAD_HOLES, 'No of Uses': CAD_HOLES, Depth: input.depthRef, 'Cutting Speed': input.speedRef, 'Feed per Rev': input.feedRef };
}

/** PEM Insertion: the sm_lookup_pem_hardware row the hole diameter and sheet thickness matched, and the CAD holes of that diameter. */
export function pemSeedRefs(row: { hole_diameter_mm: number; sheet_thickness_mm: number; pem_part_spec: string } | null | undefined): Record<string, SourceRef> {
  return defined({
    'Insertion Cycle Time': row ? smTableRef('sm_lookup_pem_hardware', 'insertion_cycle_sec', row) : undefined,
    'No Of Insertions': CAD_HOLES,
  });
}

/** Reaming: the CAD holes, the reamed depth (the sheet thickness, 3 mm when none) and the HSS reaming speed and feed of the material. */
export function reamingSeedRefs(input: {
  sheetThicknessMm: number; depthMm: number; thicknessRef?: SourceRef; materialFamily: string; speedMMin: number; diameterMm: number; feedMmPerRev: number;
}): Record<string, SourceRef> {
  return {
    Diameter: CAD_HOLES,
    'No of Uses': CAD_HOLES,
    Length: calc('Reamed depth', [
      step('Sheet thickness', 'mm', input.sheetThicknessMm, input.sheetThicknessMm > 0 ? 'The sheet thickness of the part' : 'No sheet thickness on the part', input.thicknessRef),
      result('Length', 'mm', input.depthMm, 'The sheet thickness the hole is reamed through (3 mm when none)'),
    ]),
    'Cutting Speed': calc(`Reaming surface speed, ${input.materialFamily}`, [
      step('Material family', null, input.materialFamily, "The material grade's family (classifyMaterialFamily)"),
      result('Cutting Speed', 'm/min', input.speedMMin, 'REAM_SURFACE_SPEED_M_MIN_BY_MATERIAL: the midpoint of the family on the CNC Lathing carbide and HSS reamer speeds and feeds chart'),
    ]),
    'Feed per Rev': calc('Reaming feed per rev', [
      step('Diameter', 'mm', input.diameterMm, 'CAD: the reamed hole diameter', CAD_HOLES),
      step('Feed per mm of diameter', 'mm/rev per mm', 0.02, 'The same reamer chart: feed = 0.02 x diameter (4 mm -> 0.08, 6 mm -> 0.12, 10 mm -> 0.20)'),
      result('Feed per Rev', 'mm/rev', input.feedMmPerRev, '{Feed per mm of diameter} * {Diameter}'),
    ]),
  };
}

/** Hole Extrusion (Burring): the burl diameter as estimated, the sheet thickness, the material's UTS, the CAD flanges and the stroke time. */
export function burringSeedRefs(input: {
  diameterMm: number; threads: ReadonlyArray<{ size: string; count: number }>; holeCount: number; thickness: { mm: number; ref: SourceRef };
  stroke: Parameters<typeof strokeTimeRef>[0]; uts?: SourceRef; flangeCount: number;
}): Record<string, SourceRef> {
  const threaded = input.threads.filter((t) => t.count > 0);
  const diameter = threaded.length > 0
    ? [step('Tapped threads', null, threaded.map((t) => `${t.size} x${t.count}`).join(', '), 'The thread callouts the burls are tapped for (drawing analysis, or the CAD thread recognition)'),
      result('Diameter', 'mm', input.diameterMm, 'The count-weighted average M-diameter of the threads, 4 mm for a size with none (estimateBurlDiameterMm)')]
    : input.holeCount > 0
      ? [step('Smallest hole', 'mm', input.diameterMm, 'CAD: the smallest hole on the part (no tapped thread to size the burl from)', CAD_HOLES),
        result('Diameter', 'mm', input.diameterMm, 'The smallest hole diameter (estimateBurlDiameterMm)')]
      : [step('Threads and holes', null, 'none', 'No tapped thread and no hole on the part to size the burl from'),
        result('Diameter', 'mm', input.diameterMm, 'estimateBurlDiameterMm: 3 mm when the part gives none')];
  return defined({
    Diameter: calc('Burl diameter', diameter),
    Thickness: input.thickness.ref,
    UTS: input.uts,
    'No Of Extrusions': calc('Extruded flanges', [
      step('Extruded flanges', null, input.flangeCount, 'CAD: the extruded flanges the analysis counted on the part (feature graph summary)'),
      result('No Of Extrusions', null, input.flangeCount, 'One extrusion per flange'),
    ]),
    'Stroke Time': strokeTimeRef(input.stroke, null),
  });
}
