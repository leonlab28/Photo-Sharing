"""DEZEMBER v2: fused inlay wordmark. Inner letters take the exact shape of the host counter.
One gap value G separates everything (inner/outer and letter/letter).
usage: python dez2.py OUT.json [G]"""
import math, re, json, sys
from shapely.geometry import Polygon, box
from shapely.ops import unary_union

G = float(sys.argv[2]) if len(sys.argv) > 2 else 12
H, S, T = 360, 44, 36          # cap, outer stroke, inner stroke
DIAG = 42                      # Z diagonal perpendicular thickness

def f(v): return ("%.2f" % v).rstrip("0").rstrip(".")
def P(*pts): return " ".join(f"{f(x)} {f(y)}" for x, y in pts)

# ---------- path tools ----------
def poly_path(pts):
    return "M " + " L ".join(f"{f(x)} {f(y)}" for x, y in pts) + " Z"

def fillet_path(pts, radii):
    """polygon with circular fillets; radii[i] for vertex i (0 = sharp)"""
    n, out = len(pts), []
    for i in range(n):
        p0, p, p1 = pts[i-1], pts[i], pts[(i+1) % n]
        r = radii[i]
        if not r:
            out.append(("L", p)); continue
        u1 = (p[0]-p0[0], p[1]-p0[1]); l1 = math.hypot(*u1); u1 = (u1[0]/l1, u1[1]/l1)
        u2 = (p1[0]-p[0], p1[1]-p[1]); l2 = math.hypot(*u2); u2 = (u2[0]/l2, u2[1]/l2)
        cosang = -(u1[0]*u2[0] + u1[1]*u2[1]); th = math.acos(max(-1, min(1, cosang)))
        d = r / math.tan(th/2)
        d = min(d, l1*0.5, l2*0.5); r = d*math.tan(th/2)
        t1 = (p[0]-u1[0]*d, p[1]-u1[1]*d); t2 = (p[0]+u2[0]*d, p[1]+u2[1]*d)
        sweep = 1 if (u1[0]*u2[1] - u1[1]*u2[0]) > 0 else 0
        out.append(("L", t1)); out.append(("A", r, sweep, t2))
    s = ""
    for k, seg in enumerate(out):
        if seg[0] == "L": s += ("M " if k == 0 else " L ") + P(seg[1])
        else: s += f" A {f(seg[1])} {f(seg[1])} 0 0 {seg[2]} " + P(seg[3])
    return s + " Z"

def tokens(d): return re.findall(r"[MLHVAZ]|-?\d+(?:\.\d+)?", d)

def arc_pts(rx, ry, la, sw, x1, y1, x2, y2, n=48):
    dx, dy = (x1-x2)/2, (y1-y2)/2
    lam = (dx/rx)**2 + (dy/ry)**2
    if lam > 1: rx, ry = rx*math.sqrt(lam), ry*math.sqrt(lam)
    num = rx*rx*ry*ry - rx*rx*dy*dy - ry*ry*dx*dx; den = rx*rx*dy*dy + ry*ry*dx*dx
    co = math.sqrt(max(0, num/den)) * (-1 if la == sw else 1)
    cxp, cyp = co*rx*dy/ry, -co*ry*dx/rx
    cx, cy = cxp + (x1+x2)/2, cyp + (y1+y2)/2
    a1 = math.atan2((dy-cyp)/ry, (dx-cxp)/rx); a2 = math.atan2((-dy-cyp)/ry, (-dx-cxp)/rx)
    da = a2 - a1
    if sw and da < 0: da += 2*math.pi
    if not sw and da > 0: da -= 2*math.pi
    return [(cx + rx*math.cos(a1+da*k/n), cy + ry*math.sin(a1+da*k/n)) for k in range(1, n+1)]

def shape(d):
    t, i, rings, cur, x, y = tokens(d), 0, [], None, 0, 0
    while i < len(t):
        c = t[i]; i += 1
        if c == "M": x, y = float(t[i]), float(t[i+1]); i += 2; cur = [(x, y)]; rings.append(cur)
        elif c == "L": x, y = float(t[i]), float(t[i+1]); i += 2; cur.append((x, y))
        elif c == "H": x = float(t[i]); i += 1; cur.append((x, y))
        elif c == "V": y = float(t[i]); i += 1; cur.append((x, y))
        elif c == "A":
            rx, ry, _, la, sw, nx, ny = map(float, t[i:i+7]); i += 7
            cur += arc_pts(rx, ry, int(la), int(sw), x, y, nx, ny); x, y = nx, ny
    polys = [Polygon(r).buffer(0) for r in rings]
    # even-odd: XOR all rings
    out = polys[0]
    for p in polys[1:]: out = out.symmetric_difference(p)
    return out

