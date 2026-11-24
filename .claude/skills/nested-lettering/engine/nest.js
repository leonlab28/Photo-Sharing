/*
 * nest.js: parametric engine for nested ("inlay") lettering.
 * A word is split into units: a HOST letter and an optional GUEST letter that
 * takes the exact shape of the host's counter, inset by one gap.
 * Everything is measured in units where one row's cap height = capH (default 360).
 * Runs in Node (require) and in the browser (window.Nest). Needs polygon-clipping.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    let pc;
    try { pc = require('polygon-clipping'); } catch (e) { pc = require('./vendor/polygon-clipping.umd.min.js'); }
    module.exports = factory(pc);
  } else root.Nest = factory(root.polygonClipping);
})(typeof self !== 'undefined' ? self : this, function (pc) {
  'use strict';
  const PI = Math.PI;

  // ---------- geometry helpers (polygon-clipping format) ----------
  const close = (pts) => {
    const r = pts.map((p) => [p[0], p[1]]);
    const a = r[0], b = r[r.length - 1];
    if (a[0] !== b[0] || a[1] !== b[1]) r.push([a[0], a[1]]);
    return r;
  };
  const P = (pts) => [close(pts)];
  const rect = (x0, y0, x1, y1) => P([[x0, y0], [x1, y0], [x1, y1], [x0, y1]]);
  const isPoly = (g) => typeof g[0][0][0] === 'number';
  const MP = (g) => (!g || !g.length ? [] : isPoly(g) ? [g] : g);
  function arc(cx, cy, rx, ry, a0, a1, n) {
    const N = n || Math.max(6, Math.ceil((Math.abs(a1 - a0) / (2 * PI)) * 160));
    const out = [];
    for (let i = 0; i <= N; i++) {
      const a = a0 + ((a1 - a0) * i) / N;
      out.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
    }
    return out;
  }
  function roundedRect(x0, y0, x1, y1, r = {}) {
    const lim = Math.max(0, Math.min(x1 - x0, y1 - y0) / 2);
    const R = (v) => Math.min(Math.max(v || 0, 0), lim);
    const tl = R(r.tl), tr = R(r.tr), br = R(r.br), bl = R(r.bl);
    const pts = [];
    tl ? pts.push(...arc(x0 + tl, y0 + tl, tl, tl, PI, 1.5 * PI)) : pts.push([x0, y0]);
    tr ? pts.push(...arc(x1 - tr, y0 + tr, tr, tr, -PI / 2, 0)) : pts.push([x1, y0]);
    br ? pts.push(...arc(x1 - br, y1 - br, br, br, 0, PI / 2)) : pts.push([x1, y1]);
    bl ? pts.push(...arc(x0 + bl, y1 - bl, bl, bl, PI / 2, PI)) : pts.push([x0, y1]);
    return P(pts);
  }
  const translate = (g, dx, dy) => MP(g).map((poly) => poly.map((ring) => ring.map(([x, y]) => [x + dx, y + dy])));
  const mapPts = (g, fn) => MP(g).map((poly) => poly.map((ring) => ring.map(fn)));
  function bbox(g) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const poly of MP(g)) for (const ring of poly) for (const [x, y] of ring) {
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    return [x0, y0, x1, y1];
  }
  function area(g) {
    let a = 0;
    for (const poly of MP(g)) poly.forEach((ring, k) => {
      let s = 0;
      for (let i = 0; i < ring.length - 1; i++) s += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
      a += (k === 0 ? 1 : -1) * Math.abs(s / 2);
    });
    return a;
  }
  // keep the side where nx*x + ny*y + c >= 0 (convex clip)
  function clipHalf(pts, nx, ny, c) {
    const f = (p) => nx * p[0] + ny * p[1] + c, out = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length], fa = f(a), fb = f(b);
      if (fa >= 0) out.push(a);
      if ((fa >= 0) !== (fb >= 0)) { const t = fa / (fa - fb); out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]); }
    }
    return out;
  }
  // min / max x where the horizontal line y crosses the geometry
  function xRange(g, y) {
    let lo = Infinity, hi = -Infinity;
    for (const poly of MP(g)) for (const ring of poly) for (let i = 0; i < ring.length - 1; i++) {
      const [ax, ay] = ring[i], [bx, by] = ring[i + 1];
      if ((ay <= y && by > y) || (by <= y && ay > y)) {
        const x = ax + ((y - ay) / (by - ay)) * (bx - ax);
        if (x < lo) lo = x; if (x > hi) hi = x;
      }
    }
    return [lo, hi];
  }
  function erode(region, d, n = 32) {
    const copies = [];
    for (let i = 0; i < n; i++) { const a = (2 * PI * i) / n; copies.push(translate(region, d * Math.cos(a), d * Math.sin(a))); }
    return pc.intersection(MP(region), ...copies);
  }
  // inward offset with mitre joins (sharp corners, like a drawn inline); for simple polygons
  function insetRing(ring, d) {
    const pts = ring.slice(0, -1), n = pts.length;
    let A = 0;
    for (let i = 0; i < n; i++) { const a = pts[i], b = pts[(i + 1) % n]; A += a[0] * b[1] - b[0] * a[1]; }
    const sgn = A > 0 ? 1 : -1, lines = [];
    for (let i = 0; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % n], ex = b[0] - a[0], ey = b[1] - a[1], L = Math.hypot(ex, ey);
      if (L < 1e-9) continue;
      const nx = (-ey / L) * sgn, ny = (ex / L) * sgn;
      lines.push({ px: a[0] + nx * d, py: a[1] + ny * d, ex, ey, ox: a[0], oy: a[1] });
    }
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      const l1 = lines[(i - 1 + lines.length) % lines.length], l2 = lines[i];
      const cr = l1.ex * l2.ey - l1.ey * l2.ex;
      if (Math.abs(cr) < 1e-9 * Math.hypot(l1.ex, l1.ey) * Math.hypot(l2.ex, l2.ey)) { out.push([l2.px, l2.py]); continue; }
      const t = ((l2.px - l1.px) * l2.ey - (l2.py - l1.py) * l2.ex) / cr;
      let x = l1.px + l1.ex * t, y = l1.py + l1.ey * t;
      const dx = x - l2.ox, dy = y - l2.oy, dist = Math.hypot(dx, dy);
      if (dist > 4 * d) { x = l2.ox + (dx / dist) * 4 * d; y = l2.oy + (dy / dist) * 4 * d; }  // mitre limit
      out.push([x, y]);
    }
    return close(out);
  }
  function inset(region, d) {
    const parts = MP(region).map((poly) => [insetRing(poly[0], d)]);
    try { return pc.intersection(pc.union(...parts), MP(region)); } catch (e) { return erode(region, d); }
  }
  // region shifted right so that "points at least T from the left boundary" are kept
  function leftStemShift(region, T) {
    const [, y0, , y1] = bbox(region), h = y1 - y0;
    const ya = y0 + h * 0.3, yb = y0 + h * 0.75;
    const xa = xRange(region, ya)[0], xb = xRange(region, yb)[0];
    const slope = isFinite(xa) && isFinite(xb) ? (xb - xa) / (yb - ya) : 0;
    const Tx = T * Math.sqrt(1 + slope * slope);
    return { shifted: translate(region, Tx, 0), Tx };
  }
  function rightStemShift(region, T) {
    const [, y0, , y1] = bbox(region), h = y1 - y0;
    const ya = y0 + h * 0.3, yb = y0 + h * 0.75;
    const xa = xRange(region, ya)[1], xb = xRange(region, yb)[1];
    const slope = isFinite(xa) && isFinite(xb) ? (xb - xa) / (yb - ya) : 0;
    const Tx = T * Math.sqrt(1 + slope * slope);
    return translate(region, -Tx, 0);
  }

  // ---------- OUTER letters: shape + host region (counter inset by the gap) ----------
  // build(o): o = {w, h, S, g, hosting, ...overrides}; local coords, y down, box 0..w x 0..h
  const OUTER = {
    D: {
      w0: 320,
      build(o) {
        const { w, h, S, g } = o;
        const a = Math.max(S + 4, Math.min(w * (o.straight ?? 0.53), w - S - 8));
        const rx = w - a, ry = h / 2;
        const ring = (inset) => [[inset, inset], [a, inset],
          ...arc(a, h / 2, Math.max(1, rx - inset), Math.max(1, ry - inset), -PI / 2, PI / 2).slice(1), [inset, h - inset]];
        return { shape: [close(ring(0)), close(ring(S))], region: P(ring(S + g)) };
      },
    },
    O: {
      w0: 340,
      build(o) {
        const { w, h, S, g } = o;
        const e = (i) => arc(w / 2, h / 2, Math.max(1, w / 2 - i), Math.max(1, h / 2 - i), 0, 2 * PI, 200).slice(0, -1);
        return { shape: [close(e(0)), close(e(S))], region: P(e(S + g)) };
      },
    },
    Z: {
      w0: 300,
      build(o) {
        const { w, h, S, g } = o;
        const Sd = o.diag ?? S * 0.955;            // diagonals drawn slightly lighter
        let d = S;
        for (let i = 0; i < 60; i++) d = (Sd * Math.hypot(w - d, h - 2 * S)) / (h - 2 * S);
        const shape = P([[0, 0], [w, 0], [w, S], [d, h - S], [w, h - S], [w, h], [0, h], [0, h - S], [w - d, S], [0, S]]);
        const vx = d - w, vy = h - 2 * S, L = Math.hypot(vx, vy);
        const nx = vy / L, ny = -vx / L;            // normal towards the lower-right counter
        const c = -(nx * w + ny * S) - g;
        const reg = clipHalf([[0, S + g], [w, S + g], [w, h - S - g], [0, h - S - g]], nx, ny, c);
        return { shape, region: reg.length > 2 ? P(reg) : null };
      },
    },
    M: {
      w0: 284,
      build(o) {
        const { w, h, S, g } = o;
        const vb = (o.vdepth ?? 1 / 3) * h;         // lower vertex of the V
        const half = (w - 2 * S) / 2, c = w / 2;
        let vt = vb * 0.6;
        for (let i = 0; i < 80; i++) vt = vb - S * Math.sqrt(1 + (vt / half) ** 2);
        vt = Math.max(vt, 1);
        const m = vt / half, yl = vb - m * half;
        const shape = P([[0, 0], [S, 0], [c, vt], [w - S, 0], [w, 0], [w, h], [w - S, h], [w - S, yl], [c, vb], [S, yl], [S, h], [0, h]]);
        const k = Math.sqrt(1 + m * m), xl = S + g, xr = w - S - g;
        const region = xr - xl > 4 ? P([[xl, yl + m * g + g * k], [c, vb + g * k], [xr, yl + m * g + g * k], [xr, h], [xl, h]]) : null;
        return { shape, region };
      },
    },
    E: {
      w0: 220,
      build(o) {
        const { w, h, S, g } = o;
        const m1 = o.waist != null ? o.waist * h : o.hosting ? 0.244 * h : (h - S) / 2;
        const shape = P([[0, 0], [w, 0], [w, S], [S, S], [S, m1], [w, m1], [w, m1 + S], [S, m1 + S],
          [S, h - S], [w, h - S], [w, h], [0, h]]);
        const top = m1 + S + g, bot = h - S - g;
        return { shape, region: bot - top > 4 ? rect(S + g, top, w, bot) : null };
      },
    },
    N: {
      w0: 300,
      build(o) {
        const { w, h, S, g } = o;
        const Sd = o.diag ?? S * 0.955;
        let d = Sd;                                // horizontal width of the diagonal
        for (let i = 0; i < 60; i++) d = (Sd * Math.hypot(w - d, h)) / h;
        const shape = pc.union(rect(0, 0, S, h), rect(w - S, 0, w, h), P([[0, 0], [d, 0], [w, h], [w - d, h]]));
        // lower-left counter: right of the left stem, below the diagonal, open at the baseline
        const vx = w - d, vy = h, L = Math.hypot(vx, vy);
        const nx = -vy / L, ny = vx / L;           // normal pointing down-left, away from the band
        const c = -(nx * 0 + ny * 0) - g;          // through the band's lower-left edge (0,0)-(w-d,h)
        const reg = clipHalf([[S + g, 0], [w - S - g, 0], [w - S - g, h], [S + g, h]], nx, ny, c);
        return { shape, region: reg.length > 2 ? P(reg) : null };
      },
    },
    V: {
      w0: 320,
      build(o) {
        const { w, h, S, g } = o;
        const Sd = o.diag ?? S * 0.955, c = w / 2, bw = o.tip ?? S * 0.9;   // flat tip at the baseline
        // outer edges: (0,0)->(c-bw/2,h) and mirror; arm band horizontal width dx at the top
        const ox = c - bw / 2, L0 = Math.hypot(ox, h);
        const dx = (Sd * L0) / h;
        // inner edges: (dx,0) parallel to the outer edge; meet on the axis
        const yv = Math.min(h - 1, (h * (c - dx)) / ox);
        const shape = P([[0, 0], [dx, 0], [c, yv], [w - dx, 0], [w, 0], [c + bw / 2, h], [c - bw / 2, h]]);
        // counter between the arms, inset by g, open (flush) at the cap line
        const nx = h / L0, ny = -ox / L0;          // normal of the left inner edge pointing right/up into the counter
        const cl = -(nx * dx + ny * 0) - g;
        let reg = clipHalf([[0, 0], [w, 0], [w, h], [0, h]], nx, ny, cl);
        reg = clipHalf(reg, -nx, ny, -(-nx * (w - dx) + ny * 0) - g);
        return { shape, region: reg.length > 2 ? P(reg) : null };
      },
    },
    L: {
      w0: 230,
      build(o) {
        const { w, h, S, g } = o;
        return { shape: P([[0, 0], [S, 0], [S, h - S], [w, h - S], [w, h], [0, h]]), region: rect(S + g, 0, w, h - S - g) };
      },
    },
  };

  // ---------- INNER letters: carve a letter out of any region ----------
  // r(region, o): o = {T, warn}; returns MultiPolygon
  const band = (x0, x1, ya, yb) => rect(x0 - 2, ya, x1 + 2, yb);
  const INNER = {
    E(region, o) {
      const [x0, y0, x1, y1] = bbox(region), T = o.T, H = y1 - y0;
      const mid = y0 + H * (o.mid ?? 0.5);
      if (H - 3 * T < 1.2 * T) o.warn(`E: region ${H.toFixed(0)} tall leaves slots under ${((H - 3 * T) / 2).toFixed(0)}`);
      const { shifted } = leftStemShift(region, T);
      const cut = pc.intersection(pc.union(band(x0, x1, y0 + T, mid - T / 2), band(x0, x1, mid + T / 2, y1 - T)), shifted);
      return pc.difference(MP(region), cut);
    },
    F(region, o) {
      const [x0, y0, x1, y1] = bbox(region), T = o.T, H = y1 - y0, mid = y0 + H * (o.mid ?? 0.5);
      const { shifted } = leftStemShift(region, T);
      const cut = pc.intersection(pc.union(band(x0, x1, y0 + T, mid - T / 2), band(x0, x1, mid + T / 2, y1 + 2)), shifted);
      return pc.difference(MP(region), cut);
    },
    L(region, o) {
      const [x0, y0, x1, y1] = bbox(region), T = o.T;
      const { shifted } = leftStemShift(region, T);
      return pc.difference(MP(region), pc.intersection(band(x0, x1, y0 - 2, y1 - T), shifted));
    },
    I(region, o) {
      const [, y0, , y1] = bbox(region), [l, r] = xRange(region, (y0 + y1) / 2), xc = (l + r) / 2;
      return pc.intersection(MP(region), rect(xc - o.T / 2, y0 - 2, xc + o.T / 2, y1 + 2));
    },
    T(region, o) {
      const [x0, y0, x1, y1] = bbox(region), T = o.T, [l, r] = xRange(region, (y0 + y1) / 2), xc = (l + r) / 2;
      const cut = pc.difference(band(x0, x1, y0 + T, y1 + 2), rect(xc - T / 2, y0, xc + T / 2, y1 + 2));
      return pc.difference(MP(region), cut);
    },
    H(region, o) {
      const [x0, y0, x1, y1] = bbox(region), T = o.T, H = y1 - y0, mid = y0 + H * (o.mid ?? 0.5);
      const { shifted } = leftStemShift(region, T);
      const cut = pc.intersection(pc.union(band(x0, x1, y0 - 2, mid - T / 2), band(x0, x1, mid + T / 2, y1 + 2)), shifted, rightStemShift(region, T));
      return pc.difference(MP(region), cut);
    },
    V(region, o) {
      const [x0, y0, x1, y1] = bbox(region), T = o.T, H = y1 - y0;
      const [l, r] = xRange(region, y0 + H * 0.4), xc = (l + r) / 2;
      const tipT = T * (o.tip ?? 1.35);           // the round bottom reads thin, so it is drawn heavier
      const ay = y1 - tipT;                        // apex of the notch
      // half-width of the notch at height y0+0.35H so that the arm there is one stroke wide
      const yr = y0 + H * 0.35, [lr] = xRange(region, yr);
      let s = (xc - lr - T) / (ay - yr);
      for (let i = 0; i < 30; i++) { const Th = T * Math.sqrt(1 + s * s); s = Math.max(0.05, (xc - lr - Th) / (ay - yr)); }
      const half = s * (ay - y0 + 2);
      if (half < T) o.warn('V: region too narrow, notch closes');
      const notch = P([[xc - half, y0 - 2], [xc + half, y0 - 2], [xc, ay]]);
      return pc.difference(MP(region), notch);
    },
    B(region, o) {
      const [x0, y0, x1, y1] = bbox(region), T = o.T, H = y1 - y0;
      const yw = y0 + H * (o.waist ?? 0.47);       // upper bowl slightly smaller
      const ro = 1.1 * T, rn = 1.25 * T;
      if (H < 4.5 * T) o.warn(`B: region ${H.toFixed(0)} tall is under 4.5 strokes; counters close up`);
      const mask = pc.union(roundedRect(x0 - 2, y0, x1, yw + T / 2, { tr: ro, br: rn }),
        roundedRect(x0 - 2, yw - T / 2, x1, y1, { tr: rn, br: ro }));
      const body = pc.intersection(MP(region), mask);
      const er = inset(region, T);
      const cu = pc.intersection(er, roundedRect(x0 - 2, y0 - 2, x1 - T, yw - T / 2, { tr: Math.max(ro - T, 3), br: Math.max(rn - T, 3) }));
      const cl = pc.intersection(er, roundedRect(x0 - 2, yw + T / 2, x1 - T, y1 - T, { tr: Math.max(rn - T, 3), br: Math.max(ro - T, 3) }));
      return pc.difference(body, cu, cl);
    },
    R(region, o) {
      const [x0, y0, x1, y1] = bbox(region), T = o.T, H = y1 - y0;
      const bb = y0 + H * (o.waist ?? 0.7);       // bottom of the bowl
      if (H < 4 * T) o.warn(`R: region ${H.toFixed(0)} tall is under 4 strokes`);
      const { shifted, Tx } = leftStemShift(region, T);
      const stem = pc.difference(MP(region), shifted);
      const ro = 1.1 * T, rb = 0.9 * T;
      const bowl = pc.intersection(MP(region), roundedRect(x0 - 2, y0, x1, bb, { tr: ro, br: rb }));
      const cnt = pc.intersection(inset(region, T), roundedRect(x0 - 2, y0 - 2, x1 - T, bb - T, { tr: Math.max(ro - T, 3), br: Math.max(rb - T, 3) }));
      const xs = xRange(region, bb)[0] + Tx, dy = y1 - bb;
      let xa = x1 - dy, lw = T;
      for (let i = 0; i < 40; i++) { lw = (T * Math.hypot(x1 - xa, dy)) / dy; xa = xs + lw; }
      if (xa >= x1 - 2) o.warn('R: region too narrow for the leg');
      const sl = (x1 - xa) / dy;
      const leg = pc.intersection(MP(region), P([[xa - lw - sl, bb - 1], [xa - sl, bb - 1], [x1 + 2 * sl, y1 + 2], [x1 - lw + 2 * sl, y1 + 2]]));
      return pc.union(stem, pc.difference(bowl, cnt), leg);
    },
  };

  // ---------- pairing: which letter should hold which ----------
  const HOST = { // counter type and how much room it offers (0..1)
    A: ['tri', 0.4], B: ['rect', 0.3], C: ['round', 0.8], D: ['round', 1], E: ['rect', 0.8], F: ['rect', 0.6], G: ['round', 0.6],
    H: ['rect', 0.6], I: ['none', 0], J: ['rect', 0.3], K: ['tri', 0.4], L: ['rect', 0.9], M: ['vnotch', 0.8], N: ['tri', 0.6],
    O: ['round', 0.9], P: ['rect', 0.5], Q: ['round', 0.8], R: ['rect', 0.4], S: ['none', 0.2], T: ['rect', 0.4], U: ['rect', 0.8],
    V: ['vtri', 0.6], W: ['vtri', 0.5], X: ['tri', 0.3], Y: ['tri', 0.4], Z: ['tri', 0.7],
  };
  const GUEST = { // how well a letter survives being squeezed into a foreign shape (0..1) and its build class
    E: [1, 'straight'], F: [1, 'straight'], L: [0.95, 'straight'], I: [0.9, 'straight'], T: [0.85, 'straight'], H: [0.85, 'straight'],
    B: [0.8, 'bowl'], R: [0.8, 'bowl'], P: [0.85, 'bowl'], D: [0.7, 'bowl'], U: [0.7, 'round'], N: [0.6, 'diag'], K: [0.6, 'diag'],
    C: [0.6, 'round'], O: [0.55, 'round'], M: [0.5, 'diag'], A: [0.45, 'diag'], V: [0.5, 'diag'], Y: [0.5, 'diag'], Z: [0.5, 'diag'],
    G: [0.45, 'round'], J: [0.6, 'round'], S: [0.4, 'round'], X: [0.4, 'diag'], W: [0.3, 'diag'], Q: [0.35, 'round'],
  };
  const COMPAT = {
    round: { straight: 1, bowl: 0.8, round: 0.9, diag: 0.7 },   // a V or W guest is only a notch, so round hosts suit it
    rect: { straight: 1, bowl: 1, round: 0.7, diag: 0.7 },
    tri: { straight: 0.85, bowl: 0.5, round: 0.3, diag: 0.8 },
    vtri: { straight: 0.4, bowl: 0.3, round: 0.4, diag: 0.8 },   // apex at the bottom: a guest's lower arm vanishes into the point
    vnotch: { straight: 0.8, bowl: 0.9, round: 0.6, diag: 0.6 },
    none: { straight: 0, bowl: 0, round: 0, diag: 0 },
  };
  const SOLO = 0.12;   // low on purpose: the brief is to fuse as much as possible
  function pairScore(h, g) {
    const H = HOST[h], G = GUEST[g];
    if (!H || !G) return 0;
    return H[1] * G[0] * COMPAT[H[0]][G[1]];
  }
  // dynamic programming over the word: each position is a solo letter or host+guest (reading order kept)
  function plan(word) {
    const w = word.toUpperCase().replace(/[^A-Z]/g, '');
    const best = [0], how = [null];
    for (let i = 1; i <= w.length; i++) {
      best[i] = best[i - 1] + SOLO; how[i] = 1;
      if (i >= 2) { const s = best[i - 2] + pairScore(w[i - 2], w[i - 1]); if (s > best[i]) { best[i] = s; how[i] = 2; } }
    }
    const units = [];
    for (let i = w.length; i > 0;) {
      if (how[i] === 2) { units.unshift([w[i - 2], w[i - 1]]); i -= 2; } else { units.unshift([w[i - 1], null]); i -= 1; }
    }
    const missing = new Set();
    const scored = units.map(([h, g]) => {
      if (!OUTER[h]) missing.add(`outer ${h}`);
      if (g && !INNER[g]) missing.add(`inner ${g}`);
      return { host: h, guest: g, score: g ? +pairScore(h, g).toFixed(2) : SOLO };
    });
    return { units: scored, missing: [...missing], total: +best[w.length].toFixed(2) };
  }

  // ---------- layout ----------
  const DEFAULTS = { capH: 360, gap: 12, S: 44, T: 36, aspect: null, rows: 1, rotate: false, outer: {}, inner: {} };
  function pick(map, idx, letter) { return Object.assign({}, map[letter] || {}, map[String(idx)] || {}); }

  function profiles(polys, y0, y1, step) {
    const n = Math.floor((y1 - y0) / step) + 1, L = new Array(n).fill(Infinity), R = new Array(n).fill(-Infinity);
    for (const g of polys) {
      if (!g) continue;
      for (const poly of MP(g)) for (const ring of poly) for (let i = 0; i < ring.length - 1; i++) {
        const [ax, ay] = ring[i], [bx, by] = ring[i + 1];
        if (ay === by) {
          const k = Math.round((ay - y0) / step);
          if (k >= 0 && k < n && Math.abs(y0 + k * step - ay) < 1e-6) {
            L[k] = Math.min(L[k], ax, bx); R[k] = Math.max(R[k], ax, bx);
          }
          continue;
        }
        const lo = Math.min(ay, by), hi = Math.max(ay, by);
        for (let k = Math.max(0, Math.ceil((lo - y0) / step)); k < n && y0 + k * step <= hi; k++) {
          const y = y0 + k * step, x = ax + ((y - ay) / (by - ay)) * (bx - ax);
          if (x < L[k]) L[k] = x; if (x > R[k]) R[k] = x;
        }
      }
    }
    return { L, R, y0, step };
  }

  function layout(spec) {
    const s = Object.assign({}, DEFAULTS, spec);
    let units = s.units;
    if (!units) units = plan(s.text || '').units.map((u) => [u.host, u.guest]);
    units = units.map((u) => (Array.isArray(u) ? { host: u[0], guest: u[1] || null } : u));
    const warnings = [];
    for (const u of units) {
      if (!OUTER[u.host]) throw new Error(`No outer module for "${u.host}". Add one to OUTER in nest.js.`);
      if (u.guest && !INNER[u.guest]) throw new Error(`No inner recipe for "${u.guest}". Add one to INNER in nest.js.`);
    }
    // rows: number -> split evenly, or explicit arrays of unit indices
    let rows = s.rows;
    if (typeof rows === 'number') {
      const n = Math.max(1, Math.min(rows, units.length)), per = Math.ceil(units.length / n);
      rows = []; for (let i = 0; i < units.length; i += per) rows.push(units.slice(i, i + per).map((_, j) => i + j));
    }
    const g = s.gap, capH = s.capH, nR = rows.length;
    const boxH = nR * capH + (nR - 1) * g;
    const step = 2;

    const params = units.map((u, i) => {
      const po = pick(s.outer, i, u.host), pi = u.guest ? pick(s.inner, i, u.guest) : {};
      return { po, pi, S: po.S ?? s.S, T: pi.T ?? s.T, wf: po.wf ?? 1, hf: po.hf ?? 1 };
    });
    const buildOuter = (i, k, rowY) => {
      const u = units[i], p = params[i], h = capH * p.hf;
      const w = OUTER[u.host].w0 * (capH / 360) * k * p.wf;
      const po = Object.assign({}, p.po);
      // one E per word: a solo E takes the raised waist of an E that hosts
      if (u.host === 'E' && !u.guest && po.waist == null && units.some((v) => v.host === 'E' && v.guest)) po.waist = 0.244;
      const geo = OUTER[u.host].build(Object.assign(po, { w, h, S: p.S, g, hosting: !!u.guest }));
      return { w, h, dy: rowY + capH - h, geo };
    };
    // place one row for a given width factor k; returns positions and the row width
    function placeRow(row, k, rowY) {
      const items = row.map((i) => {
        const b = buildOuter(i, k, rowY);
        const local = [b.geo.shape, units[i].guest ? b.geo.region : null].map((x) => (x ? translate(x, 0, b.dy) : null));
        return Object.assign(b, { i, prof: profiles(local, rowY, rowY + capH, step) });
      });
      let xPrev = null, right = 0;
      items.forEach((it, j) => {
        if (j === 0) { it.x = 0; }
        else {
          const A = items[j - 1], B = it, n = A.prof.L.length, reach = Math.ceil(g / step);
          let off = -Infinity;
          for (let a = 0; a < n; a++) {
            if (!isFinite(A.prof.R[a])) continue;
            for (let b = Math.max(0, a - reach); b <= Math.min(n - 1, a + reach); b++) {
              if (!isFinite(B.prof.L[b])) continue;
              const dy = (a - b) * step;
              off = Math.max(off, A.x + A.prof.R[a] - B.prof.L[b] + Math.sqrt(Math.max(0, g * g - dy * dy)));
            }
          }
          it.x = isFinite(off) ? off : A.x + A.w + g;
        }
        right = Math.max(right, it.x + it.w);
        xPrev = it.x;
      });
      return { items, width: right };
    }
    const rowY = (r) => r * (capH + g);
    const natural = rows.map((row, r) => placeRow(row, 1, rowY(r)).width);
    const aspect = s.aspect ? (s.rotate ? 1 / s.aspect : s.aspect) : null;
    const boxW = aspect ? aspect * boxH : Math.max(...natural);

    const placed = [];
    rows.forEach((row, r) => {
      let lo = 0.02, hi = 12;
      if (placeRow(row, lo, rowY(r)).width > boxW) warnings.push(`Row ${r + 1} cannot get as narrow as ${boxW.toFixed(0)}; use more rows or thinner strokes`);
      for (let it = 0; it < 40; it++) { const mid = (lo + hi) / 2; if (placeRow(row, mid, rowY(r)).width < boxW) lo = mid; else hi = mid; }
      const res = placeRow(row, (lo + hi) / 2, rowY(r));
      res.items.forEach((it) => placed.push(it));
    });

    const out = placed.map((it) => {
      const u = units[it.i], p = params[it.i];
      const outer = translate(it.geo.shape, it.x, it.dy);
      let inner = null;
      if (u.guest) {
        if (!it.geo.region) warnings.push(`${u.host}: no room left for ${u.guest}`);
        else {
          const warn = (m) => warnings.push(`${u.host}${u.guest}: ${m}`);
          inner = translate(INNER[u.guest](it.geo.region, Object.assign({}, p.pi, { T: p.T, warn })), it.x, it.dy);
          if (!inner.length || area(inner) < 1) { warnings.push(`${u.host}${u.guest}: guest vanished`); inner = null; }
        }
      }
      // sanity: the stroke must leave a counter
      const [bx0, , bx1] = bbox(it.geo.shape);
      if ((bx1 - bx0) < 2 * p.S + 2 * g) warnings.push(`${u.host}: stroke ${p.S} is too thick for width ${(bx1 - bx0).toFixed(0)}`);
      return { host: u.host, guest: u.guest, x: it.x, y: it.dy, w: it.w, h: it.h, S: p.S, T: p.T, outer, inner };
    });

    let W = boxW, Hh = boxH, result = out;
    if (s.rotate) { // 90° clockwise, as in a vertical lockup read top to bottom
      const rot = (g2) => g2 && mapPts(g2, ([x, y]) => [boxH - y, x]);
      result = out.map((u) => Object.assign({}, u, { outer: rot(u.outer), inner: rot(u.inner) }));
      W = boxH; Hh = boxW;
    }
    return { width: W, height: Hh, units: result, warnings, spec: s };
  }

  // ---------- output ----------
  const fmt = (v) => (Math.round(v * 100) / 100).toString();
  function pathD(g) {
    let d = '';
    for (const poly of MP(g)) for (const ring of poly) {
      d += 'M' + ring.slice(0, -1).map(([x, y]) => fmt(x) + ' ' + fmt(y)).join('L') + 'Z';
    }
    return d;
  }
  function toSVG(res, opt = {}) {
    const c = Object.assign({ bg: null, outer: '#1E3A32', inner: '#A9823A', pad: 0 }, opt);
    const p = c.pad, W = res.width + 2 * p, H = res.height + 2 * p;
    const outer = res.units.map((u) => pathD(u.outer)).join('');
    const inner = res.units.filter((u) => u.inner).map((u) => pathD(u.inner)).join('');
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${fmt(-p)} ${fmt(-p)} ${fmt(W)} ${fmt(H)}" width="${fmt(W)}" height="${fmt(H)}">` +
      (c.bg ? `<rect x="${fmt(-p)}" y="${fmt(-p)}" width="${fmt(W)}" height="${fmt(H)}" fill="${c.bg}"/>` : '') +
      `<path fill="${c.outer}" fill-rule="evenodd" d="${outer}"/>` +
      (inner ? `<path fill="${c.inner}" fill-rule="evenodd" d="${inner}"/>` : '') + `</svg>`;
  }

  return { layout, toSVG, pathD, plan, pairScore, OUTER, INNER, HOST, GUEST, COMPAT, DEFAULTS,
    geo: { P, rect, roundedRect, arc, translate, bbox, area, clipHalf, xRange, erode, inset, leftStemShift, rightStemShift, MP }, pc };
});
