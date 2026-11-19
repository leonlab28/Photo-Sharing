// Photo sharing Worker: auth, albums, photos, trash. Files live in R2, metadata in D1.

const SESSION_COOKIE = "ps_session";
const SESSION_MAX_AGE = 60 * 60 * 24 * 400; // 400 days, the browser maximum
const MAX_ORIGINAL_BYTES = 100 * 1024 * 1024; // Workers request body limit (Free/Pro)
const MAX_RENDITION_BYTES = 15 * 1024 * 1024;
const PENDING_TTL_MS = 24 * 60 * 60 * 1000;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS albums (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     created_by TEXT NOT NULL,
     deleted_at INTEGER,
     deleted_by TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS photos (
     id TEXT PRIMARY KEY,
     album_id TEXT NOT NULL,
     uploader TEXT NOT NULL,
     filename TEXT NOT NULL,
     mime TEXT NOT NULL,
     size INTEGER NOT NULL,
     sha256 TEXT NOT NULL,
     taken_at TEXT NOT NULL,
     taken_src TEXT NOT NULL,
     width INTEGER,
     height INTEGER,
     has_preview INTEGER NOT NULL DEFAULT 0,
     status TEXT NOT NULL DEFAULT 'pending',
     created_at INTEGER NOT NULL,
     deleted_at INTEGER,
     deleted_by TEXT
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS photos_album_hash ON photos(album_id, sha256)`,
  `CREATE INDEX IF NOT EXISTS photos_album_taken ON photos(album_id, status, deleted_at, taken_at)`,
  `CREATE INDEX IF NOT EXISTS photos_deleted ON photos(deleted_at)`,
];

let schemaReady = null;
function ensureSchema(env) {
  if (!schemaReady) {
    schemaReady = env.DB.batch(SCHEMA.map((s) => env.DB.prepare(s))).catch((e) => {
      schemaReady = null;
      throw e;
    });
  }
  return schemaReady;
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    try {
      await ensureSchema(env);
      return await route(request, env, url);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error(e);
      return json({ error: "Auf dem Server ist etwas schiefgelaufen." }, 500);
    }
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(ensureSchema(env).then(() => purge(env)));
  },
};

// ---------- routing ----------

async function route(request, env, url) {
  const method = request.method;
  const parts = url.pathname.replace(/^\/api\//, "").split("/").filter(Boolean);
  const [a, b, c] = parts;

  if (!env.APP_PASSWORD) {
    throw new HttpError(503, "Die Seite ist noch nicht eingerichtet: In Cloudflare fehlt das Secret APP_PASSWORD.");
  }

  // Mutating requests must carry a custom header, which forces a CORS preflight for
  // any other origin and so blocks cross-site request forgery.
  if (method !== "GET" && method !== "HEAD" && request.headers.get("x-requested-with") !== "photo-sharing") {
    throw new HttpError(403, "Anfrage ohne Kennung abgelehnt.");
  }

  if (a === "login" && method === "POST") return login(request, env);
  if (a === "logout" && method === "POST") return logout();

  const authed = await isAuthed(request, env);
  if (a === "session" && method === "GET") return json({ authenticated: authed, names: names(env) });
  if (!authed) throw new HttpError(401, "Bitte gib das Gruppenpasswort ein.");

  if (a === "albums") {
    if (!b && method === "GET") return listAlbums(env);
    if (!b && method === "POST") return createAlbum(request, env);
    if (b && !c && method === "GET") return getAlbum(env, b);
    if (b && !c && method === "PATCH") return renameAlbum(request, env, b);
    if (b && !c && method === "DELETE") return deleteAlbum(request, env, b);
    if (b && c === "restore" && method === "POST") return restoreAlbum(env, b);
    if (b && c === "photos" && method === "POST") return initPhoto(request, env, b);
  }

  if (a === "photos") {
    if (b === "delete" && method === "POST") return deletePhotos(request, env);
    if (b === "restore" && method === "POST") return restorePhotos(request, env);
    if (b && c === "complete" && method === "POST") return completePhoto(request, env, b);
    if (b && ["original", "preview", "thumb"].includes(c)) {
      if (method === "PUT") return putFile(request, env, b, c);
      if (method === "GET" || method === "HEAD") return getFile(request, env, b, c, url);
    }
  }

  if (a === "trash" && method === "GET") return listTrash(env);

  throw new HttpError(404, "Nicht gefunden.");
}

// ---------- auth ----------

function names(env) {
  return String(env.NAMES || "").split(",").map((s) => s.trim()).filter(Boolean);
}

function requireName(env, name) {
  if (!names(env).includes(name)) throw new HttpError(400, "Unbekannter Name. Wähl deinen Namen bitte neu.");
  return name;
}

const enc = new TextEncoder();

async function hmac(key, message) {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, enc.encode(message));
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function safeEqual(x, y) {
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

// The session token is signed with the password itself, so changing the password
// logs everyone out. That is the intended way to revoke access.
async function makeToken(env) {
  const issued = Date.now().toString(36);
  return `${issued}.${await hmac(env.APP_PASSWORD, "session.v1." + issued)}`;
}

async function isAuthed(request, env) {
  const cookie = request.headers.get("cookie") || "";
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`));
  if (!match) return false;
  const [issued, sig] = match[1].split(".");
  if (!issued || !sig) return false;
  const age = Date.now() - parseInt(issued, 36);
  if (!(age >= 0 && age < SESSION_MAX_AGE * 1000)) return false;
  return safeEqual(sig, await hmac(env.APP_PASSWORD, "session.v1." + issued));
}

