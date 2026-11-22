"""
What a roll-formed sheet-metal part's cost rests on, measured from the solid.

Roll forming bends a coil strip through a line of roll stands into a long profile of constant cross-section (a C, U, Z or hat channel,
an angle, a rail, or a closed tube welded along its seam), sometimes curved along its length, with holes, notches, lances and small forms
punched in the flat strip before the mill, cut to length at the ends (memory/Sheet metal roll forming). So the part is measured as a
section swept along a line or an arc:

  axis, length_mm     the long axis: the direction every cross-section bend runs along (a straight profile), or for a curved one the
                      direction of its chord (the tangent at mid-length); the length along it from end to end (for a curved profile the
                      arc length at the section's centroid). axis_source: "bends" or "curve".
  constant_section    whether the part is one section along its length: stock_fraction, the share of the surface on the swept
                      section (bar_tube's measure), is at least bar_tube.feature_extractor.STOCK_FRACTION (0.8).
  section             the cross-section cut across the axis clear of every feature (bar_tube.feature_extractor.cut_section's cut, its
                      pieces merged; classified by bar_tube.section.classify_section): width along the web (the widest flat of the strip)
                      and height across it, area, perimeter (outer and inner outlines), closed (the section has a hollow: a tube) and the
                      stock form.
  strip_width_mm      the strip the profile is rolled from: the section's mid-line length, section area / thickness (exact for a sheet of
                      constant thickness). strip_width_neutral_mm is the same strip read off the flats and the bends at the neutral
                      fibre (K = 0.33 below an inner radius of 2 t, else 0.41: the extractor's own flat-pattern rule; a sharp corner
                      bends about its inner corner, K 0.33, less the t tan(angle/2) its two flats run on past that corner at the
                      mid-surface), and strip_width_check sets the flats and the mid-line bend arcs beside it (they add up to
                      strip_width_mm when the strip is read right).
  thickness_mm        the sheet's thickness; for a sheet with no flat (a round tube), whose thickness the extractor cannot read between
                      flats, the wall between its concentric skins.
  bends               the cross-section bends (folds whose line runs along the length), in order across the strip from one edge to the
                      other: angle, inner radius, sharp, the flat just before the bend (0 when two bends meet), the bend's level and its
                      faces. A profile modelled without bend radii has sharp corners, two flats meeting at an edge: a bend with inner
                      radius 0, sharp true, its angle 180 deg less the angle between the flats, and no face of its own. Each flat is
                      read at the sheet's mid-surface (the mean of its two skins, which differ at a sharp corner), so the flats and the
                      bend arcs add up to the strip. A round tube is formed as two half turns meeting at the welded seam: two 180 deg
                      bends of the tube's inner radius, level 1, with no flat between them.
                      last_flange_mm is the flat after the last bend (0 for a closed section, whose strip closes on its first flat).
                      Level is the bend's precedence in the mill: 1 for the bends on the web (the widest flat), 2 for the bends one bend
                      further out, and so on; on a closed section it is counted the shorter way round from the web.
                      An open strip is listed from the edge whose first flat is narrower (ties: the side with the lower face id); a
                      closed one from its web, towards the neighbour with the lower face id.
  tube                a closed section (a tube rolled from the strip and welded along its seam): its outer diameter (a round tube;
                      null otherwise), outer width and height and wall; null for an open section.
  curve               a curved profile's radius (the section centroid's distance from the axis it is curved about), its angle and that
                      axis; null when the profile is straight.
  features            what is punched or formed along the length (the faces off the swept section, joined where they touch, away from
                      the ends): SimpleHole (round, size = its diameter), ComplexHole (any other opening closed within the sheet),
                      Cutout (an opening reaching the strip's edge: a notch), Lance (cut and formed) and Form (formed, not cut), each
                      with its size (diameter, else the longer side of the smallest rectangle round it), cut perimeter, opening area,
                      depth (lances and forms: how far it stands off the sheet), station (its middle's distance along the axis from the
                      start end) and faces.
  ends                each end's cut: square, angled (cut_angle_deg from square), notched or slotted (bar_tube's end classifier), the
                      length of the cut along the strip (cut_perimeter_mm: half the edges the end meets the sheet's skins along, the
                      strip width for a square cut) and its faces.

The part is a profile when its sheet (the faces with an offset twin one thickness away: drawn_shell.analyse_sheet_faces) is a section
swept along one axis:
  straight            its cross-section bends (cylinders folding the sheet, or sharp corners where two of its flats meet) all run one
                      way (bends any other way carry at most OTHER_BEND_SHARE of their length) and PROFILE_SHARE of the sheet runs along
                      it. A part found by sharp corners alone (which a machined or welded part has too) is a profile only when it is
                      one section along its length and that section is a strip of the sheet (its flats add up to area / t).
  curved              its cross-section bends are tori about one axis (or, with no bend radii, cylinders about it meeting flats across
                      it), PROFILE_SHARE of the sheet is revolved about it, the part stays clear of that axis (no sheet across it, its
                      nearest point OFF_AXIS_RATIO of its depth away: a drawn cup or a flange round a half disc reaches it) and does not
                      close on itself (a ring is drawn or rolled round, not cut to length).
  no flat             a round tube or a ring or trough of arcs: concentric cylinders along one axis, one wall apart, are PROFILE_SHARE of
                      the surface and no sheet lies across the axis (a can's bottom).
These are read from the face records the extractor already has, so an ordinary sheet part is turned away in a few milliseconds; null
then.
A curved profile is also a drawn shell to drawn_shell.py (its bends are twinned tori); this measurement does not read that verdict, so a
curved profile is measured whatever it says, and drawn parts are not touched.

These are measurements only. Stations, the mill, line speed, tooling and cost are decided in the backend from the staged reference.
"""
from __future__ import annotations

import logging
import math
from typing import Any, Dict, List, Optional, Sequence, Set, Tuple

from bar_tube.centreline import Bend, Centreline, Segment, _initial_frame, straight_centreline
from bar_tube.section import area as poly_area, centroid as poly_centroid, classify_section, min_area_rect
from sheet_metal.features.drawn_shell import _POS_TOL, _cross, _dot, _same_axis, _sub, _unit
from sheet_metal.features.hydroform import _across, _edge_face_map, _edge_points, _edges, _face_index_map, _length

logger = logging.getLogger(__name__)

# rf_v2 (2026-11-22): profiles modelled without bend radii (sharp corners, "sharp" on each bend) and tubes with no flat (a round tube:
# two half turns at the seam, its wall read from its skins) are measured, and a closed section carries "tube". rf_v1: the first.
VERSION = "rf_v2"

# Two directions are parallel within this of |cos| = 1, perpendicular within this of cos = 0 (the drawn-shell module's angle tolerance).
DIR_TOL = 1e-3
# Bends along any other direction than the long axis may carry at most this share of the cross-section bends' area (the small bends of a
# lance or an end tab); more and the part is folded two ways: a bracket or a box, not a profile.
OTHER_BEND_SHARE = 0.10
# At least this share of the sheet must be the swept section's surfaces (planes and cylinders along a straight axis; planes across, and
# cylinders, cones and tori about, a curve's axis): a part with a large form or panel any other way is not a profile.
PROFILE_SHARE = 0.8
# A curved profile stays clear of its curve's axis: its nearest point is at least this many times its depth across the curve away (a cup or
# a flange round a disc reaches the axis).
OFF_AXIS_RATIO = 0.5
# Chord deflection of the points an edge is read at (extents, stations) and of a cut's loop (its opening area).
EDGE_DEFLECTION_MM = 0.05
LOOP_DEFLECTION_MM = 0.01
# The cross-section outline's chord error (bar_tube's own).
SECTION_DEFLECTION_MM = 0.002
# A bore whose faces about one axis sweep a full turn less this closes on itself: a round hole (hydroform's rule).
FULL_TURN_TOL_RAD = 1e-3
# A cut is kept when its area is at least this share of volume / length (else it went through a hole: cut elsewhere).
CUT_AREA_SHARE = 0.98
# The flats and mid-line bend arcs agree with section area / thickness within this share.
STRIP_AGREE = 0.02
# Where the section is cut when no gap between the features takes a whole cut (shares of the length: bar_tube's three).
CUT_STATIONS = (0.5, 0.31, 0.69)

Vec = Tuple[float, float, float]


