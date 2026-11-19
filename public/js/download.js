// ZIP downloads, built in the browser from the untouched originals (stored, not recompressed).

import { downloadZip } from "../vendor/client-zip.js";
import { fileUrl } from "./api.js";

const PART_BYTES = 1024 * 1024 * 1024; // browsers without streaming saves get 1 GB parts

/** "2026-07-14 15.32.10 Leon IMG_0001.HEIC", so files sort by capture time in any folder. */
function zipName(photo) {
  const t = photo.taken_at.replace("T", " ").replace(/:/g, ".");
  return `${t} ${photo.uploader} ${photo.filename}`.replace(/[\/\\:*?"<>|\x00-\x1f]/g, "_");
}

function uniqueNames(photos) {
  const seen = new Map();
  return photos.map((p) => {
    let name = zipName(p);
    const n = seen.get(name) || 0;
    seen.set(name, n + 1);
    if (n) name = name.replace(/(\.[^.]*)?$/, (ext) => ` (${n + 1})${ext || ""}`);
    return { photo: p, name };
  });
}

async function* entries(list, onFile) {
  for (const { photo, name } of list) {
    const res = await fetch(fileUrl(photo.id, "original"), { credentials: "same-origin" });
    if (!res.ok) throw new Error(`${photo.filename} konnte nicht geladen werden (${res.status}).`);
    onFile?.(photo);
    yield { name, input: res, size: photo.size, lastModified: new Date(photo.taken_at) };
  }
}

export function splitIntoParts(photos, limit = PART_BYTES) {
  const parts = [];
  let current = [], bytes = 0;
  for (const p of photos) {
    if (current.length && bytes + p.size > limit) {
      parts.push(current);
      current = [];
      bytes = 0;
    }
    current.push(p);
    bytes += p.size;
  }
  if (current.length) parts.push(current);
  return parts;
}

export const canStreamToDisk = () => typeof window.showSaveFilePicker === "function";

/**
 * Stream one ZIP straight to a file on disk (Chrome/Edge desktop). Any size, almost no memory.
 * Must be called from a click handler, because the save dialog needs a user gesture.
 */
export async function streamZipToDisk(photos, baseName, onProgress) {
  const handle = await window.showSaveFilePicker({
    suggestedName: `${baseName}.zip`,
    types: [{ description: "ZIP-Archiv", accept: { "application/zip": [".zip"] } }],
  });
  const writable = await handle.createWritable();
  const list = uniqueNames(photos);
  let done = 0;
  const total = photos.reduce((s, p) => s + p.size, 0);
  try {
    await downloadZip(entries(list, (p) => onProgress?.((done += p.size) / total)), {}).body.pipeTo(writable);
  } catch (e) {
    await writable.abort().catch(() => {});
    throw e;
  }
}

/** Build a ZIP in memory and hand it to the browser as a normal download. */
export async function zipToDownload(photos, fileName, onProgress) {
  const list = uniqueNames(photos);
  let done = 0;
  const total = photos.reduce((s, p) => s + p.size, 0);
  const blob = await downloadZip(entries(list, (p) => onProgress?.((done += p.size) / total))).blob();
  saveBlob(blob, `${fileName}.zip`);
}

export function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function saveUrl(url) {
  const a = document.createElement("a");
  a.href = url;
  a.download = "";
  document.body.appendChild(a);
  a.click();
  a.remove();
}
