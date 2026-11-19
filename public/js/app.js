import { api, fileUrl } from "./api.js";
import { UploadQueue, bindVisibility } from "./upload.js";
import { needsJpegCopy, jpegCopy, extOf } from "./imaging.js";
import { canStreamToDisk, streamZipToDisk, zipToDownload, splitIntoParts, saveBlob, saveUrl } from "./download.js";

const app = document.getElementById("app");
const uploadsEl = document.getElementById("uploads");
const toastsEl = document.getElementById("toasts");

const state = {
  authed: false,
  names: [],
  album: null,
  photos: [],
  filter: null, // uploader name or null for everyone
  selecting: false,
  selected: new Set(),
  coverPick: false, // choosing an album cover by tapping a photo
  lb: null, // { list, index }
};

const queue = new UploadQueue();
bindVisibility(queue);

// ---------- small helpers ----------

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* private mode */ } },
};
const getMe = () => {
  const me = store.get("ps:me");
  return state.names.includes(me) ? me : null;
};
const setMe = (name) => store.set("ps:me", name);

function person(name) {
  const i = Math.max(0, state.names.indexOf(name)) % 4;
  return `--c:var(--p${i});--on:var(--p${i}-on)`;
}

const ICONS = {
  back: '<path d="M15 5l-7 7 7 7"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  more: '<circle cx="5" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none"/>',
  download: '<path d="M12 4v11m0 0l-4.5-4.5M12 15l4.5-4.5M5 19h14"/>',
  upload: '<path d="M12 19V8m0 0l-4.5 4.5M12 8l4.5 4.5M5 5h14"/>',
  trash: '<path d="M4 7h16M9 7V4.5h6V7M6.5 7l1 12.5h9l1-12.5"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  next: '<path d="M9 5l7 7-7 7"/>',
  prev: '<path d="M15 5l-7 7 7 7"/>',
  pen: '<path d="M4 20h4L19 9l-4-4L4 16v4z"/>',
  swap: '<path d="M7 7h11l-3-3M17 17H6l3 3"/>',
  out: '<path d="M14 5h5v14h-5M10 8l-4 4 4 4M6 12h10"/>',
  select: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8.5 12l2.5 2.5 4.5-5"/>',
  cover: '<rect x="3.5" y="5" width="17" height="14" rx="2"/><path d="M3.5 15.5l5-4.5 4 3.5 2.5-2 5.5 4.5"/><circle cx="15.5" cy="9.5" r="1.4"/>',
};
const icon = (n) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[n]}</svg>`;

const plural = (n, one, many) => `${n.toLocaleString("de-DE")} ${n === 1 ? one : many}`;
const fmtSize = (b) => (b >= 1e9 ? `${(b / 1e9).toLocaleString("de-DE", { maximumFractionDigits: 1 })} GB` : `${(b / 1e6).toLocaleString("de-DE", { maximumFractionDigits: 1 })} MB`);

function parseLocal(s) {
  const [d, t = "00:00:00"] = s.split("T");
  const [y, m, dd] = d.split("-").map(Number);
  const [h, mi, se] = t.split(":").map(Number);
  return new Date(y, m - 1, dd, h, mi, se || 0);
}
const fmtDay = new Intl.DateTimeFormat("de-DE", { weekday: "long", day: "numeric", month: "long" });
const fmtDayYear = new Intl.DateTimeFormat("de-DE", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
const fmtTime = new Intl.DateTimeFormat("de-DE", { hour: "2-digit", minute: "2-digit" });
const fmtMonth = new Intl.DateTimeFormat("de-DE", { month: "long" });

function dateRange(first, last) {
  if (!first) return "";
  const a = parseLocal(first), b = parseLocal(last);
  const sameDay = a.toDateString() === b.toDateString();
  if (sameDay) return `${a.getDate()}. ${fmtMonth.format(a)} ${a.getFullYear()}`;
  if (a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth())
    return `${a.getDate()}.–${b.getDate()}. ${fmtMonth.format(b)} ${b.getFullYear()}`;
  if (a.getFullYear() === b.getFullYear())
    return `${a.getDate()}. ${fmtMonth.format(a)} – ${b.getDate()}. ${fmtMonth.format(b)} ${b.getFullYear()}`;
  return `${a.getDate()}. ${fmtMonth.format(a)} ${a.getFullYear()} – ${b.getDate()}. ${fmtMonth.format(b)} ${b.getFullYear()}`;
}

const safeFileName = (s) => s.replace(/[\/\\:*?"<>|\x00-\x1f]/g, "_").trim() || "Fotos";

// ---------- runners: the four of us as a progress bar ----------

// One stick figure in a 20x28 box. Limbs are separate groups so CSS can swing them.
function runnerSvg(i) {
  return `<svg class="runner" viewBox="0 0 20 28" style="--c:var(--p${i});--d:${[-0.05, -0.31, -0.18, -0.42][i]}s" aria-hidden="true">
    <g class="bob">
      <g class="limb arm-b"><polyline points="11.2,10.6 8.6,13.6 6.4,12.2"/></g>
      <g class="limb leg-b"><polyline points="9.6,17 11.4,21.4 9.6,25.8"/></g>
      <line x1="11.6" y1="9" x2="9.6" y2="17"/>
      <circle cx="12.6" cy="4.8" r="3.1"/>
      <g class="limb leg-a"><polyline points="9.6,17 11.4,21.4 9.6,25.8"/></g>
      <g class="limb arm-a"><polyline points="11.2,10.6 13.6,13.6 16.2,12.4"/></g>
      <g class="cheer"><polyline points="11.2,10.6 15,8.8 18.2,7.6"/><polyline points="11.2,10.6 8.2,8.4 5.8,6"/></g>
    </g>
  </svg>`;
}

/** Progress bar of four running stick figures. `mode` "loop" runs laps when progress is unknown. */
function runners(mode = "") {
  return `<div class="runners ${mode}" role="progressbar" aria-valuemin="0" aria-valuemax="100" ${mode === "loop" ? 'aria-label="Wird geladen"' : 'aria-valuenow="0"'} style="--p:0">
    <div class="ground"><i></i></div>
    <div class="pack">${[0, 1, 2, 3].map(runnerSvg).join("")}</div>
  </div>`;
}

function setRunners(el, p) {
  if (!el) return;
  const v = Math.max(0, Math.min(1, p || 0));
  el.style.setProperty("--p", v.toFixed(4));
  el.setAttribute("aria-valuenow", String(Math.round(v * 100)));
  el.classList.toggle("finished", v >= 1);
}

const loadingBlock = (text) => `<div class="loading">${runners("loop")}<p>${esc(text)}</p></div>`;

// ---------- toasts ----------

function toast(message, { action, onAction, timeout = 5000 } = {}) {
  const el = document.createElement("div");
  el.className = "toast";
  el.innerHTML = `<span>${esc(message)}</span>${action ? `<button type="button">${esc(action)}</button>` : ""}`;
  toastsEl.appendChild(el);
  const close = () => el.remove();
  if (action) el.querySelector("button").onclick = () => { close(); onAction?.(); };
  if (timeout) setTimeout(close, timeout);
  return close;
}

function progressToast(label) {
  const el = document.createElement("div");
  el.className = "toast task";
  el.innerHTML = `<span>${esc(label)}</span>${runners()}`;
  toastsEl.appendChild(el);
  const bar = el.querySelector(".runners");
  return {
    set(p) { setRunners(bar, p); },
    done(msg) { el.remove(); toast(msg); },
    fail(msg) { el.remove(); toast(msg, { timeout: 8000 }); },
    close() { el.remove(); },
  };
}

// ---------- dialogs ----------

function dialog(html, setup) {
  return new Promise((resolve) => {
    const d = document.createElement("dialog");
    d.innerHTML = html;
    document.body.appendChild(d);
    let result = null;
    const finish = (value) => { result = value; d.close(); };
    d.addEventListener("close", () => { d.remove(); resolve(result); });
    d.addEventListener("click", (e) => { if (e.target === d) finish(null); });
    d.querySelectorAll("[data-cancel]").forEach((b) => (b.onclick = () => finish(null)));
    setup?.(d, finish);
    d.showModal();
  });
}

function askText({ title, label, value = "", confirm }) {
  return dialog(
    `<form method="dialog"><h2 class="display">${esc(title)}</h2>
      <label class="sr" for="dlg-in">${esc(label)}</label>
      <input id="dlg-in" class="field" maxlength="120" autocomplete="off" value="${esc(value)}" placeholder="${esc(label)}" required>
      <div class="row"><button type="button" class="btn quiet" data-cancel>Abbrechen</button><button class="btn primary">${esc(confirm)}</button></div></form>`,
    (d, finish) => {
      const input = d.querySelector("input");
      d.querySelector("form").onsubmit = (e) => { e.preventDefault(); const v = input.value.trim(); if (v) finish(v); };
      setTimeout(() => input.select(), 30);
    }
  );
}

function confirmBox({ title, text, confirm, danger }) {
  return dialog(
    `<h2 class="display">${esc(title)}</h2><p>${esc(text)}</p>
     <div class="row"><button type="button" class="btn quiet" data-cancel>Abbrechen</button><button type="button" class="btn ${danger ? "danger" : "primary"}" data-ok>${esc(confirm)}</button></div>`,
    (d, finish) => (d.querySelector("[data-ok]").onclick = () => finish(true))
  );
}

// ---------- menus ----------

function closeMenus() { document.querySelectorAll(".menu").forEach((m) => (m.hidden = true)); }
document.addEventListener("click", (e) => {
  const trigger = e.target.closest("[data-menu]");
  if (trigger) {
    const menu = document.getElementById(trigger.dataset.menu);
    const open = menu.hidden;
    closeMenus();
    menu.hidden = !open;
    trigger.setAttribute("aria-expanded", String(open));
    return;
  }
  if (!e.target.closest(".menu")) closeMenus();
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeMenus(); });

function meButton() {
  const me = getMe();
  return `<div class="menu-wrap">
    <button class="me" data-menu="me-menu" aria-haspopup="true" aria-expanded="false" style="${person(me)}">
      <span class="avatar">${esc(me[0])}</span>${esc(me)}
    </button>
    <div class="menu" id="me-menu" hidden>
      <button type="button" data-act="switch">${icon("swap")}Ich bin nicht ${esc(me)}</button>
      <a href="#/trash">${icon("trash")}Papierkorb</a>
      <hr>
      <button type="button" data-act="logout">${icon("out")}Abmelden</button>
    </div>
  </div>`;
}

function bindMe(root) {
  root.querySelector('[data-act="switch"]')?.addEventListener("click", () => { setMe(null); renderWho(); });
  root.querySelector('[data-act="logout"]')?.addEventListener("click", async () => {
    await api.logout().catch(() => {});
    state.authed = false;
    renderLogin();
  });
}

// ---------- routing ----------

window.addEventListener("hashchange", () => route());
window.addEventListener("ps:logged-out", () => { state.authed = false; renderLogin(); });
window.addEventListener("popstate", () => { if (state.lb) closeLightbox(true); });
window.addEventListener("resize", () => syncBarSpace());
window.addEventListener("beforeunload", (e) => { if (queue.active) { e.preventDefault(); e.returnValue = ""; } });

function route() {
  if (state.lb) closeLightbox(true);
  if (!state.authed) return renderLogin();
  if (!getMe()) return renderWho();
  const hash = location.hash.replace(/^#\/?/, "");
  const [section, id] = hash.split("/");
  setSelecting(false);
  state.coverPick = false;
  document.body.style.setProperty("--bar-space", "0px");
  app.onclick = app.ondragenter = app.ondragover = app.ondragleave = app.ondrop = null;
  if (section !== "a") state.album = null;
  if (section === "a" && id) return renderAlbum(id);
  if (section === "trash") return renderTrash();
  return renderHome();
}

async function boot() {
  try {
    const s = await api.session();
    state.names = s.names;
    state.authed = s.authenticated;
  } catch (e) {
    app.innerHTML = `<section class="login"><h1 class="display">Fotokiste</h1><p>${esc(e.message)}</p></section>`;
    return;
  }
  route();
}

// ---------- login ----------

function renderLogin() {
  document.title = "Fotokiste";
  app.innerHTML = `<section class="login">
    <img class="login-logo" src="/logo.svg" alt="" width="148" height="148">
    <h1 class="display">Fotokiste</h1>
    <p>Unsere Urlaubsfotos an einem Ort. Gib das Gruppenpasswort ein, das du bekommen hast.</p>
    <form>
      <label class="sr" for="pw">Gruppenpasswort</label>
      <input id="pw" class="field" type="password" autocomplete="current-password" placeholder="Gruppenpasswort" required>
      <button class="btn primary">Öffnen</button>
    </form>
    <p class="form-error" role="alert"></p>
  </section>`;
  const form = app.querySelector("form");
  const err = app.querySelector(".form-error");
  app.querySelector("#pw").focus();
  form.onsubmit = async (e) => {
    e.preventDefault();
    const btn = form.querySelector("button");
    btn.disabled = true;
    err.textContent = "";
    try {
      const res = await api.login(form.pw.value);
      state.names = res.names;
      state.authed = true;
      route();
    } catch (ex) {
      err.textContent = ex.message;
      btn.disabled = false;
      form.pw.select();
    }
  };
}

// ---------- who are you ----------

// The logo's hands, drawn inline so they take the page's ink color.
const HAND_PATH = "M -18 -150 A 17 17 0 0 1 16 -153 L 20 -54 Q 22 -18 54 -16 L 190 -14 A 16 16 0 0 1 190 18 L 62 22 C 80 24 82 46 63 51 C 80 55 80 76 61 80 C 76 84 74 103 55 107 C 40 114 24 118 14 122 L -2 156 A 32 32 0 0 1 -60 128 L -54 72 C -50 32 -42 2 -31 -30 Z";
const LOGO_GROUP = "translate(256 256) scale(0.84) translate(-256 -256) rotate(-9 256 256)";

function renderWho() {
  document.title = "Wer bist du? – Fotokiste";
  const tiles = state.names.map((n) =>
    `<button class="who-tile" data-name="${esc(n)}" style="${person(n)}">${esc(n)}</button>`).join("");
  app.innerHTML = `<section class="who">
    <h1 class="display who-title">Wer bist du?</h1>
    <p class="who-hint">Tippe im Bild auf deinen Namen. Deine Fotos werden damit beschriftet.</p>
    <div class="who-stage">
      <svg class="who-hands" viewBox="0 0 512 512" aria-hidden="true">
        <g transform="${LOGO_GROUP}">
          <g class="hand-a"><path d="${HAND_PATH}" transform="translate(148 348)"/></g>
          <g class="hand-b"><path d="${HAND_PATH}" transform="rotate(180 256 256) translate(148 348)"/></g>
        </g>
      </svg>
      <div class="who-frame${state.names.length === 4 ? "" : " many"}">${tiles}</div>
    </div>
  </section>`;
  const who = app.querySelector(".who");
  who.addEventListener("click", (e) => {
    const tile = e.target.closest(".who-tile");
    if (!tile) return;
    const name = tile.dataset.name;
    setMe(name);
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) return route();
    // The chosen color spreads from the tapped square over the whole screen, then the albums appear.
    who.classList.add("picked");
    const r = tile.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const far = Math.hypot(Math.max(cx, innerWidth - cx), Math.max(cy, innerHeight - cy));
    const grow = document.createElement("div");
    grow.className = "who-expand";
    grow.setAttribute("style", `${person(name)};clip-path:circle(${Math.min(r.width, r.height) / 2}px at ${cx}px ${cy}px)`);
    document.body.appendChild(grow);
    requestAnimationFrame(() => requestAnimationFrame(() => (grow.style.clipPath = `circle(${far}px at ${cx}px ${cy}px)`)));
    setTimeout(() => {
      route();
      grow.style.transition = "opacity .35s ease";
      grow.style.opacity = "0";
      setTimeout(() => grow.remove(), 380);
    }, 480);
  });
}

// ---------- home: albums ----------

async function renderHome() {
  document.title = "Fotokiste";
  app.innerHTML = `<header class="bar"><h1 class="title display brand"><img class="brand-mark" src="/icon.svg" alt="">Fotokiste</h1>${meButton()}</header>${loadingBlock("Alben werden geladen.")}`;
  bindMe(app);
  let albums;
  try {
    ({ albums } = await api.albums());
  } catch (e) {
    app.querySelector(".loading").textContent = e.message;
    return;
  }
  if (!location.hash.match(/^#?\/?$/) && location.hash !== "") return; // navigated away meanwhile

  const list = albums.map((a) => {
    const cover = a.cover_id
      ? `<img src="${fileUrl(a.cover_id, "preview")}" alt="" loading="lazy" decoding="async">`
      : "";
    const meta = a.count ? `${dateRange(a.first_taken, a.last_taken)}, ${plural(a.count, "Foto", "Fotos")}` : "Noch keine Fotos";
    return `<article class="album">
      <a class="album-cover${a.cover_id ? "" : " empty"}" href="#/a/${a.id}">${cover}<h2 class="display">${esc(a.name)}</h2></a>
      <div class="album-meta"><p>${esc(meta)}</p>
        ${a.count ? `<button class="icon-btn" data-dl="${a.id}" data-name="${esc(a.name)}" aria-label="${esc(a.name)} komplett herunterladen" title="Album herunterladen">${icon("download")}</button>` : ""}
      </div>
    </article>`;
  }).join("");

  const page = document.createElement("section");
  page.className = "page";
  page.innerHTML = albums.length
    ? `<div class="page-head"><button class="btn primary" data-act="new">Neues Album</button></div><div class="albums">${list}</div>`
    : `<div class="empty-state"><h2 class="display">Noch keine Alben</h2><p>Leg ein Album für euren Urlaub an. Danach kann jeder seine Fotos hineinladen.</p><button class="btn primary" data-act="new">Neues Album</button></div>`;
  app.querySelector(".loading").replaceWith(page);

  page.addEventListener("click", async (e) => {
    if (e.target.closest('[data-act="new"]')) {
      const name = await askText({ title: "Neues Album", label: "Name, zum Beispiel Kroatien 2026", confirm: "Album anlegen" });
      if (!name) return;
      try {
        const { id } = await api.createAlbum(name, getMe());
        location.hash = `#/a/${id}`;
      } catch (ex) { toast(ex.message); }
    }
    const dl = e.target.closest("[data-dl]");
    if (dl) {
      try {
        const { photos } = await api.album(dl.dataset.dl);
        await downloadPhotos(photos, dl.dataset.name);
      } catch (ex) { toast(ex.message); }
    }
  });
}