def _r(x: Optional[float], nd: int) -> Optional[float]:
    return None if x is None else round(float(x), nd) + 0.0  # + 0.0: no "-0.0"


def _parallel(a: Sequence[float], b: Sequence[float]) -> bool:
    return abs(abs(_dot(a, b)) - 1.0) <= DIR_TOL  # type: ignore[arg-type]


def _canonical(v: Vec) -> Vec:
    for c in v:
        if abs(c) > 1e-9:
            return v if c > 0 else (-v[0], -v[1], -v[2])
    return v


def _vertices(face: Any) -> List[Vec]:
    from OCC.Core.BRep import BRep_Tool  # type: ignore
    from OCC.Core.TopAbs import TopAbs_VERTEX  # type: ignore
    from OCC.Core.TopExp import TopExp_Explorer  # type: ignore
    from OCC.Core.TopoDS import topods  # type: ignore

    out: List[Vec] = []
    exp = TopExp_Explorer(face, TopAbs_VERTEX)
    while exp.More():
        p = BRep_Tool.Pnt(topods.Vertex(exp.Current()))
        out.append((p.X(), p.Y(), p.Z()))
        exp.Next()
    return out


def _edge_cloud(face: Any) -> List[Vec]:
    """Points along every edge of a face (its outline and openings)."""
    return [p for e in _edges(face) for p in _edge_points(e, EDGE_DEFLECTION_MM)]


def _arcs_info(faces: Sequence[Any]) -> List[Dict[str, Any]]:
    """bar_tube.feature_extractor.surface_info for faces whose angle ranges are joined (_arc_from_group), with each axis turned to the way
    its angles run: a surface on a left-handed frame (an exporter's, or the inner skin of a swept sheet) measures them about the reverse
    of its stored axis, and read as stored its arc lands on the other side of the axis."""
    from bar_tube.feature_extractor import surface_info
    from OCC.Core.BRepAdaptor import BRepAdaptor_Surface  # type: ignore
    from OCC.Core.GeomAbs import GeomAbs_Cylinder, GeomAbs_Torus  # type: ignore

    info = surface_info(faces)
    for face, rec in zip(faces, info):
        a = BRepAdaptor_Surface(face)
        kind = a.GetType()
        pos = a.Cylinder().Position() if kind == GeomAbs_Cylinder else a.Torus().Position() if kind == GeomAbs_Torus else None
        if pos is not None and "axis" in rec and not pos.Direct():
            rec["axis"] = tuple(-c for c in rec["axis"])
    return info


# ── the long axis ───────────────────────────────────────────────────────────

def _axial_length(rec: Dict[str, Any]) -> float:
    """A cylinder face's length along its axis."""
    return abs(rec["adaptor"].LastVParameter() - rec["adaptor"].FirstVParameter())


def _sharp_corners(shape: Any, by_index: Dict[int, Dict[str, Any]], twinned: Set[int], adjacency: Dict[int, set]) -> List[Tuple[Vec, float]]:
    """Where two skin planes of the sheet meet at an edge with no bend radius between them (a sharp corner): the corner line's direction and
    length, on each skin."""
    pairs = [(i, j) for i in sorted(twinned) if by_index[i]["kind"] == "plane"
             for j in sorted(adjacency.get(i, ())) if j > i and j in twinned and by_index[j]["kind"] == "plane"
             and not _parallel(by_index[i]["dir"], by_index[j]["dir"])]
    if not pairs:
        return []
    emap, fmap = _edge_face_map(shape), _face_index_map(shape)
    out = []
    for i, j in pairs:
        length = sum(_length(e) for e in _edges(by_index[i]["face"]) if j in _across(e, emap, fmap))
        if length > 0:
            out.append((_canonical(_unit(_cross(by_index[i]["dir"], by_index[j]["dir"]))), length))
    return out


def _straight_axis(shape: Any, by_index: Dict[int, Dict[str, Any]], twinned: Set[int], adjacency: Dict[int, set],
                   skin_area: float) -> Optional[Dict[str, Any]]:
    """The common direction of the cross-section bends, when the part is folded one way only. A bend is a cylinder folding the sheet, or a
    sharp corner where two of its flats meet with no radius (a profile modelled without bend radii); each counts by its length."""
    lines: List[Tuple[Vec, float, bool]] = []  # direction, length, sharp
    for i in twinned:
        r = by_index[i]
        if r["kind"] != "cylinder":
            continue
        d = r["dir"]
        along = across = False
        for j in adjacency.get(i, ()):
            if j not in twinned:
                continue
            q = by_index[j]
            if q["kind"] == "plane":
                c = abs(_dot(q["dir"], d))
                if c > 0.5:
                    across = True  # it borders a sheet it passes through: a hole's flange, not a fold
                elif c <= DIR_TOL:
                    along = True
            elif q["kind"] == "cylinder" and _parallel(q["dir"], d):
                along = True  # bend meeting bend
        if along and not across:
            lines.append((_canonical(d), _axial_length(r), False))
    lines += [(d, length, True) for d, length in _sharp_corners(shape, by_index, twinned, adjacency)]
    if not lines:
        return None
    clusters: List[List[Any]] = []  # [direction, length, length of the folds with a radius]
    for d, length, sharp in lines:
        for c in clusters:
            if _parallel(c[0], d):
                c[1] += length
                c[2] += 0.0 if sharp else length
                break
        else:
            clusters.append([d, length, 0.0 if sharp else length])
    clusters.sort(key=lambda c: -c[1])
    axis, length, radiused = clusters[0]
    if sum(c[1] for c in clusters[1:]) > OTHER_BEND_SHARE * length:
        return None
    along_area = sum(by_index[i]["area"] for i in twinned if _prismatic(by_index[i], axis))
    if along_area < PROFILE_SHARE * skin_area:
        return None
    return {"kind": "straight", "axis": axis, "sharp_only": radiused <= 0.0}


