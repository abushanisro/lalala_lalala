"""
The raw stock a machined part is cut from, measured from the solid ("stock", stk_v1).

A machined part starts as a length of stock sawn from a bar, a plate or a tube: round bar, rectangular or square bar, hex bar, plate, round
tube. Which stock, how much larger than the part and what it costs are decided in the backend from the reference data. This measures what
that rests on:

  axis            the direction the stock runs along (unit vector, its first component that is not zero positive): the axis about which
                  the smallest stock holds the part. Tried: the turning axis, when the part has turned outer diameters
                  (shared.machining_geometry.turning_axis), as round bar about it; and each side of the part's exact boxes in the
                  model's axes and in its principal axes of inertia, as the smallest of the round, the rectangle and the hexagon
                  around the part seen along it.
  axis_source     "turned" when that is the turning axis (round bar about it is no larger than any other stock); "box" otherwise: a side
                  of a box, the longest of those the smallest stock runs along (a block's rectangle is the same size along each side:
                  it is cut along its length), the model's own axes first; or, when that rectangle is wider than the part is long
                  (a part lying askew in the model), the direction of its width.
  length_mm       the part's extent along the axis: the length sawn, before any allowance.
  round           the smallest circle around the part seen along the axis; centred on the turning axis when "turned".
  rect            the smallest rectangle around the part seen along the axis, width >= height. angle_deg is the direction of its width in
                  the plane across the axis, measured from the first of the two directions _across() gives toward the second (0 to 180).
                  Its height runs along the axis crossed with that direction.
  hex             the distance across flats, when the part's outline seen along the axis is a regular hexagon; else None.
  bore            a hole through the whole part on the circle's centre line (round tube stock), as the diameter of the largest round
                  that passes it: a stepped bore gives its smallest step, a bore with a flat the round inside the flat. None when that
                  line meets the material or is no inner cylinder's axis.
  end_faces       the planar faces square to the axis at each end of the part ("min", "max" along the axis): where the saw cuts lie.
  stock_surface   the faces lying on each envelope, with their area: a surface the stock already has, machined only when the stock carries
                  an allowance there. round: outer cylinders at the circle; rect: planar faces on the rectangle's four sides ("w+" and "w-"
                  bound the width, "h+" and "h-" the height, + on the side its direction points to); hex: planar faces on the hexagon's flats.

Face ids are TopExp_Explorer ordinals, as everywhere in machining_features (machining/face_coverage.py).

"Seen along the axis" is the hull of the part's mesh nodes projected on the plane across the axis: it gives the rectangle's direction, the
circle and the hexagon. The sizes are the solid's own extents in that frame, not the mesh's. A face lies on an envelope when every node of
it is within shared.machining_geometry.envelope_tolerance of it, and an envelope a face lies on takes that face's own size: a blend surface
standing a few microns proud of a Ø14 turned diameter leaves the round at 14.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Sequence, Tuple

import numpy as np

from injection_molding.recognition.mesh import FaceMesh, tessellate_faces
from shared.machining_geometry import ENVELOPE_TOLERANCE_MM, _one_way, envelope_tolerance, turning_axis
from shared.planar_outline import Pt, enclosing_circle, hull, min_area_rect, regular_hexagon
from shared.solid_measures import principal_axes

VERSION = "stk_v1"

# A face's outward normal is along a direction when their cosine is above this (0.5 degrees): the node test then says whether it lies there.
_ALONG = math.cos(math.radians(0.5))
# Two stocks (or two lengths) differing by less than this share are the same size: rounding does not choose the axis.
_SAME_SIZE = 1e-6


# ---------------------------------------------------------------------------------------------------------------------------------------
# Frames and exact extents
# ---------------------------------------------------------------------------------------------------------------------------------------

def _unit(v: Sequence[float]) -> np.ndarray:
    a = np.asarray(v, dtype=np.float64)
    n = float(np.linalg.norm(a))
    if n < 1e-12:
        raise ValueError("a direction cannot be the zero vector")
    return a / n


def _across(axis: np.ndarray) -> Tuple[np.ndarray, np.ndarray]:
    """Two unit directions across the axis, the same two for the same axis: the model's X made square to the axis (its Y when the axis is
    within 26 degrees of X), and the axis crossed with it. The rectangle's angle_deg is measured from the first toward the second."""
    ref = np.array([1.0, 0.0, 0.0]) if abs(axis[0]) < 0.9 else np.array([0.0, 1.0, 0.0])
    u = _unit(ref - axis * float(ref @ axis))
    return u, np.cross(axis, u)


