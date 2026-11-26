import { IsOptional, IsString, IsUUID } from 'class-validator';
import type { MachineClass } from '../costing/shared/core/default-rates.constants';
import type { MachineCapability } from '../costing/shared/capability/machine-selection/seed-registry';
import type { MachineRequirement } from '../costing/shared/capability/machine-selection/physics';

type CapabilitySource = 'imported' | 'seed' | 'default_class';
export type AvailabilityStatus = 'available' | 'maintenance' | 'down' | 'retired' | 'commissioning';

export interface MachineCandidate {
  machineId: string | null;      // mhr_records.id; null for class-default fallback
  machineName: string | null;
  commodityCode: string | null;
  // The machine's own HR Rates process group: mhr_records.process_group,
  // else its commodity_code — the same rule HR Rates and the Process picker
  // use (effectiveProcessGroupOf). null for the no-machine candidate.
  processGroup: string | null;
  machineClass: MachineClass;
  hourlyRate: number;
  utilizationPct: number;        // capacity_utilization_rate 0-100 — a real value when utilizationKnown, otherwise a neutral ranking assumption
  utilizationKnown: boolean;     // false when capacity_utilization_rate wasn't on file and utilizationPct is a ranking-only placeholder
  scheduledLoadPct: number | null;
  availabilityStatus: AvailabilityStatus;
  nextAvailableAt: string | null;
  maintenanceWindowStart: string | null;
  maintenanceWindowEnd: string | null;
  capability: MachineCapability;
  capabilitySource: CapabilitySource;
  capabilityVersion: number | null;
  // mhr_records.operators — real per-machine operator headcount. null for the
  // class-default fallback candidate (no real machine) or when a real machine
  // row has never had this field set; callers must fall back to a generic
  // default (1) rather than treat null as zero operators.
  operators: number | null;
  // mhr_records.usd_lhr_total — this specific machine's own labor rate
  // (sourced from machine_library.json's labor_rate_usd_hr for benchmarked
  // rows). When present, takes precedence over the location+process_group
  // lhr_records/lhr_benchmark_rates lookup for this machine's operations —
  // an explicit, approved exception to that being the sole labor-rate source
  // (see bom-items.service.ts's buildOutput). null when no real machine or
  // the field was never set.
  laborRateUsdHr: number | null;
  // mhr_records.press_cycle_time_s / handling_time_const_s /
  // handling_time_mass_coeff_s_per_kg — Standard Press / Tandem Press's real
  // per-machine stroke-cycle-time and linear handling-time formula (Track B
  // Phase 2, migration 608). Unlike every other cutting-family process,
  // these two machine classes have no thickness/material lookup table — the
  // cycle time genuinely IS a fixed per-machine constant. null for every
  // other machine class, or a real press machine this data hasn't been
  // sourced for yet (see migration 608's own documented scope).
  pressCycleTimeS: number | null;
  handlingConstS: number | null;
  handlingMassCoeffSPerKg: number | null;
  // mhr_records.cut_to_length_cycle_const_s / cut_to_length_cycle_mass_coeff_s_per_kg /
  // cut_to_length_cut_speed_s — Cut To Length Line's real per-machine linear
  // feed-to-length cycle-time formula plus its fixed real shear-stroke
  // duration (migration 724). null for every other machine class.
  cutToLengthCycleConstS: number | null;
  cutToLengthCycleMassCoeffSPerKg: number | null;
  cutToLengthCutSpeedS: number | null;
  // mhr_records.number_spindles / drum_index_time_s / transfer_time_s /
  // stock_feed_time_s / speed_synchronization_time_s — real per-machine
  // multi-spindle automatic-lathe config (migration 788, source:
  // simultaneous_turning_usa.csv). null for every other machine class, or a
  // simultaneous_turning machine this hasn't been sourced for yet.
  numberSpindles: number | null;
  drumIndexTimeS: number | null;
  transferTimeS: number | null;
  stockFeedTimeS: number | null;
  speedSynchronizationTimeS: number | null;
  // mhr_records.specs spindle_speed_rpm / live_tooling_speed_rpm — the
  // machine's top main-spindle and driven-tool speeds (migrations 1093, 1136;
  // source memory/machining/machine/*.csv). A cutting calculator caps its
  // spindle speed n = 1000 v / (pi D) at these. null when not staged.
  maxSpindleRpm: number | null;
  liveToolingMaxRpm: number | null;
  // mhr_records.specs rapid_traverse_mm_per_min (migration 1141; source memory/machining/machine/*.csv): the rate the machine moves
  // between the features it cuts. null when not staged.
  rapidTraverseMmPerMin: number | null;
  // mhr_records.setup_time_hr — real per-machine setup time, generically
  // available for any class (2026-09-02, added for Compression Molding /
  // Reaction Injection Molding, which have no per-operation lookup table
  // the way Sheet Metal classes do — real setup_time_hr genuinely IS a
  // fixed per-machine value for these). null when not set for this machine.
  setupTimeHr: number | null;
  /** mhr_records.machine_power_kw: the machine's power draw, kW (the HR Rates engine's electricity input). Its energy per part in the
   *  sustainability panel is this x the line's cycle time. null when not on file. */
  machinePowerKw: number | null;
  /**
   * The two components the canonical Machine Hour Rate is DEFINED as
   * (migration 581: MHR = Direct Overhead Rate + Indirect Overhead Rate,
   * derived by mhr.service.ts on every write and authoritative for live quote
   * costing). Carried so applyBenchmarkOverrideIfNeeded() can distinguish a
   * real machine rate that IS that canonical sum from a mis-scaled import,
   * instead of judging both by their ratio to a generic class benchmark.
   * null when the row has no overhead breakdown on file.
   */
  directOverheadRate: number | null;
  indirectOverheadRate: number | null;
  /**
   * mhr_records.specs is_preferred / is_virtual_machine: the machine file's own flags (migration 1164 stages them for machining and sheet
   * metal; the other families' seeds carry them). The reference data chooses a virtual machine first where the family prefers them
   * (preferVirtualMachines) and then a preferred machine (usePreferredMachines): selection-policy.ts. null when the file gives none.
   */
  preferred: boolean | null;
  virtual: boolean | null;
}

