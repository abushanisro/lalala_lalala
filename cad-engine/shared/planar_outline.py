"""
Closed 2D outlines: the pure geometry several domains measure a part's section or silhouette with.

An outline is a closed list of (x, y) points in mm. Bar and tube classifies a stock section from these (bar_tube/section.py), roll forming
measures a profile's section, and machining finds the round, rectangular or hexagonal stock around a part seen along its axis
(machining/stock_envelope.py). Nothing here knows what the outline is of.
"""
from __future__ import annotations

import math
import random
from typing import Dict, List, Optional, Sequence, Tuple

Pt = Tuple[float, float]

HEX_FILL = (0.72, 0.78)       # a regular hexagon fills 3/4 of its bounding rectangle
SIMPLIFY_FRACTION = 0.03      # outline simplification, a share of the section's size (fillets and corner radii are smaller)


def area(poly: Sequence[Pt]) -> float:
    """Signed area (positive when counter-clockwise)."""
    return 0.5 * sum(poly[i][0] * poly[(i + 1) % len(poly)][1] - poly[(i + 1) % len(poly)][0] * poly[i][1] for i in range(len(poly)))


def perimeter(poly: Sequence[Pt]) -> float:
    return sum(math.dist(poly[i], poly[(i + 1) % len(poly)]) for i in range(len(poly)))


def centroid(poly: Sequence[Pt]) -> Pt:
    a = area(poly)
    if abs(a) < 1e-12:
        return (sum(p[0] for p in poly) / len(poly), sum(p[1] for p in poly) / len(poly))
    cx = cy = 0.0
    for i in range(len(poly)):
        (x0, y0), (x1, y1) = poly[i], poly[(i + 1) % len(poly)]
        c = x0 * y1 - x1 * y0
        cx += (x0 + x1) * c
        cy += (y0 + y1) * c
    return (cx / (6.0 * a), cy / (6.0 * a))


def hull(points: Sequence[Pt]) -> List[Pt]:
    """Convex hull, counter-clockwise (Andrew's monotone chain)."""
    pts = sorted(set((round(p[0], 6), round(p[1], 6)) for p in points))
    if len(pts) < 3:
        return list(pts)

    def turn(o: Pt, a: Pt, b: Pt) -> float:
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
    lower: List[Pt] = []
    for p in pts:
        while len(lower) >= 2 and turn(lower[-2], lower[-1], p) <= 0:
            lower.pop()
        lower.append(p)
    upper: List[Pt] = []
    for p in reversed(pts):
        while len(upper) >= 2 and turn(upper[-2], upper[-1], p) <= 0:
            upper.pop()
        upper.append(p)
    return lower[:-1] + upper[:-1]


def min_area_rect(points: Sequence[Pt]) -> Tuple[float, float, float]:
    """The smallest rectangle around the points: (long side, short side, angle of the long side in degrees)."""
    h = hull(points)
    if len(h) < 3:
        return (0.0, 0.0, 0.0)
    best: Optional[Tuple[float, float, float, float]] = None
    for i in range(len(h)):
        (x0, y0), (x1, y1) = h[i], h[(i + 1) % len(h)]
        ang = math.atan2(y1 - y0, x1 - x0)
        c, s = math.cos(ang), math.sin(ang)
        us = [p[0] * c + p[1] * s for p in h]
        vs = [-p[0] * s + p[1] * c for p in h]
        w, ht = max(us) - min(us), max(vs) - min(vs)
        if best is None or w * ht < best[0]:
            best = (w * ht, w, ht, ang)
    _, w, ht, ang = best  # type: ignore[misc]
    return (max(w, ht), min(w, ht), math.degrees(ang if w >= ht else ang + math.pi / 2) % 180.0)


def enclosing_circle_diameter(points: Sequence[Pt]) -> float:
    """The smallest circle around the points (the extrusion press's circumscribing circle), over the hull's points."""
    h = hull(points)
    if not h:
        return 0.0
    best = 0.0
    # The smallest enclosing circle passes through two or three hull points; for the few points of a section, try them.
    centre_r: Optional[Tuple[Pt, float]] = None
    n = len(h)

    def covers(c: Pt, r: float) -> bool:
        return all(math.dist(c, p) <= r + 1e-6 for p in h)
    for i in range(n):
        for j in range(i + 1, n):
            c = ((h[i][0] + h[j][0]) / 2.0, (h[i][1] + h[j][1]) / 2.0)
            r = math.dist(h[i], h[j]) / 2.0
            if (centre_r is None or r < centre_r[1]) and covers(c, r):
                centre_r = (c, r)
    if n <= 60:
        for i in range(n):
            for j in range(i + 1, n):
                for k in range(j + 1, n):
                    c3 = _circumcentre(h[i], h[j], h[k])
                    if c3 is None:
                        continue
                    r = math.dist(c3, h[i])
                    if (centre_r is None or r < centre_r[1]) and covers(c3, r):
                        centre_r = (c3, r)
    if centre_r is None:
        best = max(math.dist(a, b) for a in h for b in h)
        return best
    return 2.0 * centre_r[1]


