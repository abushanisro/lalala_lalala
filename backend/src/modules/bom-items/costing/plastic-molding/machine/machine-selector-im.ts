// The press tiers of the Route Comparison. Whether a press is capable is the shared rule in shared/capability/machine-selection/press-checks.ts (clamp,
// shot, tie-bars, daylight), the same one the Cost Summary's press selection uses; this module derives the clamp force the part needs from the
// reference model and groups the presses into size classes.
//
// Which capable press a route uses is decided by cost, not a score: the caller
// runs the cost engine for each capable press in a tier and keeps the cheapest
// (bom-items.service getRouteComparison).

import type { MachineCandidate, MachineSelectionResult } from '../../../dto/machine-selection.dto';
import { mhrRateFromCandidate } from '../../shared/capability/machine-selection/rate-from-candidate';
import type { PressTiming } from '../process/cycle-time';
import type { MoldingPress } from '../process/cost-injection-molding-engine';
import { checkPress, estimatedToolHeightMm } from '../../shared/capability/machine-selection/press-checks';
import { requiredClampForce, type MaterialClampProperties, type RunnerSystem } from '../clamp-force';
import type { ClampModel, PlasticReference } from '../plastic-reference';
import { partBboxLongestFirst } from '../molding-input';
import { shotGppsGramsPerCavity, shotWeightKgPerPart } from '../shot-size';

export interface IMSelectionRequirements {
  projectedAreaMm2: number | null;      // null = no clamp force derivable: the machine is not sized
  cavityCount: number;
  /** GPPS-equivalent grams one cavity needs (shot-size.ts); null = not derivable. */
  shotGppsGPerCavity: number | null;
  /** The material's reference clamp properties and label (for the reason text). */
  material: MaterialClampProperties;
  materialLabel: string;
  runner: RunnerSystem;
  partLengthMm: number | null;          // bbox largest dimension (tie-bar long axis)
  partWidthMm: number | null;           // bbox second dimension (tie-bar short axis)
  partHeightMm: number | null;          // bbox third dimension (min) — not used for tie-bar
  estimatedToolHeightMm: number | null; // null = skip daylight check
  /** Staged clamp model (plastic-reference.ts). */
  clampModel: ClampModel;
}

interface IMCandidateEvaluation {
  candidate: MachineCandidate;
  capable: boolean;
  blockReasons: string[];
  clampRequiredT: number | null;
  clampMachineT: number | null;
  clampUtil: number | null;             // requiredClamp / machineClamp, 0–1
  shotRequiredG: number | null;
  shotMachineG: number | null;
  shotUtil: number | null;
}

export function evaluateIMCandidate(
  candidate: MachineCandidate,
  req: IMSelectionRequirements,
): IMCandidateEvaluation {
  const cap = candidate.capability;
  // The clamp the part needs comes from the reference model; whether this press meets it, the shot, tie-bars and daylight are the one shared rule.
  const clamp = requiredClampForce({
    model: req.clampModel, material: req.material, materialLabel: req.materialLabel,
    projectedAreaMm2: req.projectedAreaMm2 ?? 0, cavityCount: req.cavityCount, runner: req.runner,
  });
  const shotRequiredG = req.shotGppsGPerCavity != null ? req.shotGppsGPerCavity * req.cavityCount : null;
  const checks = checkPress(cap, {
    clampTonnageRequired: clamp.derivable ? clamp.requiredTonnes : null,
    clampNotDerivableReason: clamp.derivable ? null : clamp.reason,
    shotGppsG: shotRequiredG,
    partLengthMm: req.partLengthMm,
    partWidthMm: req.partWidthMm,
    estimatedToolHeightMm: req.estimatedToolHeightMm,
  });

  return {
    candidate,
    capable: checks.capable,
    blockReasons: checks.reasons,
    clampRequiredT: checks.clampRequiredT ? Math.round(checks.clampRequiredT) : null,
    clampMachineT: cap.maxTonnage,
    clampUtil: checks.clampUtil,
    shotRequiredG: shotRequiredG != null ? Math.round(shotRequiredG) : null,
    shotMachineG: cap.shotCapacityGrams,
    shotUtil: checks.shotUtil,
  };
}

// ── Tier definitions ──────────────────────────────────────────────────────────
// Three press size classes the route comparison shows side by side (a display
// grouping of the real press pool, not a cost input).
const IM_TIERS = [
  { id: 'small',    label: 'Small Press',    minT: 0,   maxT: 120  },
  { id: 'medium',   label: 'Standard Press', minT: 121, maxT: 350  },
  { id: 'large',    label: 'Large Press',    minT: 351, maxT: 9999 },
] as const;

type IMTierId = typeof IM_TIERS[number]['id'];

interface IMTierResult {
  tierId: IMTierId;
  tierLabel: string;
  /** Every real press in the tier: capable ones first, then by clamp tonnage, largest first. */
  candidates: IMCandidateEvaluation[];
}

