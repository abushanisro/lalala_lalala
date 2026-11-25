"""
A bar's or tube's cross-section, classified from its outline.

The section is cut across the stock (normal to its centreline) and handed here as 2D outlines: the outer boundary and any inner boundaries
(the hollows), each a closed list of (x, y) points in mm. What it is decides which stock is bought and what can cut and bend it:

  ROUND_TUBE / ROUND_BAR          a circular outline (to within ROUND_TOLERANCE of its mean radius), hollow or solid
  SQUARE_TUBE / SQUARE_BAR        an outline that fills its smallest bounding rectangle (corner radii allowed), equal sides
  RECTANGULAR_TUBE / _BAR         the same with unequal sides (a flat bar is a rectangular bar)
  HEX_BAR                         six equal sides, filling three quarters of its bounding rectangle
  ANGLE_BAR, CHANNEL_BAR,         open structural sections, told apart by their reflex (inside) corners: an angle has one; a channel two
  T_BEAM, I_BEAM                  side by side (its inside corners are next to each other); a tee two apart (one each side of the stem);
                                  an I-beam four
  GENERIC_EXTRUSION               anything else: a profile that is extruded to shape

The names are the stock forms of the reference data (memory/Bar and tube fab lookup/saw_routing_evaluation.csv).
"""
from __future__ import annotations

import math
from typing import Any, Dict, List, Optional, Sequence

# The outline geometry itself (area, hull, smallest rectangle and circle, simplification, the regular-hexagon test) is shared with the other
# domains that measure an outline: shared/planar_outline.py.
from shared.planar_outline import (  # noqa: F401  (the names this module had are still read from it: roll forming, the extractor)
    HEX_FILL, SIMPLIFY_FRACTION, Pt, _ccw, _reflex, area, centroid, enclosing_circle_diameter, hull, is_regular_hexagon, min_area_rect,
    perimeter, simplify,
)

ROUND_TOLERANCE = 0.01        # a circle: every outline point within 1 % of the mean radius
RECT_FILL = 0.95              # a rectangle with corner radii still fills 95 % of its bounding rectangle
SQUARE_TOLERANCE = 0.02       # sides within 2 % are a square


def _round(poly: Sequence[Pt]) -> Optional[float]:
    """The diameter when the outline is a circle, else None."""
    c = centroid(poly)
    radii = [math.dist(c, p) for p in poly]
    mean = sum(radii) / len(radii)
    if mean <= 0 or (max(radii) - min(radii)) / mean > 2.0 * ROUND_TOLERANCE:
        return None
    return 2.0 * mean


def resample(poly: Sequence[Pt], step: float) -> List[Pt]:
    """The outline with points no farther apart than `step` (a straight edge arrives as its two ends only)."""
    out: List[Pt] = []
    n = len(poly)
    for i in range(n):
        a, b = poly[i], poly[(i + 1) % n]
        k = max(1, int(math.ceil(math.dist(a, b) / step)))
        out.extend((a[0] + (b[0] - a[0]) * j / k, a[1] + (b[1] - a[1]) * j / k) for j in range(k))
    return out


def classify_section(outer: Sequence[Pt], inners: Sequence[Sequence[Pt]] = ()) -> Dict[str, Any]:
    """
    The stock form and size of a section from its outlines. Sizes are in mm: od and wall for round tube, width (the long side), height and wall
    for square and rectangular tube, width and height for bars and structural sections (with a nominal thickness, twice the area over the
    outline length, for the open sections), across_flats for hex bar.
    """
    outer = _ccw(outer)
    inners = [_ccw(h) for h in inners if len(h) >= 3]
    span = max(max(p[0] for p in outer) - min(p[0] for p in outer), max(p[1] for p in outer) - min(p[1] for p in outer), 1e-6)
    dense_outer = resample(outer, span / 100.0)
    dense_inners = [resample(h, span / 100.0) for h in inners]
    gross = area(outer)
    net = gross - sum(area(h) for h in inners)
    length = perimeter(outer) + sum(perimeter(h) for h in inners)
    long_side, short_side, _ = min_area_rect(outer)
    out: Dict[str, Any] = {
        "stock_form": "GENERIC_EXTRUSION",
        "area_mm2": round(net, 3),
        "perimeter_mm": round(length, 3),
        "outer_perimeter_mm": round(perimeter(outer), 3),
        "width_mm": round(long_side, 3),
        "height_mm": round(short_side, 3),
        "circumscribing_diameter_mm": round(enclosing_circle_diameter(outer), 3),
        "hollows": len(inners),
    }
    od = _round(dense_outer)
    if od is not None:
        if not inners:
            return {**out, "stock_form": "ROUND_BAR", "od_mm": round(od, 3), "width_mm": round(od, 3), "height_mm": round(od, 3)}
        if len(inners) == 1:
            idia = _round(dense_inners[0])
            if idia is not None and math.dist(centroid(outer), centroid(inners[0])) < 0.05 * od:
                return {**out, "stock_form": "ROUND_TUBE", "od_mm": round(od, 3), "id_mm": round(idia, 3), "wall_mm": round((od - idia) / 2.0, 3),
                        "width_mm": round(od, 3), "height_mm": round(od, 3)}
        return out
    fill = gross / (long_side * short_side) if long_side * short_side > 0 else 0.0
    if fill >= RECT_FILL:
        square = (long_side - short_side) / long_side <= SQUARE_TOLERANCE
        if not inners:
            return {**out, "stock_form": "SQUARE_BAR" if square else "RECTANGULAR_BAR"}
        if len(inners) == 1:
            il, ishort, _ = min_area_rect(inners[0])
            if area(inners[0]) / max(il * ishort, 1e-9) >= RECT_FILL:
                wall = ((long_side - il) + (short_side - ishort)) / 4.0
                return {**out, "stock_form": "SQUARE_TUBE" if square else "RECTANGULAR_TUBE", "wall_mm": round(wall, 3)}
        return out
    if inners:
        return out
    simple = simplify(outer, SIMPLIFY_FRACTION * long_side)
    simple = _ccw(simple)
    n = len(simple)
    reflex = _reflex(simple)
    if not reflex:
        if is_regular_hexagon(simple, fill):
            return {**out, "stock_form": "HEX_BAR", "across_flats_mm": round(short_side, 3)}
        return out
    thickness = round(2.0 * gross / perimeter(outer), 3)
    r = len(reflex)
    if n == 6 and r == 1:
        return {**out, "stock_form": "ANGLE_BAR", "thickness_mm": thickness}
    if n == 8 and r == 2:
        adjacent = (reflex[1] - reflex[0]) % n in (1, n - 1)
        return {**out, "stock_form": "CHANNEL_BAR" if adjacent else "T_BEAM", "thickness_mm": thickness}
    if n == 12 and r == 4:
        return {**out, "stock_form": "I_BEAM", "thickness_mm": thickness}
    return out


def distance_to_outlines(p: Pt, outlines: Sequence[Sequence[Pt]]) -> float:
    """The distance from a point to the nearest outline segment."""
    best = math.inf
    for poly in outlines:
        n = len(poly)
        for i in range(n):
            a, b = poly[i], poly[(i + 1) % n]
            dx, dy = b[0] - a[0], b[1] - a[1]
            ll = dx * dx + dy * dy
            t = 0.0 if ll < 1e-18 else max(0.0, min(1.0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / ll))
            d = math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy))
            if d < best:
                best = d
    return best
