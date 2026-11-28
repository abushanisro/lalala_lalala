import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DrawingReading } from "@/lib/api/drawing-readings";
import { answerQuestion, askQuestion, startBuild, type BuildDeps } from "@/lib/intake/build";
import type { Entry } from "@/lib/intake/conversation";
import { intakeDraft } from "@/lib/intake/draft";
import type { IntakePlan } from "@/lib/intake/plan";
import type { IntakeResult } from "@/lib/intake/run";

const file = (name: string) => new File(["x"], name);
/** A photo of a part: what it is and how it is made, but no size and no material. */
const photo: DrawingReading = {
  isDrawing: true, partName: "Car side mirror cover", partNumber: null, revision: null, material: null, units: null, quantity: null,
  process: { family: "plastic_molding", reason: "The form is a thin moulded cover." }, shape: null, holes: [], tightestToleranceMm: null,
  surfaceFinishRaUm: null, notes: [], unsure: [],
};
/** A dimensioned drawing that names its material. */
const drawing: DrawingReading = {
  ...photo, partName: "MOUNTING BRACKET", partNumber: "BRKT-100", material: "AL 6061-T6", quantity: 2,
  process: { family: "machining", reason: "Note 3 says MACHINE FROM PLATE." }, shape: { kind: "block", lengthMm: 120, widthMm: 60, heightMm: 12 },
};
const made: IntakeResult = { projectId: "P1", bomId: "B1", parts: [{ file: "a.png", itemId: "I1", costed: true, detail: "" }], cadImported: 0 };

function deps(over: Partial<BuildDeps> = {}) {
  const created: IntakePlan[] = [];
  const all: BuildDeps = {
    read: () => Promise.resolve(photo),
    groups: ["Die Casting", "Machining", "Plastic Molding", "Sand Casting", "Sheet Metal"], locations: ["India", "USA"],
    grades: group => Promise.resolve(group === "Machining" ? ["Aluminum, ANSI 6061", "Aluminum, ANSI 7050"] : ["ABS, General Purpose", "ABS, High Impact", "PC/ABS Blend"]),
    madeIn: "",
    create: (plan, _files, onEvent) => {
      created.push(plan);
      onEvent({ key: "project", title: `Project "${plan.projectName}"`, state: "running", detail: "Creating the project" });
      onEvent({ key: "project", title: `Project "${plan.projectName}"`, state: "done", detail: "Created" });
      return Promise.resolve(made);
    },
    ...over,
  };
  return { all, created };
}
const thread = () => intakeDraft.get().thread;
const kinds = () => thread().map(e => e.kind);
type QuestionEntry = Extract<Entry, { kind: "question" }>;
const questions = () => thread().filter((e): e is QuestionEntry => e.kind === "question");
const openQuestion = () => { const q = questions().find(e => e.answer === null); if (!q) throw new Error("no question is open"); return q; };