def _tube_axis(by_index: Dict[int, Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """A sheet with no flat at all (a round tube, a ring or trough of arcs), whose thickness the extractor reads from flats and so cannot
    have: concentric cylinders along one axis, one wall apart (the commonest radius difference), holding PROFILE_SHARE of the surface, and
    no sheet across the axis (a can's bottom)."""
    cyls = [r for r in by_index.values() if r["kind"] == "cylinder"]
    if len(cyls) < 2:
        return None
    axis = _canonical(max(cyls, key=lambda r: r["area"])["dir"])
    lines: List[List[Dict[str, Any]]] = []
    for r in cyls:
        if not _parallel(r["dir"], axis):
            continue
        for g in lines:
            if _same_axis(g[0]["dir"], g[0]["point"], r["dir"], r["point"]):
                g.append(r)
                break
        else:
            lines.append([r])
    walls: Dict[float, float] = {}
    for g in lines:
        for k, a in enumerate(g):
            for b in g[k + 1:]:
                gap = abs(a["radius"] - b["radius"])
                if gap > _POS_TOL:
                    walls[round(gap, 2)] = walls.get(round(gap, 2), 0.0) + min(a["area"], b["area"])
    if not walls:
        return None
    wall = max(walls, key=lambda w: walls[w])
    tol = max(0.1 * wall, 0.02)
    paired: Set[int] = set()
    for g in lines:
        for k, a in enumerate(g):
            for b in g[k + 1:]:
                if abs(abs(a["radius"] - b["radius"]) - wall) <= tol:
                    paired |= {a["index"], b["index"]}
    if sum(by_index[i]["area"] for i in paired) < PROFILE_SHARE * sum(r["area"] for r in by_index.values()):
        return None
    across = sorted(_dot(r["point"], axis) for r in by_index.values() if r["kind"] == "plane" and _parallel(r["dir"], axis))
    if any(abs(abs(b - a) - wall) <= tol for k, a in enumerate(across) for b in across[k + 1:]):
        return None
    return {"kind": "straight", "axis": axis, "wall": wall}


def _prismatic(rec: Dict[str, Any], axis: Vec) -> bool:
    """A surface swept straight along the axis: a plane containing it or a cylinder along it."""
    if rec["kind"] == "plane":
        return abs(_dot(rec["dir"], axis)) <= DIR_TOL
    if rec["kind"] == "cylinder":
        return _parallel(rec["dir"], axis)
    return False


def _revolved(rec: Dict[str, Any], axis: Vec, point: Vec) -> bool:
    """A surface swept round the axis: a plane across it, or a cylinder, cone or torus about it."""
    if rec["kind"] == "plane":
        return _parallel(rec["dir"], axis)
    if rec["kind"] in ("cylinder", "cone", "torus"):
        return _same_axis(rec["dir"], rec["point"], axis, point)
    return False


def _crosses_axis(rec: Dict[str, Any], axis: Vec, point: Vec) -> bool:
    """A plane across the axis that the axis passes through (inside the face or on its edge): a disc or a cup's bottom."""
    if rec["kind"] != "plane" or not _parallel(rec["dir"], axis):
        return False
    from OCC.Core.BRepClass import BRepClass_FaceClassifier  # type: ignore
    from OCC.Core.TopAbs import TopAbs_OUT  # type: ignore
    from OCC.Core.gp import gp_Pnt  # type: ignore

    shift = _dot(_sub(rec["point"], point), axis)
    q = gp_Pnt(point[0] + axis[0] * shift, point[1] + axis[1] * shift, point[2] + axis[2] * shift)
    return BRepClass_FaceClassifier(rec["face"], q, _POS_TOL).State() != TopAbs_OUT


def _curved_axis(by_index: Dict[int, Dict[str, Any]], twinned: Set[int], adjacency: Dict[int, set],
                 skin_area: float) -> Optional[Dict[str, Any]]:
    """The axis the cross-section bends are revolved about, when the sheet is a section swept round it. The bends are tori; in a profile
    modelled without bend radii they are sharp corners, where a cylinder or cone about the axis meets a flat across it."""
    tori = [i for i in twinned if by_index[i]["kind"] == "torus" and by_index[i]["major"] > by_index[i]["minor"]]
    sharp_only = not tori
    if not tori:
        tori = [i for i in twinned if by_index[i]["kind"] in ("cylinder", "cone")
                and any(j in twinned and by_index[j]["kind"] == "plane" and _parallel(by_index[j]["dir"], by_index[i]["dir"])
                        for j in adjacency.get(i, ()))]
    if not tori:
        return None
    groups: List[List[int]] = []
    for i in tori:
        r = by_index[i]
        for g in groups:
            h = by_index[g[0]]
            if _same_axis(h["dir"], h["point"], r["dir"], r["point"]):
                g.append(i)
                break
        else:
            groups.append([i])
    groups.sort(key=lambda g: -sum(by_index[i]["area"] for i in g))
    main = groups[0]
    main_area = sum(by_index[i]["area"] for i in main)
    if sum(by_index[i]["area"] for g in groups[1:] for i in g) > OTHER_BEND_SHARE * main_area:
        return None
    axis = _canonical(by_index[main[0]]["dir"])
    point = by_index[main[0]]["point"]
    if sum(by_index[i]["area"] for i in twinned if _revolved(by_index[i], axis, point)) < PROFILE_SHARE * skin_area:
        return None
    radial, axial = [], []
    for i in twinned:
        for p in _vertices(by_index[i]["face"]):
            rel = _sub(p, point)
            z = _dot(rel, axis)
            radial.append(math.sqrt(max(_dot(rel, rel) - z * z, 0.0)))
            axial.append(z)
    if not radial or any(_crosses_axis(by_index[i], axis, point) for i in twinned):
        return None  # a sheet across the axis (a cup's bottom): drawn round the axis, not a profile swept along a curve
    r_min, r_max = min(radial), max(radial)
    if r_min <= OFF_AXIS_RATIO * (r_max - r_min):
        return None
    from bar_tube.feature_extractor import _arc_from_group

    info = _arcs_info([by_index[i]["face"] for i in main])
    arc = _arc_from_group(info, "torus", _POS_TOL)
    if arc is None or arc.sweep <= 0 or arc.closed():
        return None  # a closed ring is drawn or rolled round, not cut to length from a profile
    return {"kind": "curved", "axis": arc.axis, "point": point, "arc": arc, "r_min": r_min, "r_max": r_max,
            "z_min": min(axial), "z_max": max(axial), "sharp_only": sharp_only}


def _arc_centreline(arc: Bend, point: Vec, radius: float, z: float) -> Centreline:
    """One arc of the given radius about the curve's axis, at height z along it, over the bends' angle range."""
    axis = arc.axis
    # The point on the axis at height z (heights measured along the axis from the origin).
    shift = z - _dot(point, axis)
    centre = (point[0] + axis[0] * shift, point[1] + axis[1] * shift, point[2] + axis[2] * shift)
    b = Bend(centre=centre, axis=axis, x=arc.x, radius=radius, t0=arc.t0, t1=arc.t1, face_ids=list(arc.face_ids), source="torus")
    seg = Segment("bend", 0.0, radius * b.sweep, bend=b, forward=True)
    seg.u, seg.v = _initial_frame(seg.tangent(0.0))
    return Centreline([seg], closed=b.closed())


# ── the section ─────────────────────────────────────────────────────────────

def _cut_section(shape: Any, centre: Vec, u: Vec, v: Vec, t: Vec, reach: float) -> Optional[Dict[str, Any]]:
    """The cross-section at `centre` normal to t as 2D outlines in the (u, v) frame: bar_tube.feature_extractor.cut_section, with the pieces
    of the cut merged first. A profile built as a sweep (a pipe along a polyline with arcs) is cut into one piece per swept segment, and the
    piece nearest the centreline alone is one flange, not the section."""
    from bar_tube.feature_extractor import _wire_points
    from OCC.Core.BRepAlgoAPI import BRepAlgoAPI_Common  # type: ignore
    from OCC.Core.BRepBuilderAPI import BRepBuilderAPI_MakeFace, BRepBuilderAPI_MakeVertex  # type: ignore
    from OCC.Core.BRepExtrema import BRepExtrema_DistShapeShape  # type: ignore
    from OCC.Core.BRepTools import breptools  # type: ignore
    from OCC.Core.ShapeUpgrade import ShapeUpgrade_UnifySameDomain  # type: ignore
    from OCC.Core.TopAbs import TopAbs_FACE, TopAbs_WIRE  # type: ignore
    from OCC.Core.TopExp import TopExp_Explorer  # type: ignore
    from OCC.Core.TopoDS import topods  # type: ignore
    from OCC.Core.TopTools import TopTools_ListOfShape  # type: ignore
    from OCC.Core.gp import gp_Ax3, gp_Dir, gp_Pln, gp_Pnt  # type: ignore

    plane = gp_Pln(gp_Ax3(gp_Pnt(*centre), gp_Dir(*t), gp_Dir(*u)))
    cutter = BRepBuilderAPI_MakeFace(plane, -reach, reach, -reach, reach).Face()
    # Non-destructive: the boolean must not touch the part's own edges and tolerances, which the rest of the extraction reads after it.
    args, tools = TopTools_ListOfShape(), TopTools_ListOfShape()
    args.Append(shape)
    tools.Append(cutter)
    common = BRepAlgoAPI_Common()
    common.SetArguments(args)
    common.SetTools(tools)
    common.SetNonDestructive(True)
    common.Build()
    if not common.IsDone():
        return None
    unify = ShapeUpgrade_UnifySameDomain(common.Shape(), True, True, True)
    unify.Build()
    vertex = BRepBuilderAPI_MakeVertex(gp_Pnt(*centre)).Vertex()
    best, best_d = None, math.inf
    ex = TopExp_Explorer(unify.Shape(), TopAbs_FACE)
    while ex.More():
        face = topods.Face(ex.Current())
        d = BRepExtrema_DistShapeShape(vertex, face)
        dist = d.Value() if d.IsDone() else math.inf
        if dist < best_d:
            best, best_d = face, dist
        ex.Next()
    if best is None:
        return None
    outer = breptools.OuterWire(best)

    def to2d(pts: Sequence[Vec]) -> List[Tuple[float, float]]:
        return [(_dot(_sub(p, centre), u), _dot(_sub(p, centre), v)) for p in pts]

    outer2d: List[Tuple[float, float]] = []
    inners: List[List[Tuple[float, float]]] = []
    wx = TopExp_Explorer(best, TopAbs_WIRE)
    while wx.More():
        w = topods.Wire(wx.Current())
        pts = to2d(_wire_points(w, best, SECTION_DEFLECTION_MM))
        if w.IsSame(outer):
            outer2d = pts
        elif len(pts) >= 3:
            inners.append(pts)
        wx.Next()
    if len(outer2d) < 3:
        return None
    return {"outer": outer2d, "inners": inners}


def _free_stations(cl: Centreline, spans: List[Tuple[float, float]]) -> List[float]:
    """Stations to cut the section at, clear of every feature: the middles of the gaps between the features' spans along the length,
    widest gap first, then bar_tube's three (mid-length first)."""
    length = cl.length
    merged: List[List[float]] = []
    for lo, hi in sorted((max(0.0, a), min(length, b)) for a, b in spans):
        if merged and lo <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], hi)
        else:
            merged.append([lo, hi])
    gaps, last = [], 0.0
    for lo, hi in merged:
        if lo > last:
            gaps.append((lo - last, (last + lo) / 2.0))
        last = max(last, hi)
    if length > last:
        gaps.append((length - last, (last + length) / 2.0))
    gaps.sort(key=lambda g: -g[0])
    return [mid for _w, mid in gaps[:3]] + [length * share for share in CUT_STATIONS]


