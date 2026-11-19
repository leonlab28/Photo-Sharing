// Thin wrapper around the Worker API.

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// A connection counts as stuck when nothing moves for this long while the page is visible.
// Time in the background does not count: iOS freezes Safari's connections there, and they
// usually resume. After coming back, a frozen connection gets a short grace period.
const STALL_MS = 40_000;
const RESUME_GRACE_MS = 15_000;

function watchdog(onStall) {
  let last = Date.now();
  const onVisibility = () => {
    if (!document.hidden) last = Math.max(last, Date.now() - (STALL_MS - RESUME_GRACE_MS));
  };
  document.addEventListener("visibilitychange", onVisibility);
  const timer = setInterval(() => {
    if (!document.hidden && Date.now() - last > STALL_MS) onStall();
  }, 2000);
  return {
    touch() { last = Date.now(); },
    stop() { clearInterval(timer); document.removeEventListener("visibilitychange", onVisibility); },
  };
}

const STUCK = "Verbindung hing, neuer Versuch.";

async function request(method, path, body) {
  const controller = new AbortController();
  const init = { method, headers: { "x-requested-with": "photo-sharing" }, credentials: "same-origin", signal: controller.signal };
  if (body !== undefined) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  let stalled = false;
  const dog = watchdog(() => { stalled = true; controller.abort(); });
  let res, data;
  try {
    res = await fetch(`/api/${path}`, init);
    data = await res.json().catch(() => ({}));
  } catch {
    throw new ApiError(0, stalled ? STUCK : "Keine Verbindung. Prüf dein Internet und versuch es nochmal.");
  } finally {
    dog.stop();
  }
  if (!res.ok) {
    if (res.status === 401 && path !== "login") window.dispatchEvent(new Event("ps:logged-out"));
    throw new ApiError(res.status, data.error || `Anfrage fehlgeschlagen (${res.status}).`);
  }
  return data;
}

export const api = {
  session: () => request("GET", "session"),
  login: (password) => request("POST", "login", { password }),
  logout: () => request("POST", "logout", {}),

  albums: () => request("GET", "albums"),
  album: (id) => request("GET", `albums/${id}`),
  createAlbum: (name, by) => request("POST", "albums", { name, by }),
  renameAlbum: (id, name) => request("PATCH", `albums/${id}`, { name }),
  setCover: (id, photoId) => request("PATCH", `albums/${id}`, { cover_id: photoId }),
  deleteAlbum: (id, by) => request("DELETE", `albums/${id}`, { by }),
  restoreAlbum: (id) => request("POST", `albums/${id}/restore`, {}),

  initPhoto: (albumId, meta) => request("POST", `albums/${albumId}/photos`, meta),
  completePhoto: (id, dims) => request("POST", `photos/${id}/complete`, dims || {}),
  deletePhotos: (ids, by) => request("POST", "photos/delete", { ids, by }),
  restorePhotos: (ids) => request("POST", "photos/restore", { ids }),
  vote: (id, by, value) => request("POST", `photos/${id}/vote`, { by, value }),

  trash: () => request("GET", "trash"),
};

export const fileUrl = (id, kind, download = false) => `/api/photos/${id}/${kind}${download ? "?dl=1" : ""}`;

/** PUT a file with upload progress. XHR because fetch cannot report upload progress. */
export function putFile(id, kind, blob, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let stalled = false;
    // A stuck upload is dropped and retried instead of hanging forever.
    const dog = watchdog(() => { stalled = true; xhr.abort(); });
    const done = (fn) => (...args) => { dog.stop(); fn(...args); };
    resolve = done(resolve);
    reject = done(reject);
    xhr.open("PUT", `/api/photos/${id}/${kind}`);
    xhr.setRequestHeader("x-requested-with", "photo-sharing");
    if (kind !== "original") xhr.setRequestHeader("content-type", blob.type || "image/jpeg");
    xhr.upload.onprogress = (e) => {
      dog.touch();
      if (e.lengthComputable) onProgress?.(e.loaded, e.total);
    };
    xhr.upload.onload = () => dog.touch();
    xhr.onabort = () => reject(new ApiError(0, stalled ? STUCK : "Hochladen abgebrochen."));
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve();
      let msg = `Hochladen fehlgeschlagen (${xhr.status}).`;
      try { msg = JSON.parse(xhr.responseText).error || msg; } catch { /* keep default */ }
      reject(new ApiError(xhr.status, msg));
    };
    xhr.onerror = () => reject(new ApiError(0, "Verbindung beim Hochladen abgebrochen."));
    xhr.send(blob);
  });
}