function cookieHeader(value, maxAge) {
  return `${SESSION_COOKIE}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

async function login(request, env) {
  const { password } = await readJson(request);
  const given = await hmac("compare", String(password || ""));
  const expected = await hmac("compare", env.APP_PASSWORD);
  if (!safeEqual(given, expected)) {
    await new Promise((r) => setTimeout(r, 600)); // slow down guessing
    throw new HttpError(401, "Falsches Passwort.");
  }
  return json({ ok: true, names: names(env) }, 200, { "set-cookie": cookieHeader(await makeToken(env), SESSION_MAX_AGE) });
}

function logout() {
  return json({ ok: true }, 200, { "set-cookie": cookieHeader("", 0) });
}

// ---------- helpers ----------

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    throw new HttpError(400, "Ungültige Anfrage.");
  }
}

function newId() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, (x) => x.toString(16).padStart(2, "0")).join("");
}

const keyFor = (albumId, photoId, kind) => `albums/${albumId}/${photoId}/${kind}`;
const allKeys = (albumId, photoId) => ["original", "preview", "thumb"].map((k) => keyFor(albumId, photoId, k));

function trashDays(env) {
  const days = Number(env.TRASH_DAYS);
  return Number.isFinite(days) && days >= 0 ? days : 30;
}

function trashCutoff(env) {
  const days = trashDays(env);
  return Date.now() - days * 24 * 60 * 60 * 1000;
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

const EXT_MIME = {
  jpg: "image/jpeg", jpeg: "image/jpeg", jpe: "image/jpeg", png: "image/png", gif: "image/gif",
  webp: "image/webp", avif: "image/avif", heic: "image/heic", heif: "image/heif", hif: "image/heif",
  tif: "image/tiff", tiff: "image/tiff", bmp: "image/bmp", jxl: "image/jxl", svg: "image/svg+xml",
  dng: "image/x-adobe-dng", cr2: "image/x-canon-cr2", cr3: "image/x-canon-cr3", nef: "image/x-nikon-nef",
  nrw: "image/x-nikon-nrw", arw: "image/x-sony-arw", srf: "image/x-sony-srf", sr2: "image/x-sony-sr2",
  orf: "image/x-olympus-orf", rw2: "image/x-panasonic-rw2", raf: "image/x-fuji-raf", pef: "image/x-pentax-pef",
  srw: "image/x-samsung-srw", raw: "image/x-panasonic-raw", "3fr": "image/x-hasselblad-3fr", iiq: "image/x-phaseone-iiq",
};

function mimeFor(filename, given) {
  const ext = (filename.split(".").pop() || "").toLowerCase();
  if (EXT_MIME[ext]) return EXT_MIME[ext];
  if (given && /^[\w.+-]+\/[\w.+-]+$/.test(given)) return given;
  return "application/octet-stream";
}

function contentDisposition(type, filename) {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

// ---------- albums ----------

async function listAlbums(env) {
  const { results } = await env.DB.prepare(
    `SELECT a.id, a.name, a.created_at, a.created_by,
            COUNT(p.id) AS count,
            MIN(p.taken_at) AS first_taken,
            MAX(p.taken_at) AS last_taken,
            (SELECT c.id FROM photos c
              WHERE c.album_id = a.id AND c.status = 'ready' AND c.deleted_at IS NULL AND c.has_preview = 1
              ORDER BY c.taken_at LIMIT 1) AS cover_id,
            COALESCE(SUM(p.size), 0) AS bytes
       FROM albums a
       LEFT JOIN photos p ON p.album_id = a.id AND p.status = 'ready' AND p.deleted_at IS NULL
      WHERE a.deleted_at IS NULL
      GROUP BY a.id
      ORDER BY COALESCE(MAX(p.taken_at), '') DESC, a.created_at DESC`
  ).all();
  return json({ albums: results });
}

async function createAlbum(request, env) {
  const body = await readJson(request);
  const name = String(body.name || "").trim().slice(0, 120);
  if (!name) throw new HttpError(400, "Gib dem Album einen Namen.");
  const by = requireName(env, body.by);
  const id = newId();
  await env.DB.prepare(`INSERT INTO albums (id, name, created_at, created_by) VALUES (?, ?, ?, ?)`)
    .bind(id, name, Date.now(), by).run();
  return json({ id, name });
}

async function loadAlbum(env, id, { allowDeleted = false } = {}) {
  const album = await env.DB.prepare(`SELECT * FROM albums WHERE id = ?`).bind(id).first();
  if (!album || (album.deleted_at && !allowDeleted)) throw new HttpError(404, "Dieses Album gibt es nicht (mehr).");
  return album;
}

async function getAlbum(env, id) {
  const album = await loadAlbum(env, id);
  const { results } = await env.DB.prepare(
    `SELECT id, uploader, filename, mime, size, taken_at, taken_src, width, height, has_preview
       FROM photos
      WHERE album_id = ? AND status = 'ready' AND deleted_at IS NULL
      ORDER BY taken_at, filename`
  ).bind(id).all();
  return json({ album: { id: album.id, name: album.name, created_at: album.created_at, created_by: album.created_by }, photos: results });
}

async function renameAlbum(request, env, id) {
  await loadAlbum(env, id);
  const body = await readJson(request);
  const name = String(body.name || "").trim().slice(0, 120);
  if (!name) throw new HttpError(400, "Gib dem Album einen Namen.");
  await env.DB.prepare(`UPDATE albums SET name = ? WHERE id = ?`).bind(name, id).run();
  return json({ ok: true, name });
}

async function deleteAlbum(request, env, id) {
  await loadAlbum(env, id);
  const body = await readJson(request);
  const by = requireName(env, body.by);
  await env.DB.prepare(`UPDATE albums SET deleted_at = ?, deleted_by = ? WHERE id = ?`).bind(Date.now(), by, id).run();
  return json({ ok: true });
}

async function restoreAlbum(env, id) {
  await loadAlbum(env, id, { allowDeleted: true });
  await env.DB.prepare(`UPDATE albums SET deleted_at = NULL, deleted_by = NULL WHERE id = ?`).bind(id).run();
  return json({ ok: true });
}

// ---------- photos ----------

const TAKEN_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;

async function initPhoto(request, env, albumId) {
  await loadAlbum(env, albumId);
  const body = await readJson(request);
  const uploader = requireName(env, body.uploader);
  const sha256 = String(body.sha256 || "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new HttpError(400, "Fingerabdruck der Datei fehlt.");
  const size = Number(body.size);
  if (!Number.isSafeInteger(size) || size <= 0) throw new HttpError(400, "Ungültige Dateigröße.");
  if (size > MAX_ORIGINAL_BYTES) throw new HttpError(413, "Diese Datei ist größer als 100 MB.");
  const filename = String(body.filename || "photo").replace(/[\/\\\x00-\x1f]/g, "_").slice(0, 200) || "photo";
  const takenAt = TAKEN_RE.test(body.takenAt) ? body.takenAt : new Date().toISOString().slice(0, 19);
  const takenSrc = ["exif", "file"].includes(body.takenSrc) ? body.takenSrc : "upload";
  const width = Number.isSafeInteger(body.width) ? body.width : null;
  const height = Number.isSafeInteger(body.height) ? body.height : null;

  const existing = await env.DB.prepare(`SELECT id, status, deleted_at, uploader FROM photos WHERE album_id = ? AND sha256 = ?`)
    .bind(albumId, sha256).first();
  if (existing) {
    if (existing.status === "pending") {
      // An earlier upload of this exact file broke off. Let this one finish it.
      await env.DB.prepare(
        `UPDATE photos SET uploader = ?, filename = ?, mime = ?, size = ?, taken_at = ?, taken_src = ?, width = ?, height = ?, created_at = ? WHERE id = ?`
      ).bind(uploader, filename, mimeFor(filename, body.mime), size, takenAt, takenSrc, width, height, Date.now(), existing.id).run();
      return json({ id: existing.id, state: "new" });
    }
    if (existing.deleted_at) {
      await env.DB.prepare(`UPDATE photos SET deleted_at = NULL, deleted_by = NULL WHERE id = ?`).bind(existing.id).run();
      return json({ id: existing.id, state: "restored" });
    }
    return json({ id: existing.id, state: "duplicate", uploader: existing.uploader });
  }

  const id = newId();
  await env.DB.prepare(
    `INSERT INTO photos (id, album_id, uploader, filename, mime, size, sha256, taken_at, taken_src, width, height, has_preview, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'pending', ?)`
  ).bind(id, albumId, uploader, filename, mimeFor(filename, body.mime), size, sha256, takenAt, takenSrc, width, height, Date.now()).run();
  return json({ id, state: "new" });
}

async function loadPhoto(env, id) {
  const photo = await env.DB.prepare(`SELECT * FROM photos WHERE id = ?`).bind(id).first();
  if (!photo) throw new HttpError(404, "Dieses Foto gibt es nicht (mehr).");
  return photo;
}

async function putFile(request, env, id, kind) {
  const photo = await loadPhoto(env, id);
  const length = Number(request.headers.get("content-length"));
  if (!request.body || !Number.isSafeInteger(length) || length <= 0) throw new HttpError(411, "Dateigröße fehlt.");

  if (kind === "original") {
    if (photo.status !== "pending") throw new HttpError(409, "Dieses Foto ist schon hochgeladen.");
    if (length !== photo.size) throw new HttpError(400, "Dateigröße stimmt nicht.");
    // R2 checks the SHA-256 on arrival and rejects the upload if a single byte differs.
    try {
      await env.BUCKET.put(keyFor(photo.album_id, id, "original"), request.body, {
        sha256: photo.sha256,
        httpMetadata: { contentType: photo.mime },
      });
    } catch (e) {
      console.warn("original upload rejected", id, e?.message);
      throw new HttpError(422, "Die Datei kam beschädigt oder unvollständig an und wird neu gesendet.");
    }
    return json({ ok: true });
  }

  if (length > MAX_RENDITION_BYTES) throw new HttpError(413, "Vorschaubild zu groß.");
  const type = request.headers.get("content-type") || "image/jpeg";
  if (!/^image\/(jpeg|webp|png)$/.test(type)) throw new HttpError(415, "Vorschaubilder müssen JPEG, WebP oder PNG sein.");
  await env.BUCKET.put(keyFor(photo.album_id, id, kind), request.body, { httpMetadata: { contentType: type } });
  if (kind === "preview" && !photo.has_preview) {
    await env.DB.prepare(`UPDATE photos SET has_preview = 1 WHERE id = ?`).bind(id).run();
  }
  return json({ ok: true });
}

async function completePhoto(request, env, id) {
  const photo = await loadPhoto(env, id);
  if (photo.status === "ready") return json({ ok: true });
  const body = await request.json().catch(() => ({}));
  const head = await env.BUCKET.head(keyFor(photo.album_id, id, "original"));
  if (!head || head.size !== photo.size) throw new HttpError(409, "Die Originaldatei ist noch nicht vollständig angekommen.");
  const dim = (v) => (Number.isSafeInteger(v) && v > 0 && v < 1e6 ? v : null);
  await env.DB.prepare(`UPDATE photos SET status = 'ready', width = COALESCE(?, width), height = COALESCE(?, height) WHERE id = ?`)
    .bind(dim(body.width), dim(body.height), id).run();
  return json({ ok: true });
}

async function getFile(request, env, id, kind, url) {
  const photo = await loadPhoto(env, id);
  const object = await env.BUCKET.get(keyFor(photo.album_id, id, kind), {
    onlyIf: request.headers,
  });
  if (!object) throw new HttpError(404, "Datei nicht gefunden.");

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  if (kind === "original") {
    headers.set("cache-control", "private, max-age=86400");
    headers.set("content-disposition", contentDisposition(url.searchParams.has("dl") ? "attachment" : "inline", photo.filename));
    headers.set("x-content-type-options", "nosniff");
  } else {
    headers.set("cache-control", "private, max-age=31536000, immutable");
  }
  if (!("body" in object) || !object.body) return new Response(null, { status: 304, headers });
  headers.set("content-length", String(object.size));
  return new Response(request.method === "HEAD" ? null : object.body, { headers });
}

async function deletePhotos(request, env) {
  const body = await readJson(request);
  const by = requireName(env, body.by);
  const ids = Array.isArray(body.ids) ? body.ids.filter((x) => typeof x === "string").slice(0, 5000) : [];
  if (!ids.length) throw new HttpError(400, "Keine Fotos ausgewählt.");
  const now = Date.now();
  const stmts = chunk(ids, 90).map((part) =>
    env.DB.prepare(`UPDATE photos SET deleted_at = ?, deleted_by = ? WHERE deleted_at IS NULL AND id IN (${part.map(() => "?").join(",")})`)
      .bind(now, by, ...part)
  );
  await env.DB.batch(stmts);
  return json({ ok: true, count: ids.length });
}

async function restorePhotos(request, env) {
  const body = await readJson(request);
  const ids = Array.isArray(body.ids) ? body.ids.filter((x) => typeof x === "string").slice(0, 5000) : [];
  if (!ids.length) throw new HttpError(400, "Keine Fotos ausgewählt.");
  const stmts = chunk(ids, 95).map((part) =>
    env.DB.prepare(`UPDATE photos SET deleted_at = NULL, deleted_by = NULL WHERE id IN (${part.map(() => "?").join(",")})`).bind(...part)
  );
  await env.DB.batch(stmts);
  return json({ ok: true });
}

// ---------- trash ----------

async function listTrash(env) {
  const albums = await env.DB.prepare(
    `SELECT a.id, a.name, a.deleted_at, a.deleted_by,
            (SELECT COUNT(*) FROM photos p WHERE p.album_id = a.id AND p.status = 'ready' AND p.deleted_at IS NULL) AS count,
            (SELECT c.id FROM photos c WHERE c.album_id = a.id AND c.status = 'ready' AND c.has_preview = 1 ORDER BY c.taken_at LIMIT 1) AS cover_id
       FROM albums a WHERE a.deleted_at IS NOT NULL ORDER BY a.deleted_at DESC`
  ).all();
  const photos = await env.DB.prepare(
    `SELECT p.id, p.album_id, a.name AS album_name, p.uploader, p.filename, p.taken_at, p.has_preview, p.deleted_at, p.deleted_by
       FROM photos p JOIN albums a ON a.id = p.album_id
      WHERE p.deleted_at IS NOT NULL AND p.status = 'ready' AND a.deleted_at IS NULL
      ORDER BY p.deleted_at DESC LIMIT 2000`
  ).all();
  return json({ albums: albums.results, photos: photos.results, days: trashDays(env) });
}

// ---------- daily cleanup ----------

async function purge(env) {
  const cutoff = trashCutoff(env);
  const pendingCutoff = Date.now() - PENDING_TTL_MS;

  const doomed = await env.DB.prepare(
    `SELECT p.id, p.album_id FROM photos p LEFT JOIN albums a ON a.id = p.album_id
      WHERE (p.deleted_at IS NOT NULL AND p.deleted_at < ?1)
         OR (p.status = 'pending' AND p.created_at < ?2)
         OR (a.deleted_at IS NOT NULL AND a.deleted_at < ?1)
         OR a.id IS NULL
      LIMIT 3000`
  ).bind(cutoff, pendingCutoff).all();

  const rows = doomed.results;
  for (const part of chunk(rows, 300)) {
    await env.BUCKET.delete(part.flatMap((r) => allKeys(r.album_id, r.id)));
    await env.DB.batch(
      chunk(part, 95).map((p) =>
        env.DB.prepare(`DELETE FROM photos WHERE id IN (${p.map(() => "?").join(",")})`).bind(...p.map((r) => r.id))
      )
    );
  }

  // Remove trashed albums whose photos are all gone now.
  await env.DB.prepare(
    `DELETE FROM albums WHERE deleted_at IS NOT NULL AND deleted_at < ? AND NOT EXISTS (SELECT 1 FROM photos p WHERE p.album_id = albums.id)`
  ).bind(cutoff).run();

  console.log(`purge: removed ${rows.length} photos`);
}