// ---------- album ----------

function visiblePhotos() {
  return state.filter ? state.photos.filter((p) => p.uploader === state.filter) : state.photos;
}

async function renderAlbum(id, { keepScroll = false } = {}) {
  const scrollY = window.scrollY;
  if (!keepScroll) {
    app.innerHTML = `<header class="bar"><a class="icon-btn back" href="#/" aria-label="Alle Alben">${icon("back")}</a><h1 class="title display"></h1></header>${loadingBlock("Album wird geladen.")}`;
  }
  let data;
  try {
    data = await api.album(id);
  } catch (e) {
    app.innerHTML = `<header class="bar"><a class="icon-btn back" href="#/" aria-label="Alle Alben">${icon("back")}</a></header><div class="loading">${esc(e.message)}</div>`;
    return;
  }
  if (location.hash !== `#/a/${id}`) return;
  if (state.album?.id !== id) state.filter = null;
  state.album = data.album;
  state.photos = data.photos;
  document.title = `${data.album.name} – Fotokiste`;

  app.innerHTML = `
    <header class="bar">
      <a class="icon-btn back" href="#/" aria-label="Alle Alben">${icon("back")}</a>
      <h1 class="title display">${esc(data.album.name)}</h1>
      <div class="menu-wrap">
        <button class="icon-btn" data-menu="album-menu" aria-haspopup="true" aria-expanded="false" aria-label="Albumoptionen">${icon("more")}</button>
        <div class="menu" id="album-menu" hidden>
          <button type="button" data-act="dl-album">${icon("download")}Album herunterladen</button>
          <button type="button" data-act="rename">${icon("pen")}Umbenennen</button>
          <button type="button" data-act="pick-cover">${icon("cover")}Cover wählen</button>
          <hr>
          <button type="button" class="danger" data-act="del-album">${icon("trash")}Album löschen</button>
        </div>
      </div>
    </header>
    <section class="album-head">
      <p class="meta"></p>
      <div class="actions">
        <button class="btn primary" data-act="upload">${icon("upload")}Fotos hochladen</button>
        <button class="btn" data-act="select">${icon("select")}Auswählen</button>
      </div>
      <input type="file" multiple hidden id="file-input">
    </section>
    <nav class="filters" aria-label="Nach Person filtern"></nav>
    <div id="days"></div>
    <div class="select-bar" hidden></div>`;

  renderAlbumBody();
  bindAlbum(id);
  if (keepScroll) window.scrollTo(0, scrollY);
}