// Structured version of the material/thickness-vs-capacity check — lets the
// UI render a Material/Thickness/Capacity/Status table instead of parsing a
// flat "MS 1.5 mm ≤ 12 mm limit" string. materialGrade is the raw grade (e.g.
// "SECC"), not the classified family used for the limit lookup, so the UI
// shows what the user actually selected. null when this requirement kind has
// no single dominant dimensional check (e.g. generic/deburring).
export interface CapabilityCheck {
  parameter: string;              // e.g. 'Thickness', 'Tonnage'
  materialGrade: string | null;
  value: number;
  limit: number | null;
  unit: string;
  supported: boolean;
}

export interface MachineRecommendation {
  candidate: MachineCandidate;
  score: number;      // 0-1: how tightly the part fills this machine's capability envelope (1 = sized for it)
  reasons: string[];  // human-readable "why this machine"
  capabilityCheck?: CapabilityCheck | null;
}

/** One capable machine as the choice saw it. */
export interface MachineRankEntry {
  machineId: string | null;
  machineName: string | null;
  hourlyRate: number;
  /** The machine's own flags (MachineCandidate.preferred / virtual). */
  preferred: boolean | null;
  virtual: boolean | null;
  /** Among the machines the choice was made from, after the virtual and preferred steps. A capable machine those steps set aside is false. */
  inPool: boolean;
  /** How tightly the part fills this machine's capability envelope (1 = sized for it): the tie-break between equal costs. */
  fit: number;
  /** Its cost per part, for a line whose machines run at different speeds and are compared on it (deburr). Absent: compared on the hour rate. */
  costPerPart?: number;
}

/** One step of the choice, in the order taken (selection-policy.ts SelectionStep). */
export interface MachineSelectionStep {
  rule: 'capable' | 'virtual' | 'preferred' | 'cheapest';
  /** Machines left after the step. */
  count: number;
  text: string;
}

/**
 * Why the chosen machine won over the next one of the machines it was chosen from: a lower cost; at an equal cost the tighter fit, then the
 * name. 'only_capable' when no other machine passed the capability check, 'only_in_pool' when it was the one machine the virtual and
 * preferred steps left, 'override' when a user forced the pick.
 */
export interface MachineSelectionDecision {
  winnerId: string | null;
  runnerUpId: string | null;
  decidingFactor: 'cost' | 'fit' | 'name' | 'only_capable' | 'only_in_pool' | 'override';
}

export interface MachineSelectionResult {
  /**
   * The machine the cost engine prices the line on: of the machines that can do the part, the virtual and then the preferred ones as the
   * reference data says, then the cheapest (selector.ts selectMachine). The field keeps its first name: saved lines and the API carry it.
   */
  balanced: MachineRecommendation;
  /** The lowest-cost capable machine of all, the virtual and preferred steps left aside. */
  cheapest: MachineRecommendation;
  alternatives: MachineCandidate[];   // up to 2, deduped against the chosen machine
  confidence: number;                 // the chosen machine's fit × 100
  requirement: MachineRequirement;
  allowOverride: true;
  overridden: boolean;                // true when a user override forced the pick
  availabilityWarning?: string;
  /** Every capable machine: the ones the choice was made from first, cheapest first, then the capable machines the steps set aside. */
  ranking?: MachineRankEntry[];
  /** Machines of this class that failed the part's capability check, with the compared values. */
  rejected?: Array<{ machineId: string | null; machineName: string | null; reasons: string[] }>;
  /** How the machine was chosen, step by step. */
  steps?: MachineSelectionStep[];
  decision?: MachineSelectionDecision;
}

export class MachineOverrideDto {
  @IsString()
  processKey!: string;               // machine class key, e.g. 'fiber_laser'

  @IsOptional()
  @IsUUID()
  mhrRecordId?: string | null;       // null/omitted = clear override, revert to auto

  // Digital Factory location the override applies to. Overrides are scoped per
  // location (migration 329) — an India machine pick must never leak into a USA
  // costing. Optional for backward compatibility; the service defaults it.
  @IsOptional()
  @IsString()
  location?: string;
}