def _cut(shape: Any, cl: Centreline, reach: float, expected_area: float, stations: Sequence[float]) -> Optional[Dict[str, Any]]:
    """The section cut across the centreline at the first station it is whole at (as large as volume / length), else the largest cut."""
    seg = cl.segments[0]
    best = None
    for s in stations:
        u, v, t = seg.frame(s)
        cut = _cut_section(shape, seg.point(s), u, v, t, reach)
        if cut is None:
            continue
        sec = classify_section(cut["outer"], cut["inners"])
        if best is None or sec["area_mm2"] > best[1]["area_mm2"] + 1e-6:
            best = (cut, sec, s)
        if sec["area_mm2"] >= CUT_AREA_SHARE * expected_area:
            break
    if best is None:
        return None
    cut, sec, s = best
    return {"outer": cut["outer"], "inners": cut["inners"], "section": sec, "station": s}


def _section_centroid(outer: Sequence[Tuple[float, float]], inners: Sequence[Sequence[Tuple[float, float]]]) -> Tuple[float, float]:
    loops = [list(outer)] + [list(h) for h in inners]
    total = 0.0
    cx = cy = 0.0
    for k, loop in enumerate(loops):
        a = abs(poly_area(loop)) * (1.0 if k == 0 else -1.0)
        c = poly_centroid(loop)
        total += a
        cx += a * c[0]
        cy += a * c[1]
    if abs(total) < 1e-12:
        return poly_centroid(outer)
    return cx / total, cy / total


def _segments_2d(outlines: Sequence[Sequence[Tuple[float, float]]]):
    import numpy as np  # type: ignore

    a = [np.asarray(poly, dtype=float) for poly in outlines if len(poly) >= 2]
    return np.vstack(a), np.vstack([np.roll(x, -1, axis=0) for x in a])


def _distances(points, seg_a, seg_b):
    """Each 2D point's distance to the nearest outline segment (bar_tube.section.distance_to_outlines, vectorised)."""
    import numpy as np  # type: ignore

    p = np.asarray(points, dtype=float)
    ab = seg_b - seg_a
    ll = np.maximum((ab * ab).sum(axis=1), 1e-18)
    ap = p[:, None, :] - seg_a[None, :, :]
    t = np.clip((ap * ab[None, :, :]).sum(axis=2) / ll[None, :], 0.0, 1.0)
    proj = seg_a[None, :, :] + t[:, :, None] * ab[None, :, :]
    return np.sqrt(((p[:, None, :] - proj) ** 2).sum(axis=2)).min(axis=1)


# ── the strip: flats and bends across it ────────────────────────────────────

def _same_surface(a: Dict[str, Any], b: Dict[str, Any]) -> bool:
    if a["kind"] != b["kind"]:
        return False
    if a["kind"] == "plane":
        return _parallel(a["dir"], b["dir"]) and abs(_dot(_sub(b["point"], a["point"]), a["dir"])) <= _POS_TOL
    if a["kind"] in ("cylinder", "cone"):
        return _same_axis(a["dir"], a["point"], b["dir"], b["point"]) and abs(a["radius"] - b["radius"]) <= _POS_TOL
    if a["kind"] == "torus":
        return (_same_axis(a["dir"], a["point"], b["dir"], b["point"]) and abs(a["major"] - b["major"]) <= _POS_TOL
                and abs(a["minor"] - b["minor"]) <= _POS_TOL)
    return False


def _farthest(points: Sequence[Tuple[float, float]]) -> Tuple[float, Tuple[float, float]]:
    """The largest distance between two of the points and the unit direction between them."""
    best, direction = 0.0, (1.0, 0.0)
    pts = list(points)
    for i in range(len(pts)):
        for j in range(i + 1, len(pts)):
            dx, dy = pts[j][0] - pts[i][0], pts[j][1] - pts[i][1]
            d = math.hypot(dx, dy)
            if d > best:
                best, direction = d, (dx / d, dy / d)
    return best, direction


def _elements(skin: List[int], by_index: Dict[int, Dict[str, Any]], partners: Dict[int, List[int]], xy: Dict[int, Any],
              margin: float, bend_kind: str) -> List[Dict[str, Any]]:
    """The strip's flats and bends: its skin faces joined with their offset twins and with the other faces of the same surface where their
    traces on the section overlap (a face split along the length, or interrupted by a hole). Two coplanar flanges (a hat's feet) stay apart."""
    boxes = {i: (xy[i][:, 0].min() - margin, xy[i][:, 1].min() - margin, xy[i][:, 0].max() + margin, xy[i][:, 1].max() + margin)
             for i in skin}
    parent = {i: i for i in skin}

    def find(a: int) -> int:
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    def overlap(a: int, b: int) -> bool:
        ba, bb = boxes[a], boxes[b]
        return ba[0] <= bb[2] and bb[0] <= ba[2] and ba[1] <= bb[3] and bb[1] <= ba[3]

    skin_set = set(skin)
    for k, i in enumerate(skin):
        for j in skin[k + 1:]:
            if find(i) == find(j):
                continue
            if (j in partners.get(i, ()) and j in skin_set or _same_surface(by_index[i], by_index[j])) and overlap(i, j):
                parent[find(i)] = find(j)
    groups: Dict[int, List[int]] = {}
    for i in skin:
        groups.setdefault(find(i), []).append(i)
    out = []
    for ids in groups.values():
        ids.sort()
        out.append({"face_ids": ids, "kind": "bend" if by_index[ids[0]]["kind"] == bend_kind else "flat",
                    "area": sum(by_index[i]["area"] for i in ids)})
    out.sort(key=lambda e: e["face_ids"][0])
    return out


def _flat_trace(el: Dict[str, Any], by_index: Dict[int, Dict[str, Any]], xy: Dict[int, Any]) -> Dict[str, Any]:
    """A flat across the strip: its width at the sheet's mid-surface (the mean of its two skins' traces on the section, which differ at a
    sharp corner, where the outer skin runs on past the inner one), its direction and its two mid-surface ends on the section."""
    skins: List[List[int]] = []
    for i in sorted(el["face_ids"], key=lambda i: -by_index[i]["area"]):
        for c in skins:
            if _same_surface(by_index[c[0]], by_index[i]):
                c.append(i)
                break
        else:
            skins.append([i])
    skins = skins[:2]
    _len, w = _farthest([tuple(p) for i in skins[0] for p in xy[i].tolist()])
    lows, highs = [], []
    for c in skins:
        pts = [tuple(p) for i in c for p in xy[i].tolist()]
        along = [p[0] * w[0] + p[1] * w[1] for p in pts]
        lows.append(pts[along.index(min(along))])
        highs.append(pts[along.index(max(along))])
    e0 = (sum(p[0] for p in lows) / len(lows), sum(p[1] for p in lows) / len(lows))
    e1 = (sum(p[0] for p in highs) / len(highs), sum(p[1] for p in highs) / len(highs))
    return {"width": (e1[0] - e0[0]) * w[0] + (e1[1] - e0[1]) * w[1], "dir": w, "ends": (e0, e1)}