function renderAlbumBody() {
  const meta = app.querySelector(".album-head .meta");
  const photos = state.photos;
  meta.textContent = photos.length
    ? `${dateRange(photos[0].taken_at, photos[photos.length - 1].taken_at)}, ${plural(photos.length, "Foto", "Fotos")}`
    : "";

  const counts = Object.fromEntries(state.names.map((n) => [n, 0]));
  for (const p of photos) counts[p.uploader] = (counts[p.uploader] || 0) + 1;
  app.querySelector(".filters").innerHTML =
    `<button class="chip all" aria-pressed="${!state.filter}" data-filter="">Alle <span class="n">${photos.length}</span></button>` +
    state.names.map((n) =>
      `<button class="chip" style="${person(n)}" aria-pressed="${state.filter === n}" data-filter="${esc(n)}" ${counts[n] ? "" : "disabled"}><span class="dot"></span>${esc(n)} <span class="n">${counts[n]}</span></button>`
    ).join("");

  const days = app.querySelector("#days");
  const list = visiblePhotos();
  if (!photos.length) {
    days.innerHTML = `<div class="page"><div class="empty-state"><h2 class="display">Noch leer</h2><p>Lade die ersten Fotos hoch. Du kannst sie auch einfach hier hineinziehen. Sie werden automatisch nach Aufnahmezeit sortiert.</p></div></div>`;
    return;
  }
  const multiYear = photos[0].taken_at.slice(0, 4) !== photos[photos.length - 1].taken_at.slice(0, 4);
  const groups = [];
  for (const p of list) {
    const day = p.taken_at.slice(0, 10);
    if (!groups.length || groups[groups.length - 1].day !== day) groups.push({ day, items: [] });
    groups[groups.length - 1].items.push(p);
  }
  let index = 0;
  days.innerHTML = groups.map((g) => {
    const date = parseLocal(g.day + "T12:00:00");
    const label = (multiYear ? fmtDayYear : fmtDay).format(date);
    const tiles = g.items.map((p) => tile(p, index++)).join("");
    return `<section class="day" data-day="${g.day}">
      <div class="day-head"><h3 class="display">${esc(label)}</h3>
        ${state.selecting ? `<button class="btn" data-select-day="${g.day}">Tag auswählen</button>` : `<span class="count">${plural(g.items.length, "Foto", "Fotos")}</span>`}
      </div>
      <div class="grid">${tiles}</div>
    </section>`;
  }).join("");
}