def _deflection(shape: Any) -> float:
    """The mesh chord error the outline is read at, as bar and tube reads a section's surface (bar_tube/feature_extractor.py)."""
    from OCC.Core.Bnd import Bnd_Box  # type: ignore
    from OCC.Core.BRepBndLib import brepbndlib  # type: ignore

    box = Bnd_Box()
    brepbndlib.Add(shape, box)
    x0, y0, z0, x1, y1, z1 = box.Get()
    return max(0.02, math.sqrt((x1 - x0) ** 2 + (y1 - y0) ** 2 + (z1 - z0) ** 2) * 0.0005)


def _extents(shape: Any, nodes: np.ndarray, a: np.ndarray, b: np.ndarray, c: np.ndarray, deflection: float) -> List[Tuple[float, float]]:
    """
    The part's extent along three directions square to each other (b = c x a), as (low, high) each: the solid's exact box in that frame.
    The mesh nodes check it: they lie on the part, so the box cannot be inside them, and a box standing off them by more than the mesh's
    own chord error is not tight (an exact box can be loose on a trimmed face); the nodes' extent is taken then.
    """
    from OCC.Core.Bnd import Bnd_Box  # type: ignore
    from OCC.Core.BRepBndLib import brepbndlib  # type: ignore
    from OCC.Core.gp import gp_Ax3, gp_Dir, gp_Pnt, gp_Trsf  # type: ignore
    from OCC.Core.TopLoc import TopLoc_Location  # type: ignore

    to_frame = gp_Trsf()
    to_frame.SetTransformation(gp_Ax3(gp_Pnt(0.0, 0.0, 0.0), gp_Dir(*(float(x) for x in c)), gp_Dir(*(float(x) for x in a))))
    box = Bnd_Box()
    box.SetGap(0.0)
    brepbndlib.AddOptimal(shape.Moved(TopLoc_Location(to_frame)), box, False, False)
    x0, y0, z0, x1, y1, z1 = box.Get()
    slack = 2.0 * deflection + ENVELOPE_TOLERANCE_MM
    out: List[Tuple[float, float]] = []
    for direction, lo, hi in ((a, x0, x1), (b, y0, y1), (c, z0, z1)):
        along = nodes @ direction
        n_lo, n_hi = float(along.min()), float(along.max())
        out.append((min(lo, n_lo) if n_lo - lo <= slack else n_lo, max(hi, n_hi) if hi - n_hi <= slack else n_hi))
    return out


# ---------------------------------------------------------------------------------------------------------------------------------------
# Faces
# ---------------------------------------------------------------------------------------------------------------------------------------

@dataclass
class _Face:
    index: int
    kind: str                           # "plane" | "outer_cylinder" | "inner_cylinder" | "other"
    area: float
    nodes: np.ndarray                   # the face's mesh nodes, (n, 3)
    normal: Optional[np.ndarray] = None       # a plane's outward normal
    radius: Optional[float] = None            # a cylinder's radius,
    axis: Optional[np.ndarray] = None         # its axis direction
    on_axis: Optional[np.ndarray] = None      # and a point on its axis


