// The hidden photo voting: random photos one after another, swipe right for up, left for down.
// The screen tints green or red the further a photo is dragged, until it flies off.

import { fileUrl } from "./api.js";

const COMMIT_PX = 110;      // drag distance that counts as a decision
const FLICK_SPEED = 0.6;    // or a quick flick (px per ms) over a shorter distance
const TINT_MAX = 0.72;

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function shuffle(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * @param {object} o
 * @param {Array} o.photos      photos of the album (with has_preview and voters)
 * @param {string} o.me         who is voting
 * @param {(name:string)=>string} o.person  style string for a person's color
 * @param {(photo:object, value:number)=>Promise} o.onVote
 * @param {()=>void} o.onRanking   open the ranking (Voting filter)
 * @param {()=>void} o.onClose
 * @param {(iso:string)=>string} o.when  human date for a photo
 */
export function openTinder(o) {
  const mine = (p) => (p.voters || "").split("|").includes(o.me);
  const queue = shuffle(o.photos.filter((p) => p.has_preview && !mine(p)));
  const total = queue.length;
  let busy = false;

  const el = document.createElement("div");
  el.className = "tinder";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-modal", "true");
  el.setAttribute("aria-label", "Foto-Voting");
  el.innerHTML = `
    <div class="tinder-tint"></div>
    <div class="tinder-top">
      <span class="tinder-count" aria-live="polite"></span>
      <button class="tinder-x" data-t="close" aria-label="Voting schließen">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
      </button>
    </div>
    <div class="tinder-deck"></div>
    <div class="tinder-meta"></div>
    <div class="tinder-actions">
      <button class="vote-btn down" data-t="down" aria-label="Flop">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M7 7l10 10M17 7L7 17"/></svg>
      </button>
      <button class="vote-btn up" data-t="up" aria-label="Top">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 20.5s-7.5-4.4-7.5-10.1A4.3 4.3 0 0 1 12 7.6a4.3 4.3 0 0 1 7.5 2.8c0 5.7-7.5 10.1-7.5 10.1z"/></svg>
      </button>
    </div>`;
  document.body.appendChild(el);
  document.body.style.overflow = "hidden";
  history.pushState({ tinder: true }, "");

  const deck = el.querySelector(".tinder-deck");
  const tint = el.querySelector(".tinder-tint");
  const meta = el.querySelector(".tinder-meta");
  const count = el.querySelector(".tinder-count");

  function setTint(dx, instant) {
    const a = Math.min(Math.abs(dx) / 240, 1) * TINT_MAX;
    tint.style.transition = instant ? "none" : "";
    tint.style.background = dx >= 0 ? `rgba(22, 163, 92, ${a})` : `rgba(224, 65, 47, ${a})`;
  }

  function card(p, cls) {
    return `<div class="tcard ${cls}" data-id="${p.id}">
      <img src="${fileUrl(p.id, "preview")}" alt="Foto von ${esc(p.uploader)}" draggable="false">
      <span class="stamp top">Top</span><span class="stamp flop">Flop</span>
    </div>`;
  }

  function draw() {
    const [cur, next] = queue;
    count.textContent = cur ? `Noch ${queue.length} von ${total}` : "";
    if (!cur) {
      deck.innerHTML = `<div class="tinder-done">
        <h2 class="display">${total ? "Alles bewertet" : "Nichts Neues"}</h2>
        <p>${total ? "Du hast jedes Foto in diesem Album bewertet." : "Du hast hier schon alle Fotos bewertet."} Die Rangliste findest du im Filter Voting.</p>
        <button class="btn primary" data-t="ranking">Rangliste ansehen</button>
      </div>`;
      meta.innerHTML = "";
      el.querySelector(".tinder-actions").hidden = true;
      return;
    }
    deck.innerHTML = (next ? card(next, "next") : "") + card(cur, "current");
    meta.innerHTML = `<span class="dot" style="${o.person(cur.uploader)}"></span>${esc(cur.uploader)}, ${esc(o.when(cur.taken_at))}`;
    if (queue[2]) new Image().src = fileUrl(queue[2].id, "preview");
    bindDrag(deck.querySelector(".tcard.current"));
  }

  function bindDrag(c) {
    let x0 = 0, y0 = 0, t0 = 0, dx = 0, dy = 0, dragging = false;
    c.addEventListener("pointerdown", (e) => {
      if (busy) return;
      dragging = true;
      x0 = e.clientX; y0 = e.clientY; t0 = performance.now(); dx = dy = 0;
      c.setPointerCapture(e.pointerId);
      c.style.transition = "none";
    });
    c.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      dx = e.clientX - x0; dy = e.clientY - y0;
      c.style.transform = `translate(${dx}px, ${dy * 0.35}px) rotate(${dx / 18}deg)`;
      c.style.setProperty("--top", Math.max(0, Math.min(1, dx / COMMIT_PX)));
      c.style.setProperty("--flop", Math.max(0, Math.min(1, -dx / COMMIT_PX)));
      setTint(dx, true);
    });
    const end = () => {
      if (!dragging) return;
      dragging = false;
      const speed = Math.abs(dx) / Math.max(1, performance.now() - t0);
      if (Math.abs(dx) > COMMIT_PX || (Math.abs(dx) > 40 && speed > FLICK_SPEED)) return decide(dx > 0 ? 1 : -1);
      c.style.transition = "";
      c.style.transform = "";
      c.style.setProperty("--top", 0);
      c.style.setProperty("--flop", 0);
      setTint(0);
    };
    c.addEventListener("pointerup", end);
    c.addEventListener("pointercancel", end);
  }

  function decide(value) {
    const c = deck.querySelector(".tcard.current");
    const p = queue[0];
    if (!c || !p || busy) return;
    busy = true;
    const dir = value > 0 ? 1 : -1;
    c.style.transition = "transform 0.34s cubic-bezier(.3,.6,.4,1)";
    c.style.setProperty(dir > 0 ? "--top" : "--flop", 1);
    c.style.transform = `translate(${dir * (innerWidth + 260)}px, -40px) rotate(${dir * 32}deg)`;
    setTint(dir * 400);
    o.onVote(p, value);
    setTimeout(() => {
      queue.shift();
      setTint(0);
      busy = false;
      draw();
    }, 340);
  }

  function close(fromHistory = false) {
    document.removeEventListener("keydown", onKey);
    window.removeEventListener("popstate", onPop);
    el.remove();
    document.body.style.overflow = "";
    if (!fromHistory && history.state?.tinder) history.back();
    o.onClose();
  }

  function onKey(e) {
    if (e.key === "Escape") close();
    if (e.key === "ArrowRight") decide(1);
    if (e.key === "ArrowLeft") decide(-1);
  }
  const onPop = () => close(true);

  el.addEventListener("click", (e) => {
    const t = e.target.closest("[data-t]")?.dataset.t;
    if (t === "close") close();
    if (t === "up") decide(1);
    if (t === "down") decide(-1);
    if (t === "ranking") { close(); o.onRanking(); }
  });
  document.addEventListener("keydown", onKey);
  window.addEventListener("popstate", onPop);
  draw();
}
