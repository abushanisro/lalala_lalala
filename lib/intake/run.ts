// Carries an intake plan out: the project, its BOM, then each part (the record, the model built from its drawing, the files, the
// analysis, the cost), then the CAD files. Every step goes through an existing endpoint, given here as `api` so the order can be
// tested without a server. One part failing does not stop the others; the project or the BOM failing stops everything.
import type { DrawingHole, DrawingShape, DrawingSolid } from "@/lib/api/drawing-readings";

import { costable, type IntakePlan, type PlanPart } from "./plan";

export interface IntakeApi {
  createProject(name: string): Promise<{ id: string }>;
  createBom(projectId: string, name: string): Promise<{ id: string }>;
  createItem(item: { bomId: string; name: string; partNumber: string; quantity: number; annualVolume?: number; material?: string; materialGrade?: string }): Promise<{ id: string }>;
  buildSolid(body: { shape: DrawingShape; holes: DrawingHole[]; name: string }): Promise<DrawingSolid>;
  uploadFiles(itemId: string, files: { file2d?: File; file3d?: File }): Promise<unknown>;
  setProcessGroup(itemId: string, processGroup: string): Promise<unknown>;
  /** Makes the part's analysis current; ready is false while something is still missing. */
  analyse(itemId: string): Promise<{ status: { ready: boolean; missing: string[] } }>;
  applyScenario(itemId: string, request: { location: string; route: { mode: "auto" }; materialGrade: string; annualVolume?: number; batchSize?: number; scenarioPatch: Record<string, unknown> }): Promise<unknown>;
  importCad(bomId: string, file: File): Promise<unknown>;
}

export type StepState = "running" | "done" | "failed";
/** One line of progress: the project, the BOM, a part or a CAD file, with what is happening to it now. */
export interface IntakeEvent { key: string; title: string; state: StepState; detail: string }

export interface PartOutcome { file: string; itemId: string | null; costed: boolean; detail: string }
export interface IntakeResult {
  projectId: string; bomId: string; parts: PartOutcome[]; cadImported: number;
  /** The person stopped it before everything was made: `parts` holds only what was begun. */
  stopped?: boolean;
}

/** The page of the BOM that was made. */
export const bomPath = ({ projectId, bomId }: Pick<IntakeResult, "projectId" | "bomId">): string => `/projects/${projectId}/bom/${bomId}`;
/**
 * The Manufacturing Intelligence page of the part to look at first: the first costed one, else the first one created. Null when no
 * part was made here (CAD files only: their parts appear in the BOM as the import finishes).
 */
export function partPath(result: IntakeResult): string | null {
  const part = result.parts.find(p => p.costed && p.itemId) ?? result.parts.find(p => p.itemId);
  return part?.itemId ? `${bomPath(result)}/items/${part.itemId}/manufacturing-intelligence` : null;
}

const messageOf = (error: unknown): string => (error instanceof Error && error.message ? error.message : "The server did not answer.");

/** The STEP of a built solid as a file to upload. */
export function stepFile(solid: Pick<DrawingSolid, "fileName" | "stepBase64">): File {
  const bytes = Uint8Array.from(atob(solid.stepBase64), char => char.charCodeAt(0));
  return new File([bytes], solid.fileName, { type: "application/octet-stream" });
}

/** Thrown between the steps of a part when the person has stopped: the part stays as far as it was made. */
class Stopped extends Error {}

const ANALYSIS_TRIES = 3;
const BUSY_TRIES = 4;

/**
 * The server limits how fast files are uploaded and analyses started (HTTP 429). A batch of drawings meets that limit as a matter of
 * course, so a busy answer is waited out and asked again; anything else is a failure at once.
 */
async function patiently<T>(work: () => Promise<T>, wait: (ms: number) => Promise<void>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await work();
    } catch (error) {
      if ((error as { status?: unknown }).status !== 429 || attempt === BUSY_TRIES) throw error;
      await wait(20_000);
    }
  }
}