describe("a build as a conversation", () => {
  beforeEach(() => { intakeDraft.clear(); });

  it("reads the picture, says what it saw, and asks for what a cost still needs, one thing at a time", async () => {
    const { all, created } = deps();
    intakeDraft.setNote("i want to build costing");
    intakeDraft.setFiles([file("mirror.png")]);
    await startBuild("i want to build costing", [file("mirror.png")], all);

    expect(kinds()).toEqual(["user", "step", "say", "question"]);
    expect(thread()[1]).toMatchObject({ title: "Reviewed mirror.png", state: "done" });
    expect(thread()[2]).toMatchObject({ text: expect.stringContaining("It gives no overall size.") as string });
    expect(intakeDraft.get()).toMatchObject({ note: "", files: [], working: false });
    expect(openQuestion().question).toMatchObject({ need: { kind: "size", part: "mirror.png" } });   // the process was clear from the picture
    expect(created).toHaveLength(0);

    expect(await answerQuestion(openQuestion().id, { action: "accept", value: "250 x 120 x 90" }, all)).toBeNull();
    expect(openQuestion().question).toMatchObject({ need: { kind: "wall", part: "mirror.png" }, text: "Is Car side mirror cover hollow?" });   // moulded, and known only as a block
    expect(await answerQuestion(openQuestion().id, { action: "accept", value: "2.5" }, all)).toBeNull();
    expect(openQuestion().question).toMatchObject({ need: { kind: "grade" }, choices: ["ABS, General Purpose", "ABS, High Impact", "PC/ABS Blend"] });
    expect(await answerQuestion(openQuestion().id, { action: "accept", value: "abs" }, all)).toMatch(/^Several match "abs"/);
    expect(openQuestion().question.need.kind).toBe("grade");                                         // still open after an answer that cannot be used
    await answerQuestion(openQuestion().id, { action: "accept", value: "pc abs" }, all);
    expect(openQuestion().question.need).toEqual({ kind: "location", part: null });
    await answerQuestion(openQuestion().id, { action: "accept", value: "India" }, all);

    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      projectName: "i want to build costing", location: "India",
      parts: [{ name: "Car side mirror cover", processGroup: "Plastic Molding", grade: "PC/ABS Blend", shape: { kind: "shell", lengthMm: 250, widthMm: 120, heightMm: 90, wallMm: 2.5 } }],
    });
    expect(kinds().slice(-2)).toEqual(["step", "result"]);
    expect(questions().map(e => (e.answer?.action === "accept" ? e.answer.value : null))).toEqual(["Block 250 × 120 × 90 mm", "Hollow 250 × 120 × 90 mm, 2.5 mm wall", "PC/ABS Blend", "India"]);
    expect(intakeDraft.get()).toMatchObject({ build: null, working: false });
  });

  it("asks nothing when the drawing and the page give everything: the grade the drawing names is taken as read", async () => {
    const { all, created } = deps({ read: () => Promise.resolve(drawing), madeIn: "USA" });
    await startBuild("", [file("a.png")], all);
    expect(kinds()).toEqual(["user", "step", "say", "say", "step", "result"]);
    expect(thread()[3]).toMatchObject({ text: "Material for MOUNTING BRACKET: Aluminum, ANSI 6061, as the drawing says (AL 6061-T6)." });
    expect(created[0]).toMatchObject({ projectName: "MOUNTING BRACKET", location: "USA", parts: [{ grade: "Aluminum, ANSI 6061", processGroup: "Machining" }] });
  });

  it("keeps the block when the part is said to be solid, or the hollow question is skipped, and goes on to the material", async () => {
    for (const given of [{ action: "accept", value: "Solid" }, { action: "skip" }] as const) {
      intakeDraft.clear();
      const { all } = deps();
      await startBuild("", [file("mirror.png")], all);
      await answerQuestion(openQuestion().id, { action: "accept", value: "250 x 120 x 90" }, all);
      expect(openQuestion().question.need.kind).toBe("wall");
      await answerQuestion(openQuestion().id, given, all);
      expect(openQuestion().question.need.kind).toBe("grade");
      expect(intakeDraft.get().build?.plan.parts[0]?.shape).toEqual({ kind: "block", lengthMm: 250, widthMm: 120, heightMm: 90 });
    }
  });

  it("creates a part without a cost when its question is skipped, and asks nothing more about it", async () => {
    const { all, created } = deps();
    await startBuild("", [file("mirror.png")], all);
    await answerQuestion(openQuestion().id, { action: "skip" }, all);
    expect(created).toHaveLength(1);
    expect(created[0]?.parts[0]).toMatchObject({ shape: null, grade: null });
    expect(questions()).toHaveLength(1);
  });

  it("asks which process when the picture does not settle it, offering the family it points to", async () => {
    const { all } = deps({ read: () => Promise.resolve({ ...photo, process: { family: "casting", reason: "A cast housing." } }) });
    await startBuild("", [file("housing.png")], all);
    expect(openQuestion().question).toMatchObject({ need: { kind: "process" }, pick: null, options: [{ value: "Die Casting" }, { value: "Sand Casting" }] });
    await answerQuestion(openQuestion().id, { action: "accept", value: "Die Casting" }, all);
    expect(openQuestion().question.need.kind).toBe("size");
  });

  it("says so when a file cannot be read or is not a part, and creates nothing from nothing", async () => {
    const failing = deps({ read: () => Promise.reject(new Error("You have used your daily AI allowance.")) });
    await startBuild("", [file("a.png")], failing.all);
    expect(thread()[1]).toMatchObject({ title: "Could not read a.png", state: "failed", detail: "You have used your daily AI allowance." });
    expect(thread().at(-1)).toMatchObject({ kind: "say", text: "Nothing here can be made into a part, so nothing was created." });
    expect(failing.created).toHaveLength(0);
    expect(intakeDraft.get().working).toBe(false);

    intakeDraft.clear();
    const cat = deps({ read: () => Promise.resolve({ ...photo, isDrawing: false }) });
    await startBuild("", [file("cat.png")], cat.all);
    expect(thread().some(e => e.kind === "say" && e.text.includes("is not a drawing or a picture of a manufactured part"))).toBe(true);
    expect(cat.created).toHaveLength(0);
  });

  it("imports CAD files as they are, with no question", async () => {
    const { all, created } = deps();
    await startBuild("Pump frame", [file("frame.step")], all);
    expect(created[0]).toMatchObject({ projectName: "Pump frame", bomName: "Imported parts", parts: [], cadFiles: ["frame.step"] });
  });

  it("says why when creating stops", async () => {
    const { all } = deps({ read: () => Promise.resolve(drawing), madeIn: "USA", create: () => Promise.reject(new Error("The project could not be created.")) });
    await startBuild("", [file("a.png")], all);
    expect(thread().at(-1)).toMatchObject({ kind: "say", text: "Stopped: The project could not be created." });
    expect(intakeDraft.get()).toMatchObject({ build: null, working: false });
  });
});

describe("a question in the conversation", () => {
  beforeEach(() => { intakeDraft.clear(); });

  it("shows the question with its picture, then the answer in its place", async () => {
    const ask = vi.fn(() => Promise.resolve("It is a machined bracket."));
    intakeDraft.setNote("What is this part?");
    await askQuestion("What is this part?", file("a.png"), ask);
    expect(ask).toHaveBeenCalledWith("What is this part?", expect.any(File));
    expect(thread()).toMatchObject([{ kind: "user", text: "What is this part?" }, { kind: "say", text: "It is a machined bracket." }]);
    expect(intakeDraft.get()).toMatchObject({ note: "", working: false });
  });

  it("says why when the question cannot be answered", async () => {
    await askQuestion("And in steel?", undefined, () => Promise.reject(new Error("AI features are switched off by the operator.")));
    expect(thread().at(-1)).toMatchObject({ kind: "step", title: "Could not answer", state: "failed", detail: "AI features are switched off by the operator." });
  });
});