def _corner_angle(a: Dict[str, Any], b: Dict[str, Any]) -> float:
    """The angle the strip turns through (radians) at a sharp corner from flat a to flat b: 180 deg less the angle between them."""
    i, j = min(((i, j) for i in (0, 1) for j in (0, 1)), key=lambda ij: math.dist(a["ends"][ij[0]], b["ends"][ij[1]]))
    near_a, far_a = a["ends"][i], a["ends"][1 - i]
    near_b, far_b = b["ends"][j], b["ends"][1 - j]
    da = (near_a[0] - far_a[0], near_a[1] - far_a[1])
    db = (far_b[0] - near_b[0], far_b[1] - near_b[1])
    la, lb = math.hypot(*da), math.hypot(*db)
    if la <= 0 or lb <= 0:
        return 0.0
    return math.acos(max(-1.0, min(1.0, (da[0] * db[0] + da[1] * db[1]) / (la * lb))))


def _bend_measures(el: Dict[str, Any], by_index: Dict[int, Dict[str, Any]]) -> Tuple[float, float]:
    """(inner radius, angle in radians) of a bend: its inner skin's radius, and the arc it turns through (a cylinder's angle about its
    axis, joined over the faces of that skin; a torus's sweep about its own tube)."""
    from bar_tube.feature_extractor import _arc_from_group

    recs = [by_index[i] for i in el["face_ids"]]
    field = "radius" if recs[0]["kind"] == "cylinder" else "minor"
    inner_r = min(r[field] for r in recs)
    inner = [r for r in recs if abs(r[field] - inner_r) <= _POS_TOL]
    if recs[0]["kind"] == "cylinder":
        arc = _arc_from_group(_arcs_info([r["face"] for r in inner]), "cylinder", _POS_TOL)
        angle = arc.sweep if arc is not None else max(abs(r["adaptor"].LastUParameter() - r["adaptor"].FirstUParameter()) for r in inner)
    else:
        angle = max(abs(r["adaptor"].LastVParameter() - r["adaptor"].FirstVParameter()) for r in inner)
    return inner_r, angle


def _chain(elements: List[Dict[str, Any]], elem_of: Dict[int, int], adjacency: Dict[int, set]) -> Tuple[Optional[List[int]], bool]:
    """The elements in order across the strip (the connected run holding the most area), and whether it closes on itself. None when the
    strip branches (a part that is not one sheet)."""
    n = len(elements)
    nbrs: List[Set[int]] = [set() for _ in range(n)]
    for k, el in enumerate(elements):
        for f in el["face_ids"]:
            for g in adjacency.get(f, ()):
                m = elem_of.get(g)
                if m is not None and m != k:
                    nbrs[k].add(m)
    seen: Set[int] = set()
    comps: List[List[int]] = []
    for k in range(n):
        if k in seen:
            continue
        comp, stack = [], [k]
        seen.add(k)
        while stack:
            a = stack.pop()
            comp.append(a)
            for b in nbrs[a]:
                if b not in seen:
                    seen.add(b)
                    stack.append(b)
        comps.append(comp)
    if not comps:
        return None, False
    comp = max(comps, key=lambda c: sum(elements[k]["area"] for k in c))
    if any(len(nbrs[k]) > 2 for k in comp):
        return None, False
    if len(comp) == 1:
        return comp, False
    ends = [k for k in comp if len(nbrs[k]) == 1]
    closed = not ends
    if not closed and len(ends) != 2:
        return None, False
    start = ends[0] if not closed else comp[0]
    order, prev = [start], None
    while True:
        cur = order[-1]
        nxt = [b for b in sorted(nbrs[cur], key=lambda b: elements[b]["face_ids"][0]) if b != prev and b not in order]
        if not nxt:
            break
        prev = cur
        order.append(nxt[0])
    if len(order) != len(comp):
        return None, False
    return order, closed


def _strip(elements: List[Dict[str, Any]], order: Optional[List[int]], closed: bool, traces: Dict[int, Dict[str, Any]],
           bend_data: Dict[int, Tuple[float, float]]) -> Tuple[List[Dict[str, Any]], List[Tuple[bool, float, float]], Optional[float],
                                                              Optional[int]]:
    """The bends in strip order with the flat before each and their levels; each as (sharp, inner radius, angle in radians) for the strip
    width; the flat after the last bend; and the web element. Two flats that meet with no bend element between them meet at a sharp corner,
    a bend of inner radius 0. A closed strip that is one full-turn bend (a round tube) is two half-turn bends meeting at the seam."""
    def flat_w(k: int) -> float:
        return traces[k]["width"] if k in traces else 0.0

    def entry(kind: str, ref: Any, before: Optional[float], level: Optional[int]) -> Tuple[Dict[str, Any], Tuple[bool, float, float]]:
        if kind == "bend":
            r, a = bend_data[ref]
            face_ids = elements[ref]["face_ids"]
        else:  # a sharp corner has no face of its own
            r, a = 0.0, _corner_angle(traces[ref[0]], traces[ref[1]])
            face_ids = []
        return ({"angle_deg": _r(math.degrees(a), 2), "inner_radius_mm": _r(r, 3), "sharp": kind == "sharp", "flange_before_mm": _r(before, 3),
                 "level": level, "face_ids": face_ids}, (kind == "sharp", r, a))

    if order is None:
        made = [entry("bend", k, None, None) for k in sorted(bend_data, key=lambda k: elements[k]["face_ids"][0])]
        return [m[0] for m in made], [m[1] for m in made], None, None

    flats = [k for k in order if elements[k]["kind"] == "flat"]
    if closed:
        web = max(flats, key=lambda k: (round(flat_w(k), 3), -elements[k]["face_ids"][0])) if flats else None
        if web is not None:
            i = order.index(web)
            order = order[i:] + order[:i]
            # Round from the web towards the neighbour with the lower face id.
            if len(order) > 2 and elements[order[-1]]["face_ids"][0] < elements[order[1]]["face_ids"][0]:
                order = [order[0]] + order[1:][::-1]
    else:
        # From the edge whose first flat is narrower (ties: the lower face id).
        def head(seq: List[int]) -> Tuple[float, int]:
            first = seq[0]
            return (round(flat_w(first), 3) if elements[first]["kind"] == "flat" else 0.0, elements[first]["face_ids"][0])
        if head(order[::-1]) < head(order):
            order = order[::-1]
        web = max(flats, key=lambda k: (round(flat_w(k), 3), -order.index(k))) if flats else None

    # The strip as items in order: flats, bends, and a sharp corner wherever two flats meet.
    items: List[Tuple[str, Any]] = []
    for p, k in enumerate(order):
        items.append((elements[k]["kind"], k))
        nxt = order[p + 1] if p + 1 < len(order) else (order[0] if closed and len(order) > 1 else None)
        if nxt is not None and elements[k]["kind"] == "flat" and elements[nxt]["kind"] == "flat":
            items.append(("sharp", (k, nxt)))
    n = len(items)
    web_pos = next((p for p, it in enumerate(items) if it == ("flat", web)), None)

    def level(p: int) -> int:
        if web_pos is None:
            return 1
        lo, hi = min(p, web_pos), max(p, web_pos)
        between = sum(1 for q in range(lo + 1, hi) if items[q][0] != "flat")
        if closed:
            other = sum(1 for q in list(range(hi + 1, n)) + list(range(0, lo)) if items[q][0] != "flat")
            between = min(between, other)
        return between + 1

    made = []
    for p, (kind, ref) in enumerate(items):
        if kind == "flat":
            continue
        prev = items[p - 1] if p > 0 else (items[-1] if closed else None)
        before = flat_w(prev[1]) if prev is not None and prev[0] == "flat" else 0.0
        made.append(entry(kind, ref, before, level(p)))
    if closed and len(items) == 1 and items[0][0] == "bend" and bend_data[items[0][1]][1] >= 2.0 * math.pi - FULL_TURN_TOL_RAD:
        # A round tube: formed from the strip as two half turns that meet at the welded seam.
        r = bend_data[items[0][1]][0]
        half = dict(made[0][0], angle_deg=180.0)
        made = [(dict(half), (False, r, math.pi)), (dict(half), (False, r, math.pi))]
    last = items[-1]
    last_flange = 0.0 if closed else (flat_w(last[1]) if last[0] == "flat" else 0.0)
    return [m[0] for m in made], [m[1] for m in made], last_flange, web


# ── features and ends ───────────────────────────────────────────────────────