def move(d, ox):
    out, t, i = [], tokens(d), 0
    while i < len(t):
        c = t[i]; i += 1; out.append(c)
        if c in "ML": out += [f(float(t[i])+ox), f(float(t[i+1]))]; i += 2
        elif c == "H": out.append(f(float(t[i])+ox)); i += 1
        elif c == "V": out.append(t[i]); i += 1
        elif c == "A": out += t[i:i+5] + [f(float(t[i+5])+ox), t[i+6]]; i += 7
    return " ".join(out)

def ring_path(geom):
    g = geom.simplify(0.01)
    return poly_path(list(g.exterior.coords)[:-1])

# ---------- D with E ----------
D_W, D_A = 320, 170                    # width, straight length
rxo, rxi = D_W - D_A, D_W - D_A - S
D = (f"M 0 0 H {D_A} A {rxo} 180 0 0 1 {D_A} 360 H 0 Z "
     f"M {S} {S} H {D_A} A {rxi} {180-S} 0 0 1 {D_A} {360-S} H {S} Z")
top, bot = S + G, H - S - G            # inner band shared by every inner letter
rxe, rye = rxi - G, 180 - S - G
band_h = bot - top
slot = (band_h - 3*T) / 2
arms = [(top, top+T), (top+T+slot, top+2*T+slot), (bot-T, bot)]   # y-bands of inner arms
def ex(y): return D_A + rxe*math.sqrt(max(0, 1 - ((y-180)/rye)**2))
x0 = S + G; xs = x0 + T
segs = [f"M {f(x0)} {f(top)} H {D_A}"]
(a1, a2), (b1, b2), (c1, c2) = arms
segs.append(f"A {f(rxe)} {f(rye)} 0 0 1 {f(ex(a2))} {f(a2)} H {f(xs)} V {f(b1)} H {f(ex(b1))}")
segs.append(f"A {f(rxe)} {f(rye)} 0 0 1 {f(ex(b2))} {f(b2)} H {f(xs)} V {f(c1)} H {f(ex(c1))}")
segs.append(f"A {f(rxe)} {f(rye)} 0 0 1 {D_A} {f(bot)} H {f(x0)} Z")
D_in = " ".join(segs)

# ---------- Z with E ----------
Z_W = 300
def z_d(W):
    d = 60.0
    for _ in range(60): d = DIAG*math.hypot(W-d, H-2*S)/(H-2*S)
    return d
zd = z_d(Z_W)
Zp = [(0, 0), (Z_W, 0), (Z_W, S), (zd, H-S), (Z_W, H-S), (Z_W, H), (0, H), (0, H-S), (Z_W-zd, S), (0, S)]
Z = poly_path(Zp)
Zs = Polygon(Zp)
region = box(0, top, Z_W, bot).difference(Zs.buffer(G, join_style=2))
region = max(getattr(region, "geoms", [region]), key=lambda g: g.area)
# stem follows the diagonal: everything right of (diagonal + G + T-perp) inside a slot band is cut
L = math.hypot(Z_W-zd, H-2*S)
stem_edge = Zs.buffer(G + T, join_style=2)
zE = region
for (y1, y2) in [(a2, b1), (b2, c1)]:
    zE = zE.difference(box(0, y1, Z_W+1, y2).difference(stem_edge))
zE = max(getattr(zE, "geoms", [zE]), key=lambda g: g.area)
Z_in = ring_path(zE)

