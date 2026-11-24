"""
What a printed circuit board's cost rests on, measured from a 3D model (STEP) when its board files (Gerber, drill, Pick Place) are not given.

A model states the board's shape and nothing of its copper: no layer count, copper weight, nets or placements. So only the bare board is
measured, and the backend takes the rest from the Cost Guide or the reference, saying so (costing/pcb/pcb-part.ts, basis cad_model):

  board        the board itself, found among the model's bodies (an ECAD export carries the components too, so the model's box is not the
               board): the largest planar face whose opposite parallel face of about the same area lies a board's thickness away. Its
               thickness (the gap between them), its outline (the face's outer boundary: length, enclosed area, the smallest rectangle round
               it, the long and short side) and the side it faces.
  holes        the round openings through the board (the face's circular inner boundaries), by diameter. A model does not say which are
               plated: the backend says so on the board's facts.
  cutouts      the other openings through the board (slots, windows): each one's boundary length, routed with the outline.
  components   the bodies standing on the board, by side (counted, not classified: a model does not say what a part is or how it is
               mounted), so the backend can say the board is populated.

These are measurements only. Which steps the board takes and their cost are decided in the backend from the staged reference.
"""
from __future__ import annotations

import logging
import math
from typing import Any, Dict, List, Optional, Sequence, Tuple

from shared import planar_outline

logger = logging.getLogger(__name__)

VERSION = "pcb-step-1"
# A board is a plate this thin: the thinnest and thickest boards fabricated (the reference's stack-up tables run 0.4 to 3.2 mm; a margin both
# ways for flex and heavy copper boards).
MIN_THICKNESS_MM = 0.2
MAX_THICKNESS_MM = 6.0
# The face opposite the board's top covers about the same area (the same outline, holes aside).
OPPOSITE_AREA_RATIO = 0.8
# Two normals are parallel within this.
PARALLEL_COS = math.cos(math.radians(1.0))
# A circular boundary is a hole when it is one closed circle (a full turn, or arcs of one circle).
CIRCLE_TOL_MM = 1e-3
DEFLECTION_MM = 0.05

Vec = Tuple[float, float, float]


def _vec(p: Any) -> Vec:
    return (p.X(), p.Y(), p.Z())


def _dot(a: Sequence[float], b: Sequence[float]) -> float:
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def _cross(a: Sequence[float], b: Sequence[float]) -> Vec:
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def _unit(a: Sequence[float]) -> Vec:
    n = math.sqrt(_dot(a, a)) or 1.0
    return (a[0] / n, a[1] / n, a[2] / n)


def _planar_faces(shape: Any) -> List[Dict[str, Any]]:
    """Every planar face: its outward normal, a point on it, its area."""
    from OCC.Core.BRepAdaptor import BRepAdaptor_Surface  # type: ignore
    from OCC.Core.BRepGProp import brepgprop  # type: ignore
    from OCC.Core.GeomAbs import GeomAbs_Plane  # type: ignore
    from OCC.Core.GProp import GProp_GProps  # type: ignore
    from OCC.Core.TopAbs import TopAbs_FACE, TopAbs_REVERSED  # type: ignore
    from OCC.Core.TopExp import TopExp_Explorer  # type: ignore
    from OCC.Core.TopoDS import topods  # type: ignore

    out: List[Dict[str, Any]] = []
    ex = TopExp_Explorer(shape, TopAbs_FACE)
    while ex.More():
        face = topods.Face(ex.Current())
        ex.Next()
        surf = BRepAdaptor_Surface(face)
        if surf.GetType() != GeomAbs_Plane:
            continue
        plane = surf.Plane()
        n = _vec(plane.Axis().Direction())
        if face.Orientation() == TopAbs_REVERSED:
            n = (-n[0], -n[1], -n[2])
        props = GProp_GProps()
        brepgprop.SurfaceProperties(face, props)
        out.append({"face": face, "normal": _unit(n), "point": _vec(plane.Location()), "area": props.Mass(), "centre": _vec(props.CentreOfMass())})
    return out