function tile(p, index) {
  const when = fmtTime.format(parseLocal(p.taken_at));
  const inner = p.has_preview
    ? `<img src="${fileUrl(p.id, "thumb")}" alt="" loading="lazy" decoding="async">`
    : `<span class="ext">${esc(extOf(p.filename).toUpperCase() || "?")}</span>`;
  const isCover = state.album?.cover_id === p.id;
  return `<button class="tile${isCover ? " is-cover" : ""}" data-id="${p.id}" data-i="${index}" style="${person(p.uploader)}"
      aria-label="Foto von ${esc(p.uploader)}, ${when} Uhr" ${state.selecting ? `aria-pressed="${state.selected.has(p.id)}"` : ""}>
      ${inner}${isCover ? '<span class="cover-badge">Cover</span>' : ""}<span class="check">${icon("check")}</span></button>`;
}

function setSelecting(on) {
  state.selecting = on;
  if (!on) state.selected.clear();
  document.body.classList.toggle("selecting-on", on);
  app.classList.toggle("selecting", on);
}

// Toasts and the upload panel sit above whatever bar is pinned to the bottom.
function syncBarSpace() {
  const bar = app.querySelector(".select-bar");
  const h = bar && !bar.hidden ? bar.offsetHeight : 0;
  document.body.style.setProperty("--bar-space", `${h}px`);
}

