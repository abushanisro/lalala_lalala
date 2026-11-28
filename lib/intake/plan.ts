// The intake box's plan: what each dropped file is, what a drawing reading becomes as a part to create, and what is still missing
// before the project can be created. Pure: the box renders this and lib/intake/run.ts carries it out.
import type { DrawingHole, DrawingReading, DrawingShape, ProcessFamily } from "@/lib/api/drawing-readings";

export type IntakeFileKind = "drawing" | "cad";

/** What a dropped file is, by its name: a drawing is read by the vision model, a CAD file goes to the CAD import. Null: not taken. */
export function intakeFileKind(fileName: string): IntakeFileKind | null {
  const extension = fileName.toLowerCase().split(".").pop() ?? "";
  if (["png", "jpg", "jpeg", "webp", "gif", "pdf"].includes(extension)) return "drawing";
  if (["step", "stp", "zip"].includes(extension)) return "cad";
  return null;
}
export const INTAKE_ACCEPT = ".png,.jpg,.jpeg,.webp,.gif,.pdf,.step,.stp,.zip";

/** Whether an added file is a picture the page can show as it is (a PDF drawing and a CAD file are named instead). */
export function isPicture(fileName: string): boolean {
  return ["png", "jpg", "jpeg", "webp", "gif"].includes(fileName.toLowerCase().split(".").pop() ?? "");
}

/**
 * Whether a drag carries files (a DataTransfer's `types`), as opposed to selected text or a link: only then is it the prompt's to take.
 * The files themselves cannot be read until the drop.
 */
export function carriesFiles(types: readonly string[] | undefined | null): boolean {
  return types?.includes("Files") ?? false;
}

/** One part the plan will create, from one drawing. The person can change the name, the grade and the process before creating. */
export interface PlanPart {
  /** The drawing's file name: the part's key in the plan. */
  file: string;
  name: string;
  partNumber: string;
  quantity: number;
  /** The material as the drawing writes it. */
  materialRead: string | null;
  /** The material grade from the material database: needed for a cost. */
  grade: string | null;
  /** The app's process group: needed for a cost. */
  processGroup: string | null;
  processReason: string | null;
  shape: DrawingShape | null;
  holes: DrawingHole[];
  /** What the reader could not read clearly, in its own words. */
  unsure: string[];
}

const num = (v: number): string => String(Math.round(v * 100) / 100);

/** "Block 120 × 60 × 12 mm, 6 holes": what the model will be built as. */
export function shapeSummary(shape: DrawingShape | null, holes: readonly DrawingHole[]): string {
  if (!shape) return "No overall size on the drawing";
  const count = holes.reduce((sum, h) => sum + h.count, 0);
  const holed = count === 0 ? "" : `, ${count} ${count === 1 ? "hole" : "holes"}`;
  if (shape.kind === "block") return `Block ${num(shape.lengthMm)} × ${num(shape.widthMm)} × ${num(shape.heightMm)} mm${holed}`;
  if (shape.kind === "sheet") return `Sheet ${num(shape.lengthMm)} × ${num(shape.widthMm)} mm, ${num(shape.thicknessMm)} mm thick${holed}`;
  const length = shape.segments.reduce((sum, s) => sum + s.lengthMm, 0);
  const largest = Math.max(...shape.segments.map(s => s.diameterMm));
  return `Turned, ⌀${num(largest)} × ${num(length)} mm in ${shape.segments.length} ${shape.segments.length === 1 ? "step" : "steps"}`
    + `${shape.boreDiameterMm ? `, ⌀${num(shape.boreDiameterMm)} bore` : ""}${holed}`;
}

/** The process group of the app's catalog that a drawing's process family means, when the catalog has exactly that one. */
export function processGroupFor(family: ProcessFamily | undefined, groups: readonly string[]): string | null {
  const wanted: Partial<Record<ProcessFamily, RegExp>> = {
    machining: /^machining$/i, sheet_metal: /^sheet metal$/i, forging: /^forging$/i, plastic_molding: /^plastic molding$/i,
  };
  const pattern = family ? wanted[family] : undefined;      // casting has several groups (sand, die, investment): the person chooses
  return (pattern && groups.find(g => pattern.test(g))) ?? null;
}

