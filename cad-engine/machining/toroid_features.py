"""
Toroidal faces (GeomAbs_Torus) of a machined part: what each one is, and the facts a costing needs to time it.

A torus face is swept by a circle of the minor radius r (the cross-section) round a circle of the major radius R. On a
B-Rep face, the parameter u runs along the major circle and v round the cross-section, so the face's UV bounds
(BRepTools.UVBounds) say how much of each it covers:

  sweep_deg    the u range: the arc of the major circle the face runs along (360 = all the way round).
  profile_deg  the v range: how much of the cross-section circle the face is. A fillet that blends two faces square to
               each other is a quarter of it (90); a half-round groove cut into the material is half of it (180).
  path_length_mm
               R x sweep (radians): the length of the major-circle arc. It is the path the centre of a ball of radius r
               travels to cut the face, as the tube's centre circle is the major circle: the tool a concave fillet is
               finished with (a ball-nose end mill of the fillet radius) follows it exactly. It is not the arc of the
               face's own edges (R - r or R + r), which neither the tool nor the drawing's fillet length goes by.

Concave or convex is read from the face itself: the material lies outside the tube (concave: an inside fillet, a groove)
when the face's outward normal points towards the tube's centre circle, inside it (convex: a rounded edge) when it points
away. On a torus placed on a right-handed axis the surface's own normal points away from the tube, so this agrees with
the old read (a REVERSED face is concave); on a left-handed axis the surface's normal points into the tube, and the
orientation alone would call every face the opposite of what it is.

Patches of one torus: an exporter can split one fillet or groove into several faces (a full-turn groove into two
halves, a fillet into the pieces either side of a hole that breaks into it). Faces on one torus surface -- the same
centre, axis line, R and r, the same side of the tube and the same profile (v interval) -- are one feature when their
sweeps add up to at most one turn: their sweeps and path lengths sum, their faces are the feature's faces. This is the
rule the cylinder patches of one bore are merged by (_deduplicate_cylinders: arc patches whose sweeps sum to at most a
turn). Faces on one torus with different profiles (a groove split along its cross-section) stay separate.

Classification (classify_toroid):

  groove   concave, and the profile is at least GROOVE_MIN_PROFILE_DEG (135): a round-bottomed recess cut into the
           material. A fillet in a corner is at most a quarter turn of the cross-section for faces square to each
           other, more only in an acute corner (a 45 degree corner gives 135); a half-round groove is 180. 135 is
           midway between the quarter-round fillet and the half-round groove. Its depth is r(1 - cos(theta/2)) and
           its width the chord 2r sin(theta/2) (theta, the profile, capped at a half turn for the width: past it
           the groove is undercut and its mouth is narrower than the ball that cuts it).
  fillet   concave with a smaller profile: an inside blend between two faces, emitted as the catalog's Edge:round (the
           same feature a concave cylindrical arc already is) with concave=True. It is cut by a ball-nose end mill of
           its radius along path_length_mm.
  round    convex: a rounded edge, Edge:round with concave=False.

On a turned or mill-turn part a concave torus on the turning line that goes all the way round (sweep at least
FULL_TURN_MIN_SWEEP_DEG, 355: a split full turn sums to 360 less export noise) is cut on the lathe: a groove profile is
the plunged Ring:groove; a fillet profile is the fillet at a shoulder that the finish-turning pass forms, Edge:round with
turned_shoulder=True (the costing does not cut it a second time). Any other concave torus on a turned part is milled
(Slot:groove or a concave Edge:round), as on a milled part.
"""
from __future__ import annotations

import math
from typing import Dict, List, Optional, Sequence, Tuple

from shared.machining_geometry import COAXIAL_TOLERANCE_MM, PARALLEL_AXIS_TOLERANCE_DEG, point_to_axis_distance

# A concave torus whose cross-section covers at least this much of its circle is a groove; less, a fillet (see the module doc).
GROOVE_MIN_PROFILE_DEG = 135.0
# A torus that sweeps at least this far round its axis goes all the way round (a full turn split into patches sums to 360 less export noise).
FULL_TURN_MIN_SWEEP_DEG = 355.0
# Two tori are one surface when their radii agree to this (mm) and their centres to COAXIAL_TOLERANCE_MM.
_SAME_RADIUS_MM = 0.01
# Two patches have one profile when their v intervals agree to this (degrees).
_SAME_PROFILE_DEG = 0.5
# Patches of one torus are one feature when their sweeps sum to at most a turn, plus this (degrees) for export noise.
_ONE_TURN_SLACK_DEG = 1.0

Vec = Tuple[float, float, float]


def _unit(v: Sequence[float]) -> Vec:
    n = math.sqrt(sum(c * c for c in v)) or 1.0
    return (v[0] / n, v[1] / n, v[2] / n)