function updateSelectBar() {
  drawSelectBar();
  syncBarSpace();
}

function drawSelectBar() {
  const bar = app.querySelector(".select-bar");
  if (!bar) return;
  if (state.coverPick) {
    bar.hidden = false;
    bar.innerHTML = `<span class="count">Tippe das Foto an, das das Cover werden soll.</span>
      <button class="btn" data-act="cover-auto">Automatisch</button>
      <button class="btn" data-act="cover-cancel">Abbrechen</button>`;
    return;
  }
  bar.hidden = !state.selecting;
  if (!state.selecting) return;
  const n = state.selected.size;
  bar.innerHTML = `<span class="count">${n ? plural(n, "Foto", "Fotos") + " ausgewählt" : "Tippe Fotos an"}</span>
    <button class="btn primary" data-act="sel-dl" ${n ? "" : "disabled"}>${icon("download")}Herunterladen</button>
    <button class="btn danger" data-act="sel-del" ${n ? "" : "disabled"}>${icon("trash")}Löschen</button>
    <button class="btn" data-act="sel-done">Fertig</button>`;
}

// Long press on a photo starts selecting (registered once, only acts in an album).
let pressTimer = null, longPressed = false;
const inAlbum = () => location.hash.startsWith("#/a/") && state.album;
app.addEventListener("pointerdown", (e) => {
  const t = e.target.closest(".tile");
  if (!t || state.selecting || state.coverPick || !inAlbum()) return;
  longPressed = false;
  pressTimer = setTimeout(() => {
    longPressed = true;
    setSelecting(true);
    state.selected.add(t.dataset.id);
    renderAlbumBody();
    updateSelectBar();
    navigator.vibrate?.(15);
  }, 480);
});
const cancelPress = () => clearTimeout(pressTimer);
app.addEventListener("pointerup", cancelPress);
app.addEventListener("pointercancel", cancelPress);
app.addEventListener("pointermove", (e) => { if (Math.abs(e.movementX) + Math.abs(e.movementY) > 4) cancelPress(); });
app.addEventListener("contextmenu", (e) => { if (inAlbum() && e.target.closest(".tile")) e.preventDefault(); });

function bindAlbum(id) {
  const input = app.querySelector("#file-input");
  input.onchange = () => {
    if (input.files.length) startUpload([...input.files]);
    input.value = "";
  };

  app.onclick = async (e) => {
    const act = e.target.closest("[data-act]")?.dataset.act;
    const t = e.target.closest(".tile");
    const chip = e.target.closest("[data-filter]");
    const dayBtn = e.target.closest("[data-select-day]");

    if (t) {
      if (longPressed) { longPressed = false; return; }
      if (state.coverPick) {
        const p = state.photos.find((x) => x.id === t.dataset.id);
        if (!p?.has_preview) { toast("Für dieses Format gibt es kein Vorschaubild, also kein Cover."); return; }
        await chooseCover(p.id);
        return;
      }
      if (state.selecting) {
        const sel = state.selected;
        sel.has(t.dataset.id) ? sel.delete(t.dataset.id) : sel.add(t.dataset.id);
        t.setAttribute("aria-pressed", String(sel.has(t.dataset.id)));
        updateSelectBar();
      } else {
        openLightbox(visiblePhotos(), Number(t.dataset.i));
      }
      return;
    }
    if (chip) {
      state.filter = chip.dataset.filter || null;
      renderAlbumBody();
      return;
    }
    if (dayBtn) {
      const ids = visiblePhotos().filter((p) => p.taken_at.startsWith(dayBtn.dataset.selectDay)).map((p) => p.id);
      const all = ids.every((x) => state.selected.has(x));
      ids.forEach((x) => (all ? state.selected.delete(x) : state.selected.add(x)));
      renderAlbumBody();
      updateSelectBar();
      return;
    }

    switch (act) {
      case "upload": input.click(); break;
      case "select":
        setSelecting(!state.selecting);
        renderAlbumBody();
        updateSelectBar();
        break;
      case "sel-done":
        setSelecting(false);
        renderAlbumBody();
        updateSelectBar();
        break;
      case "sel-dl": {
        const chosen = state.photos.filter((p) => state.selected.has(p.id));
        await downloadPhotos(chosen, `${state.album.name} Auswahl`);
        break;
      }
      case "sel-del": {
        const ids = [...state.selected];
        await deletePhotos(ids);
        setSelecting(false);
        renderAlbumBody();
        updateSelectBar();
        break;
      }
      case "pick-cover":
        closeMenus();
        setSelecting(false);
        state.coverPick = true;
        renderAlbumBody();
        updateSelectBar();
        break;
      case "cover-auto": await chooseCover(null); break;
      case "cover-cancel":
        state.coverPick = false;
        updateSelectBar();
        break;
      case "dl-album": closeMenus(); await downloadPhotos(state.photos, state.album.name); break;
      case "rename": {
        closeMenus();
        const name = await askText({ title: "Umbenennen", label: "Albumname", value: state.album.name, confirm: "Speichern" });
        if (!name) return;
        try {
          await api.renameAlbum(id, name);
          state.album.name = name;
          app.querySelector(".bar .title").textContent = name;
          document.title = `${name} – Fotokiste`;
        } catch (ex) { toast(ex.message); }
        break;
      }
      case "del-album": {
        closeMenus();
        const ok = await confirmBox({
          title: "Album löschen?",
          text: `„${state.album.name}“ kommt mit allen ${plural(state.photos.length, "Foto", "Fotos")} in den Papierkorb. Dort kann es jeder 30 Tage lang wiederherstellen.`,
          confirm: "Album löschen",
          danger: true,
        });
        if (!ok) return;
        try {
          await api.deleteAlbum(id, getMe());
          const albumId = id;
          location.hash = "#/";
          toast("Album gelöscht", { action: "Rückgängig", onAction: async () => { await api.restoreAlbum(albumId); location.hash = `#/a/${albumId}`; } });
        } catch (ex) { toast(ex.message); }
        break;
      }
    }
  };

  // drag and drop anywhere on the album page
  let depth = 0, zone = null;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
  app.ondragenter = (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (depth++ === 0) {
      zone = document.createElement("div");
      zone.className = "dropzone";
      zone.textContent = "Loslassen zum Hochladen";
      document.body.appendChild(zone);
    }
  };
  app.ondragover = (e) => { if (hasFiles(e)) e.preventDefault(); };
  app.ondragleave = () => { if (--depth <= 0) { depth = 0; zone?.remove(); } };
  app.ondrop = (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    zone?.remove();
    const files = [...e.dataTransfer.files];
    if (files.length) startUpload(files);
  };
}