/**
 * The material grade of the database that a drawing's material text names, when one clearly does: the grade must carry every
 * designation number of the text (6061, 304, 4140), and of several that do, the plainest (shortest) name wins. No number, no match:
 * a guess here would cost the part in the wrong metal.
 */
export function gradeFor(materialRead: string | null, grades: readonly string[]): string | null {
  const numbers = (materialRead ?? "").match(/\d{3,}/g);
  if (!numbers) return null;
  const tokens = (name: string) => name.toLowerCase().split(/[^a-z0-9]+/);
  const matching = grades.filter(grade => numbers.every(n => tokens(grade).includes(n)));
  return matching.sort((a, b) => a.length - b.length || a.localeCompare(b))[0] ?? null;
}

/** A reading as a part of the plan. Null when the file is not a drawing of a part. */
export function planPart(file: string, reading: DrawingReading, groups: readonly string[]): PlanPart | null {
  if (!reading.isDrawing) return null;
  const stem = file.replace(/\.[^.]+$/, "");
  return {
    file,
    name: reading.partName ?? stem,
    partNumber: reading.partNumber ?? stem,
    quantity: reading.quantity ?? 1,
    materialRead: reading.material,
    grade: null,
    processGroup: processGroupFor(reading.process?.family, groups),
    processReason: reading.process?.reason ?? null,
    shape: reading.shape,
    holes: reading.holes,
    unsure: reading.unsure,
  };
}

export interface IntakePlan {
  projectName: string;
  bomName: string;
  /** Where the parts are made: the scenario every part is costed in. */
  location: string;
  annualVolume: number | null;
  batchSize: number | null;
  parts: PlanPart[];
  /** STEP files and zips, imported into the BOM as they are. */
  cadFiles: string[];
}

/** Whether a part of the plan will be costed, and if not, why. A part with no size is still created, with its drawing. */
export function costable(part: PlanPart): { ok: true } | { ok: false; why: string } {
  if (!part.shape) return { ok: false, why: "The drawing gives no overall size, so no model can be built: the part is created without a cost." };
  if (!part.processGroup) return { ok: false, why: "Choose the process to cost this part." };
  if (!part.grade) return { ok: false, why: "Choose the material grade to cost this part." };
  return { ok: true };
}

/** What stops the plan from being created, in the order the person meets it. Empty: ready. */
export function planBlockers(plan: IntakePlan): string[] {
  const blockers: string[] = [];
  if (!plan.projectName.trim()) blockers.push("Give the project a name.");
  if (!plan.bomName.trim()) blockers.push("Give the BOM a name.");
  if (plan.parts.length === 0 && plan.cadFiles.length === 0) blockers.push("Nothing to create: no part was read and no CAD file was added.");
  if (plan.parts.some(p => !p.name.trim() || !p.partNumber.trim())) blockers.push("Every part needs a name and a part number.");
  if (plan.parts.some(p => p.shape && p.processGroup && p.grade) && !plan.location) blockers.push("Choose where the parts are made.");
  return blockers;
}

/**
 * What Build still needs from the person before it creates the project by itself: whatever stops the plan, then each part that has a
 * size but no process or no material grade (it would be created without a cost, and only the person can say which it is). A part with
 * no size on its drawing is not held back for: no answer makes it costable. Empty: Build goes ahead.
 */
export function buildNeeds(plan: IntakePlan): string[] {
  const needs = planBlockers(plan);
  for (const part of plan.parts) {
    if (!part.shape) continue;
    if (!part.processGroup) needs.push(`Choose the process for ${part.name.trim() || part.file}.`);
    else if (!part.grade) needs.push(`Choose the material grade for ${part.name.trim() || part.file}.`);
  }
  return needs;
}