def _dot(a: Sequence[float], b: Sequence[float]) -> float:
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def _one_way(axis: Vec) -> Tuple[Vec, float]:
    """The axis with one sign (its first component that is not zero is positive), and the sign it was multiplied by."""
    sign = next((1.0 if c > 0 else -1.0 for c in (round(c, 9) for c in axis) if c != 0.0), 1.0)
    return (axis[0] * sign + 0.0, axis[1] * sign + 0.0, axis[2] * sign + 0.0), sign


def _profile_interval(v0: float, v1: float, sign: float) -> Tuple[float, float]:
    """The face's v interval in degrees on the one-way axis, its start in [0, 360). Flipping a torus's axis turns v into -v."""
    a, b = (v0, v1) if sign > 0 else (-v1, -v0)
    a_deg = math.degrees(a)
    # A start a hair below a turn (-0.0000001 degrees) is that turn, not the end of the one before.
    shift = math.floor((a_deg + _SAME_PROFILE_DEG) / 360.0) * 360.0
    return a_deg - shift, math.degrees(b) - shift


def torus_face_facts(face, face_idx: int) -> Optional[Dict]:
    """One toroidal face's geometry: radii, sweep, profile, axis, centre, side of the tube, centroid and area. None when it is not a torus."""
    from OCC.Core.BRepAdaptor import BRepAdaptor_Surface  # type: ignore
    from OCC.Core.BRepGProp import brepgprop  # type: ignore
    from OCC.Core.BRepTools import breptools  # type: ignore
    from OCC.Core.GeomAbs import GeomAbs_Torus  # type: ignore
    from OCC.Core.GProp import GProp_GProps  # type: ignore
    from OCC.Core.TopAbs import TopAbs_REVERSED  # type: ignore
    from OCC.Core.gp import gp_Pnt, gp_Vec  # type: ignore

    surf = BRepAdaptor_Surface(face)
    if surf.GetType() != GeomAbs_Torus:
        return None
    tor = surf.Torus()
    major_r, minor_r = tor.MajorRadius(), tor.MinorRadius()
    ax = tor.Axis()
    d, loc = ax.Direction(), ax.Location()
    axis = _unit((d.X(), d.Y(), d.Z()))
    centre = (loc.X(), loc.Y(), loc.Z())
    u0, u1, v0, v1 = breptools.UVBounds(face)
    sweep = min(max(u1 - u0, 0.0), 2.0 * math.pi)
    profile = min(max(v1 - v0, 0.0), 2.0 * math.pi)

    # Concave or convex, from the face's outward normal at its middle (see the module doc).
    p, du, dv = gp_Pnt(), gp_Vec(), gp_Vec()
    surf.D1((u0 + u1) / 2.0, (v0 + v1) / 2.0, p, du, dv)
    n = du.Crossed(dv)
    if face.Orientation() == TopAbs_REVERSED:
        n.Reverse()
    rel = (p.X() - centre[0], p.Y() - centre[1], p.Z() - centre[2])
    radial = tuple(rel[k] - _dot(rel, axis) * axis[k] for k in range(3))
    tube_centre = tuple(centre[k] + major_r * _unit(radial)[k] for k in range(3))
    away = (p.X() - tube_centre[0], p.Y() - tube_centre[1], p.Z() - tube_centre[2])
    if n.Magnitude() > 1e-9 and math.sqrt(_dot(radial, radial)) > 1e-9:
        is_concave = _dot((n.X(), n.Y(), n.Z()), away) < 0.0
    else:  # a degenerate point (the pole of a spindle torus): the orientation of a right-handed torus is the read
        is_concave = face.Orientation() == TopAbs_REVERSED

    props = GProp_GProps()
    brepgprop.SurfaceProperties(face, props)
    cg = props.CentreOfMass()
    one_way, sign = _one_way(axis)
    return {
        "major_radius": major_r,
        "minor_radius": minor_r,
        "is_concave": is_concave,
        "sweep_rad": sweep,
        "profile_rad": profile,
        "profile_interval_deg": _profile_interval(v0, v1, sign),
        "axis": one_way,
        "centre": centre,
        "area": props.Mass(),
        "centroid": (cg.X(), cg.Y(), cg.Z()),
        "face_indices": [face_idx],
    }


def _same_torus(a: Dict, b: Dict) -> bool:
    if a["is_concave"] != b["is_concave"]:
        return False
    if abs(a["major_radius"] - b["major_radius"]) > _SAME_RADIUS_MM or abs(a["minor_radius"] - b["minor_radius"]) > _SAME_RADIUS_MM:
        return False
    if abs(_dot(a["axis"], b["axis"])) < math.cos(math.radians(PARALLEL_AXIS_TOLERANCE_DEG)):
        return False
    if math.dist(a["centre"], b["centre"]) > COAXIAL_TOLERANCE_MM:
        return False
    (a0, a1), (b0, b1) = a["profile_interval_deg"], b["profile_interval_deg"]
    return abs(a0 - b0) <= _SAME_PROFILE_DEG and abs(a1 - b1) <= _SAME_PROFILE_DEG