async function chooseCover(photoId) {
  const album = state.album;
  try {
    await api.setCover(album.id, photoId);
  } catch (e) {
    toast(e.message);
    return;
  }
  // null means automatic: the first photo with a preview
  album.cover_id = photoId ?? state.photos.find((p) => p.has_preview)?.id ?? null;
  state.coverPick = false;
  if (!state.lb) {
    renderAlbumBody();
    updateSelectBar();
  }
  toast(photoId ? "Albumcover geändert" : "Cover ist wieder automatisch das erste Foto");
}

async function deletePhotos(ids) {
  if (!ids.length) return;
  try {
    await api.deletePhotos(ids, getMe());
  } catch (e) {
    toast(e.message);
    return;
  }
  const gone = new Set(ids);
  state.photos = state.photos.filter((p) => !gone.has(p.id));
  if (state.album && gone.has(state.album.cover_id)) state.album.cover_id = state.photos.find((p) => p.has_preview)?.id ?? null;
  const albumId = state.album.id;
  toast(`${plural(ids.length, "Foto", "Fotos")} im Papierkorb`, {
    action: "Rückgängig",
    timeout: 8000,
    onAction: async () => {
      try {
        await api.restorePhotos(ids);
        if (state.album?.id === albumId && location.hash === `#/a/${albumId}`) renderAlbum(albumId, { keepScroll: true });
      } catch (e) { toast(e.message); }
    },
  });
}

// ---------- uploads ----------

function startUpload(files) {
  queue.add(state.album.id, getMe(), files);
}

let refreshTimer = null;
let lastRefreshDone = 0;
queue.addEventListener("change", (e) => {
  scheduleUploadPanel();
  if (!e.detail?.finished) return;
  // Pull fresh photos into the open album now and then while uploads land.
  const done = queue.stats().done;
  const albumId = e.detail.finished.albumId;
  const viewing = location.hash === `#/a/${albumId}`;
  if (!viewing) return;
  clearTimeout(refreshTimer);
  const due = !queue.active || done - lastRefreshDone >= 12;
  const refresh = () => {
    if (location.hash !== `#/a/${albumId}`) return;
    // Don't pull the rug out from under someone selecting or viewing a photo; try again shortly.
    if (state.lb || state.selecting || document.querySelector("dialog[open]")) { refreshTimer = setTimeout(refresh, 1500); return; }
    lastRefreshDone = done;
    renderAlbum(albumId, { keepScroll: true });
  };
  refreshTimer = setTimeout(refresh, due ? 300 : 4000);
});

let panelQueued = false;
function scheduleUploadPanel() {
  if (panelQueued) return;
  panelQueued = true;
  requestAnimationFrame(() => { panelQueued = false; renderUploadPanel(); });
}

let panelHideTimer = null;
function renderUploadPanel() {
  const s = queue.stats();
  clearTimeout(panelHideTimer);
  // Tuck the panel away a few seconds after a clean finish.
  if (s.total && !queue.active && !s.failed) panelHideTimer = setTimeout(() => { queue.items = []; renderUploadPanel(); }, 6000);
  if (!s.total) { uploadsEl.hidden = true; return; }
  uploadsEl.hidden = false;
  // Build the frame once; afterwards only update it, so the runners keep their stride.
  if (!uploadsEl.querySelector(".runners")) {
    uploadsEl.innerHTML = `<h4></h4><p class="notes"></p>${runners()}<ul></ul><div class="row"></div>`;
  }
  const finished = s.done + s.duplicate + s.restored + s.failed;
  const active = queue.active;
  const notes = [];
  if (s.duplicate) notes.push(`${plural(s.duplicate, "Foto war", "Fotos waren")} schon im Album.`);
  if (s.restored) notes.push(`${plural(s.restored, "Foto", "Fotos")} aus dem Papierkorb zurückgeholt.`);
  if (s.failed) notes.push(`${plural(s.failed, "Foto", "Fotos")} nicht hochgeladen.`);
  if (active && matchMedia("(hover: none)").matches) notes.push("Lass den Bildschirm an, bis alles oben ist.");
  const failed = queue.items.filter((i) => i.state === "failed");

  uploadsEl.querySelector("h4").textContent = active ? `Hochladen: ${finished} von ${s.total}` : `${plural(s.done, "Foto", "Fotos")} hochgeladen`;
  const notesEl = uploadsEl.querySelector(".notes");
  notesEl.textContent = notes.join(" ");
  notesEl.hidden = !notes.length;
  setRunners(uploadsEl.querySelector(".runners"), s.bytesTotal ? s.bytesDone / s.bytesTotal : 0);
  const list = uploadsEl.querySelector("ul");
  list.innerHTML = failed.map((i) => `<li><span>${esc(i.file.name)}</span><span class="err">${esc(i.error)}</span></li>`).join("");
  list.hidden = !failed.length;
  uploadsEl.querySelector(".row").innerHTML =
    (failed.length && !active ? `<button class="btn primary" data-up="retry">Nochmal versuchen</button>` : "") +
    (!active ? `<button class="btn" data-up="close">Schließen</button>` : "");
}
uploadsEl.addEventListener("click", (e) => {
  const act = e.target.closest("[data-up]")?.dataset.up;
  if (act === "retry") queue.retryFailed();
  if (act === "close") { queue.items = []; renderUploadPanel(); }
});

// ---------- downloads ----------

