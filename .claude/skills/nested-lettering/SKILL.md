---
name: nested-lettering
description: Build "inlay" wordmarks in which one letter sits inside the counter of another and takes that counter's exact shape (e.g. DEZEMBER as D·E Z·E M·B E·R). Use when the user wants nested, interlocking or fused lettering, sends a sketch of letters drawn inside letters, asks to adapt the Dezember wordmark to another word or format, or wants to change stroke weights, letter widths, gap or box ratio of such a wordmark.
---

# Nested lettering

A word becomes a row of **units**. Each unit is a **host** letter and an optional **guest**: the letter that follows the host in reading order. The guest is carved out of the host's counter. It fills that counter exactly, inset by one gap, with slots cut in to make it legible.

The engine in `engine/` builds this exactly and fast. Use it, do not hand-compute geometry.

## The design rules (what the user signed off on)

1. **One gap everywhere.** The same gap `G` separates guest from host and letter from letter. Default 12 at cap height 360 (3.3%). The gap is the only separation, so it sets the minimum size.
2. **The guest takes the host's shape.** Arms end on the host's curve (D·E), stems run along the host's diagonal (Z·E), tops follow the host's V (M·B). Guests end flush with open sides of the host, so neighbours meet along straight lines.
3. **Two stroke weights.** Outer stroke `S` (default 44) and inner stroke `T` (default 36). The guest is relatively heavier so it holds up small. Z's diagonal is about 95% of `S` because diagonals look heavier.
4. **Strokes are absolute.** Changing a letter's width or height, or the box ratio, never changes a stroke. A thicker host grows inwards: its outer size stays and its guest gets squeezed without thinning.
5. **Reading order is sacred.** A host only holds the letter right after it.
6. **One shape per letter per word.** If one E hosts (raised waist), a solo E in the same word takes the same waist. The engine does this automatically.
7. **Colour separates the two layers**: outer letters in one colour, guests in an accent. In one colour it must still read, which the gap guarantees down to its minimum size.

Approved reference: `reference/dezember-v2-approved.svg` (exact arcs, from `reference/dezember-v2-geometry.py`) and `reference/dezember-v2.spec.json` (the same setting for the engine).

## Workflow

1. **Pair the letters.** Run `node engine/cli.js plan WORD`. It scores every host/guest pair and picks the best split by dynamic programming (see "Choosing pairs"). Check the result against the user's sketch: the sketch wins.
2. **Check the modules.** `plan` lists letters that have no module yet (`missing`). Add them (see "Adding letters") before rendering.
3. **Render.** Write a spec (below) and run `node engine/cli.js render spec.json out.svg`. The JSON report gives the box, every unit's width and position, and **warnings**. Treat every warning as a design problem to solve, not noise.
4. **Look at it once.** Render to PNG with Playwright and look at the letters, especially guests in triangles and small counters.
5. **Tune with factors, not by hand**: per-unit `S`, `wf`, `hf`, guest `T`, global `gap`, `aspect`, `rows`.
6. **Hand over**: SVG (with and without ground), the spec, and the Inlay Lettering tool link so the user can keep adjusting. The tool page is `tool/inlay-lettering.html`, built by `node tool/build.cjs`.

## The spec

```json
{
  "text": "DEZEMBER",                       // or "units": [["D","E"],["Z","E"],["M","B"],["E","R"]]
  "capH": 360, "gap": 12, "S": 44, "T": 36,
  "aspect": 0.75,                          // final box width/height; null = natural width
  "rows": 2,                               // a number, or [[0,1],[2,3]] as unit indices per row
  "rotate": false,                         // true = turned 90° clockwise, read top to bottom
  "outer": { "D": {"S": 60}, "1": {"wf": 0.9, "hf": 1} },   // by host letter or unit index (index wins)
  "inner": { "E": {"T": 40} },                              // by guest letter or unit index
  "colors": { "bg": "#F3EFE6", "outer": "#1E3A32", "inner": "#A9823A" }
}
```

