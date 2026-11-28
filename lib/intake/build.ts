// Carries the New page's conversation out: reads what was sent, asks the person for what a cost still needs, then creates the project
// and costs its parts. A fixed sequence of steps, with the model only where a step needs it (reading a drawing, answering a question):
// what is created is decided by the rules in conversation.ts and plan.ts, never by generated text. Everything it learns goes into the
// draft (lib/intake/draft.ts), so it carries on while the page is not on screen. What it calls is given as `deps`, so the order can
// be tested without a server.
import type { DrawingReading } from "@/lib/api/drawing-readings";

import { applyAnswer, narrative, needKey, nextNeed, questionFor, type Answer, type Entry } from "./conversation";
import { intakeDraft } from "./draft";
import { gradeFor, intakeFileKind, planBlockers, planPart, type IntakePlan, type PlanPart } from "./plan";

import type { IntakeEvent, IntakeResult, StepState } from "./run";

export interface BuildDeps {
  read(file: File, note: string): Promise<DrawingReading>;
  /** The process groups of the catalog, and the places parts can be made, as the page has them. */
  groups: readonly string[];
  locations: readonly string[];
  /** The material grades of a process group. */
  grades(processGroup: string): Promise<string[]>;
  /** Where the parts are made, when the person already chose ("" when not). */
  madeIn: string;
  create(plan: IntakePlan, files: ReadonlyMap<string, File>, onEvent: (event: IntakeEvent) => void): Promise<IntakeResult>;
}

const messageOf = (error: unknown): string => (error instanceof Error && error.message ? error.message : "The server did not answer.");

let lastId = 0;
/** An id no other entry has, rising with time. */
const newId = (): number => (lastId = Math.max(lastId + 1, Date.now()));
const push = (entry: Entry): void => { intakeDraft.setThread(thread => [...thread, entry]); };
const say = (text: string): void => { push({ kind: "say", id: newId(), text }); };
/** One line of progress, written again in place as its state changes. */
function step(key: string, title: string, state: StepState, detail: string): void {
  intakeDraft.setThread(thread => (thread.some(e => e.kind === "step" && e.key === key)
    ? thread.map(e => (e.kind === "step" && e.key === key ? { ...e, title, state, detail } : e))
    : [...thread, { kind: "step", id: newId(), key, title, state, detail }]));
}
const dropStep = (key: string): void => { intakeDraft.setThread(thread => thread.filter(e => !(e.kind === "step" && e.key === key))); };

/** Build: the person's message goes into the conversation, each drawing is read, and the build goes as far as it can by itself. */
export async function startBuild(note: string, files: File[], deps: BuildDeps): Promise<void> {
  const run = newId();
  push({ kind: "user", id: run, text: note.trim(), files });
  intakeDraft.clearInputs();
  intakeDraft.setWorking(true);
  const parts: PlanPart[] = [];
  const reads: Record<string, DrawingReading["process"]> = {};
  for (const file of files.filter(f => intakeFileKind(f.name) === "drawing")) {   // one at a time: a person may run only a few AI requests at once
    const key = `read:${run}:${file.name}`;
    step(key, `Reading ${file.name}`, "running", "About a quarter of a minute");
    try {
      const reading = await deps.read(file, note);
      step(key, `Reviewed ${file.name}`, "done", "");
      say(narrative(reading, file.name));
      const part = planPart(file.name, reading, deps.groups);
      if (part) { parts.push(part); reads[file.name] = reading.process; }
    } catch (error) {
      step(key, `Could not read ${file.name}`, "failed", messageOf(error));
    }
  }
  const cadFiles = files.filter(f => intakeFileKind(f.name) === "cad").map(f => f.name);
  if (parts.length === 0 && cadFiles.length === 0) {
    say("Nothing here can be made into a part, so nothing was created.");
    intakeDraft.setWorking(false);
    return;
  }
  const firstLine = note.trim().split("\n")[0] ?? "";
  intakeDraft.setBuild({
    plan: {
      projectName: firstLine.length > 0 && firstLine.length <= 60 ? firstLine : parts[0]?.name ?? files[0]?.name.replace(/\.[^.]+$/, "") ?? "",
      bomName: parts.length > 0 ? "Parts from drawings" : "Imported parts",
      location: deps.madeIn, annualVolume: null, batchSize: null, parts, cadFiles,
    },
    files, reads, closed: [],
  });
  await advance(deps);
}