def _components(ids: Sequence[int], adjacency: Dict[int, set]) -> List[List[int]]:
    left = set(ids)
    out: List[List[int]] = []
    while left:
        seed = min(left)
        left.discard(seed)
        comp, stack = [seed], [seed]
        while stack:
            for n in adjacency.get(stack.pop(), ()):
                if n in left:
                    left.discard(n)
                    comp.append(n)
                    stack.append(n)
        out.append(sorted(comp))
    return out


def _shared_edges(face: Any, others: Set[int], emap: Any, fmap: Any) -> List[Any]:
    """The edges of `face` (oriented as it runs them) it shares with any of `others`."""
    return [e for e in _edges(face) if _across(e, emap, fmap) & others]


def _half_cut_length(group: Sequence[int], skins: Set[int], by_index: Dict[int, Dict[str, Any]], emap: Any, fmap: Any) -> float:
    """Half the length of the edges the group meets the sheet's skins along: the cut along the strip's mid-surface (a through cut meets
    both skins)."""
    total = 0.0
    for i in group:
        total += sum(_length(e) for e in _shared_edges(by_index[i]["face"], skins, emap, fmap))
    return total / 2.0


def _opening(group: Set[int], skin_face: int, by_index: Dict[int, Dict[str, Any]], emap: Any, fmap: Any) -> float:
    """The area the group's outline encloses on one skin face (Newell's vector area of the face's edges along the group, oriented as the
    face runs them; an outline open to the strip's edge is closed by the straight line across its ends)."""
    chains = [_edge_points(e, LOOP_DEFLECTION_MM) for e in _shared_edges(by_index[skin_face]["face"], group, emap, fmap)]
    chains = [c for c in chains if len(c) >= 2]
    if not chains:
        return 0.0
    ax = ay = az = 0.0

    def add(p: Vec, q: Vec) -> None:
        nonlocal ax, ay, az
        ax += p[1] * q[2] - p[2] * q[1]
        ay += p[2] * q[0] - p[0] * q[2]
        az += p[0] * q[1] - p[1] * q[0]

    for c in chains:
        for p, q in zip(c, c[1:]):
            add(p, q)
    tol = 1e-4
    starts = [c[0] for c in chains if not any(math.dist(c[0], d[-1]) <= tol for d in chains)]
    ends = [c[-1] for c in chains if not any(math.dist(c[-1], d[0]) <= tol for d in chains)]
    for e in ends:
        if starts:
            s = min(starts, key=lambda s: math.dist(e, s))
            starts.remove(s)
            add(e, s)
    return math.sqrt(ax * ax + ay * ay + az * az) / 2.0


def _round_hole(group: Sequence[int], by_index: Dict[int, Dict[str, Any]]) -> Optional[float]:
    """The diameter when the group is one bore: cylinders of one radius on one axis line, a full turn between them."""
    recs = [by_index[i] for i in group]
    if not recs or any(r["kind"] != "cylinder" for r in recs):
        return None
    h = recs[0]
    if not all(_same_axis(h["dir"], h["point"], r["dir"], r["point"]) and abs(r["radius"] - h["radius"]) <= _POS_TOL for r in recs):
        return None
    from bar_tube.feature_extractor import _arc_from_group

    arc = _arc_from_group(_arcs_info([r["face"] for r in recs]), "cylinder", _POS_TOL)
    sweep = arc.sweep if arc is not None else sum(abs(r["adaptor"].LastUParameter() - r["adaptor"].FirstUParameter()) for r in recs)
    return 2.0 * h["radius"] if sweep >= 2.0 * math.pi - FULL_TURN_TOL_RAD else None


def _closed_in_sheet(group: Set[int], stock: Set[int], by_index: Dict[int, Dict[str, Any]], adjacency: Dict[int, set], emap: Any,
                     fmap: Any) -> bool:
    """Whether the group meets a stock face along one of that face's inner outlines: an opening closed within the sheet."""
    from OCC.Core.BRepTools import breptools  # type: ignore
    from OCC.Core.TopAbs import TopAbs_WIRE  # type: ignore
    from OCC.Core.TopExp import TopExp_Explorer  # type: ignore
    from OCC.Core.TopoDS import topods  # type: ignore

    touching = {j for i in group for j in adjacency.get(i, ()) if j in stock}
    for j in touching:
        face = by_index[j]["face"]
        outer = breptools.OuterWire(face)
        wx = TopExp_Explorer(face, TopAbs_WIRE)
        while wx.More():
            w = topods.Wire(wx.Current())
            if not w.IsSame(outer) and any(_across(e, emap, fmap) & group for e in _edges(w)):
                return True
            wx.Next()
    return False


def _skin_normal(face_rec: Dict[str, Any], at: Vec) -> Optional[Vec]:
    """The sheet's normal on a skin face near a point: a plane's normal, a cylinder's radial direction there."""
    if face_rec["kind"] == "plane":
        return _unit(tuple(face_rec["dir"]))  # type: ignore[arg-type]
    if face_rec["kind"] == "cylinder":
        a = _unit(tuple(face_rec["dir"]))  # type: ignore[arg-type]
        rel = _sub(at, face_rec["point"])
        radial = _sub(rel, tuple(c * _dot(rel, a) for c in a))  # type: ignore[arg-type]
        if math.sqrt(_dot(radial, radial)) > 1e-9:
            return _unit(radial)
    return None


def _end_kind(group: List[int], by_index: Dict[int, Dict[str, Any]], out: Vec, section: Dict[str, Any]) -> Tuple[str, Optional[float]]:
    """(kind, cut angle) of the faces at one end: one plane (or coplanar planes) is a square or angled cut, anything else is read by
    bar_tube's end classifier (notched, slotted)."""
    from bar_tube.feature_extractor import _end_kind as bar_end_kind, surface_info

    recs = [by_index[i] for i in group]
    if recs and all(r["kind"] == "plane" for r in recs) and all(_same_surface(recs[0], r) for r in recs):
        c = abs(_dot(recs[0]["dir"], out))
        if c > 1.0 - 1e-4:
            return "square", 0.0
        return "angled", round(math.degrees(math.acos(min(1.0, c))), 2)
    info = {}
    for i, rec in zip(group, surface_info([by_index[i]["face"] for i in group])):
        rec["index"] = i
        info[i] = rec
    _ftype, variant, angle = bar_end_kind(group, info, out, section, _POS_TOL)  # type: ignore[arg-type]
    return {"notch": "notched", "slot": "slotted"}.get(variant, variant), angle


# ── the measurement ─────────────────────────────────────────────────────────

def _swept(frame: Dict[str, Any]):
    """Whether a face record is one of the swept section's surfaces for this frame."""
    if frame["kind"] == "straight":
        return lambda rec: _prismatic(rec, frame["axis"])
    return lambda rec: _revolved(rec, frame["arc"].axis, frame["point"])


def _centreline(frame: Dict[str, Any], points: Sequence[Vec], diagonal: float) -> Tuple[Centreline, float]:
    """A first centreline (a straight line through the middle of the part's extent across the axis, or an arc about the curve's axis
    through the middle of the sheet's extent) and how far the section cut must reach either side of it."""
    if frame["kind"] == "straight":
        d = frame["axis"]
        u0, v0 = _initial_frame(d)
        along = [_dot(p, d) for p in points]
        pu = [_dot(p, u0) for p in points]
        pv = [_dot(p, v0) for p in points]
        lo, hi = min(along), max(along)
        mu, mv = (min(pu) + max(pu)) / 2.0, (min(pv) + max(pv)) / 2.0
        start = tuple(mu * u0[k] + mv * v0[k] + lo * d[k] for k in range(3))
        return straight_centreline(start, d, hi - lo), diagonal  # type: ignore[arg-type]
    arc = frame["arc"]
    r_mid = (frame["r_min"] + frame["r_max"]) / 2.0
    z_mid = _dot(frame["point"], arc.axis) + (frame["z_min"] + frame["z_max"]) / 2.0
    return _arc_centreline(arc, frame["point"], r_mid, z_mid), max(frame["r_max"] - frame["r_min"], frame["z_max"] - frame["z_min"]) + 1.0


