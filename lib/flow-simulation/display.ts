/**
 * How a fill simulation is shown: which results there are, the colour scale and its legend, the animation's fill mask, and where the
 * direction arrows go. Pure functions on the API's arrays, so they are tested without a canvas.
 */
import type { CrossWlf, FillMesh, FillRun, FillSimulationInputs, FillSimulationRequest, Vec3 } from "@/lib/api/fill-simulation";

export type ResultKind = "fillTime" | "pressure" | "frontSpeed" | "shearStress" | "shearRate" | "thickness";

export interface ResultSpec {
  kind: ResultKind;
  label: string;
  unit: string;
  digits: number;
  /** Scale to the 98th percentile: these peak at the gate, a point source, and one hot node would wash the rest to blue. */
  capped: boolean;
  /** What the picture shows, in one line under the legend. */
  note: string;
}

const FILL_TIME: ResultSpec = { kind: "fillTime", label: "Fill time", unit: "s", digits: 3, capped: false, note: "When the melt front reached each point. Evenly spaced bands mean an even fill." };

export const RESULTS: readonly ResultSpec[] = [
  FILL_TIME,
  { kind: "pressure", label: "Pressure at V/P switchover", unit: "MPa", digits: 1, capped: false, note: "Cavity pressure when the machine switches from filling to packing. Highest at the gate." },
  { kind: "frontSpeed", label: "Melt-front velocity", unit: "mm/s", digits: 0, capped: true, note: "Melt speed as the front passed. Arrows show the direction. A stall is a hesitation mark risk." },
  { kind: "shearStress", label: "Shear stress at wall", unit: "MPa", digits: 3, capped: true, note: "At switchover. Compare with the grade's limit: over it the surface degrades." },
  { kind: "shearRate", label: "Shear rate at wall", unit: "1/s", digits: 0, capped: true, note: "At switchover. Compare with the grade's limit." },
  { kind: "thickness", label: "Wall thickness", unit: "mm", digits: 2, capped: false, note: "The wall the simulation used at each point of the mid-surface." },
];

export function specOf(kind: ResultKind): ResultSpec {
  return RESULTS.find((r) => r.kind === kind) ?? FILL_TIME;
}

/** The node values of a result; before a run only the wall thickness exists. */
export function valuesOf(kind: ResultKind, mesh: FillMesh, run: FillRun | null): (number | null)[] {
  if (kind === "thickness" || !run) return mesh.thicknessMm;
  if (kind === "fillTime") return run.fillTimeS;
  if (kind === "pressure") return run.pressureMpa;
  if (kind === "frontSpeed") return run.frontSpeedMmS;
  if (kind === "shearStress") return run.wallShearStressMpa;
  return run.wallShearRatePerS;
}

export interface Scale {
  /** Smallest and largest value present. */
  min: number;
  max: number;
  /** The value drawn in the top colour: `max`, or the 98th percentile for a capped result. */
  top: number;
}

export function scaleOf(values: readonly (number | null)[], capped: boolean): Scale | null {
  const present = values.filter((v): v is number => v !== null && Number.isFinite(v)).sort((a, b) => a - b);
  const min = present[0];
  const max = present[present.length - 1];
  if (min === undefined || max === undefined) return null;
  const top = capped ? (present[Math.min(present.length - 1, Math.floor(0.98 * present.length))] ?? max) : max;
  return { min, max, top: top > min ? top : max };
}

/** The contour colours every mold-flow tool uses: blue (low) through cyan, green and yellow to red (high). t is clamped to 0..1. */
export function contourColour(t: number): Vec3 {
  const x = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0)) * 4;
  if (x <= 1) return [0, x, 1];
  if (x <= 2) return [0, 1, 2 - x];
  if (x <= 3) return [x - 2, 1, 0];
  return [1, 4 - x, 0];
}

export const UNFILLED: Vec3 = [0.78, 0.8, 0.82];

/** Where on the colour scale a value sits (0..1); a flat field sits in the middle. */
export function position(value: number, scale: Scale): number {
  return scale.top > scale.min ? (value - scale.min) / (scale.top - scale.min) : 0.5;
}

/**
 * Colours for every node at animation time `time`: the result's colour where the melt has arrived, grey where it has not.
 * `fillTime` null means no run yet: everything is shown. Writes into `out` (3 floats per node) and returns it.
 */
export function nodeColours(values: readonly (number | null)[], scale: Scale | null, fillTime: readonly (number | null)[] | null, time: number, out: Float32Array): Float32Array {
  for (let i = 0; i < values.length; i++) {
    const value = values[i] ?? null;
    const arrived = fillTime ? fillTime[i] ?? null : 0;
    const filled = arrived !== null && arrived <= time;
    const [r, g, b] = filled && value !== null && scale ? contourColour(position(value, scale)) : UNFILLED;
    out[3 * i] = r;
    out[3 * i + 1] = g;
    out[3 * i + 2] = b;
  }
  return out;
}

