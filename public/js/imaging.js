// Everything that happens to a photo in the browser before upload:
// fingerprint, capture date, and small preview images. The original file is never modified.

import exifr from "../vendor/exifr.mjs";

export const PREVIEW_EDGE = 2048;
export const THUMB_EDGE = 480;

const RAW_EXT = new Set(["dng", "cr2", "cr3", "nef", "nrw", "arw", "srf", "sr2", "orf", "rw2", "raf", "pef", "srw", "raw", "3fr", "iiq", "erf", "kdc", "mrw", "x3f"]);
const HEIC_EXT = new Set(["heic", "heif", "hif"]);
const TIFF_EXT = new Set(["tif", "tiff"]);

export const extOf = (name) => (name.split(".").pop() || "").toLowerCase();

export function kindOf(file) {
  const ext = extOf(file.name);
  if (HEIC_EXT.has(ext) || /image\/hei[cf]/.test(file.type)) return "heic";
  if (TIFF_EXT.has(ext) || file.type === "image/tiff") return "tiff";
  if (RAW_EXT.has(ext)) return "raw";
  return "native";
}

/** True for formats most browsers cannot show, where a JPEG copy is a useful download option. */
export function needsJpegCopy(filename) {
  const ext = extOf(filename);
  return HEIC_EXT.has(ext) || TIFF_EXT.has(ext) || RAW_EXT.has(ext);
}

export async function sha256Hex(buffer) {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

const pad = (n) => String(n).padStart(2, "0");
const localIso = (d) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

/**
 * When was the photo taken? Camera clock time as written in the file, without time zone,
 * so photos from the same moment line up no matter where people upload from.
 */
export async function captureTime(file) {
  try {
    const tags = await exifr.parse(file, {
      tiff: true, exif: true, xmp: true, gps: false, interop: false, ifd1: false, iptc: false, icc: false,
      reviveValues: false,
      pick: ["DateTimeOriginal", "CreateDate", "DateTimeDigitized", "DateCreated", "ModifyDate"],
    });
    for (const key of ["DateTimeOriginal", "CreateDate", "DateTimeDigitized", "DateCreated", "ModifyDate"]) {
      const iso = normalizeDate(tags?.[key]);
      if (iso) return { takenAt: iso, takenSrc: "exif" };
    }
  } catch {
    // no readable metadata, fall through
  }
  const scanned = await scanForExifDate(file);
  if (scanned) return { takenAt: scanned, takenSrc: "exif" };
  if (file.lastModified) return { takenAt: localIso(new Date(file.lastModified)), takenSrc: "file" };
  return { takenAt: localIso(new Date()), takenSrc: "upload" };
}

/**
 * Fallback for files the EXIF parser cannot read (unusual HEIC writers, Canon CR3 and other
 * RAW variants): EXIF stores dates as plain text "YYYY:MM:DD HH:MM:SS", so look for that near
 * the start of the file. The earliest one is the capture time; later ones are edit times.
 */
async function scanForExifDate(file) {
  try {
    const head = new Uint8Array(await file.slice(0, 1024 * 1024).arrayBuffer());
    const text = new TextDecoder("latin1").decode(head);
    const re = /(19[89]\d|20\d\d):(0[1-9]|1[0-2]):(0[1-9]|[12]\d|3[01]) ([01]\d|2[0-3]):([0-5]\d):([0-5]\d)/g;
    let best = null;
    for (const m of text.matchAll(re)) {
      const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`;
      if (!best || iso < best) best = iso;
    }
    return best;
  } catch {
    return null;
  }
}

function normalizeDate(value) {
  if (!value) return null;
  if (value instanceof Date && !isNaN(value)) return localIso(value);
  const m = String(value).match(/^(\d{4})[:\-](\d{2})[:\-](\d{2})[ T](\d{2}):(\d{2}):?(\d{2})?/);
  if (!m || m[1] === "0000" || m[2] === "00") return null;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] || "00"}`;
}

// ---------- decoding ----------

async function decodeNative(blob) {
  try {
    return await createImageBitmap(blob);
  } catch {
    // Some formats (e.g. HEIC in Safari) decode via <img> but not createImageBitmap.
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image();
      img.decoding = "async";
      img.src = url;
      await img.decode();
      if (!img.naturalWidth) throw new Error("empty image");
      return await createImageBitmap(img);
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

let heicModule = null;
async function decodeHeic(file) {
  try {
    return await decodeNative(file); // Safari shows HEIC natively
  } catch {
    heicModule ??= import("../vendor/heic-to.js");
    const { heicTo } = await heicModule;
    return await heicTo({ blob: file, type: "bitmap" });
  }
}

let utifLoaded = null;
function loadUtif() {
  utifLoaded ??= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "/vendor/utif.js";
    s.onload = () => resolve(window.UTIF);
    s.onerror = () => reject(new Error("TIFF decoder failed to load"));
    document.head.appendChild(s);
  });
  return utifLoaded;
}

async function decodeTiff(file, buffer) {
  try {
    return await decodeNative(file); // Safari shows TIFF natively
  } catch {
    const UTIF = await loadUtif();
    const ifds = UTIF.decode(buffer);
    // pick the largest page
    let best = null;
    for (const ifd of ifds) {
      UTIF.decodeImage(buffer, ifd, ifds);
      if (!best || ifd.width * ifd.height > best.width * best.height) best = ifd;
    }
    if (!best) throw new Error("no TIFF image");
    const rgba = UTIF.toRGBA8(best);
    return await createImageBitmap(new ImageData(new Uint8ClampedArray(rgba.buffer, 0, best.width * best.height * 4), best.width, best.height));
  }
}

/**
 * Camera RAW files carry a full-size JPEG preview made by the camera. Find it by scanning
 * for JPEG start markers and keep the largest one that decodes.
 */
async function decodeRaw(file, buffer) {
  const bytes = new Uint8Array(buffer);
  const starts = [];
  for (let i = 0; i < bytes.length - 4 && starts.length < 80; i++) {
    if (bytes[i] === 0xff && bytes[i + 1] === 0xd8 && bytes[i + 2] === 0xff) {
      const marker = bytes[i + 3];
      // Skip lossless JPEG (SOF3, 0xC3), which is RAW sensor data browsers cannot decode.
      if (marker >= 0xc0 && marker !== 0xc3) starts.push(i);
    }
  }
  let best = null;
  for (const start of starts) {
    try {
      const bmp = await createImageBitmap(new Blob([file.slice(start)], { type: "image/jpeg" }));
      if (bmp.width < 160) { bmp.close(); continue; }
      if (!best || bmp.width * bmp.height > best.width * best.height) {
        best?.close();
        best = bmp;
      } else bmp.close();
    } catch {
      // not a decodable JPEG, keep looking
    }
  }
  if (!best) throw new Error("no embedded preview");
  let orientation = 1;
  try { orientation = (await exifr.orientation(file)) || 1; } catch { /* ignore */ }
  if (orientation === 1) return best;
  const oriented = orient(best, orientation);
  best.close();
  return oriented;
}

function orient(bitmap, o) {
  const swap = o >= 5;
  const w = swap ? bitmap.height : bitmap.width;
  const h = swap ? bitmap.width : bitmap.height;
  const canvas = makeCanvas(w, h);
  const ctx = canvas.getContext("2d");
  const W = bitmap.width, H = bitmap.height;
  const t = {
    2: [-1, 0, 0, 1, W, 0], 3: [-1, 0, 0, -1, W, H], 4: [1, 0, 0, -1, 0, H],
    5: [0, 1, 1, 0, 0, 0], 6: [0, 1, -1, 0, H, 0], 7: [0, -1, -1, 0, H, W], 8: [0, -1, 1, 0, 0, W],
  }[o];
  if (t) ctx.setTransform(...t);
  ctx.drawImage(bitmap, 0, 0);
  return canvas;
}

function makeCanvas(w, h) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

/** Decode any supported file into something drawable. Throws when no preview is possible. */
export async function decode(file, buffer) {
  switch (kindOf(file)) {
    case "heic": return decodeHeic(file);
    case "tiff": return decodeTiff(file, buffer ?? (await file.arrayBuffer()));
    case "raw": return decodeRaw(file, buffer ?? (await file.arrayBuffer()));
    default: return decodeNative(file);
  }
}

// ---------- rendering ----------

function scaledCanvas(source, maxEdge) {
  const sw = source.width, sh = source.height;
  const scale = Math.min(1, maxEdge / Math.max(sw, sh));
  const w = Math.max(1, Math.round(sw * scale));
  const h = Math.max(1, Math.round(sh * scale));
  const canvas = makeCanvas(w, h);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff"; // transparent PNGs get a white backdrop in JPEG previews
  ctx.fillRect(0, 0, w, h);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, 0, 0, w, h);
  return canvas;
}

const toBlob = (canvas, type, quality) =>
  new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("encode failed"))), type, quality));