def _through_centroid(frame: Dict[str, Any], cl: Centreline, cut: Dict[str, Any]) -> Tuple[Centreline, Dict[str, Any]]:
    """A curved profile's centreline through its section's centroid (the curve's radius is the centroid's), and the cut's outline carried
    into that centreline's frame."""
    arc, point = frame["arc"], frame["point"]
    seg = cl.segments[0]
    u, v, _t = seg.frame(cut["station"])
    cx, cy = _section_centroid(cut["outer"], cut["inners"])
    on = seg.point(cut["station"])
    rel = _sub(tuple(on[k] + cx * u[k] + cy * v[k] for k in range(3)), point)  # type: ignore[arg-type]
    z = _dot(rel, arc.axis)
    radius = math.sqrt(max(_dot(rel, rel) - z * z, 0.0))
    moved = dict(cut, outer=[(x - cx, y - cy) for x, y in cut["outer"]], inners=[[(x - cx, y - cy) for x, y in h] for h in cut["inners"]])
    return _arc_centreline(arc, point, radius, _dot(point, arc.axis) + z), moved


def _stock_faces(by_index: Dict[int, Dict[str, Any]], swept, cl: Centreline, outlines: Sequence[Sequence[Tuple[float, float]]],
                 on_tol: float) -> Dict[int, Any]:
    """The stock surface (bar_tube's measure): each face swept along the centreline whose every point lies on the section outline at its
    place along the centreline, with those points in the section's frame."""
    import numpy as np  # type: ignore
    from bar_tube.feature_extractor import surface_samples

    seg_a, seg_b = _segments_2d(outlines)
    stock: Dict[int, Any] = {}
    for i in sorted(by_index):
        rec = by_index[i]
        if not swept(rec):
            continue
        try:
            samples = surface_samples(rec["face"]) + _vertices(rec["face"])
        except Exception:
            samples = _vertices(rec["face"])
        if not samples:
            continue
        located = [cl.to_section(p) for p in samples]
        if any(loc.beyond > on_tol for _xy, loc in located):
            continue
        pts = np.asarray([pt for pt, _loc in located], dtype=float)
        if float(_distances(pts, seg_a, seg_b).max()) <= on_tol:
            stock[i] = pts
    return stock


def _feature(group: List[int], gpts: List[Vec], station: float, ctx: Dict[str, Any]) -> Dict[str, Any]:
    """One punched or formed feature: its type, size, cut perimeter, opening area, depth, station and faces."""
    by_index, twinned, skins, emap, fmap = ctx["by_index"], ctx["twinned"], ctx["skins"], ctx["emap"], ctx["fmap"]
    gset = set(group)
    # The skin the feature is cut through: the one it shares the longest edge with.
    touching = {j for i in group for j in ctx["adjacency"].get(i, ()) if j in skins}
    skin_face = max(touching, key=lambda j: sum(_length(e) for e in _shared_edges(by_index[j]["face"], gset, emap, fmap)), default=None)
    centre: Vec = tuple(sum(p[k] for p in gpts) / len(gpts) for k in range(3))  # type: ignore[assignment]
    normal = _skin_normal(by_index[skin_face], centre) if skin_face is not None else None
    cut_faces = [i for i in group if i not in twinned]
    diameter = _round_hole(group, by_index) if len(cut_faces) == len(group) else None
    if gset & ctx["lance_faces"]:
        ftype = "Lance"
    elif gset & ctx["form_faces"]:
        ftype = "Form"
    elif len(cut_faces) == len(group):
        ftype = "SimpleHole" if diameter is not None else (
            "ComplexHole" if _closed_in_sheet(gset, ctx["stock"], by_index, ctx["adjacency"], emap, fmap) else "Cutout")
    elif not cut_faces:
        ftype = "Form"
    else:
        formed = [by_index[i] for i in group if i in twinned]
        # A hole whose rim is drawn up (an extruded hole) is formed about one axis; a lance's tab is cut and bent.
        about_one_axis = all(r["kind"] in ("cylinder", "cone", "torus") and _same_axis(formed[0]["dir"], formed[0]["point"], r["dir"], r["point"])
                             for r in formed)
        ftype = "Form" if about_one_axis else "Lance"
    if diameter is not None:
        size: float = diameter
        area: Optional[float] = math.pi * diameter * diameter / 4.0
    else:
        t_dir = ctx["cl"].locate(centre).t
        if normal is not None:
            across = _unit(_cross(normal, t_dir))
            size = min_area_rect([(_dot(p, t_dir), _dot(p, across)) for p in gpts])[0]
        else:
            size = _farthest([(_dot(p, t_dir), 0.0) for p in gpts])[0]
        area = _opening(gset, skin_face, by_index, emap, fmap) if skin_face is not None else None
    depth = None
    if ftype in ("Lance", "Form") and normal is not None:
        along_n = [_dot(p, normal) for p in gpts]
        depth = max(0.0, max(along_n) - min(along_n) - ctx["thickness"])
    return {
        "feature_type": ftype,
        "size_mm": _r(size, 2),
        "perimeter_mm": _r(_half_cut_length(group, skins, by_index, emap, fmap), 2),
        "area_mm2": _r(area, 1),
        "depth_mm": _r(depth, 2),
        "station_mm": _r(station, 2),
        "face_ids": group,
    }


def _features_and_ends(ctx: Dict[str, Any], section: Dict[str, Any], on_tol: float) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    """The faces off the stock surface, joined where they touch: at an end, that end's cut; elsewhere, a feature along the length."""
    cl, by_index, cloud = ctx["cl"], ctx["by_index"], ctx["cloud"]
    length = cl.length
    end_zone = max(2.0 * on_tol, 0.5)
    seg0, seg1 = cl.segments[0], cl.segments[-1]
    features: List[Dict[str, Any]] = []
    ends: List[Dict[str, Any]] = []
    for group in _components([i for i in sorted(by_index) if i not in ctx["stock"]], ctx["adjacency"]):
        gpts = [p for i in group for p in cloud(i)]
        if not gpts:
            continue
        locs = [cl.locate(p) for p in gpts]
        lo = min(loc.station - loc.beyond for loc in locs)
        hi = max(loc.station + loc.beyond for loc in locs)
        at_start = not cl.closed and lo <= end_zone
        at_end = not cl.closed and hi >= length - end_zone
        if not (at_start or at_end):
            features.append(_feature(group, gpts, (lo + hi) / 2.0, ctx))
            continue
        which = "start" if at_start and not at_end else "end" if at_end and not at_start else ("start" if lo <= length - hi else "end")
        out = tuple(-c for c in seg0.tangent(0.0)) if which == "start" else seg1.tangent(seg1.length)
        kind, angle = _end_kind(group, by_index, out, section)  # type: ignore[arg-type]
        ends.append({"end": which, "kind": kind, "cut_angle_deg": angle,
                     "cut_perimeter_mm": _r(_half_cut_length(group, ctx["skins"], by_index, ctx["emap"], ctx["fmap"]), 2),
                     "face_ids": group})
    features.sort(key=lambda f: (f["station_mm"], f["face_ids"][0]))
    for which in ("start", "end"):
        if not cl.closed and not any(e["end"] == which for e in ends):
            # An end with no face of its own off the stock surface: a square cut.
            ends.append({"end": which, "kind": "square", "cut_angle_deg": 0.0, "cut_perimeter_mm": None, "face_ids": []})
    ends.sort(key=lambda e: 0 if e["end"] == "start" else 1)
    return features, ends