/** Legend labels from the top colour down to the bottom, `steps` intervals. */
export function legendTicks(scale: Scale, steps = 10): number[] {
  return Array.from({ length: steps + 1 }, (_, i) => scale.top - ((scale.top - scale.min) * i) / steps);
}

export function formatValue(value: number, digits: number): string {
  return value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** The legend's colour bar as a CSS gradient, top colour first. */
export function legendGradient(): string {
  const stops = [1, 0.75, 0.5, 0.25, 0].map((t) => {
    const [r, g, b] = contourColour(t);
    return `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`;
  });
  return `linear-gradient(to bottom, ${stops.join(", ")})`;
}

export interface Arrow {
  at: Vec3;
  /** Unit vector: the way the melt was moving. */
  direction: Vec3;
  speed: number;
  /** When the front closed the triangle the arrow sits on: the arrow appears then. */
  time: number;
}

export interface ArrowPlan {
  /** Sorted by `time`, so the arrows visible at a moment are a prefix. */
  arrows: Arrow[];
  /** Arrow length in mm: a fraction of the spacing, so neighbours never overlap. */
  length: number;
}

/**
 * Direction arrows spread evenly over the part: the mesh is far denser than a readable arrow field, so the part's box is cut into cells
 * and each cell shows the arrow of one triangle in it. About `target` arrows on a part of any size or shape.
 */
export function planArrows(mesh: FillMesh, run: FillRun, target = 320): ArrowPlan {
  let area = 0;
  const centroids: Vec3[] = [];
  for (const [a, b, c] of mesh.triangles) {
    const p = mesh.nodesMm[a];
    const q = mesh.nodesMm[b];
    const r = mesh.nodesMm[c];
    if (!p || !q || !r) {
      centroids.push([0, 0, 0]);
      continue;
    }
    const u: Vec3 = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
    const v: Vec3 = [r[0] - p[0], r[1] - p[1], r[2] - p[2]];
    area += Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) / 2;
    centroids.push([(p[0] + q[0] + r[0]) / 3, (p[1] + q[1] + r[1]) / 3, (p[2] + q[2] + r[2]) / 3]);
  }
  const cell = Math.sqrt(area / Math.max(1, target)) || 1;
  const taken = new Set<string>();
  const arrows: Arrow[] = [];
  mesh.triangles.forEach((triangle, i) => {
    const velocity = run.velocityMmS[i];
    const at = centroids[i];
    if (!velocity || !at) return;
    const speed = Math.hypot(velocity[0], velocity[1], velocity[2]);
    const times = triangle.map((n) => run.fillTimeS[n] ?? null);
    if (speed <= 0 || times.some((t) => t === null)) return;
    const key = at.map((x) => Math.floor(x / cell)).join(":");
    if (taken.has(key)) return;
    taken.add(key);
    arrows.push({ at, direction: [velocity[0] / speed, velocity[1] / speed, velocity[2] / speed], speed, time: Math.max(...(times as number[])) });
  });
  arrows.sort((a, b) => a.time - b.time);
  return { arrows, length: 0.72 * cell };
}