export function selectIMmachinesByTier(
  pool: MachineCandidate[],
  req: IMSelectionRequirements,
): IMTierResult[] {
  const evaluated = pool.filter((c) => c.machineClass === 'injection_molding').map((c) => evaluateIMCandidate(c, req));
  return IM_TIERS.map((tier) => ({
    tierId: tier.id,
    tierLabel: tier.label,
    candidates: evaluated
      .filter((e) => {
        const t = e.candidate.capability.maxTonnage;
        return t != null && t >= tier.minT && t <= tier.maxT;
      })
      .sort((a, b) => (a.capable !== b.capable ? (a.capable ? -1 : 1) : (b.candidate.capability.maxTonnage ?? 0) - (a.candidate.capability.maxTonnage ?? 0))),
  }));
}

/**
 * A real press as the injection engine's cavity search takes it (costMoldOnPresses): its clamp, shot and tie bars from its machine record, its
 * rate in the factory currency, and its own HR Rates process data (dry cycle, injection rate, good-part yield).
 */
export function moldingPressOf(
  candidate: MachineCandidate,
  records: ReadonlyMap<string, PressTiming & { goodPartYield: number | null }>,
  usdToLocal: number,
  selection?: MachineSelectionResult,
): MoldingPress {
  const record = candidate.machineId ? records.get(candidate.machineId) ?? null : null;
  return {
    mhrRate: mhrRateFromCandidate(candidate, 'injection_molding', usdToLocal, selection),
    machineClampTonnes: candidate.capability.maxTonnage,
    machineShotCapacityG: candidate.capability.shotCapacityGrams,
    tieBarXMm: candidate.capability.tieBarXMm,
    tieBarYMm: candidate.capability.tieBarYMm,
    pressTiming: record,
    goodPartYield: record?.goodPartYield ?? null,
  };
}

/**
 * What a press must hold for one cavity of the part (cold runner): the clamp the reference model derives from its projected area (bounding-box
 * footprint), the GPPS-equivalent shot (shot-size.ts, the engine's rule), and the part on the platen. The Cost Summary and the Route Comparison
 * pick their presses with it; the engine then sizes the cavities on them.
 */
export function injectionPressRequirements(a: {
  item: { maxLength?: number | null; maxWidth?: number | null; maxHeight?: number | null; volume?: number | null };
  grade: string | null;
  material: { materialDensityKgM3: number; densityOfMeltKgM3: number | null; clampProperties: MaterialClampProperties };
  reference: PlasticReference;
}): IMSelectionRequirements {
  const [l, w, h] = partBboxLongestFirst(a.item);
  const partVolumeMm3 = a.item.volume ?? 0;
  return {
    projectedAreaMm2: l * w > 0 ? l * w : null,
    cavityCount: 1,
    shotGppsGPerCavity: shotGppsGramsPerCavity({
      shotWeightKg: shotWeightKgPerPart((partVolumeMm3 / 1e9) * a.material.materialDensityKgM3, 'cold'),
      meltDensityKgM3: a.material.densityOfMeltKgM3,
      reference: a.reference,
    }),
    material: a.material.clampProperties,
    materialLabel: a.grade ?? 'this material',
    runner: 'cold',
    partLengthMm: l > 0 ? l : null,
    partWidthMm: w > 0 ? w : null,
    partHeightMm: h > 0 ? h : null,
    estimatedToolHeightMm: estimatedToolHeightMm(l),
    clampModel: a.reference.clampModel,
  };
}

/**
 * The press selection as the line shows it, with the press the part was costed on as the pick: when the cavity search (costMoldOnPresses)
 * molded the part on another press than the scored pick, that press leads, the scored pick becomes the first alternative, and the reason says
 * why. `candidate` is in USD (the machine pool); the selection is in the factory currency, so its rate is converted with `usdToLocal`.
 */
export function selectionCostedOn(selection: MachineSelectionResult, candidate: MachineCandidate, reason: string, usdToLocal: number): MachineSelectionResult {
  if (selection.balanced.candidate.machineId === candidate.machineId) {
    return { ...selection, balanced: { ...selection.balanced, reasons: [reason, ...selection.balanced.reasons] } };
  }
  const local: MachineCandidate = { ...candidate, hourlyRate: candidate.hourlyRate * usdToLocal };
  const ranked = selection.ranking?.find((r) => r.machineId === candidate.machineId);
  return {
    ...selection,
    balanced: { candidate: local, score: ranked?.score ?? selection.balanced.score, reasons: [reason] },
    alternatives: [selection.balanced.candidate, ...selection.alternatives.filter((c) => c.machineId !== candidate.machineId)].slice(0, 2),
    ...(selection.decision ? { decision: { winnerId: candidate.machineId, runnerUpId: selection.balanced.candidate.machineId, decidingFactor: 'cost' as const } } : {}),
  };
}