async function downloadPhotos(photos, baseName) {
  if (!photos.length) return;
  const name = safeFileName(baseName);
  if (photos.length === 1) return saveUrl(fileUrl(photos[0].id, "original", true));

  if (canStreamToDisk()) {
    let t;
    try {
      const promise = streamZipToDisk(photos, name, (p) => t?.set(p));
      t = progressToast(`${plural(photos.length, "Foto", "Fotos")} werden gespeichert`);
      await promise;
      t.done("ZIP gespeichert");
    } catch (e) {
      if (e?.name === "AbortError") t?.close();
      else t ? t.fail(e.message) : toast(e.message);
    }
    return;
  }

  const parts = splitIntoParts(photos);
  if (parts.length === 1) return zipPart(parts[0], name);

  await dialog(
    `<h2 class="display">In ${parts.length} Teilen</h2>
     <p>${plural(photos.length, "Foto", "Fotos")} mit ${fmtSize(photos.reduce((s, p) => s + p.size, 0))} sind zu viel für eine Datei in diesem Browser. Lade die Teile nacheinander.</p>
     <div class="parts">${parts.map((p, i) => `<button class="btn" data-part="${i}"><span>Teil ${i + 1}</span><span>${plural(p.length, "Foto", "Fotos")}, ${fmtSize(p.reduce((s, x) => s + x.size, 0))}</span></button>`).join("")}</div>
     <div class="row"><button class="btn quiet" data-cancel>Schließen</button></div>`,
    (d) => d.querySelectorAll("[data-part]").forEach((b) => (b.onclick = async () => {
      const i = Number(b.dataset.part);
      b.disabled = true;
      await zipPart(parts[i], `${name} Teil ${i + 1} von ${parts.length}`);
      b.querySelector("span").textContent = `Teil ${i + 1} geladen`;
    }))
  );
}

async function zipPart(photos, name) {
  const t = progressToast(`ZIP mit ${plural(photos.length, "Foto", "Fotos")} wird gepackt`);
  try {
    await zipToDownload(photos, name, (p) => t.set(p));
    t.done("ZIP heruntergeladen");
  } catch (e) {
    t.fail(e.message);
  }
}

// ---------- lightbox ----------

let lbEl = null;

function openLightbox(list, index) {
  state.lb = { list, index };
  history.pushState({ lb: true }, "");
  lbEl = document.createElement("div");
  lbEl.className = "lightbox";
  lbEl.setAttribute("role", "dialog");
  lbEl.setAttribute("aria-modal", "true");
  lbEl.setAttribute("aria-label", "Fotoansicht");
  document.body.appendChild(lbEl);
  document.body.style.overflow = "hidden";
  drawLightbox();
  lbEl.addEventListener("click", onLightboxClick);
  bindSwipe(lbEl);
  document.addEventListener("keydown", onLightboxKey);
}

function closeLightbox(fromHistory = false) {
  if (!state.lb) return;
  const { list, index } = state.lb;
  state.lb = null;
  document.removeEventListener("keydown", onLightboxKey);
  lbEl?.remove();
  lbEl = null;
  document.body.style.overflow = "";
  if (!fromHistory && history.state?.lb) history.back();
  // keep the gallery where the viewer left off
  const id = list[index]?.id;
  if (id) app.querySelector(`.tile[data-id="${id}"]`)?.focus({ preventScroll: false });
}

function drawLightbox() {
  const { list, index } = state.lb;
  const p = list[index];
  if (!p) return closeLightbox();
  const when = parseLocal(p.taken_at);
  const whenText = `${fmtDayYear.format(when)}, ${fmtTime.format(when)} Uhr`;
  const timeNote = p.taken_src === "exif" ? "" : " (Aufnahmezeit unbekannt, Dateidatum)";
  const ext = extOf(p.filename).toUpperCase();
  lbEl.innerHTML = `
    <div class="lb-top">
      <span class="pos">${index + 1} von ${list.length}</span>
      <button class="icon-btn" data-lb="close" aria-label="Schließen">${icon("close")}</button>
    </div>
    <div class="lb-stage">
      ${p.has_preview
        ? `<img src="${fileUrl(p.id, "preview")}" alt="Foto von ${esc(p.uploader)}, ${esc(whenText)}">`
        : `<div class="noprev"><strong>${esc(ext || "?")}</strong>Für dieses Format gibt es keine Vorschau. Das Original kannst du trotzdem herunterladen.</div>`}
      ${index > 0 ? `<button class="icon-btn lb-nav prev" data-lb="prev" aria-label="Vorheriges Foto">${icon("prev")}</button>` : ""}
      ${index < list.length - 1 ? `<button class="icon-btn lb-nav next" data-lb="next" aria-label="Nächstes Foto">${icon("next")}</button>` : ""}
    </div>
    <div class="lb-bottom">
      <div class="lb-info">
        <span class="avatar" style="${person(p.uploader)}">${esc(p.uploader[0])}</span>
        <div><div class="who-line">${esc(p.uploader)}</div>
          <div class="sub">${esc(whenText + timeNote)}<br>${esc(p.filename)}, ${fmtSize(p.size)}${p.width ? `, ${p.width} × ${p.height}` : ""}</div></div>
      </div>
      <div class="lb-actions">
        <button class="btn primary" data-lb="original">${icon("download")}Original laden</button>
        ${needsJpegCopy(p.filename) ? `<button class="btn" data-lb="jpeg">Als JPEG laden</button>` : ""}
        ${p.has_preview ? (state.album?.cover_id === p.id
          ? `<button class="btn" disabled>${icon("cover")}Ist das Cover</button>`
          : `<button class="btn" data-lb="cover">${icon("cover")}Als Cover</button>`) : ""}
        <button class="btn danger" data-lb="delete">${icon("trash")}Löschen</button>
      </div>
    </div>`;
  // warm up the neighbours so swiping feels instant
  for (const n of [list[index + 1], list[index - 1]]) if (n?.has_preview) new Image().src = fileUrl(n.id, "preview");
}

function step(delta) {
  const lb = state.lb;
  const next = lb.index + delta;
  if (next < 0 || next >= lb.list.length) return;
  lb.index = next;
  drawLightbox();
}

