// Thin wrapper around the Worker API.

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function request(method, path, body) {
  const init = { method, headers: { "x-requested-with": "photo-sharing" }, credentials: "same-origin" };
  if (body !== undefined) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(`/api/${path}`, init);
  } catch {
    throw new ApiError(0, "Keine Verbindung. Prüf dein Internet und versuch es nochmal.");
  }
  const data = await res.json().catch(() => ({}));
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
  deleteAlbum: (id, by) => request("DELETE", `albums/${id}`, { by }),
  restoreAlbum: (id) => request("POST", `albums/${id}/restore`, {}),

  initPhoto: (albumId, meta) => request("POST", `albums/${albumId}/photos`, meta),
  completePhoto: (id, dims) => request("POST", `photos/${id}/complete`, dims || {}),
  deletePhotos: (ids, by) => request("POST", "photos/delete", { ids, by }),
  restorePhotos: (ids) => request("POST", "photos/restore", { ids }),

  trash: () => request("GET", "trash"),
};

export const fileUrl = (id, kind, download = false) => `/api/photos/${id}/${kind}${download ? "?dl=1" : ""}`;

/** PUT a file with upload progress. XHR because fetch cannot report upload progress. */
export function putFile(id, kind, blob, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", `/api/photos/${id}/${kind}`);
    xhr.setRequestHeader("x-requested-with", "photo-sharing");
    if (kind !== "original") xhr.setRequestHeader("content-type", blob.type || "image/jpeg");
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded, e.total);
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
