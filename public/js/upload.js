// Upload queue: fingerprint, capture date, previews, then the untouched original.

import { api, putFile, ApiError } from "./api.js";
import { sha256Hex, captureTime, renditions } from "./imaging.js";

export const MAX_BYTES = 100 * 1024 * 1024;
const PARALLEL = 2; // phones run out of memory with more big files in flight
const RETRIES = 3;

/**
 * Item states: waiting, working, done, duplicate, restored, failed.
 * The queue emits "change" whenever anything moves, so the UI can redraw.
 */
export class UploadQueue extends EventTarget {
  constructor() {
    super();
    this.items = [];
    this.running = 0;
    this.wakeLock = null;
  }

  add(albumId, uploader, files) {
    for (const file of files) {
      const item = { id: crypto.randomUUID(), albumId, uploader, file, state: "waiting", progress: 0, error: null };
      if (file.size > MAX_BYTES) Object.assign(item, { state: "failed", error: "Größer als 100 MB" });
      else if (file.size === 0) Object.assign(item, { state: "failed", error: "Leere Datei" });
      this.items.push(item);
    }
    this.emit();
    this.pump();
  }

  get active() {
    return this.items.some((i) => i.state === "waiting" || i.state === "working");
  }

  stats() {
    const s = { total: this.items.length, done: 0, duplicate: 0, failed: 0, restored: 0, bytesTotal: 0, bytesDone: 0 };
    for (const i of this.items) {
      if (i.state === "done") s.done++;
      if (i.state === "duplicate") s.duplicate++;
      if (i.state === "restored") s.restored++;
      if (i.state === "failed") s.failed++;
      s.bytesTotal += i.file.size;
      s.bytesDone += ["done", "duplicate", "restored", "failed"].includes(i.state) ? i.file.size : i.file.size * i.progress;
    }
    return s;
  }

  retryFailed() {
    for (const i of this.items) {
      if (i.state === "failed" && i.file.size <= MAX_BYTES && i.file.size > 0) Object.assign(i, { state: "waiting", error: null, progress: 0 });
    }
    this.emit();
    this.pump();
  }

  clearFinished() {
    this.items = this.items.filter((i) => i.state === "waiting" || i.state === "working" || i.state === "failed");
    this.emit();
  }

  emit(detail) {
    this.dispatchEvent(new CustomEvent("change", { detail }));
  }

  async pump() {
    if (this.active) await this.holdScreen();
    while (this.running < PARALLEL) {
      const next = this.items.find((i) => i.state === "waiting");
      if (!next) break;
      this.running++;
      next.state = "working";
      this.emit();
      this.process(next)
        .catch((e) => Object.assign(next, { state: "failed", error: e.message || "Fehler" }))
        .finally(() => {
          this.running--;
          this.emit({ finished: next });
          this.pump();
        });
    }
    if (!this.active) this.releaseScreen();
  }

  async process(item) {
    const { file } = item;
    const buffer = await file.arrayBuffer();
    const sha256 = await sha256Hex(buffer);
    const { takenAt, takenSrc } = await captureTime(file);

    const init = await withRetry(() =>
      api.initPhoto(item.albumId, { sha256, size: file.size, filename: file.name, mime: file.type, takenAt, takenSrc, uploader: item.uploader })
    );
    if (init.state === "duplicate") {
      item.state = "duplicate";
      item.note = init.uploader;
      return;
    }
    if (init.state === "restored") {
      item.state = "restored";
      return;
    }

    const r = await renditions(file, buffer);
    if (r.thumb) await withRetry(() => putFile(init.id, "thumb", r.thumb));
    if (r.preview) await withRetry(() => putFile(init.id, "preview", r.preview));

    await withRetry(() =>
      putFile(init.id, "original", file, (loaded, total) => {
        item.progress = loaded / total;
        this.emit();
      })
    );
    await withRetry(() => api.completePhoto(init.id, { width: r.width, height: r.height }));
    item.progress = 1;
    item.state = "done";
    item.photoId = init.id;
  }

  async holdScreen() {
    // Keep the phone awake while uploading; a locked screen stops the upload.
    if (this.wakeLock || !("wakeLock" in navigator)) return;
    try {
      this.wakeLock = await navigator.wakeLock.request("screen");
      this.wakeLock.addEventListener("release", () => (this.wakeLock = null));
    } catch { /* not allowed right now */ }
  }

  releaseScreen() {
    this.wakeLock?.release().catch(() => {});
    this.wakeLock = null;
  }
}

async function withRetry(fn) {
  let last;
  for (let attempt = 0; attempt < RETRIES; attempt++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      // Client errors other than "damaged in transit" will not fix themselves.
      if (e instanceof ApiError && e.status >= 400 && e.status < 500 && e.status !== 422 && e.status !== 409) throw e;
      await new Promise((r) => setTimeout(r, 800 * 2 ** attempt));
    }
  }
  throw last;
}

// Re-acquire the wake lock when the tab becomes visible again during an upload.
export function bindVisibility(queue) {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && queue.active) queue.holdScreen();
  });
}
