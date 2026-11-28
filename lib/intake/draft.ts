// The New page prompt's state that outlives the page: what is typed and added, the conversation so far, and a build that is under
// way. It lives outside the page, so it is all still there when the person goes elsewhere in the app and comes back, and a build
// that is running or waiting for an answer goes on. It is also kept by the browser for the person in the tab (`keepIn`, given
// draft-storage.ts by the page; the text in session storage as well, so it is there at the first paint), so a reload brings it
// back: the text, the files, the conversation and an open question. Work that was under way when the page was reloaded cannot go
// on, and the conversation says so (`settled`).
import type { ProcessFamily } from "@/lib/api/drawing-readings";

import type { Entry } from "./conversation";
import type { IntakePlan } from "./plan";

/** A build between its first reading and its result: the plan as far as it is known, and the questions that are closed. */
export interface BuildState {
  plan: IntakePlan;
  files: File[];
  /** What each drawing itself indicated as its process (by file name), for the question about it. */
  reads: Record<string, { family: ProcessFamily; reason: string } | null>;
  /** The questions closed without changing the plan: skipped, or answered with what it already was (conversation.ts needKey). */
  closed: string[];
}

export interface IntakeDraft {
  note: string;
  files: File[];
  thread: Entry[];
  build: BuildState | null;
  /** The engine is busy (reading, creating, answering): the prompt waits. False while a question is open for the person. */
  working: boolean;
  /** The person pressed Stop while parts were being created: it ends after the step in hand. */
  stopping: boolean;
}

/** The draft as the browser keeps it for the tab. */
export interface SavedDraft { note: string; files: File[]; thread: Entry[]; build: BuildState | null; working: boolean; savedAt: number }
export interface DraftStorage {
  /** The tab's saved draft, if it has one. */
  load(): Promise<SavedDraft | null>;
  /** Keeps the draft (the latest given wins); a draft with nothing in it removes what was kept. */
  save(draft: Omit<SavedDraft, "savedAt">): void;
}

const INTERRUPTED = "Interrupted: the page was reloaded";

/**
 * A saved draft as the page takes it back after a reload. What was said and asked comes back as it was, and an open question can be
 * answered and the build goes on. Work that was under way (a reading, an answer, parts being created) ended with the page: its
 * step says so, and the conversation says what that means. A reading or an answer is simply sent again, so what was sent goes back
 * into the box; parts being created may or may not have been made, so nothing is repeated and the person is pointed to Projects.
 * A result that comes back is marked, so the page shows it and does not open it again.
 */
export function settled(saved: Omit<SavedDraft, "savedAt">): IntakeDraft {
  const thread: Entry[] = saved.thread.map(e => (e.kind === "step" && e.state === "running" ? { ...e, state: "failed", detail: INTERRUPTED }
    : e.kind === "result" ? { ...e, restored: true } : e));
  const asked = thread.some(e => e.kind === "question" && e.answer === null);
  const settledDraft = { thread, working: false, stopping: false };
  if (!saved.working) return { ...settledDraft, note: saved.note, files: saved.files, build: asked ? saved.build : null };

  const sent = saved.thread.filter(e => e.kind === "user").at(-1);
  const since = sent ? saved.thread.slice(saved.thread.indexOf(sent)) : saved.thread;
  const creating = since.some(e => e.kind === "step" && e.key.startsWith("make:"));
  if (creating) {
    const say = "The page was reloaded while this was being created, so it stopped here. What was already made is in Projects: look there before sending it again.";
    return { ...settledDraft, thread: [...thread, { kind: "say", id: Date.now(), text: say }], note: saved.note, files: saved.files, build: null };
  }
  // Nothing was created yet: what was sent goes back into the box, unless the person has put something else there since.
  const back = saved.note === "" && saved.files.length === 0 && sent ? { note: sent.text, files: sent.files } : { note: saved.note, files: saved.files };
  const say = `The page was reloaded while this was being worked on, so it stopped. Nothing was created.${back.files.length > 0 || back.note !== "" ? " What you sent is back in the box below: send it again." : ""}`;
  return { ...settledDraft, thread: [...thread, { kind: "say", id: Date.now(), text: say }], ...back, build: null };
}

const NOTE_KEY = "intake.draft.note";
const EMPTY: IntakeDraft = { note: "", files: [], thread: [], build: null, working: false, stopping: false };

const savedNote = (): string => { try { return sessionStorage.getItem(NOTE_KEY) ?? ""; } catch { return ""; } };
const saveNote = (note: string): void => {
  try {
    if (note === "") sessionStorage.removeItem(NOTE_KEY);
    else sessionStorage.setItem(NOTE_KEY, note);
  } catch { /* the text is then kept for this visit only */ }
};

let draft: IntakeDraft | null = null;
const listeners = new Set<() => void>();
/** Where every change is kept, once what the tab had before has been read from it. */
let storage: DraftStorage | null = null;
let restoring: Promise<void> | null = null;
type Change<T> = T | ((current: T) => T);
const applied = <T>(change: Change<T>, current: T): T => (typeof change === "function" ? (change as (current: T) => T)(current) : change);

function update(change: (current: IntakeDraft) => IntakeDraft): void {
  const before = intakeDraft.get();
  draft = change(before);
  if (draft.note !== before.note) saveNote(draft.note);
  const { note, files, thread, build, working } = draft;
  storage?.save({ note, files, thread, build, working });
  for (const listener of listeners) listener();
}

export const intakeDraft = {
  /** What a page shows before the browser's own draft is known (on the server, and for the first paint). */
  empty: EMPTY,
  /** The draft as it stands: the same object until something changes it. */
  get: (): IntakeDraft => (draft ??= { ...EMPTY, note: savedNote() }),
  subscribe: (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
  /**
   * Keeps the draft in `kept` from now on, after taking back what it holds: once, and only into a draft the person has not begun
   * again in the meantime (their newer text, files or conversation win).
   */
  keepIn: (kept: DraftStorage): Promise<void> => (restoring ??= kept.load().catch(() => null).then(saved => {
    storage = kept;
    const now = intakeDraft.get();
    if (!saved || now.files.length > 0 || now.thread.length > 0) return;
    const back = settled(saved);
    update(() => ({ ...back, note: now.note !== "" ? now.note : back.note }));
  })),
  setNote: (note: string): void => { update(d => ({ ...d, note })); },
  setFiles: (files: Change<File[]>): void => { update(d => ({ ...d, files: applied(files, d.files) })); },
  setThread: (thread: Change<Entry[]>): void => { update(d => ({ ...d, thread: applied(thread, d.thread) })); },
  setBuild: (build: BuildState | null): void => { update(d => ({ ...d, build })); },
  setWorking: (working: boolean): void => { update(d => ({ ...d, working })); },
  setStopping: (stopping: boolean): void => { update(d => ({ ...d, stopping })); },
  /** What was typed and added has been sent or used: the conversation stays. */
  clearInputs: (): void => { update(d => ({ ...d, note: "", files: [] })); },
  clear: (): void => { update(() => EMPTY); },
};