/** How many of a time-sorted list have happened by `time` (binary search). */
export function countUpTo(times: readonly number[], time: number): number {
  let lo = 0;
  let hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((times[mid] ?? Infinity) <= time) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The text fields of the setup form. Kept as typed so a half-entered number is not thrown away. */
export interface SetupForm {
  gate: Vec3 | null;
  fillTimeS: string;
  meltTempC: string;
  /** How the melt's viscosity is given: estimated from the grade's flow length ratio, or the grade's own Cross-WLF constants. */
  viscosity: "estimate" | "crossWlf";
  flowLengthRatio: string;
  n: string;
  tauPa: string;
  d1PaS: string;
  d2K: string;
  a1: string;
  a2K: string;
  /** "" = automatic: the CAD engine chooses the opening direction from the part. */
  pullAxis: "" | "x" | "y" | "z";
  maxInjectionPressureMpa: string;
}

export const EMPTY_SETUP: SetupForm = {
  gate: null, fillTimeS: "", meltTempC: "", viscosity: "estimate", flowLengthRatio: "", n: "", tauPa: "", d1PaS: "", d2K: "", a1: "", a2K: "", pullAxis: "", maxInjectionPressureMpa: "",
};

/** A value the setup can start from, and where it comes from, in words. */
export interface Suggestion {
  value: string;
  source: string;
}

export type SuggestedField = "fillTimeS" | "meltTempC" | "maxInjectionPressureMpa" | "flowLengthRatio";
export type Suggestions = Partial<Record<SuggestedField, Suggestion>>;

/** The fill time the cost engine calculated for the part: the "Fill Time" step of its molding line's calculator. Null when there is none. */
export function costedFillTimeS(lines: readonly { calculationTrace?: readonly { fieldName: string; value: number | string | null }[] | undefined }[] | undefined): number | null {
  for (const line of lines ?? []) {
    const step = line.calculationTrace?.find((s) => s.fieldName === "Fill Time");
    if (step && typeof step.value === "number" && step.value > 0) return step.value;
  }
  return null;
}

const tidy = (value: number): string => String(Number(value.toPrecision(4)));

/**
 * What the setup starts from: the grade's reference values and the part's costed fill time. Only what the data really holds: a grade the
 * reference does not cover suggests nothing. `runner` picks the pressure left after that runner system (the cold runner's when not known).
 */
export function suggestionsOf(inputs: FillSimulationInputs | null | undefined, cost: { fillTimeS: number | null; runner: "hot" | "cold" | null }): Suggestions {
  const out: Suggestions = {};
  if (cost.fillTimeS !== null) out.fillTimeS = { value: tidy(cost.fillTimeS), source: "this part's costed fill time" };
  if (!inputs) return out;
  const record = inputs.referenceMaterial ? `the ${inputs.referenceMaterial} record` : "the material record";
  if (inputs.meltTempC !== null) out.meltTempC = { value: tidy(inputs.meltTempC), source: record };
  const runner = cost.runner ?? "cold";
  const pressure = inputs.availablePressureMpa[runner] ?? inputs.injectionPressureMaxMpa;
  if (pressure !== null) {
    out.maxInjectionPressureMpa = {
      value: tidy(pressure),
      source: inputs.availablePressureMpa[runner] !== null ? `${record}, less the ${runner} runner's loss` : `${record} (maximum injection pressure)`,
    };
  }
  if (inputs.flowLengthRatio !== null) out.flowLengthRatio = { value: tidy(inputs.flowLengthRatio), source: record };
  return out;
}

/** The form with every still-empty field filled from the suggestions. What the engineer typed is never replaced. */
export function withSuggestions(form: SetupForm, suggestions: Suggestions): SetupForm {
  const next = { ...form };
  for (const key of Object.keys(suggestions) as SuggestedField[]) {
    const suggestion = suggestions[key];
    if (suggestion && next[key].trim() === "") next[key] = suggestion.value;
  }
  return next;
}

const number = (text: string): number | null => {
  const value = Number(text.trim());
  return text.trim() !== "" && Number.isFinite(value) ? value : null;
};

/** The request a filled-in form makes, or what is still missing or impossible, in the engineer's words. */
export function requestOf(form: SetupForm): { request: FillSimulationRequest; missing: [] } | { request: null; missing: string[] } {
  const missing: string[] = [];
  if (!form.gate) missing.push("a gate (click the model)");
  const fillTimeS = number(form.fillTimeS);
  if (fillTimeS === null || fillTimeS <= 0 || fillTimeS > 600) missing.push("fill time (0 to 600 s)");
  const limit = number(form.maxInjectionPressureMpa);
  const meltTempC = number(form.meltTempC);
  const meltOk = meltTempC !== null && meltTempC > 0 && meltTempC < 500;
  const rheology: Partial<CrossWlf> = {};
  const flowLengthRatio = number(form.flowLengthRatio);
  if (form.viscosity === "crossWlf") {
    if (!meltOk) missing.push("melt temperature (deg C)");
    const fields: [keyof CrossWlf, string, string][] = [["n", form.n, "n"], ["tauPa", form.tauPa, "tau*"], ["d1PaS", form.d1PaS, "D1"], ["d2K", form.d2K, "D2"], ["a1", form.a1, "A1"], ["a2K", form.a2K, "A2"]];
    for (const [key, text, name] of fields) {
      const value = number(text);
      if (value === null || value <= 0 || (key === "n" && value > 1)) missing.push(key === "n" ? "n (above 0, at most 1)" : `${name} (above 0)`);
      else rheology[key] = value;
    }
    if (meltOk && rheology.d2K !== undefined && meltTempC + 273.15 <= rheology.d2K) missing.push("a melt temperature above D2");
    if (form.maxInjectionPressureMpa.trim() !== "" && (limit === null || limit <= 0)) missing.push("a pressure limit above 0, or none");
  } else {
    if (form.meltTempC.trim() !== "" && !meltOk) missing.push("melt temperature (deg C), or none");
    if (flowLengthRatio === null || flowLengthRatio <= 0 || flowLengthRatio > 2000) missing.push("the grade's flow length ratio");
    if (limit === null || limit <= 0) missing.push("the injection pressure available (MPa)");
  }
  if (missing.length > 0 || !form.gate || fillTimeS === null) return { request: null, missing };
  return {
    request: {
      gateMm: form.gate,
      fillTimeS,
      ...(meltOk ? { meltTempC } : {}),
      ...(form.viscosity === "crossWlf" ? { rheology: rheology as CrossWlf } : flowLengthRatio !== null ? { flowLengthRatio } : {}),
      ...(form.pullAxis ? { pullAxis: form.pullAxis } : {}),
      ...(limit !== null ? { maxInjectionPressureMpa: limit } : {}),
    },
    missing: [],
  };
}
