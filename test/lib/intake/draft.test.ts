import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
    expect(reloaded.intakeDraft.get()).toEqual({ note: "gearbox housing, rev B", files: [], thread: [], build: null, working: false });
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
    expect(intakeDraft.get()).toEqual({ note: "", files: [], thread: [], build: null, working: false });
  });

  it("works where the browser gives no storage: the draft is then kept for the visit only", async () => {
    vi.stubGlobal("sessionStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => { throw new Error("blocked"); } });
    vi.resetModules();
    const { intakeDraft } = await import("@/lib/intake/draft");
    intakeDraft.setNote("kept in memory");
    expect(intakeDraft.get().note).toBe("kept in memory");
  });
});