def _faces(meshes: Sequence[FaceMesh]) -> List[_Face]:
    out: List[_Face] = []
    for m in meshes:
        nodes = np.asarray([v for t in m.triangles for v in t.vertices], dtype=np.float64).reshape(-1, 3)
        face = _Face(index=m.index, kind="other", area=float(m.area), nodes=nodes)
        if m.triangles and m.surface == "plane":
            face.kind, face.normal = "plane", _unit(m.triangles[0].normal)
        elif m.triangles and m.surface == "cylinder" and m.revolved is not None:
            # Outer (convex) when the material is inside it: a triangle's outward normal points away from the cylinder's axis.
            t = m.triangles[0]
            face.axis, face.on_axis, face.radius = _unit(m.revolved.axis), np.asarray(m.revolved.axis_point, dtype=np.float64), float(m.revolved.radius)
            rel = np.asarray(t.centroid, dtype=np.float64) - face.on_axis
            radial = rel - face.axis * float(rel @ face.axis)
            face.kind = "outer_cylinder" if float(np.asarray(t.normal, dtype=np.float64) @ radial) > 0.0 else "inner_cylinder"
        out.append(face)
    return out


def _on_plane(face: _Face, outward: np.ndarray, offset: float, tol: float) -> bool:
    """A planar face facing `outward` whose every node is at `offset` along it (within tol)."""
    if face.kind != "plane" or float(face.normal @ outward) < _ALONG:
        return False
    return bool(np.all(np.abs(face.nodes @ outward - offset) <= tol))


def _plane_offset(faces: Sequence[_Face], outward: np.ndarray, offset: float, tol: float) -> Tuple[List[_Face], float]:
    """The planar faces on a flat side of an envelope, and the side's offset: the largest such face's own, when there is one."""
    on = [f for f in faces if _on_plane(f, outward, offset, tol)]
    if on:
        offset = float(np.mean(max(on, key=lambda f: f.area).nodes @ outward))
    return on, offset


# ---------------------------------------------------------------------------------------------------------------------------------------
# The envelope about one axis
# ---------------------------------------------------------------------------------------------------------------------------------------

@dataclass
class _Envelope:
    axis: np.ndarray
    source: str
    u0: np.ndarray
    v0: np.ndarray
    outline: List[Pt]                      # the hull of the nodes seen along the axis, in (u0, v0)
    centre: Tuple[float, float]            # the circle's centre, in (u0, v0)
    radius: float
    round_faces: List[_Face]
    angle_deg: float                       # the direction of the rectangle's width, in (u0, v0)
    width_dir: np.ndarray
    width: float
    height: float
    sides: Dict[str, List[_Face]]          # "w+", "w-", "h+", "h-": the planar faces on each side of the rectangle
    hexagon: Optional[Dict[str, Any]]      # the outline as a regular hexagon (its corners, across flats), or None
    span: Tuple[float, float]              # the part's extent along the axis (low, high)
    length: float
    ends: Dict[str, List[_Face]]           # "min", "max": the planar faces at each end

    @property
    def round_volume(self) -> float:
        return math.pi * self.radius ** 2 * self.length

    @property
    def rect_volume(self) -> float:
        return self.width * self.height * self.length

    @property
    def smallest_volume(self) -> float:
        """The smallest stock along this axis: round bar, rectangular bar or, for a hexagon outline, hex bar."""
        volumes = [self.round_volume, self.rect_volume]
        if self.hexagon is not None:
            volumes.append(math.sqrt(3.0) / 2.0 * float(self.hexagon["across_flats_mm"]) ** 2 * self.length)
        return min(volumes)


