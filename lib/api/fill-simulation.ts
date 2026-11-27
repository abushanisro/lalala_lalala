import { apiClient } from "@/lib/api/client";

export type Vec3 = [number, number, number];

/** The grade's own Cross-WLF viscosity constants (datasheet or rheometer fit). There is no default set. */
export interface CrossWlf {
  n: number;
  tauPa: number;
  d1PaS: number;
  d2K: number;
  a1: number;
  a2K: number;
}

/** POST /bom-items/:id/fill-simulations. Without `gateMm` the answer is the fill mesh alone. */
export interface FillSimulationRequest {
  /** Part-centred millimetres: the frame of `mesh.nodesMm`. */
  gateMm?: Vec3;
  gateRadiusMm?: number;
  fillTimeS?: number;
  meltTempC?: number;
  /** The grade's own constants; or, without them, `flowLengthRatio` with `maxInjectionPressureMpa` for an estimate. */
  rheology?: CrossWlf;
  flowLengthRatio?: number;
  /** Left out: the CAD engine chooses the opening direction from the part. */
  pullAxis?: "x" | "y" | "z";
  maxInjectionPressureMpa?: number;
}

/** GET /bom-items/:id/fill-simulation-inputs: what the reference data recommends for the part's grade. Null where it has nothing. */
export interface FillSimulationInputs {
  materialGrade: string | null;
  /** The material record the values were read from. */
  referenceMaterial: string | null;
  meltTempC: number | null;
  moldTempC: number | null;
  injectionPressureMaxMpa: number | null;
  /** The grade's maximum flow length over wall thickness. */
  flowLengthRatio: number | null;
  /** Pressure left at the cavity after the runner, by runner system. */
  availablePressureMpa: { cold: number | null; hot: number | null };
  notes: string[];
}

export interface FillMesh {
  /** Part-centred millimetres, on the wall's mid-surface. */
  nodesMm: Vec3[];
  triangles: Vec3[];
  /** Wall thickness at each node. */
  thicknessMm: (number | null)[];
  faceId: number[];
  centreMm: Vec3;
}

export interface FillMeshReport {
  trianglesTotal: number;
  trianglesInMesh: number;
  /** Detached pieces (rib sides, bosses) left out of the mesh, and their share of the volume. */
  detachedPieces: number;
  detachedVolumePct: number;
  longestEdgeMm: number;
  targetEdgeMm: number;
  resolutionLimited: boolean;
  cadVolumeMm3: number;
  meshVolumeMm3: number;
  volumeRatio: number | null;
  /** The mold opening direction the CAD engine chose from the part, when it could. */
  pullDirection: Vec3 | null;
  issues: { code: string; message: string; triangles: number[] }[];
  /** False when the mesh cannot be filled or would not describe the part (no thin wall): `issues` says why. */
  canSimulate: boolean;
}

export interface FillIssue {
  code: string;
  severity: "error" | "warning" | "info";
  message: string;
}

export interface FillSummary {
  fillTimeS: number;
  flowRateMm3S: number;
  volumeMm3: number;
  switchoverPressureMpa: number;
  wallShearStressPeakMpa: number;
  wallShearRatePeakPerS: number;
  frontSpeedMedianMmS: number;
  unfilledVolumePct: number;
  weldLineLengthMm: number;
  airTraps: number;
  ventedEndPoints: number;
  /** Null when no pull axis was given. */
  clampForceT: number | null;
}

export interface FillRun {
  inputs: {
    gateMm: Vec3;
    fillTimeS: number;
    meltTempC: number | null;
    flowRateMm3S: number;
    switchover: number;
    /** How the melt's viscosity was given: the grade's Cross-WLF constants, or one number estimated from its flow length ratio. */
    viscosity: { model: "cross_wlf" } | { model: "flow_length_estimate"; effectiveViscosityPaS: number; flowLengthRatio: number; pressureMpa: number };
    /** The opening direction used for the clamp force, and whether the engineer gave it or the engine chose it. */
    pull: { vector: Vec3; source: "given" | "automatic" } | null;
  };
  /** Per node; null where the melt never arrived. */
  fillTimeS: (number | null)[];
  /** Per node, at the velocity/pressure switchover. */
  pressureMpa: (number | null)[];
  frontSpeedMmS: (number | null)[];
  wallShearStressMpa: (number | null)[];
  wallShearRatePerS: (number | null)[];
  /** Per triangle: the melt velocity as the front closed it. */
  velocityMmS: Vec3[];
  weldLines: { fromMm: Vec3; toMm: Vec3; timeS: number; meetingAngleDeg: number }[];
  endOfFill: { atMm: Vec3; timeS: number; ventedEdge: boolean }[];
  curve: { timeS: number[]; inletPressureMpa: number[]; filledFraction: number[] };
  assumptions: string[];
  summary: FillSummary;
  issues: FillIssue[];
}

export interface FillSimulationResponse {
  version: string;
  mesh: FillMesh;
  report: FillMeshReport;
  simulation: FillRun | null;
}

export const fillSimulationApi = {
  inputs(bomItemId: string): Promise<FillSimulationInputs> {
    return apiClient.get<FillSimulationInputs>(`/bom-items/${encodeURIComponent(bomItemId)}/fill-simulation-inputs`);
  },
  /** The engine meshes the part and, with a gate, fills it: seconds, so no retry and a long timeout. */
  run(bomItemId: string, body: FillSimulationRequest): Promise<FillSimulationResponse> {
    return apiClient.post<FillSimulationResponse>(`/bom-items/${encodeURIComponent(bomItemId)}/fill-simulations`, body, { timeout: 250_000, retry: false });
  },
};