async function createPart(part: PlanPart, plan: IntakePlan, bomId: string, drawing: File | undefined, api: IntakeApi,
  say: (state: StepState, detail: string) => void, wait: (ms: number) => Promise<void>, stopped: () => boolean): Promise<PartOutcome> {
  let itemId: string | null = null;
  let doing = "creating the part";
  /** Before each step that follows the part's creation: a stop is honoured between steps, never in the middle of one. */
  const goOn = () => { if (stopped()) throw new Stopped(); };
  try {
    say("running", "Creating the part");
    itemId = (await api.createItem({
      bomId, name: part.name.trim(), partNumber: part.partNumber.trim(), quantity: part.quantity,
      ...(plan.annualVolume != null ? { annualVolume: plan.annualVolume } : {}),
      ...(part.materialRead ? { material: part.materialRead } : {}),
      ...(part.grade ? { materialGrade: part.grade } : {}),
    })).id;

    let note = "";
    let model: File | undefined;
    if (part.shape) {
      goOn();
      doing = "building the 3D model";
      say("running", "Building the 3D model from the drawing");
      const { shape, holes } = part;
      const solid = await patiently(() => api.buildSolid({ shape, holes, name: part.partNumber.trim() }), wait);
      model = stepFile(solid);
      if (solid.holesLeftOut > 0) note = ` ${solid.holesLeftOut} ${solid.holesLeftOut === 1 ? "hole does" : "holes do"} not fit the model and ${solid.holesLeftOut === 1 ? "is" : "are"} not in the cost.`;
    }
    if (drawing || model) {
      goOn();
      doing = "attaching the files";
      say("running", "Attaching the drawing and the model");
      const made = itemId;
      await patiently(() => api.uploadFiles(made, { ...(drawing ? { file2d: drawing } : {}), ...(model ? { file3d: model } : {}) }), wait);
    }

    const cost = costable(part);
    if (!cost.ok || !part.processGroup || !part.grade) {
      const why = cost.ok ? "" : cost.why;
      say("done", `Created without a cost. ${why}`);
      return { file: part.file, itemId, costed: false, detail: why };
    }
    goOn();
    doing = "analysing the model";
    say("running", `Analysing the model for ${part.processGroup}`);
    const item = itemId, { grade, processGroup } = part;
    await api.setProcessGroup(item, processGroup);          // before the analysis: it extracts the features of the chosen process
    for (let attempt = 1; ; attempt++) {
      const { status } = await patiently(() => api.analyse(item), wait);
      if (status.ready) break;
      if (attempt === ANALYSIS_TRIES) throw new Error(`The analysis is not complete (${status.missing.join(", ") || "still running"}).`);
      await wait(6000);
      goOn();
    }
    goOn();
    doing = "costing";
    say("running", `Costing in ${plan.location}`);
    await patiently(() => api.applyScenario(item, {
      location: plan.location, route: { mode: "auto" }, materialGrade: grade, scenarioPatch: {},
      ...(plan.annualVolume != null ? { annualVolume: plan.annualVolume } : {}),
      ...(plan.batchSize != null ? { batchSize: plan.batchSize } : {}),
    }), wait);
    say("done", `Costed from a model built from the drawing (approximate).${note}`);
    return { file: part.file, itemId, costed: true, detail: note.trim() };
  } catch (error) {
    if (error instanceof Stopped) {
      say("done", "Created without a cost: stopped before it was costed.");
      return { file: part.file, itemId, costed: false, detail: "Stopped before it was costed." };
    }
    const detail = `Stopped while ${doing}: ${messageOf(error)}`;
    say("failed", detail);
    return { file: part.file, itemId, costed: false, detail };
  }
}

/** `stopped` says whether the person has asked to stop: no further part or file is begun then, and the part in hand ends after its step. */
export async function runIntake(plan: IntakePlan, files: ReadonlyMap<string, File>, api: IntakeApi, onEvent: (event: IntakeEvent) => void,
  wait: (ms: number) => Promise<void> = ms => new Promise(resolve => { setTimeout(resolve, ms); }), stopped: () => boolean = () => false): Promise<IntakeResult> {
  const step = async <T>(key: string, title: string, doing: string, work: () => Promise<T>): Promise<T> => {
    onEvent({ key, title, state: "running", detail: doing });
    try {
      const made = await work();
      onEvent({ key, title, state: "done", detail: "Created" });
      return made;
    } catch (error) {
      onEvent({ key, title, state: "failed", detail: messageOf(error) });
      throw error;
    }
  };
  const project = await step("project", `Project "${plan.projectName.trim()}"`, "Creating the project", () => api.createProject(plan.projectName.trim()));
  const bom = await step("bom", `BOM "${plan.bomName.trim()}"`, "Creating the BOM", () => api.createBom(project.id, plan.bomName.trim()));

  const parts: PartOutcome[] = [];
  for (const part of plan.parts) {            // one at a time: the CAD engine limits how many analyses run at once
    if (stopped()) break;
    const title = part.name.trim();
    parts.push(await createPart(part, plan, bom.id, files.get(part.file), api, (state, detail) => { onEvent({ key: `part:${part.file}`, title, state, detail }); }, wait, stopped));
  }
  let cadImported = 0;
  for (const name of plan.cadFiles) {
    const file = files.get(name);
    if (!file) continue;
    if (stopped()) break;
    try {
      onEvent({ key: `cad:${name}`, title: name, state: "running", detail: "Sending to the CAD import" });
      await api.importCad(bom.id, file);
      cadImported++;
      onEvent({ key: `cad:${name}`, title: name, state: "done", detail: "Import started: its parts appear in the BOM as it finishes." });
    } catch (error) {
      onEvent({ key: `cad:${name}`, title: name, state: "failed", detail: messageOf(error) });
    }
  }
  return { projectId: project.id, bomId: bom.id, parts, cadImported, ...(stopped() ? { stopped: true } : {}) };
}
