// The New page prompt's draft: what was typed, the files added and the questions asked so far. It lives outside the page, so it is
// still there when the person goes elsewhere in the app and comes back. The text is also kept by the browser for the tab (session
// storage), so it survives a reload; files and answers are held in memory only, and a reload drops them.

/** One question asked in Ask mode, with the drawing it was about, and what became of it. */
export type AskedQuestion = { id: number; question: string; file: string | null }
  & ({ state: "asking" } | { state: "answered"; answer: string } | { state: "failed"; why: string });

export interface IntakeDraft { note: string; files: File[]; asked: AskedQuestion[] }

const NOTE_KEY = "intake.draft.note";
const EMPTY: IntakeDraft = { note: "", files: [], asked: [] };

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
  setAsked: (asked: Change<AskedQuestion[]>): void => { update(d => ({ ...d, asked: applied(asked, d.asked) })); },
  /** What was typed and added has been used (a project was made from it): the questions and answers stay. */
  clearInputs: (): void => { update(d => ({ ...d, note: "", files: [] })); },
  clear: (): void => { update(() => EMPTY); },
};