/** Asks the next thing only the person can say and stops for their answer; when nothing is left to ask, creates the project. */
async function advance(deps: BuildDeps): Promise<void> {
  for (;;) {
    const build = intakeDraft.get().build;
    if (!build) return;
    const need = nextNeed(build.plan, build.closed);
    if (!need) break;
    const part = build.plan.parts.find(p => p.file === need.part);
    let grades: string[] = [];
    if (need.kind === "grade" && part?.processGroup) {
      grades = await deps.grades(part.processGroup).catch((): string[] => []);
      const named = gradeFor(part.materialRead, grades);
      if (named) {                                    // the drawing names the grade itself: taken as read, and said
        intakeDraft.setBuild({ ...build, plan: { ...build.plan, parts: build.plan.parts.map(p => (p.file === part.file ? { ...p, grade: named } : p)) } });
        say(`Material for ${part.name}: ${named}, as the drawing says (${part.materialRead ?? ""}).`);
        continue;
      }
    }
    const question = questionFor(need, build.plan, { groups: deps.groups, grades, locations: deps.locations }, need.part ? build.reads[need.part] : null);
    push({ kind: "question", id: newId(), question, answer: null });
    intakeDraft.setWorking(false);                    // the person's turn
    return;
  }
  await create(deps);
}

async function create(deps: BuildDeps): Promise<void> {
  const build = intakeDraft.get().build;
  if (!build) return;
  intakeDraft.setWorking(true);
  const blocker = planBlockers(build.plan)[0];
  if (blocker) {
    say(`Nothing was created. ${blocker}`);
  } else {
    const run = newId();
    try {
      const result = await deps.create(build.plan, new Map(build.files.map(file => [file.name, file])),
        event => { step(`make:${run}:${event.key}`, event.title, event.state, event.detail); });
      push({ kind: "result", id: newId(), result });
    } catch (error) {
      say(`Stopped: ${messageOf(error)}`);
    }
  }
  intakeDraft.setBuild(null);
  intakeDraft.setWorking(false);
}

/**
 * The person's answer to an open question: submitted (an option, or their own words) or skipped. Returns why a submitted answer
 * cannot be used, and the question stays open; null when it was taken and the build went on.
 */
export async function answerQuestion(entryId: number, answer: Answer, deps: BuildDeps): Promise<string | null> {
  const { build, thread } = intakeDraft.get();
  const entry = thread.find(e => e.kind === "question" && e.id === entryId && e.answer === null);
  if (!build || entry?.kind !== "question") return null;
  let given = answer;
  const { need } = entry.question;
  if (answer.action === "skip") {
    intakeDraft.setBuild({ ...build, closed: [...build.closed, needKey(need)] });
  } else {
    const applied = applyAnswer(build.plan, entry.question, answer.value);
    if ("error" in applied) return applied.error;
    // "Solid" leaves the plan as it is, so the question is closed by name or it would be asked again.
    intakeDraft.setBuild({ ...build, plan: applied.plan, closed: need.kind === "wall" ? [...build.closed, needKey(need)] : build.closed });
    given = { action: "accept", value: applied.said };
  }
  intakeDraft.setThread(current => current.map(e => (e.kind === "question" && e.id === entryId ? { ...e, answer: given } : e)));
  intakeDraft.setWorking(true);
  await advance(deps);
  return null;
}

/** Ask: the question goes to the model with the drawing or picture added, if there is one, and its answer joins the conversation. Nothing is created. */
export async function askQuestion(question: string, drawing: File | undefined, ask: (question: string, drawing?: File) => Promise<string>): Promise<void> {
  const run = newId();
  push({ kind: "user", id: run, text: question, files: drawing ? [drawing] : [] });
  intakeDraft.setNote("");
  intakeDraft.setWorking(true);
  const key = `ask:${run}`;
  step(key, "Answering", "running", "");
  try {
    const answer = await ask(question, drawing);
    dropStep(key);
    say(answer);
  } catch (error) {
    step(key, "Could not answer", "failed", messageOf(error));
  }
  intakeDraft.setWorking(false);
}