def _circumcentre(a: Pt, b: Pt, c: Pt) -> Optional[Pt]:
    d = 2.0 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]))
    if abs(d) < 1e-12:
        return None
    ux = ((a[0] ** 2 + a[1] ** 2) * (b[1] - c[1]) + (b[0] ** 2 + b[1] ** 2) * (c[1] - a[1]) + (c[0] ** 2 + c[1] ** 2) * (a[1] - b[1])) / d
    uy = ((a[0] ** 2 + a[1] ** 2) * (c[0] - b[0]) + (b[0] ** 2 + b[1] ** 2) * (a[0] - c[0]) + (c[0] ** 2 + c[1] ** 2) * (b[0] - a[0])) / d
    return (ux, uy)


def enclosing_circle(points: Sequence[Pt]) -> Tuple[Pt, float]:
    """
    The smallest circle around the points, as (centre, radius): exact for any number of points (each point outside the circle so far must
    lie on the new one, taken in a fixed shuffled order so the work stays near linear). enclosing_circle_diameter above tries every pair and
    triple of a section's few hull points; a part's silhouette has hundreds, and its centre is wanted too.
    """
    pts = hull(points)
    if not pts:
        return (0.0, 0.0), 0.0
    random.Random(0).shuffle(pts)

    def outside(c: Pt, r: float, p: Pt) -> bool:
        return math.dist(c, p) > r + 1e-9

    def through_two(a: Pt, b: Pt) -> Tuple[Pt, float]:
        return ((a[0] + b[0]) / 2.0, (a[1] + b[1]) / 2.0), math.dist(a, b) / 2.0

    centre, radius = pts[0], 0.0
    for i, p in enumerate(pts):
        if not outside(centre, radius, p):
            continue
        centre, radius = p, 0.0
        for j in range(i):
            q = pts[j]
            if not outside(centre, radius, q):
                continue
            centre, radius = through_two(p, q)
            for k in range(j):
                s = pts[k]
                if outside(centre, radius, s):
                    c3 = _circumcentre(p, q, s)
                    if c3 is not None:
                        centre, radius = c3, math.dist(c3, p)
    return centre, radius


def simplify(poly: Sequence[Pt], eps: float) -> List[Pt]:
    """Douglas-Peucker on a closed outline: the corners that stand more than eps off the straight line between their neighbours."""
    if len(poly) < 4:
        return list(poly)
    # Split the ring at its two farthest-apart points, simplify each half as an open line.
    i0 = 0
    i1 = max(range(len(poly)), key=lambda i: math.dist(poly[i0], poly[i]))
    i0 = max(range(len(poly)), key=lambda i: math.dist(poly[i1], poly[i]))
    if i0 > i1:
        i0, i1 = i1, i0
    a = list(poly[i0:i1 + 1])
    b = list(poly[i1:]) + list(poly[:i0 + 1])
    return _dp(a, eps)[:-1] + _dp(b, eps)[:-1]


def _dp(line: List[Pt], eps: float) -> List[Pt]:
    if len(line) < 3:
        return line
    (x0, y0), (x1, y1) = line[0], line[-1]
    dx, dy = x1 - x0, y1 - y0
    length = math.hypot(dx, dy)
    far, fi = -1.0, 0
    for i in range(1, len(line) - 1):
        px, py = line[i]
        d = abs(dy * (px - x0) - dx * (py - y0)) / length if length > 1e-12 else math.dist(line[i], line[0])
        if d > far:
            far, fi = d, i
    if far <= eps:
        return [line[0], line[-1]]
    return _dp(line[:fi + 1], eps)[:-1] + _dp(line[fi:], eps)


def _ccw(poly: Sequence[Pt]) -> List[Pt]:
    return list(poly) if area(poly) >= 0 else list(reversed(poly))


def _reflex(poly: Sequence[Pt]) -> List[int]:
    """Indices of the inside (reflex) corners of a counter-clockwise outline."""
    n = len(poly)
    out = []
    for i in range(n):
        a, b, c = poly[i - 1], poly[i], poly[(i + 1) % n]
        if (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]) < 0:
            out.append(i)
    return out


def is_regular_hexagon(simple: Sequence[Pt], fill: float) -> bool:
    """Whether a simplified convex outline is a regular hexagon: six sides equal to within 5 %, the outline filling three quarters of its
    bounding rectangle (`fill`, its area over that rectangle's)."""
    n = len(simple)
    if n != 6 or not (HEX_FILL[0] <= fill <= HEX_FILL[1]):
        return False
    sides = [math.dist(simple[i], simple[(i + 1) % n]) for i in range(n)]
    return (max(sides) - min(sides)) / max(sides) <= 0.05


def regular_hexagon(outline: Sequence[Pt]) -> Optional[Dict[str, object]]:
    """The outline as a regular hexagon: its six corners (counter-clockwise) and the distance across its flats; None when it is not one."""
    if len(outline) < 6:
        return None
    outer = _ccw(outline)
    long_side, short_side, _ = min_area_rect(outer)
    if long_side * short_side <= 0:
        return None
    simple = _ccw(simplify(outer, SIMPLIFY_FRACTION * long_side))
    if _reflex(simple) or not is_regular_hexagon(simple, area(outer) / (long_side * short_side)):
        return None
    return {"corners": simple, "across_flats_mm": short_side}