def _envelope(shape: Any, faces: Sequence[_Face], nodes: np.ndarray, axis: np.ndarray, source: str, deflection: float,
              centre_point: Optional[Sequence[float]] = None, turned_radius: float = 0.0, side: Optional[np.ndarray] = None) -> _Envelope:
    """The round and the rectangle around the part seen along `axis`, its length and the faces on them. With centre_point (a point on the
    turning axis) the circle is centred there and is no smaller than turned_radius. With `side` (a direction across the axis) the rectangle
    with a side along it is tried too, and kept unless the outline's own is smaller."""
    u0, v0 = _across(axis)
    outline = hull(list(zip((nodes @ u0).tolist(), (nodes @ v0).tolist())))
    if len(outline) < 3:
        raise ValueError("the part has no outline seen along its axis")

    # The circle: about the turning axis, or the smallest there is. It takes the radius of the largest outer cylinder lying on it.
    if centre_point is not None:
        on_axis = np.asarray(centre_point, dtype=np.float64)
        centre = (float(on_axis @ u0), float(on_axis @ v0))
        radius = max(turned_radius, max(math.dist(centre, p) for p in outline))
    else:
        centre, radius = enclosing_circle(outline)
    centre_3d = u0 * centre[0] + v0 * centre[1]
    round_tol = envelope_tolerance(2.0 * radius)

    def on_round(f: _Face) -> bool:
        if f.kind != "outer_cylinder" or abs(f.radius - radius) > round_tol:
            return False
        rel = f.nodes - centre_3d
        reach = np.linalg.norm(rel - np.outer(rel @ axis, axis), axis=1)
        return bool(np.all(np.abs(reach - radius) <= round_tol))

    round_faces = [f for f in faces if on_round(f)]
    if round_faces:
        radius = max(f.radius for f in round_faces)

    def rectangle(angle_deg: float):
        """The rectangle with its width along the direction at angle_deg: its sizes from the solid, each side at the planar face lying on
        it (or at the circle's cylinder, where the circle touches it)."""
        a = math.radians(angle_deg)
        w_dir = u0 * math.cos(a) + v0 * math.sin(a)
        h_dir = np.cross(axis, w_dir)
        extents = _extents(shape, nodes, w_dir, h_dir, axis, deflection)
        sides: Dict[str, List[_Face]] = {}
        sizes: List[float] = []
        for name, direction, (lo, hi) in (("w", w_dir, extents[0]), ("h", h_dir, extents[1])):
            tol = envelope_tolerance(hi - lo)
            if round_faces:
                c = float(centre_3d @ direction)
                lo = c - radius if abs(lo - (c - radius)) <= round_tol else lo
                hi = c + radius if abs(hi - (c + radius)) <= round_tol else hi
            sides[f"{name}-"], minus = _plane_offset(faces, -direction, -lo, tol)
            sides[f"{name}+"], plus = _plane_offset(faces, direction, hi, tol)
            sizes.append(plus + minus)
        return angle_deg, w_dir, sizes[0], sizes[1], sides, extents[2]

    def widest_first(angle_deg: float):
        found = rectangle(angle_deg)
        return found if found[2] >= found[3] else rectangle((angle_deg + 90.0) % 180.0)

    # The rectangle's direction from the outline (an angle a hair under 180 is 0: one direction, one name); width is its longer side.
    angle, width_dir, width, height, sides, span = widest_first(round(min_area_rect(outline)[2], 6) % 180.0)
    if side is not None:
        given = widest_first(round(math.degrees(math.atan2(float(side @ v0), float(side @ u0))), 6) % 180.0)
        if given[2] * given[3] <= width * height * (1.0 + _SAME_SIZE):
            angle, width_dir, width, height, sides, span = given

    # The ends: the planar faces square to the axis at each extreme, and the length between them.
    end_tol = envelope_tolerance(span[1] - span[0])
    low_faces, low = _plane_offset(faces, -axis, -span[0], end_tol)
    high_faces, high = _plane_offset(faces, axis, span[1], end_tol)

    return _Envelope(axis=axis, source=source, u0=u0, v0=v0, outline=outline, centre=centre, radius=radius, round_faces=round_faces,
                     angle_deg=angle, width_dir=width_dir, width=width, height=height, sides=sides, hexagon=regular_hexagon(outline), span=span,
                     length=high + low, ends={"min": low_faces, "max": high_faces})


