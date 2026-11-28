// Where the New page's draft is kept across a reload: the browser's own database (IndexedDB), which holds files as they are. One
// record for a person in a tab (the tab's id is in its session storage, so a reload finds it and another tab does not; the person's
// id is in the key, so whoever signs in next in the same tab is not given it), and a record a day old is deleted, so what a closed
// tab left behind does not stay. Nothing here leaves the browser.
import type { DraftStorage, SavedDraft } from "./draft";

const DATABASE = "emithran-intake";
const STORE = "drafts";
const TAB_KEY = "intake.draft.tab";
const KEEP_MS = 24 * 3_600_000;
/** Changes come a keystroke at a time: they are written once they pause this long. */
const WAIT_MS = 150;

function opened(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => { request.result.createObjectStore(STORE); };
    request.onsuccess = () => { resolve(request.result); };
    request.onerror = () => { reject(request.error ?? new Error("The browser's database did not open.")); };
  });
}
const finished = (transaction: IDBTransaction): Promise<void> => new Promise((resolve, reject) => {
  transaction.oncomplete = () => { resolve(); };
  transaction.onerror = transaction.onabort = () => { reject(transaction.error ?? new Error("The draft was not written.")); };
});

/** The storage of `owner` (the signed-in person's id) in this tab, or null where there is none to use (on the server, or a browser that refuses storage). */
export function browserDraftStorage(owner: string, now: () => number = Date.now): DraftStorage | null {
  let tab: string;
  try {
    if (typeof indexedDB === "undefined") return null;
    const id = sessionStorage.getItem(TAB_KEY) ?? crypto.randomUUID();
    sessionStorage.setItem(TAB_KEY, id);
    tab = `${owner}:${id}`;
  } catch {
    return null;
  }
  let waiting: Omit<SavedDraft, "savedAt"> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const write = async (): Promise<void> => {
    const draft = waiting;
    waiting = null;
    if (timer) clearTimeout(timer);
    timer = null;
    if (!draft) return;
    try {
      const database = await opened();
      const transaction = database.transaction(STORE, "readwrite");
      const nothing = draft.note === "" && draft.files.length === 0 && draft.thread.length === 0;
      if (nothing) transaction.objectStore(STORE).delete(tab);
      else transaction.objectStore(STORE).put({ ...draft, savedAt: now() } satisfies SavedDraft, tab);
      await finished(transaction);
      database.close();
    } catch { /* the draft is then kept for this visit only */ }
  };
  // What is still waiting is written as the page goes (a reload straight after a change).
  window.addEventListener("pagehide", () => { void write(); });

  return {
    load: async () => {
      try {
        const database = await opened();
        const transaction = database.transaction(STORE, "readwrite");
        const store = transaction.objectStore(STORE);
        const mine = await new Promise<SavedDraft | null>((resolve, reject) => {
          let found: SavedDraft | null = null;
          const walk = store.openCursor();
          walk.onsuccess = () => {
            const cursor = walk.result;
            if (!cursor) { resolve(found); return; }
            const saved = cursor.value as SavedDraft;
            if (now() - saved.savedAt > KEEP_MS) cursor.delete();
            else if (cursor.key === tab) found = saved;
            cursor.continue();
          };
          walk.onerror = () => { reject(walk.error ?? new Error("The draft was not read.")); };
        });
        await finished(transaction);
        database.close();
        return mine;
      } catch {
        return null;
      }
    },
    save: draft => {
      waiting = draft;
      const nothing = draft.note === "" && draft.files.length === 0 && draft.thread.length === 0;
      if (nothing) void write();                       // a cleared draft is removed at once: it must not come back after a reload
      else timer ??= setTimeout(() => { void write(); }, WAIT_MS);
    },
  };
}
