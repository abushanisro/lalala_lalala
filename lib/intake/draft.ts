// The New page prompt's state that outlives the page: what is typed and added, the conversation so far, and a build that is under
// way. It lives outside the page, so it is all still there when the person goes elsewhere in the app and comes back, and a build
// that is running or waiting for an answer goes on. The text is also kept by the browser for the tab (session storage), so it
// survives a reload; files and the conversation are held in memory only, and a reload drops them.
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
type Change<T> = T | ((current: T) => T);
const applied = <T>(change: Change<T>, current: T): T => (typeof change === "function" ? (change as (current: T) => T)(current) : change);

function update(change: (current: IntakeDraft) => IntakeDraft): void {
  const before = intakeDraft.get();
  draft = change(before);
  if (draft.note !== before.note) saveNote(draft.note);
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