def _named(axis: Sequence[float]) -> np.ndarray:
    """The axis under its one name (its first component that is not zero positive): "min" and "max", and the rectangle's sides, follow it."""
    return np.asarray(_one_way(tuple(float(x) for x in axis)), dtype=np.float64)


def _box_axes(shape: Any, nodes: np.ndarray, deflection: float) -> List[np.ndarray]:
    """The sides of the part's boxes, each direction once: the model's axes first, then its principal axes of inertia (a part modelled off
    the model's axes lies along them); within a box, the longest side first."""
    frames: List[Tuple[np.ndarray, np.ndarray]] = [(np.array([1.0, 0.0, 0.0]), np.array([0.0, 0.0, 1.0]))]  # (first side, third side)
    try:
        _, inertia = principal_axes(shape)
        frames.append((_unit(inertia[0]), _unit(inertia[2])))
    except Exception:  # a shape with no volume has no inertia: the model's axes stand
        pass

    axes: List[np.ndarray] = []
    for a, c in frames:
        c = _unit(c - a * float(c @ a))
        sides = (a, np.cross(c, a), c)
        spans = [hi - lo for lo, hi in _extents(shape, nodes, sides[0], sides[1], sides[2], deflection)]
        for i in sorted(range(3), key=lambda k: -spans[k]):
            if not any(abs(float(sides[i] @ seen)) >= _ALONG for seen in axes):
                axes.append(_named(sides[i]))
    return axes


# ---------------------------------------------------------------------------------------------------------------------------------------
# The measurement
# ---------------------------------------------------------------------------------------------------------------------------------------

def _clear_bore(shape: Any, faces: Sequence[_Face], env: _Envelope) -> Optional[float]:
    """
    The diameter of the largest round that passes through the whole part along the circle's centre line, when a hole runs there: twice the
    least distance from that line, over the part's length, to the part. None when the line meets the material, or when no inner cylinder
    has that line for its axis (the gap of an open channel is not a bore).
    """
    from OCC.Core.BRepBuilderAPI import BRepBuilderAPI_MakeEdge  # type: ignore
    from OCC.Core.BRepExtrema import BRepExtrema_DistShapeShape  # type: ignore
    from OCC.Core.gp import gp_Pnt  # type: ignore

    centre = env.u0 * env.centre[0] + env.v0 * env.centre[1]
    tol = envelope_tolerance(2.0 * env.radius)

    def coaxial(f: _Face) -> bool:
        if f.kind != "inner_cylinder" or abs(float(f.axis @ env.axis)) < _ALONG:
            return False
        off = f.on_axis - centre
        return float(np.linalg.norm(off - env.axis * float(off @ env.axis))) <= tol

    if not any(coaxial(f) for f in faces):
        return None
    ends = [centre + env.axis * s for s in env.span]
    line = BRepBuilderAPI_MakeEdge(gp_Pnt(*(float(x) for x in ends[0])), gp_Pnt(*(float(x) for x in ends[1]))).Edge()
    dist = BRepExtrema_DistShapeShape(line, shape)
    if not dist.IsDone():
        raise ValueError("the distance from the stock's centre line to the part could not be measured")
    clear = float(dist.Value())
    return 2.0 * clear if clear > ENVELOPE_TOLERANCE_MM else None


def _hexagon_faces(env: _Envelope, faces: Sequence[_Face], hexagon: Dict[str, Any]) -> List[_Face]:
    """The planar faces on the hexagon's six flats."""
    corners: List[Pt] = hexagon["corners"]
    tol = envelope_tolerance(float(hexagon["across_flats_mm"]))
    outline = np.asarray(env.outline, dtype=np.float64)
    on_flats: Dict[int, _Face] = {}
    for i in range(len(corners)):
        (x0, y0), (x1, y1) = corners[i], corners[(i + 1) % len(corners)]
        edge = math.hypot(x1 - x0, y1 - y0)
        across = np.array([(y1 - y0) / edge, -(x1 - x0) / edge])   # the flat's outward direction: the corners run counter-clockwise
        outward = env.u0 * across[0] + env.v0 * across[1]
        offset = float(np.max(outline @ across))
        on_flats.update({f.index: f for f in faces if _on_plane(f, outward, offset, tol)})
    return [on_flats[i] for i in sorted(on_flats)]