Factor meanings:
- `outer.<k>.S`: that host's stroke. Its outer box stays, the counter shrinks, the guest is squeezed.
- `outer.<k>.wf` / `hf`: width / height factor for that unit (1 = default). Guests follow; strokes do not change. Heights align to the baseline.
- `inner.<k>.T`: that guest's stroke. Outer letters are untouched.
- Shape levers per host: `D.straight` (share of straight side, 0.53), `M.vdepth` (V depth as share of height, 1/3), `E.waist` (top of middle arm as share of height when hosting, 0.244), `Z.diag` (diagonal thickness). Per guest: `E.mid`, `B.waist` (0.47), `R.waist` (0.7).
- `aspect` + `rows`: the box is `rows × capH + (rows−1) × gap` tall. Every row is stretched or squeezed to the box width by scaling letter widths only.

## Format and feasibility

Strokes are fixed, so a box ratio has a floor. When a row gets too narrow the engine warns "stroke is too thick for width" or slots shrink to nothing. Then change the layout, not the strokes:
- Wide formats (≥ 2.5:1): one row.
- Near square or portrait (3:4, 4:5, 1:1): two rows (DZ / ME as DE·ZE over MB·ER).
- Tall banners (≤ 1:2): `rotate: true` on one row (the original sketch), or one unit per row.
- Smallest safe size: the gap should stay at least 1.5 px on screen and 0.25 mm in print. Wordmark width ≥ 1.5 × width ÷ gap px. For DEZEMBER at gap 12 that is about 140 px or 23 mm.

## Choosing pairs

Every letter has a **host profile** (type and room of its best counter) and a **guest profile** (how well it survives being squeezed, and its build class). The full table is in `engine/nest.js` (`HOST`, `GUEST`, `COMPAT`); `reference/letters.md` explains it.

- score(host, guest) = room × squeezability × compatibility(counter type, guest class)
- A solo letter scores 0.12 (low on purpose: the brief is to fuse as much as possible).
- Best hosts: D, O, Q, L, U, E (lower counter), M (under the V), C, Z (lower triangle).
- Best guests: straight letters E, F, L, I, T, H; then the bowl letters B, R, P. Round guests (O, C, S, G) need round or wide counters. Diagonal guests (A, V, W, X, Z) only work in triangles.
- Triangles with the point at the bottom (V, W) are poor hosts: the guest's lower arm vanishes. V and W are good guests in round counters, because they are only a notch (NOVEMBER: O·V, not V·E).
- A host's empty counter is a hole in a fused word: prefer pairings that fill the big counters (O, D) over ones that fill small triangles.
- Never host with I, S or J. A word with an odd count, or a letter no host can hold, keeps solo letters, which is fine.
- Weigh the sketch, the meaning and the rhythm over the score: prefer pairings that give units of similar width.

## Adding letters

Outer letter: add to `OUTER` in `engine/nest.js`:
```js
X: { w0: 300, build(o) {             // o = {w, h, S, g, hosting, ...overrides}
  return { shape,                     // Polygon/MultiPolygon, y down, box 0..w × 0..h
           region };                  // the host counter inset by g; flush (not inset) on open sides
}}
```
Build the region analytically: offset each bounding stroke edge by `g`, keep open sides at the letter's edge. Curves are polylines from `arc()`.

Guest letter: add to `INNER`:
```js
X(region, o) { /* o.T, o.warn(msg) */ return MultiPolygon; }
```
Carve, never draw from scratch: start from `region` and subtract slots (`band()` ∩ `leftStemShift(region, T).shifted` gives "everything at least one stroke right of the left edge"). Use `inset(region, T)` for counters, `roundedRect()` masks for bowls, and `warn()` when the region is too small for the letter to read. Then add the letter's row to `HOST` / `GUEST` if missing, rebuild the tool, and render a test word.

## Program vs. by hand

Use the engine for everything it covers: geometry is exact, reproducible and takes milliseconds. Claude's job is the parts a program can't judge: pairing against the sketch, writing new letter modules, art direction (colour, gap, proportions) and reading the warnings. Engine output is polylines with fine curve steps. For a final logo with clean arcs for Illustrator, rebuild the approved setting analytically the way `reference/dezember-v2-geometry.py` does.