def merge_torus_patches(patches: List[Dict]) -> List[Dict]:
    """Faces of one torus surface with one profile, whose sweeps sum to at most a turn, as one toroid (see the module doc)."""
    parent = list(range(len(patches)))

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for i in range(len(patches)):
        for j in range(i + 1, len(patches)):
            if _same_torus(patches[i], patches[j]):
                parent[find(i)] = find(j)
    groups: Dict[int, List[Dict]] = {}
    for i, patch in enumerate(patches):
        groups.setdefault(find(i), []).append(patch)

    out: List[Dict] = []
    for group in groups.values():
        total = sum(p["sweep_rad"] for p in group)
        members = [group] if math.degrees(total) <= 360.0 + _ONE_TURN_SLACK_DEG else [[p] for p in group]
        for g in members:
            out.append(_combined(g))
    return sorted(out, key=lambda t: t["face_indices"][0])


def _combined(group: List[Dict]) -> Dict:
    first = group[0]
    area = sum(p["area"] for p in group)
    if area > 0:
        centroid = tuple(sum(p["centroid"][k] * p["area"] for p in group) / area for k in range(3))
    else:
        centroid = first["centroid"]
    sweep = min(sum(p["sweep_rad"] for p in group), 2.0 * math.pi)
    return {
        **first,
        "sweep_rad": sweep,
        "area": area,
        "centroid": (round(centroid[0], 3), round(centroid[1], 3), round(centroid[2], 3)),
        "face_indices": sorted(i for p in group for i in p["face_indices"]),
    }


def toroid_params(tor: Dict) -> Dict:
    """The measured facts every toroid feature carries: the existing fields plus its sweep, profile, path and axis."""
    sweep_deg = math.degrees(tor["sweep_rad"])
    return {
        "major_diameter_mm": round(tor["major_radius"] * 2.0, 3),
        "radius_mm": round(tor["minor_radius"], 3),
        "sweep_deg": round(sweep_deg, 1),
        "profile_deg": round(math.degrees(tor["profile_rad"]), 1),
        "path_length_mm": round(tor["major_radius"] * tor["sweep_rad"], 3),
        "concave": bool(tor["is_concave"]),
        "axis": [round(c, 4) + 0.0 for c in tor["axis"]],
        "centroid": list(tor.get("centroid", (0.0, 0.0, 0.0))),
    }


def is_groove_profile(tor: Dict) -> bool:
    return bool(tor["is_concave"]) and math.degrees(tor["profile_rad"]) >= GROOVE_MIN_PROFILE_DEG


def groove_section(minor_radius: float, profile_rad: float) -> Tuple[float, float]:
    """(depth, width) of a round-bottomed groove of radius r whose cross-section covers theta of its circle (see the module doc)."""
    depth = minor_radius * (1.0 - math.cos(profile_rad / 2.0))
    width = 2.0 * minor_radius * math.sin(min(profile_rad, math.pi) / 2.0)
    return depth, width


def on_turning_line(tor: Dict, turning_axis: Optional[Sequence[float]], on_axis: Optional[Sequence[float]]) -> bool:
    """The torus's axis is the turning line: parallel to the turning direction and its centre on the line through on_axis."""
    if turning_axis is None or on_axis is None:
        return False
    direction = _unit(turning_axis)
    if abs(_dot(tor["axis"], direction)) < math.cos(math.radians(PARALLEL_AXIS_TOLERANCE_DEG)):
        return False
    c = tor["centre"]
    off = point_to_axis_distance((c[0] - on_axis[0], c[1] - on_axis[1], c[2] - on_axis[2]), direction)
    return off <= 0.02 + 0.005 * tor["major_radius"]


def classify_toroid(
    tor: Dict,
    turned: bool = False,
    turning_axis: Optional[Sequence[float]] = None,
    on_axis: Optional[Sequence[float]] = None,
) -> Tuple[str, str, Dict]:
    """(feature type, variant, params) for one toroid (see the module doc for the rules)."""
    params = toroid_params(tor)
    if not tor["is_concave"]:
        return "Edge", "round", params
    groove = is_groove_profile(tor)
    if groove:
        depth, width = groove_section(tor["minor_radius"], tor["profile_rad"])
        params["depth_mm"] = round(depth, 3)
        params["width_mm"] = round(width, 3)
    lathe = (turned and math.degrees(tor["sweep_rad"]) >= FULL_TURN_MIN_SWEEP_DEG
             and on_turning_line(tor, turning_axis, on_axis))
    if groove:
        return ("Ring", "groove", params) if lathe else ("Slot", "groove", params)
    if lathe:
        params["turned_shoulder"] = True
    return "Edge", "round", params