def find_board(shape: Any) -> Optional[Dict[str, Any]]:
    """The board: the largest planar face with an opposite parallel face of about its area a board's thickness away (None when there is none)."""
    faces = sorted(_planar_faces(shape), key=lambda f: -f["area"])
    for top in faces[:12]:
        n = top["normal"]
        for other in faces:
            if other is top or _dot(other["normal"], n) > -PARALLEL_COS:
                continue
            if other["area"] < OPPOSITE_AREA_RATIO * top["area"] or other["area"] > top["area"] / OPPOSITE_AREA_RATIO:
                continue
            gap = _dot((top["point"][0] - other["point"][0], top["point"][1] - other["point"][1], top["point"][2] - other["point"][2]), n)
            # The top faces away from the bottom: the bottom lies behind it.
            if MIN_THICKNESS_MM <= gap <= MAX_THICKNESS_MM:
                return {"top": top, "bottom": other, "thickness_mm": gap, "normal": n}
    return None


def _wires(face: Any) -> Tuple[Any, List[Any]]:
    from OCC.Core.BRepTools import breptools  # type: ignore
    from OCC.Core.TopAbs import TopAbs_WIRE  # type: ignore
    from OCC.Core.TopExp import TopExp_Explorer  # type: ignore
    from OCC.Core.TopoDS import topods  # type: ignore

    outer = breptools.OuterWire(face)
    inners: List[Any] = []
    ex = TopExp_Explorer(face, TopAbs_WIRE)
    while ex.More():
        w = topods.Wire(ex.Current())
        if not w.IsSame(outer):
            inners.append(w)
        ex.Next()
    return outer, inners


def _edges(wire: Any) -> List[Any]:
    from OCC.Core.TopAbs import TopAbs_EDGE  # type: ignore
    from OCC.Core.TopExp import TopExp_Explorer  # type: ignore
    from OCC.Core.TopoDS import topods  # type: ignore

    out = []
    ex = TopExp_Explorer(wire, TopAbs_EDGE)
    while ex.More():
        out.append(topods.Edge(ex.Current()))
        ex.Next()
    return out


def _wire_length(wire: Any) -> float:
    from OCC.Core.BRepGProp import brepgprop  # type: ignore
    from OCC.Core.GProp import GProp_GProps  # type: ignore

    props = GProp_GProps()
    brepgprop.LinearProperties(wire, props)
    return props.Mass()


def _circle_diameter(wire: Any) -> Optional[float]:
    """The diameter of a wire that is one whole circle (its edges arcs of one circle), else None."""
    from OCC.Core.BRepAdaptor import BRepAdaptor_Curve  # type: ignore
    from OCC.Core.GeomAbs import GeomAbs_Circle  # type: ignore

    radius: Optional[float] = None
    centre: Optional[Vec] = None
    for e in _edges(wire):
        c = BRepAdaptor_Curve(e)
        if c.GetType() != GeomAbs_Circle:
            return None
        circ = c.Circle()
        r, o = circ.Radius(), _vec(circ.Location())
        if radius is None:
            radius, centre = r, o
        elif abs(r - radius) > CIRCLE_TOL_MM or math.dist(o, centre) > CIRCLE_TOL_MM:  # type: ignore[arg-type]
            return None
    return None if radius is None else 2.0 * radius


def _wire_points(wire: Any) -> List[Vec]:
    from OCC.Core.BRepAdaptor import BRepAdaptor_Curve  # type: ignore
    from OCC.Core.GCPnts import GCPnts_QuasiUniformDeflection  # type: ignore

    pts: List[Vec] = []
    for e in _edges(wire):
        c = BRepAdaptor_Curve(e)
        d = GCPnts_QuasiUniformDeflection(c, DEFLECTION_MM)
        if d.IsDone():
            pts.extend(_vec(d.Value(i)) for i in range(1, d.NbPoints() + 1))
        else:
            pts.extend([_vec(c.Value(c.FirstParameter())), _vec(c.Value(c.LastParameter()))])
    return pts