def measure_stock(shape: Any) -> Dict[str, Any]:
    """The stock envelope of a machined part (see the module docstring for each key)."""
    deflection = _deflection(shape)
    faces = _faces(tessellate_faces(shape, linear_deflection=deflection))
    meshed = [f.nodes for f in faces if len(f.nodes)]
    if not meshed:
        raise ValueError("the part has no mesh to measure its stock from")
    nodes = np.unique(np.round(np.concatenate(meshed), 6), axis=0)

    # The axis of the smallest stock. Round bar about the turning axis when nothing is smaller; else the longest of the box sides the
    # smallest stock runs along, the model's own first.
    boxes = [_envelope(shape, faces, nodes, axis, "box", deflection) for axis in _box_axes(shape, nodes, deflection)]
    smallest = min(e.smallest_volume for e in boxes)
    tied = [e for e in boxes if e.smallest_volume <= smallest * (1.0 + _SAME_SIZE)]
    longest = max(e.length for e in tied)
    env = next(e for e in tied if e.length >= longest * (1.0 - _SAME_SIZE))
    # A rectangular block wider than it is long (a part lying askew in the model, measured along a model axis) is the same block cut
    # along its width: it is named by its longest side.
    for _ in range(2):
        if env.rect_volume > env.smallest_volume * (1.0 + _SAME_SIZE) or env.width <= env.length * (1.0 + _SAME_SIZE):
            break
        along_width = _envelope(shape, faces, nodes, _named(env.width_dir), "box", deflection, side=env.axis)
        if along_width.smallest_volume > env.smallest_volume * (1.0 + _SAME_SIZE):
            break
        env = along_width
    smallest = min(smallest, env.smallest_volume)
    line = turning_axis(shape)
    if line is not None and line["diameters"]:
        turned = _envelope(shape, faces, nodes, _named(line["direction"]), "turned", deflection,
                           centre_point=line["point"], turned_radius=float(line["largest_radius_mm"]))
        if turned.round_volume <= smallest * (1.0 + _SAME_SIZE):
            env = turned

    hexagon = env.hexagon
    bore = _clear_bore(shape, faces, env)

    def ids(found: Sequence[_Face]) -> List[int]:
        return sorted(f.index for f in found)

    return {
        "version": VERSION,
        "axis": [round(float(x) + 0.0, 6) for x in env.axis],
        "axis_source": env.source,
        "length_mm": round(env.length, 3),
        "round": {"od_mm": round(2.0 * env.radius, 3)},
        "rect": {"width_mm": round(env.width, 3), "height_mm": round(env.height, 3), "angle_deg": round(env.angle_deg, 3)},
        "hex": {"across_flats_mm": round(float(hexagon["across_flats_mm"]), 3)} if hexagon is not None else None,
        "bore": {"diameter_mm": round(bore, 3)} if bore is not None else None,
        "end_faces": {"min": ids(env.ends["min"]), "max": ids(env.ends["max"])},
        "stock_surface": {
            "round": [{"face_id": f.index, "kind": "CurvedWall", "area_mm2": round(f.area, 3)} for f in sorted(env.round_faces, key=lambda f: f.index)],
            "rect": [{"face_id": f.index, "kind": "PlanarFace", "side": side, "area_mm2": round(f.area, 3)}
                     for side in ("w+", "w-", "h+", "h-") for f in sorted(env.sides[side], key=lambda f: f.index)],
            "hex": [{"face_id": f.index, "kind": "PlanarFace", "area_mm2": round(f.area, 3)} for f in (_hexagon_faces(env, faces, hexagon) if hexagon is not None else [])],
        },
    }