def measure_roll_form(
    shape: Any,
    thickness: float,
    sheet_faces: Optional[Dict[str, Any]],
    lances: Optional[Sequence[Dict[str, Any]]] = None,
    formed_features: Optional[Sequence[Dict[str, Any]]] = None,
) -> Optional[Dict[str, Any]]:
    """
    The roll-forming measurements of one sheet part (the module docstring), or None when the part is not a profile.

    sheet_faces       drawn_shell.analyse_sheet_faces(shape, thickness)
    lances, formed_features   the extractor's lance and formed-feature candidates: a feature group holding a recognised one's faces is a
                      Lance or a Form
    A sheet with no flat (a round tube) has no thickness the extractor can read (it reads it between flats); its wall is read from its
    concentric cylinders here, and its faces analysed again at that thickness.
    """
    if thickness <= 0 or not sheet_faces:
        return None
    by_index, partners, twinned, adjacency = (sheet_faces["by_index"], sheet_faces["partners"], sheet_faces["twinned"],
                                              sheet_faces["adjacency"])
    skin_area = sum(by_index[i]["area"] for i in twinned)
    frame = None
    if skin_area > 0:
        frame = _curved_axis(by_index, twinned, adjacency, skin_area) or _straight_axis(shape, by_index, twinned, adjacency, skin_area)
    if frame is None:
        frame = _tube_axis(by_index)
        if frame is None:
            return None
        if abs(frame["wall"] - thickness) > max(0.1 * frame["wall"], 0.02):
            from sheet_metal.features.drawn_shell import analyse_sheet_faces

            thickness = frame["wall"]
            sheet_faces = analyse_sheet_faces(shape, thickness)
            by_index, partners, twinned, adjacency = (sheet_faces["by_index"], sheet_faces["partners"], sheet_faces["twinned"],
                                                      sheet_faces["adjacency"])

    from bar_tube.feature_extractor import STOCK_FRACTION
    from OCC.Core.BRepGProp import brepgprop  # type: ignore
    from OCC.Core.GProp import GProp_GProps  # type: ignore

    faces_all = sorted(by_index)
    clouds: Dict[int, List[Vec]] = {}

    def cloud(i: int) -> List[Vec]:
        if i not in clouds:
            clouds[i] = _edge_cloud(by_index[i]["face"]) or _vertices(by_index[i]["face"])
        return clouds[i]

    points = [p for i in faces_all for p in cloud(i)]
    if not points:
        return None
    lows = [min(p[k] for p in points) for k in range(3)]
    highs = [max(p[k] for p in points) for k in range(3)]
    diagonal = math.dist(lows, highs) or 1.0
    props = GProp_GProps()
    brepgprop.VolumeProperties(shape, props)
    volume = abs(props.Mass())
    # A solid whose faces point inward (negative volume) is cut as the solid it bounds.
    cut_shape = shape.Reversed() if props.Mass() < 0 else shape

    cl, reach = _centreline(frame, points, diagonal)
    if cl.length <= 0:
        return None
    # The section is cut clear of the features: the faces off the swept surfaces (holes, notches, forms, the ends) span stations.
    swept = _swept(frame)
    spans = []
    for i in faces_all:
        if not swept(by_index[i]):
            st = [cl.locate(p).station for p in cloud(i)]
            spans.append((min(st), max(st)))
    cut = _cut(cut_shape, cl, reach, volume / cl.length, _free_stations(cl, spans))
    if cut is None:
        logger.warning("[RollForm] the cross-section could not be cut")
        return None
    if frame["kind"] == "curved":
        cl, cut = _through_centroid(frame, cl, cut)
    section = cut["section"]
    length = cl.length

    size = max(section["width_mm"], section["height_mm"], 1.0)
    on_tol = max(_POS_TOL, min(0.005 * size, 0.05 * thickness))
    xy = _stock_faces(by_index, swept, cl, [cut["outer"]] + list(cut["inners"]), on_tol)
    stock = set(xy)
    stock_fraction = sum(by_index[i]["area"] for i in stock) / (sum(by_index[i]["area"] for i in faces_all) or 1.0)

    # The strip across the section: its flats and bends, in order.
    skin = sorted(stock & twinned)
    elements = _elements(skin, by_index, partners, xy, thickness + on_tol, "cylinder" if frame["kind"] == "straight" else "torus")
    elem_of = {f: k for k, el in enumerate(elements) for f in el["face_ids"]}
    traces: Dict[int, Dict[str, Any]] = {}
    bend_data: Dict[int, Tuple[float, float]] = {}
    for k, el in enumerate(elements):
        if el["kind"] == "flat":
            traces[k] = _flat_trace(el, by_index, xy)
        else:
            bend_data[k] = _bend_measures(el, by_index)
    order, closed_strip = _chain(elements, elem_of, adjacency)
    if order is not None:
        bend_data = {k: b for k, b in bend_data.items() if k in set(order)}
        if len(order) == 1 and order[0] in bend_data and bend_data[order[0]][1] >= 2.0 * math.pi - FULL_TURN_TOL_RAD:
            closed_strip = True  # one bend all the way round: a round tube
    bends, turns, last_flange, web = _strip(elements, order, closed_strip, traces, bend_data)

    strip_width = section["area_mm2"] / thickness
    strip_neutral = None
    strip_check = None
    if order is not None:
        # The flats are read at the mid-surface: at a sharp corner each runs on to the corner of the mid-surface, t/2 tan(angle/2) past
        # the inner corner, which the neutral fibre (bending about the inner corner, K 0.33) does not.
        flats_sum = sum(traces[k]["width"] for k in order if k in traces)
        arcs_mid = sum(a * (r + thickness / 2.0) for sharp, r, a in turns if not sharp)
        strip_neutral = flats_sum
        for sharp, r, a in turns:
            k_factor = 0.33 if r < 2.0 * thickness else 0.41
            strip_neutral += a * (r + k_factor * thickness)
            if sharp and a < math.radians(179.0):
                strip_neutral -= thickness * math.tan(a / 2.0)
        strip_check = {"flats_mm": _r(flats_sum, 3), "bend_arcs_mm": _r(arcs_mid, 3),
                       "agrees": abs(flats_sum + arcs_mid - strip_width) <= STRIP_AGREE * strip_width}

    if frame.get("sharp_only") and not (stock_fraction >= STOCK_FRACTION and bends and strip_check and strip_check["agrees"]):
        # Found by sharp corners alone (flats meeting with no bend radius), which a machined or welded part has too: it is a profile only
        # when it is one section along its length and that section is a strip of the sheet bent at its corners.
        return None

    # The section's width along the web and height across it.
    width, height = section["width_mm"], section["height_mm"]
    if web is not None:
        wx, wy = traces[web]["dir"]
        along_w = [x * wx + y * wy for x, y in cut["outer"]]
        across_w = [-x * wy + y * wx for x, y in cut["outer"]]
        width, height = max(along_w) - min(along_w), max(across_w) - min(across_w)

    ctx = {
        "cl": cl, "by_index": by_index, "twinned": twinned, "adjacency": adjacency, "stock": stock, "skins": stock & twinned,
        "emap": _edge_face_map(shape), "fmap": _face_index_map(shape), "cloud": cloud, "thickness": thickness,
        "lance_faces": {f for c in lances or () if c.get("recognition_status") == "recognized" for f in c.get("face_ids") or ()},
        "form_faces": {f for c in formed_features or () if c.get("recognition_status") == "recognized" for f in c.get("face_ids") or ()},
    }
    features, ends = _features_and_ends(ctx, section, on_tol)

    tube = None
    if section["hollows"] > 0:
        # A closed section: a tube rolled from the strip and welded along its seam.
        tube = {"outer_diameter_mm": _r(section.get("od_mm"), 2) if section["stock_form"] == "ROUND_TUBE" else None,
                "outer_width_mm": _r(width, 2), "outer_height_mm": _r(height, 2), "wall_mm": _r(section.get("wall_mm") or thickness, 3)}
    curve = None
    axis_out = frame["axis"]
    if frame["kind"] == "curved":
        arc = cl.segments[0].bend
        assert arc is not None
        axis_out = cl.segments[0].tangent(length / 2.0)  # the chord's direction
        curve = {"radius_mm": _r(arc.radius, 2), "angle_deg": _r(math.degrees(arc.sweep), 2), "axis": [_r(c, 4) for c in arc.axis]}
    return {
        "version": VERSION,
        "axis": [_r(c, 4) for c in axis_out],
        "axis_source": "bends" if frame["kind"] == "straight" else "curve",
        "length_mm": _r(length, 2),
        "constant_section": stock_fraction >= STOCK_FRACTION,
        "stock_fraction": _r(stock_fraction, 4),
        "section": {
            "height_mm": _r(height, 2),
            "width_mm": _r(width, 2),
            "area_mm2": _r(section["area_mm2"], 2),
            "perimeter_mm": _r(section["perimeter_mm"], 2),
            "closed": section["hollows"] > 0,
            "stock_form": section["stock_form"],
        },
        "strip_width_mm": _r(strip_width, 2),
        "strip_width_neutral_mm": _r(strip_neutral, 2),
        "strip_width_check": strip_check,
        "thickness_mm": _r(thickness, 3),
        "bends": bends,
        "last_flange_mm": _r(last_flange, 3),
        "tube": tube,
        "curve": curve,
        "features": features,
        "ends": ends,
    }
