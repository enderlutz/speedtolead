// Crew photos that wait on the phone until they get through (Alan and
// Chris, 2026-10-22: on a weak signal the upload spun, failed, and the photo
// was gone). A photo taken in the app is saved here first, shows on the job
// at once as "sending", and goes up in the background: tried, and on a
// failure tried again a little later, again and again, when the signal comes
// back and whenever the app is opened. Closing the app loses nothing.
//
// Kept in the phone's own storage (IndexedDB). Where that's blocked (a
// private window), the queue lives in memory for as long as the page is open.
import { api } from "@/lib/api";

export type QueuedPhoto = {
  id: string; leadId: string; section: string; takenAt: string; timeTyped?: boolean;
  // The picture as raw bytes: iPhone Safari has refused to keep a Blob in
  // IndexedDB, and the queue then fell back to memory only, so the photo was
  // gone when the app closed (Eric Davies' after photos, 2026-11-16). Older
  // rows still have `blob`.
  name: string; type: string; data?: ArrayBuffer; blob?: Blob; createdAt: number; tries: number; lastError: string;
};
export type PendingPhoto = Omit<QueuedPhoto, "blob" | "data"> & { url: string };

const bytes = (p: QueuedPhoto): Blob => p.blob || new Blob([p.data || new ArrayBuffer(0)], { type: p.type });

const DB = "sterling-photo-queue";
const STORE = "photos";
const memory = new Map<string, QueuedPhoto>();
let dbp: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbp) return dbp;
  dbp = new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => { req.result.createObjectStore(STORE, { keyPath: "id" }); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch { resolve(null); }
  });
  return dbp;
}

async function tx<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
  const db = await openDb();
  if (!db) return undefined;
  return new Promise((resolve) => {
    try {
      const t = db.transaction(STORE, mode);
      const r = run(t.objectStore(STORE));
      if (mode === "readonly") {
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => resolve(undefined);
      } else {
        // A write counts only once it is on the phone's disk, not when the
        // request is queued: the app can be closed a moment later.
        t.oncomplete = () => resolve((r.result ?? true) as T);
        t.onerror = () => resolve(undefined);
        t.onabort = () => resolve(undefined);
      }
    } catch { resolve(undefined); }
  });
}

async function all(): Promise<QueuedPhoto[]> {
  const rows = (await tx<QueuedPhoto[]>("readonly", (s) => s.getAll() as IDBRequest<QueuedPhoto[]>)) || [];
  const seen = new Set(rows.map((r) => r.id));
  return [...rows, ...[...memory.values()].filter((m) => !seen.has(m.id))].sort((a, b) => a.createdAt - b.createdAt);
}
/** Saves it on the phone. False = only in memory (lost if the app closes). */
async function put(p: QueuedPhoto): Promise<boolean> {
  const ok = await tx("readwrite", (s) => s.put(p));
  if (ok === undefined) { memory.set(p.id, p); return false; }
  memory.delete(p.id);
  return true;
}
async function drop(id: string) {
  memory.delete(id);
  await tx("readwrite", (s) => s.delete(id));
}

// ── Listeners: the job screen redraws its "sending" photos ──────────────
type Event = { kind: "changed" } | { kind: "sent"; leadId: string; section: string };
const listeners = new Set<(e: Event) => void>();
export function onQueue(fn: (e: Event) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
const emit = (e: Event) => listeners.forEach((fn) => { try { fn(e); } catch { /* a screen gone */ } });

// Thumbnails: one object URL per queued photo, freed when it's sent.
const urls = new Map<string, string>();
export async function pending(leadId?: string): Promise<PendingPhoto[]> {
  return (await all()).filter((p) => !leadId || p.leadId === leadId).map((full) => {
    const { blob: _b, data: _d, ...p } = full;
    if (!urls.has(p.id)) urls.set(p.id, URL.createObjectURL(bytes(full)));
    return { ...p, url: urls.get(p.id)! };
  });
}

/** Saves the photo on the phone and starts sending it. Returns false when
 *  the phone wouldn't keep it, so the screen can say "keep the app open". */
export async function enqueue(p: { leadId: string; section: string; takenAt: string; timeTyped?: boolean; file: Blob; name?: string }): Promise<boolean> {
  const id = (crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const durable = await put({
    id, leadId: p.leadId, section: p.section, takenAt: p.takenAt, timeTyped: !!p.timeTyped, name: p.name || `photo-${id}.jpg`,
    type: p.file.type || "image/jpeg", data: await p.file.arrayBuffer(), createdAt: Date.now(), tries: 0, lastError: "",
  });
  emit({ kind: "changed" });
  kick();
  return durable;
}

// ── The sender ───────────────────────────────────────────────────────────
const TIMEOUT_MS = 90_000;
let running = false;
let timer: ReturnType<typeof setTimeout> | null = null;

function later(ms: number) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { timer = null; kick(); }, ms);
}

export function kick() {
  if (running) return;
  running = true;
  void (async () => {
    let failed = 0;
    try {
      for (const p of await all()) {
        const ctl = new AbortController();
        const stop = setTimeout(() => ctl.abort(), TIMEOUT_MS);
        try {
          const file = new File([bytes(p)], p.name, { type: p.type });
          await api.uploadCompanyCamPhoto(p.leadId, file, { section: p.section, takenAt: p.takenAt, timeTyped: p.timeTyped, signal: ctl.signal });
          await drop(p.id);
          const u = urls.get(p.id);
          if (u) { URL.revokeObjectURL(u); urls.delete(p.id); }
          emit({ kind: "sent", leadId: p.leadId, section: p.section });
        } catch (e) {
          failed += 1;
          const msg = e instanceof Error ? e.message : String(e);
          // Never thrown away: a photo that won't go up stays on the phone,
          // with the reason on the job, until the office sorts it out.
          await put({ ...p, tries: p.tries + 1, lastError: msg.slice(0, 200) });
          emit({ kind: "changed" });
          // No signal (the request never reached us): wait, then start over.
          // The server said no to this one photo (not assigned yet, too big):
          // go on with the rest instead of holding every later photo behind it.
          if (e instanceof TypeError || (e instanceof DOMException && e.name === "AbortError")) break;
          continue;
        } finally { clearTimeout(stop); }
      }
    } finally {
      running = false;
    }
    if (failed) later(Math.min(30_000, 4_000 * 2 ** Math.min(failed, 3)));
    else if ((await all()).length) later(1_000);
  })();
}

let started = false;
/** Called once when the app opens: anything left from last time goes up. */
export function startPhotoQueue() {
  if (started || typeof window === "undefined") return;
  started = true;
  // Ask the phone not to clear our storage when it runs low (iPhone Safari
  // wipes site data it thinks is unused).
  try { void navigator.storage?.persist?.(); } catch { /* not offered */ }
  window.addEventListener("online", () => kick());
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") kick(); });
  setInterval(() => kick(), 20_000);
  kick();
}
