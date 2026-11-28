import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DrawingReading, IntakePick, IntakePickRequest } from "@/lib/api/drawing-readings";
import { answerQuestion, askQuestion, startBuild, stopBuild, type BuildDeps } from "@/lib/intake/build";
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
    pick: () => Promise.resolve([]),                  // the model has nothing to suggest, unless a test says otherwise
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

  it("offers the material the model suggests for a part whose drawing names none, chosen for the person to confirm", async () => {
    const asked: IntakePickRequest[] = [];
    const pick = (request: IntakePickRequest): Promise<IntakePick[]> => { asked.push(request); return Promise.resolve([{ choice: "ABS, High Impact", why: "Exterior trim takes knocks." }]); };
    const { all, created } = deps({ pick, madeIn: "USA" });
    await startBuild("a cover for a car mirror", [file("mirror.png")], all);
    await answerQuestion(openQuestion().id, { action: "accept", value: "250 x 120 x 90" }, all);
    await answerQuestion(openQuestion().id, { action: "accept", value: "2.5" }, all);

    expect(asked).toEqual([{
      purpose: "material", choices: ["ABS, General Purpose", "ABS, High Impact", "PC/ABS Blend"],
      part: { name: "Car side mirror cover", processGroup: "Plastic Molding", materialRead: "", seen: "The form is a thin moulded cover.", note: "a cover for a car mirror" },
    }]);
    expect(openQuestion().question).toMatchObject({ need: { kind: "grade" }, pick: "ABS, High Impact", options: [{ value: "ABS, High Impact", why: "Suggested. Exterior trim takes knocks." }] });
    expect(thread().some(e => e.kind === "step" && e.title.includes("Looking for the likely material"))).toBe(false);   // the line goes once the question is there
    expect(created).toHaveLength(0);                                                                                // a suggestion is not an answer
    await answerQuestion(openQuestion().id, { action: "accept", value: "ABS, High Impact" }, all);
    expect(created[0]?.parts[0]).toMatchObject({ grade: "ABS, High Impact" });
  });

  it("asks for the material with no suggestion when the model cannot be asked", async () => {
    const { all } = deps({ pick: () => Promise.reject(new Error("You have used your daily AI allowance.")) });
    await startBuild("", [file("mirror.png")], all);
    await answerQuestion(openQuestion().id, { action: "accept", value: "250 x 120 x 90" }, all);
    await answerQuestion(openQuestion().id, { action: "accept", value: "Solid" }, all);
    expect(openQuestion().question).toMatchObject({ need: { kind: "grade" }, pick: null, options: [] });
    expect(intakeDraft.get().working).toBe(false);
  });

  it("takes words that are no listed answer by spelling as the answer the model says they mean, and says what they were", async () => {
    const asked: IntakePickRequest[] = [];
    const pick = (request: IntakePickRequest): Promise<IntakePick[]> => {
      asked.push(request);
      return Promise.resolve(request.purpose === "answer" && request.said.includes("mould") ? [{ choice: "Plastic Molding", why: "Another spelling of molding." }] : []);
    };
    const { all } = deps({ pick, read: () => Promise.resolve({ ...photo, process: null }) });
    await startBuild("", [file("mirror.png")], all);
    const process = openQuestion();
    expect(process.question.need.kind).toBe("process");

    expect(await answerQuestion(process.id, { action: "accept", value: "by magic" }, all)).toBe('Nothing here is called "by magic".');   // the model names none: the question stays
    expect(openQuestion().id).toBe(process.id);
    expect(intakeDraft.get().working).toBe(false);

    expect(await answerQuestion(process.id, { action: "accept", value: " injection moulding " }, all)).toBeNull();
    expect(asked.at(-1)).toEqual({ purpose: "answer", question: "Which process makes Car side mirror cover?", said: "injection moulding", choices: all.groups });
    expect(questions()[0]?.answer).toEqual({ action: "accept", value: 'Plastic Molding (from "injection moulding")' });
    expect(intakeDraft.get().build?.plan.parts[0]?.processGroup).toBe("Plastic Molding");
    expect(openQuestion().question.need.kind).toBe("size");
  });

  it("offers the answers the words could mean when the model names several, and leaves the question open", async () => {
    const family = [{ choice: "ABS, General Purpose", why: "The common ABS." }, { choice: "ABS, High Impact", why: "" }];
    const { all, created } = deps({ pick: request => Promise.resolve(request.purpose === "answer" ? family : []), madeIn: "USA" });
    await startBuild("", [file("mirror.png")], all);
    await answerQuestion(openQuestion().id, { action: "accept", value: "250 x 120 x 90" }, all);
    await answerQuestion(openQuestion().id, { action: "accept", value: "Solid" }, all);
    const material = openQuestion();
    expect(await answerQuestion(material.id, { action: "accept", value: "acrylonitrile" }, all)).toBe('"acrylonitrile" could be one of these. Choose one, or type more of the name.');
    expect(openQuestion()).toMatchObject({ id: material.id, question: {
      pick: null, options: [{ value: "ABS, General Purpose", why: "The common ABS." }, { value: "ABS, High Impact" }],
      hint: 'These are the answers "acrylonitrile" could mean. Choose one, or type more of the name.',
    } });
    expect(intakeDraft.get().working).toBe(false);
    await answerQuestion(material.id, { action: "accept", value: "ABS, High Impact" }, all);
    expect(created[0]?.parts[0]).toMatchObject({ grade: "ABS, High Impact" });
  });

  it("does not ask the model about words a listed answer holds, a size or a wall", async () => {
    const pick = vi.fn((): Promise<IntakePick[]> => Promise.resolve([]));
    const { all } = deps({ pick });
    await startBuild("", [file("mirror.png")], all);
    expect(await answerQuestion(openQuestion().id, { action: "accept", value: "quite big" }, all)).toMatch(/does not read as a size/);
    await answerQuestion(openQuestion().id, { action: "accept", value: "250 x 120 x 90" }, all);
    expect(await answerQuestion(openQuestion().id, { action: "accept", value: "thin" }, all)).toMatch(/Type the wall thickness/);
    await answerQuestion(openQuestion().id, { action: "accept", value: "Solid" }, all);
    const before = pick.mock.calls.length;                                                           // the one suggestion for the material
    expect(before).toBe(1);
    expect(await answerQuestion(openQuestion().id, { action: "accept", value: "abs" }, all)).toMatch(/^Several match "abs"/);
    expect(pick).toHaveBeenCalledTimes(before);
  });

  it("stops at once while a picture is being read: nothing is created, and what the reader still returns is left out", async () => {
    let finish: (reading: DrawingReading) => void = () => undefined;
    const { all, created } = deps({ read: () => new Promise(resolve => { finish = resolve; }) });
    const building = startBuild("", [file("mirror.png"), file("b.png")], all);
    expect(intakeDraft.get().working).toBe(true);
    stopBuild();
    expect(kinds()).toEqual(["user", "step", "say"]);
    expect(thread()[1]).toMatchObject({ title: "Reading mirror.png", state: "failed", detail: "Stopped" });
    expect(thread()[2]).toMatchObject({ text: "Stopped. Nothing was created." });
    expect(intakeDraft.get()).toMatchObject({ working: false, stopping: false, build: null });

    finish(photo);                                    // the reading that was in flight comes back
    await building;
    expect(kinds()).toEqual(["user", "step", "say"]); // no second picture read, no question, nothing made
    expect(created).toHaveLength(0);
    stopBuild();                                      // nothing is busy: Stop does nothing
    expect(kinds()).toEqual(["user", "step", "say"]);
  });

  it("stops after the step in hand while parts are being created, keeps what was made, and says so", async () => {
    const making: { finish: (result: IntakeResult) => void; asksToStop: (() => boolean) | null } = { finish: () => undefined, asksToStop: null };
    const { all } = deps({
      read: () => Promise.resolve(drawing), madeIn: "USA",
      create: (_plan, _files, _onEvent, stopped) => { making.asksToStop = stopped; return new Promise(resolve => { making.finish = resolve; }); },
    });
    const building = startBuild("", [file("a.png")], all);
    await vi.waitFor(() => { expect(making.asksToStop).not.toBeNull(); });       // creating has begun
    expect(making.asksToStop?.()).toBe(false);
    stopBuild();
    expect(intakeDraft.get()).toMatchObject({ working: true, stopping: true });   // still busy: the step in hand is finished first
    expect(making.asksToStop?.()).toBe(true);
    expect(thread().some(e => e.kind === "say" && e.text.startsWith("Stopped"))).toBe(false);

    making.finish({ ...made, parts: [{ file: "a.png", itemId: "I1", costed: false, detail: "Stopped before it was costed." }], stopped: true });
    await building;
    expect(kinds().slice(-2)).toEqual(["result", "say"]);
    expect(thread().at(-1)).toMatchObject({ text: "Stopped. What was made so far is kept." });
    expect(intakeDraft.get()).toMatchObject({ working: false, stopping: false, build: null });
  });

  it("stops while the model is asked what typed words mean, and its late answer changes nothing", async () => {
    let finish: (picks: IntakePick[]) => void = () => undefined;
    const pick = (request: IntakePickRequest): Promise<IntakePick[]> => (request.purpose === "answer" ? new Promise(resolve => { finish = resolve; }) : Promise.resolve([]));
    const { all } = deps({ pick, read: () => Promise.resolve({ ...photo, process: null }) });
    await startBuild("", [file("mirror.png")], all);
    const answering = answerQuestion(openQuestion().id, { action: "accept", value: "injection moulding" }, all);
    expect(intakeDraft.get().working).toBe(true);
    stopBuild();
    finish([{ choice: "Plastic Molding", why: "Another spelling." }]);
    expect(await answering).toBeNull();
    expect(thread().at(-1)).toMatchObject({ kind: "say", text: "Stopped. Nothing was created." });
    expect(intakeDraft.get()).toMatchObject({ working: false, build: null });
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

  it("stops waiting for an answer: the answer that comes later is left out", async () => {
    let finish: (answer: string) => void = () => undefined;
    const asking = askQuestion("Which process fits?", undefined, () => new Promise(resolve => { finish = resolve; }));
    stopBuild();
    finish("Machining.");
    await asking;
    expect(kinds()).toEqual(["user", "step", "say"]);
    expect(thread()[1]).toMatchObject({ title: "Answering", state: "failed", detail: "Stopped" });
    expect(thread()[2]).toMatchObject({ text: "Stopped. Nothing was created." });
    expect(intakeDraft.get().working).toBe(false);
  });

  it("says why when the question cannot be answered", async () => {
    await askQuestion("And in steel?", undefined, () => Promise.reject(new Error("AI features are switched off by the operator.")));
    expect(thread().at(-1)).toMatchObject({ kind: "step", title: "Could not answer", state: "failed", detail: "AI features are switched off by the operator." });
  });
});