# ---------- M with B ----------
M_W, M_VB = 284, 120                    # width, depth of the V's lower vertex
half = (M_W - 2*S)/2; c = M_W/2
vt = 80.0
for _ in range(80): vt = M_VB - S*math.sqrt(1 + (vt/half)**2)
m = vt/half; yl = M_VB - m*half
Mp = [(0, 0), (S, 0), (c, vt), (M_W-S, 0), (M_W, 0), (M_W, H), (M_W-S, H), (M_W-S, yl), (c, M_VB), (S, yl), (S, H), (0, H)]
M = poly_path(Mp)
k = math.sqrt(1 + m*m)
xl, xr = S + G, M_W - S - G
yTL = yl + m*G + G*k                    # B top at the legs (offset of the V edge)
yV = M_VB + G*k                          # B top at the centre
w_top = math.ceil(yV + T*k + 34); w_bot = w_top + T   # upper counter keeps >= 34 at its V point
notch = 12; wm = (w_top + w_bot)/2
RO, RI = 40, 8
Bo = [(xl, yTL), (c, yV), (xr, yTL), (xr, wm-notch), (xr-notch, wm), (xr, wm+notch), (xr, H), (xl, H)]
B_out = fillet_path(Bo, [0, 0, RO, 0, 0, 0, RO, 0])
yA = yTL + m*T + T*k
Bu = [(xl+T, yA), (c, yV + T*k), (xr-T, yA), (xr-T, w_top), (xl+T, w_top)]
Bl = [(xl+T, w_bot), (xr-T, w_bot), (xr-T, H-T), (xl+T, H-T)]
B_in = B_out + " " + fillet_path(Bu, [0, 0, RI, RI, 0]) + " " + fillet_path(Bl, [0, RI, RI, 0])

# ---------- E with R ----------
E_W = 220
E_m1 = 88; E_m2 = E_m1 + S              # raised waist
E = poly_path([(0, 0), (E_W, 0), (E_W, S), (S, S), (S, E_m1), (E_W, E_m1), (E_W, E_m2), (S, E_m2),
               (S, H-S), (E_W, H-S), (E_W, H), (0, H)])
rt, rb = E_m2 + G, bot                  # R band
rx0, rx1 = S + G, E_W
r_w1 = rt + T + 40                      # bowl counter 40 tall
r_w2 = r_w1 + T                         # waist bottom
xa = rx1 - 64
for _ in range(60):   # leg's inner edge lands exactly on the stem: no stub
    leg_w = T*math.hypot(rx1-xa, rb-r_w2)/(rb-r_w2); xa = rx0 + T + leg_w
Ro = [(rx0, rt), (rx1, rt), (rx1, r_w2), (xa, r_w2), (rx1, rb), (rx1-leg_w, rb), (xa-leg_w, r_w2),
      (rx0+T, r_w2), (rx0+T, rb), (rx0, rb)]
R_out = fillet_path(Ro, [0, RO, RO*0.8, 0, 0, 0, 0, 0, 0, 0])
Rc = [(rx0+T, rt+T), (rx1-T, rt+T), (rx1-T, r_w1), (rx0+T, r_w1)]
R_in = R_out + " " + fillet_path(Rc, [0, RI, RI, 0])

glyphs = [("D", D, D_in, D_W), ("Z", Z, Z_in, Z_W), ("M", M, B_in, M_W), ("E", E, R_in, E_W)]

# ---------- kerning: every letter gap == G ----------
placed = []
for i, (n, o, inn, w) in enumerate(glyphs):
    if i == 0: ox = 0
    else:
        prev = unary_union([shape(placed[-1][1]), shape(placed[-1][2])])
        lo, hi = placed[-1][4] - 220, placed[-1][4] + 60
        for _ in range(50):
            ox = (lo+hi)/2
            cur = unary_union([shape(move(o, ox)), shape(move(inn, ox))])
            if prev.distance(cur) < G: lo = ox
            else: hi = ox
        ox = math.ceil(hi*2)/2
    placed.append((n, move(o, ox), move(inn, ox), ox, ox + w))

rep = {"G": G, "W": placed[-1][4], "slot": slot}
for n, o, inn, ox, right in placed:
    rep[n] = {"x": ox, "inner_gap": round(shape(o).distance(shape(inn)), 2)}
for a, b in zip(placed, placed[1:]):
    rep[a[0]+b[0]] = round(unary_union([shape(a[1]), shape(a[2])]).distance(unary_union([shape(b[1]), shape(b[2])])), 2)
print(json.dumps(rep), file=sys.stderr)
json.dump({"outer": " ".join(p[1] for p in placed), "inner": " ".join(p[2] for p in placed),
           "w": placed[-1][4], "h": H, "G": G}, open(sys.argv[1], "w"), indent=1)