async function onLightboxClick(e) {
  const act = e.target.closest("[data-lb]")?.dataset.lb;
  if (!act) return;
  const p = state.lb.list[state.lb.index];
  if (act === "close") closeLightbox();
  if (act === "prev") step(-1);
  if (act === "next") step(1);
  if (act === "original") saveUrl(fileUrl(p.id, "original", true));
  if (act === "cover") {
    await chooseCover(p.id);
    if (state.lb) { drawLightbox(); renderAlbumBody(); }
  }
  if (act === "jpeg") {
    const t = progressToast("JPEG wird erstellt");
    try {
      const res = await fetch(fileUrl(p.id, "original"));
      if (!res.ok) throw new Error("Original konnte nicht geladen werden.");
      t.set(0.5);
      const jpg = await jpegCopy(await res.blob(), p.filename);
      saveBlob(jpg, p.filename.replace(/\.[^.]+$/, "") + ".jpg");
      t.done("JPEG heruntergeladen");
    } catch (ex) {
      t.fail(`JPEG ging nicht: ${ex.message}. Das Original funktioniert immer.`);
    }
  }
  if (act === "delete") {
    const lb = state.lb;
    await deletePhotos([p.id]);
    lb.list = lb.list.filter((x) => x.id !== p.id);
    if (!lb.list.length) { closeLightbox(); renderAlbumBody(); return; }
    lb.index = Math.min(lb.index, lb.list.length - 1);
    drawLightbox();
    renderAlbumBody();
  }
}

function onLightboxKey(e) {
  if (!state.lb || document.querySelector("dialog[open]")) return;
  if (e.key === "Escape") closeLightbox();
  if (e.key === "ArrowRight") step(1);
  if (e.key === "ArrowLeft") step(-1);
}

function bindSwipe(el) {
  let x0 = null, y0 = null, img = null;
  el.addEventListener("pointerdown", (e) => {
    if (!e.target.closest(".lb-stage") || e.target.closest("button")) return;
    x0 = e.clientX; y0 = e.clientY;
    img = el.querySelector(".lb-stage img");
  });
  el.addEventListener("pointermove", (e) => {
    if (x0 == null || !img) return;
    img.style.transition = "none";
    img.style.transform = `translateX(${e.clientX - x0}px)`;
  });
  const end = (e) => {
    if (x0 == null) return;
    const dx = e.clientX - x0, dy = e.clientY - y0;
    x0 = null;
    if (img) { img.style.transition = ""; img.style.transform = ""; }
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy)) step(dx < 0 ? 1 : -1);
    else if (dy > 110 && Math.abs(dy) > Math.abs(dx)) closeLightbox();
  };
  el.addEventListener("pointerup", end);
  el.addEventListener("pointercancel", () => { x0 = null; if (img) img.style.transform = ""; });
}

// ---------- trash ----------

async function renderTrash() {
  document.title = "Papierkorb – Fotokiste";
  app.innerHTML = `<header class="bar"><a class="icon-btn back" href="#/" aria-label="Alle Alben">${icon("back")}</a><h1 class="title display">Papierkorb</h1>${meButton()}</header>${loadingBlock("Papierkorb wird geladen.")}`;
  bindMe(app);
  let data;
  try {
    data = await api.trash();
  } catch (e) {
    app.querySelector(".loading").textContent = e.message;
    return;
  }
  if (location.hash !== "#/trash") return;
  const daysLeft = (t) => Math.max(0, data.days - Math.floor((Date.now() - t) / 86400000));
  const selected = new Set();

  const page = document.createElement("section");
  page.className = "page";
  const empty = !data.albums.length && !data.photos.length;
  page.innerHTML = empty
    ? `<div class="empty-state"><h2 class="display">Leer</h2><p>Gelöschte Fotos und Alben landen hier und bleiben ${data.days} Tage lang wiederherstellbar.</p></div>`
    : `<p class="trash-note">Alles hier wird nach ${data.days} Tagen endgültig gelöscht.</p>
      ${data.albums.length ? `<div class="trash-section"><h2 class="display">Alben</h2><div class="trash-albums">${data.albums.map((a) => `
        <div class="trash-album">${a.cover_id ? `<img src="${fileUrl(a.cover_id, "thumb")}" alt="">` : `<span class="ph"></span>`}
          <div><strong>${esc(a.name)}</strong><small>${plural(a.count, "Foto", "Fotos")}, gelöscht von ${esc(a.deleted_by)}, noch ${plural(daysLeft(a.deleted_at), "Tag", "Tage")}</small></div>
          <button class="btn" data-restore-album="${a.id}">Wiederherstellen</button></div>`).join("")}</div></div>` : ""}
      ${data.photos.length ? `<div class="trash-section"><h2 class="display">Fotos</h2><p class="trash-note">Tippe Fotos an, die zurück sollen.</p>
        <div class="grid trash-grid selecting">${data.photos.map((p) => `
          <button class="tile" data-id="${p.id}" aria-pressed="false" style="${person(p.uploader)}" aria-label="Foto von ${esc(p.uploader)} aus ${esc(p.album_name)}, gelöscht von ${esc(p.deleted_by)}">
            ${p.has_preview ? `<img src="${fileUrl(p.id, "thumb")}" alt="" loading="lazy">` : `<span class="ext">${esc(extOf(p.filename).toUpperCase())}</span>`}
            <span class="days">noch ${daysLeft(p.deleted_at)} T.</span><span class="check">${icon("check")}</span></button>`).join("")}</div></div>` : ""}`;
  app.querySelector(".loading").replaceWith(page);

  const bar = document.createElement("div");
  bar.className = "select-bar";
  bar.hidden = true;
  app.appendChild(bar);
  const drawBar = () => {
    bar.hidden = !selected.size;
    bar.innerHTML = `<span class="count">${plural(selected.size, "Foto", "Fotos")} ausgewählt</span><button class="btn primary" data-restore-photos>Wiederherstellen</button>`;
    syncBarSpace();
  };

  app.onclick = async (e) => {
    const t = e.target.closest(".tile");
    if (t) {
      selected.has(t.dataset.id) ? selected.delete(t.dataset.id) : selected.add(t.dataset.id);
      t.setAttribute("aria-pressed", String(selected.has(t.dataset.id)));
      drawBar();
      return;
    }
    const ra = e.target.closest("[data-restore-album]");
    if (ra) {
      try {
        await api.restoreAlbum(ra.dataset.restoreAlbum);
        toast("Album wiederhergestellt");
        renderTrash();
      } catch (ex) { toast(ex.message); }
      return;
    }
    if (e.target.closest("[data-restore-photos]")) {
      try {
        await api.restorePhotos([...selected]);
        toast(`${plural(selected.size, "Foto", "Fotos")} wiederhergestellt`);
        renderTrash();
      } catch (ex) { toast(ex.message); }
    }
  };
}

boot();