def _enclosed_area(wire: Any) -> float:
    """The area a closed planar wire encloses (holes in it not taken off): a face built on it."""
    from OCC.Core.BRepBuilderAPI import BRepBuilderAPI_MakeFace  # type: ignore
    from OCC.Core.BRepGProp import brepgprop  # type: ignore
    from OCC.Core.GProp import GProp_GProps  # type: ignore

    mk = BRepBuilderAPI_MakeFace(wire, True)
    if not mk.IsDone():
        return 0.0
    props = GProp_GProps()
    brepgprop.SurfaceProperties(mk.Face(), props)
    return abs(props.Mass())


def _frame(n: Vec) -> Tuple[Vec, Vec]:
    """Two directions across the board."""
    a = (1.0, 0.0, 0.0) if abs(n[0]) < 0.9 else (0.0, 1.0, 0.0)
    u = _unit(_cross(n, a))
    return u, _unit(_cross(n, u))


def _components(shape: Any, board: Dict[str, Any]) -> Dict[str, int]:
    """The bodies other than the board, by the side of it they stand on (a body's centre above the top, or below the bottom)."""
    from OCC.Core.BRepGProp import brepgprop  # type: ignore
    from OCC.Core.GProp import GProp_GProps  # type: ignore
    from OCC.Core.TopAbs import TopAbs_SOLID  # type: ignore
    from OCC.Core.TopExp import TopExp_Explorer  # type: ignore

    n, top_pt = board["normal"], board["top"]["point"]
    counts = {"top": 0, "bottom": 0}
    ex = TopExp_Explorer(shape, TopAbs_SOLID)
    while ex.More():
        solid = ex.Current()
        ex.Next()
        props = GProp_GProps()
        brepgprop.VolumeProperties(solid, props)
        h = _dot(tuple(a - b for a, b in zip(_vec(props.CentreOfMass()), top_pt)), n)  # type: ignore[arg-type]
        if h > 1e-3:
            counts["top"] += 1
        elif h < -board["thickness_mm"] - 1e-3:
            counts["bottom"] += 1
    return counts


class PcbStepFeatureExtractor:
    """A board's shape from its 3D model: thickness, outline, holes and cutouts, and the bodies standing on it."""

    def extract(self, shape: Any, dims: Sequence[float] = ()) -> Dict[str, Any]:
        board = find_board(shape)
        if board is None:
            return {
                "extraction_version": VERSION, "board": None,
                "unresolved": [f"no board found: no planar face with an opposite face of about its area {MIN_THICKNESS_MM}-{MAX_THICKNESS_MM} mm behind it"],
            }
        top = board["top"]["face"]
        outer, inners = _wires(top)
        n = board["normal"]
        u, v = _frame(n)
        pts2d = [(_dot(p, u), _dot(p, v)) for p in _wire_points(outer)]
        enclosed = _enclosed_area(outer)
        rect = planar_outline.min_area_rect(pts2d) if len(pts2d) >= 3 else (0.0, 0.0, 0.0)
        length, width = max(rect[0], rect[1]), min(rect[0], rect[1])
        holes: Dict[float, int] = {}
        cutouts: List[float] = []
        for w in inners:
            d = _circle_diameter(w)
            if d is not None:
                key = round(d, 3)
                holes[key] = holes.get(key, 0) + 1
            else:
                cutouts.append(round(_wire_length(w), 3))
        components = _components(shape, board)
        result = {
            "extraction_version": VERSION,
            "board": {
                "thickness_mm": round(board["thickness_mm"], 4),
                "length_mm": round(length, 3), "width_mm": round(width, 3),
                "area_mm2": round(enclosed, 3),
                "perimeter_mm": round(_wire_length(outer), 3),
                "normal": [round(x, 6) for x in n],
            },
            "holes": [{"diameter_mm": d, "count": c} for d, c in sorted(holes.items())],
            "cutouts": [{"perimeter_mm": p} for p in cutouts],
            "components": components,
            "unresolved": [],
        }
        logger.info(f"[pcb] board {length:.2f} x {width:.2f} x {board['thickness_mm']:.3f} mm, {sum(holes.values())} holes, {len(cutouts)} cutouts, components {components}")
        return result