/** Small JPEG previews for the gallery. Returns nulls when the format cannot be shown. */
export async function renditions(file, buffer) {
  let source;
  try {
    source = await decode(file, buffer);
  } catch (e) {
    console.info("no preview for", file.name, e?.message);
    return { preview: null, thumb: null, width: null, height: null };
  }
  try {
    const width = source.width, height = source.height;
    const previewCanvas = scaledCanvas(source, PREVIEW_EDGE);
    const preview = await toBlob(previewCanvas, "image/jpeg", 0.86);
    const thumb = await toBlob(scaledCanvas(previewCanvas, THUMB_EDGE), "image/jpeg", 0.8);
    return { preview, thumb, width, height };
  } finally {
    source.close?.();
  }
}

/** Full-resolution JPEG copy for formats many devices cannot open (HEIC, TIFF, RAW). */
export async function jpegCopy(blob, filename) {
  const file = new File([blob], filename, { type: blob.type });
  const source = await decode(file);
  try {
    try {
      return await toBlob(scaledCanvas(source, Infinity), "image/jpeg", 0.95);
    } catch {
      // iOS limits canvases to about 16.7 megapixels; scale down only when full size fails.
      const pixels = source.width * source.height;
      const edge = Math.floor(Math.max(source.width, source.height) * Math.sqrt(16_000_000 / pixels));
      return await toBlob(scaledCanvas(source, edge), "image/jpeg", 0.95);
    }
  } finally {
    source.close?.();
  }
}
