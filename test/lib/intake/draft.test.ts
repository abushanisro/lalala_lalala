import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Entry } from "@/lib/intake/conversation";
import type { SavedDraft } from "@/lib/intake/draft";

/** A fresh copy of the draft module over a stand-in for the tab's session storage. */
async function freshDraft(stored: Record<string, string> = {}) {
  const store = new Map(Object.entries(stored));
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); },
  });
  vi.resetModules();
  const { intakeDraft } = await import("@/lib/intake/draft");
  return { intakeDraft, store };
}
const file = (name: string) => new File(["x"], name, { type: "image/png" });

describe("the prompt's draft", () => {
  beforeEach(() => { vi.unstubAllGlobals(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("keeps what is typed, the files added and the conversation, for whoever reads it next", async () => {
    const { intakeDraft } = await freshDraft();
    intakeDraft.setNote("cooling line flanges");
    intakeDraft.setFiles([file("a.png")]);
    intakeDraft.setFiles((current) => [...current, file("b.png")]);
    intakeDraft.setThread([{ kind: "user", id: 1, text: "What is it?", files: [] }]);
    intakeDraft.setThread((current) => [...current, { kind: "say", id: 2, text: "A flange." }]);
    intakeDraft.setWorking(true);
    const draft = intakeDraft.get();
    expect(draft.note).toBe("cooling line flanges");
    expect(draft.files.map((f) => f.name)).toEqual(["a.png", "b.png"]);
    expect(draft.thread).toEqual([{ kind: "user", id: 1, text: "What is it?", files: [] }, { kind: "say", id: 2, text: "A flange." }]);
    expect(draft.working).toBe(true);
  });

  it("is the same object until something changes, and tells its listeners when it does", async () => {
    const { intakeDraft } = await freshDraft();
    const heard = vi.fn();
    const stop = intakeDraft.subscribe(heard);
    const before = intakeDraft.get();
    expect(intakeDraft.get()).toBe(before);
    intakeDraft.setNote("x");
    expect(intakeDraft.get()).not.toBe(before);
    expect(heard).toHaveBeenCalledTimes(1);
    stop();
    intakeDraft.setNote("y");
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it("keeps the text for the tab, so a reload brings it back; files and the conversation are not stored", async () => {
    const first = await freshDraft();
    first.intakeDraft.setNote("gearbox housing, rev B");
    first.intakeDraft.setFiles([file("a.png")]);
    expect([...first.store.entries()]).toEqual([["intake.draft.note", "gearbox housing, rev B"]]);
    const reloaded = await freshDraft(Object.fromEntries(first.store));
    expect(reloaded.intakeDraft.get()).toEqual({ note: "gearbox housing, rev B", files: [], thread: [], build: null, working: false, stopping: false });
  });

  it("drops the text and the files once they are sent, and everything on a fresh start", async () => {
    const { intakeDraft, store } = await freshDraft();
    intakeDraft.setNote("flanges");
    intakeDraft.setFiles([file("a.png")]);
    intakeDraft.setThread([{ kind: "say", id: 1, text: "answer" }]);
    intakeDraft.clearInputs();
    expect(intakeDraft.get()).toMatchObject({ note: "", files: [] });
    expect(intakeDraft.get().thread).toHaveLength(1);
    expect(store.size).toBe(0);
    intakeDraft.clear();
    expect(intakeDraft.get()).toEqual({ note: "", files: [], thread: [], build: null, working: false, stopping: false });
  });

  it("works where the browser gives no storage: the draft is then kept for the visit only", async () => {
    vi.stubGlobal("sessionStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => { throw new Error("blocked"); } });
    vi.resetModules();
    const { intakeDraft } = await import("@/lib/intake/draft");
    intakeDraft.setNote("kept in memory");
    expect(intakeDraft.get().note).toBe("kept in memory");
  });
});

describe("the draft across a reload", () => {
  beforeEach(() => { vi.unstubAllGlobals(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  const question = (answer: Extract<Entry, { kind: "question" }>["answer"]): Entry => ({
    kind: "question", id: 5, answer,
    question: { need: { kind: "grade", part: "a.png" }, text: "Which material is the bracket made of?", hint: "", options: [], pick: null, choices: ["ABS"], skip: "Skip." },
  });
  const build = { plan: { projectName: "Brackets", bomName: "Parts", location: "India", annualVolume: null, batchSize: null, parts: [], cadFiles: [] }, files: [file("a.png")], reads: {}, closed: [] };
  const sent: Entry = { kind: "user", id: 1, text: "brackets for the pump frame", files: [file("a.png")] };
  const saved = (over: Partial<SavedDraft>): SavedDraft => ({ note: "", files: [], thread: [], build: null, working: false, savedAt: 0, ...over });
  /** A stand-in for the browser's storage: what it holds, and everything it was asked to keep. */
  const storage = (held: SavedDraft | null) => {
    const kept: Omit<SavedDraft, "savedAt">[] = [];
    return { kept, load: () => Promise.resolve(held), save: (draft: Omit<SavedDraft, "savedAt">) => { kept.push(draft); } };
  };

  it("brings back the text, the files and the conversation as they were when nothing was under way", async () => {
    const { settled } = await import("@/lib/intake/draft");
    const said: Entry = { kind: "say", id: 2, text: "This is a bracket." };
    const back = settled(saved({ note: "and the cover", files: [file("b.png")], thread: [sent, said] }));
    expect(back).toEqual({ note: "and the cover", files: [expect.objectContaining({ name: "b.png" })], thread: [sent, said], build: null, working: false, stopping: false });
  });

  it("keeps an open question and its build, so it can still be answered", async () => {
    const { settled } = await import("@/lib/intake/draft");
    const back = settled(saved({ thread: [sent, question(null)], build }));
    expect(back.build).toBe(build);
    expect(back.thread).toHaveLength(2);
    expect(settled(saved({ thread: [sent, question({ action: "skip" })], build })).build).toBeNull();   // nothing is open: there is no build to go on with
  });

  it("marks a result that comes back, so the page shows it and does not open it again", async () => {
    const { settled } = await import("@/lib/intake/draft");
    const result: Entry = { kind: "result", id: 9, result: { projectId: "P", bomId: "B", parts: [], cadImported: 0 } };
    expect(settled(saved({ thread: [sent, result] })).thread[1]).toEqual({ ...result, restored: true });
  });

  it("says a reading that was under way stopped, and puts what was sent back in the box", async () => {
    const { settled } = await import("@/lib/intake/draft");
    const reading: Entry = { kind: "step", id: 2, key: "read:1:a.png", title: "Reading a.png", state: "running", detail: "About a quarter of a minute" };
    const back = settled(saved({ thread: [sent, reading], working: true }));
    expect(back.thread[1]).toMatchObject({ title: "Reading a.png", state: "failed", detail: "Interrupted: the page was reloaded" });
    expect(back.thread[2]).toMatchObject({ kind: "say", text: "The page was reloaded while this was being worked on, so it stopped. Nothing was created. What you sent is back in the box below: send it again." });
    expect(back).toMatchObject({ note: "brackets for the pump frame", files: [{ name: "a.png" }], build: null, working: false });
  });

  it("leaves the box as the person has it when they typed something else meanwhile, and says so without the promise", async () => {
    const { settled } = await import("@/lib/intake/draft");
    const back = settled(saved({ note: "another job", thread: [sent, question({ action: "accept", value: "ABS" })], build, working: true }));   // the next step was being worked out
    expect(back).toMatchObject({ note: "another job", files: [], build: null });
    expect(back.thread.at(-1)).toMatchObject({ text: expect.stringMatching(/Nothing was created\. What you sent is back in the box below/) as string });
  });

  it("does not repeat a creation that was under way: it points to Projects and sends nothing back to the box", async () => {
    const { settled } = await import("@/lib/intake/draft");
    const project: Entry = { kind: "step", id: 6, key: "make:6:project", title: 'Project "Brackets"', state: "done", detail: "Created" };
    const part: Entry = { kind: "step", id: 7, key: "make:6:part:a.png", title: "Bracket", state: "running", detail: "Analysing the model for Machining" };
    const back = settled(saved({ thread: [sent, project, part], build, working: true }));
    expect(back.thread[2]).toMatchObject({ state: "failed", detail: "Interrupted: the page was reloaded" });
    expect(back.thread.at(-1)).toMatchObject({ kind: "say", text: expect.stringMatching(/while this was being created.*look there before sending it again/) as string });
    expect(back).toMatchObject({ note: "", files: [], build: null, working: false });
  });

  it("takes back what the browser kept, once, and keeps every change from then on", async () => {
    const { intakeDraft } = await freshDraft();
    const kept = storage(saved({ note: "from before", files: [file("a.png")], thread: [sent] }));
    let told = 0;
    intakeDraft.subscribe(() => { told++; });
    await intakeDraft.keepIn(kept);
    expect(intakeDraft.get()).toMatchObject({ note: "from before", files: [{ name: "a.png" }], thread: [sent] });
    expect(told).toBe(1);
    intakeDraft.setNote("from before, and more");
    expect(kept.kept.at(-1)).toMatchObject({ note: "from before, and more", thread: [sent], working: false });
    await intakeDraft.keepIn(storage(saved({ note: "another tab's" })));            // asked again: nothing is taken a second time
    expect(intakeDraft.get().note).toBe("from before, and more");
  });

  it("does not put the kept draft over what the person has begun since, and keeps their text over the kept one", async () => {
    const begun = await freshDraft();
    begun.intakeDraft.setFiles([file("new.png")]);
    await begun.intakeDraft.keepIn(storage(saved({ note: "old", thread: [sent] })));
    expect(begun.intakeDraft.get()).toMatchObject({ files: [{ name: "new.png" }], thread: [] });

    const typed = await freshDraft({ "intake.draft.note": "typed just now" });
    await typed.intakeDraft.keepIn(storage(saved({ note: "older text", thread: [sent] })));
    expect(typed.intakeDraft.get()).toMatchObject({ note: "typed just now", thread: [sent] });
  });

  it("removes what is kept when the draft is cleared", async () => {
    const { intakeDraft } = await freshDraft();
    const kept = storage(null);
    await intakeDraft.keepIn(kept);
    intakeDraft.setNote("x");
    intakeDraft.clear();
    expect(kept.kept.at(-1)).toEqual({ note: "", files: [], thread: [], build: null, working: false });
  });
});

