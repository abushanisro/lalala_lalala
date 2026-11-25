"""
A hole's thread is read with what is at its mouth, not from its diameter alone (shared/machining_geometry.py).

- A short counterbore step at a tap-drill size over a tapped hole is a counterbore, not a thread of its own (R_M-0230-030 Motor Mount:
  six Ø4.5 x 2.03 counterbores over the M3 holes were six M4 helicoil holes). The tapped hole below stays a tapped hole.
- A countersink whose entry is far wider than the thread a hole's size suggests is a countersunk screw's head seat: the hole is a
  clearance hole (R_M-0230-033 Carriage Mount: four Ø2.2 holes under Ø4.0 countersinks, the M2 screw's seat, were tapped M2.5).
- A cone is a countersink only at the mouth of a hole whose wall goes all the way round: the quarter cone of a pocket's rim chamfer
  where it runs round a rounded inside corner is a chamfer (R_M-0230-031 Cannula End Bearing Housing: the rim chamfers of its pockets'
  corners were six Ø4.5 and two Ø3.5 countersinks).

Built on OCC solids with known sizes, and on the shared functions directly.
"""
import itertools
import math
from types import SimpleNamespace

import pytest

pytest.importorskip("OCC")

from OCC.Core.BRepAdaptor import BRepAdaptor_Curve  # noqa: E402
from OCC.Core.BRepBndLib import brepbndlib  # noqa: E402
from OCC.Core.BRepFilletAPI import BRepFilletAPI_MakeChamfer, BRepFilletAPI_MakeFillet  # noqa: E402
from OCC.Core.BRepPrimAPI import BRepPrimAPI_MakeCone  # noqa: E402
from OCC.Core.Bnd import Bnd_Box  # noqa: E402
from OCC.Core.GeomAbs import GeomAbs_Line  # noqa: E402
from OCC.Core.TopAbs import TopAbs_EDGE  # noqa: E402
from OCC.Core.TopExp import TopExp_Explorer  # noqa: E402
from OCC.Core.TopoDS import topods  # noqa: E402
from OCC.Core.gp import gp_Ax2, gp_Dir, gp_Pnt  # noqa: E402

from machining.machining_feature_recognizer import (  # noqa: E402
    MachiningFeatureRecognizer, _part_bounding_box, build_machining_feature_graph_v2,
)
from shared.machining_geometry import (  # noqa: E402
    COUNTERSUNK_SEAT_MIN_RATIO, MIN_THREAD_ENGAGEMENT_DIAMETERS, classify_cone, classify_hole, countersink_mouths, detect_counterbores,
    is_screw_seat, thread_nominal_mm,
)

import machined_parts as P  # noqa: E402

Z = (0, 0, 1)
DOWN = (0, 0, -1)


def _features(shape, family="milled"):
    return MachiningFeatureRecognizer().recognize(shape, family).features


def _of(features, ftype, variant=None):
    return [f for f in features if f.type == ftype and (variant is None or f.variant == variant)]


def _holes_of(features, diameter):
    return [f for f in _of(features, "SimpleHole") if abs(f.params.get("diameter_mm", 0.0) - diameter) < 0.01]


def _drilled(x, y, top, diameter):
    """A hole through a part `top` thick, drilled from its top face. The cylinder's origin is where the drill starts, 1 mm above:
    classify_cone pairs a cone with a hole only when their stored origins lie within 5 mm (an existing guard, see its comment)."""
    return P.cylinder((x, y, top + 1.0), DOWN, diameter, top + 2.0)


def _countersink_tool(x, y, top, entry_diameter):
    """A 90 degree countersink (45 degree half angle) of entry_diameter at z = top, cut from above."""
    r = entry_diameter / 2.0 + 0.5
    return BRepPrimAPI_MakeCone(gp_Ax2(gp_Pnt(x, y, top + 0.5), gp_Dir(*DOWN)), r, 0.0, r).Shape()


# ── The counterbore over a tapped hole (Motor Mount) ─────────────────────────

# A 30 x 30 x 12 block, a Ø2.5 hole (the M3 tap drill) 10 deep from its top, counterbored Ø4.5 x 2 (the helicoil band of an M4).
BLOCK_H, TAP_DRILL, HOLE_DEPTH, CBORE, CBORE_DEPTH = 12.0, 2.5, 10.0, 4.5, 2.0


def _counterbored_tapped_block():
    block = P.box((0, 0, 0), (30, 30, BLOCK_H))
    block = P.cut(block, P.cylinder((15, 15, BLOCK_H - HOLE_DEPTH), Z, TAP_DRILL, HOLE_DEPTH + 1.0))
    return P.cut(block, P.cylinder((15, 15, BLOCK_H - CBORE_DEPTH), Z, CBORE, CBORE_DEPTH + 1.0))


def _counterbored_tapped_shaft():
    """The same counterbored M3 hole in the end face of a Ø20 x 30 shaft, on its axis."""
    shaft = P.cylinder((0, 0, 0), Z, 20.0, 30.0)
    shaft = P.cut(shaft, P.cylinder((0, 0, 30.0 - HOLE_DEPTH), Z, TAP_DRILL, HOLE_DEPTH + 1.0))
    return P.cut(shaft, P.cylinder((0, 0, 30.0 - CBORE_DEPTH), Z, CBORE, CBORE_DEPTH + 1.0))


@pytest.mark.parametrize("shape_fn,family", [(_counterbored_tapped_block, "milled"), (_counterbored_tapped_shaft, "turned")])
def test_a_counterbore_over_a_tapped_hole_is_a_counterbore_and_the_hole_stays_tapped(shape_fn, family):
    features = _features(shape_fn(), family)

    assert _holes_of(features, CBORE) == [], "the Ø4.5 step is the counterbore, not a hole of its own"
    assert not any(f.params.get("helicoil_candidate") for f in features), "no helicoil: nothing here is an M4"
    cbores = _of(features, "MultiStepHole", "counterbore")
    assert len(cbores) == 1
    p = cbores[0].params
    assert p["counterbore_diameter_mm"] == pytest.approx(CBORE)
    assert p["counterbore_depth_mm"] == pytest.approx(CBORE_DEPTH, abs=0.01)
    assert p["bore_diameter_mm"] == pytest.approx(TAP_DRILL)
    assert p["bore_spec"] == "M3×0.5"

    tapped = _holes_of(features, TAP_DRILL)
    assert len(tapped) == 1 and tapped[0].variant == "threaded" and tapped[0].params["spec"] == "M3×0.5"
    # The counterbore claims the step's faces, the tapped hole its own: no face is claimed twice.
    assert not set(cbores[0].face_ids) & set(tapped[0].face_ids)


def test_the_counterbore_and_the_tapped_hole_reach_the_feature_graph_apart():
    shape = _counterbored_tapped_block()
    bb = _part_bounding_box(shape)
    centre = ((bb["xmin"] + bb["xmax"]) / 2, (bb["ymin"] + bb["ymax"]) / 2, (bb["zmin"] + bb["zmax"]) / 2)
    tree = MachiningFeatureRecognizer().recognize(shape, "milled").to_dict()
    graph = build_machining_feature_graph_v2(tree, centre, [], 0)
    by_kind = {(f["feature_type"], f["variant"]): f for f in graph["features"]}

    cbore = by_kind[("MultiStepHole", "counterbore")]
    assert cbore["diameter_mm"] == pytest.approx(CBORE)
    assert [o["tapped"] for o in cbore["occurrences"]] == [False]
    # The bore's thread rides on the counterbore, so the costing drills and taps the bore once, as its own hole (operation-sequencer.ts).
    assert [o.get("bore_spec") for o in cbore["occurrences"]] == ["M3×0.5"]
    threaded = by_kind[("SimpleHole", "threaded")]
    assert threaded["diameter_mm"] == pytest.approx(TAP_DRILL)
    assert [(o["tapped"], o["spec"]) for o in threaded["occurrences"]] == [(True, "M3×0.5")]


_FACE = itertools.count()


def _bore(fid, diameter, depth, spec=None, x=0.0, z_range=None):
    params = {"diameter_mm": diameter, "depth_mm": depth}
    if spec:
        params["spec"] = spec
    cyl = {"centroid": (x, 0.0, 0.0), "axis": (0.0, 0.0, 1.0), "radius": diameter / 2.0, "face_indices": [next(_FACE)]}
    if z_range:
        cyl["axial_range"] = z_range
    return SimpleNamespace(id=fid, params=params, face_ids=cyl["face_indices"]), cyl


def _pairs(*bores):
    return detect_counterbores([b for b, _c in bores], {b.id: c for b, c in bores})


def test_a_step_as_deep_as_its_thread_needs_stays_a_tapped_hole():
    # An M5 (Ø4.2) tapped 8 deep over a Ø2.5 hole 12 deep: 8 >= 1 x 5, a thread with full engagement over a smaller hole.
    deep = _pairs(_bore("outer", 4.2, 8.0, "M5×0.8"), _bore("inner", 2.5, 12.0, "M3×0.5"))
    assert deep == []
    # 3 deep is short of one diameter of engagement: a counterbore.
    short = _pairs(_bore("outer", 4.2, 3.0, "M5×0.8"), _bore("inner", 2.5, 12.0, "M3×0.5"))
    assert [(o, i) for o, i, _p in short] == [("outer", "inner")]
    assert short[0][2]["bore_spec"] == "M3×0.5"
    assert MIN_THREAD_ENGAGEMENT_DIAMETERS == 1.0


def test_two_holes_side_by_side_are_not_a_counterbore():
    # Origins 3 mm apart (within the old 5 mm guard) on parallel axes: two holes, not one stepped hole.
    assert _pairs(_bore("wide", 6.0, 2.0, x=0.0), _bore("narrow", 3.0, 10.0, x=3.0)) == []
    # The same two on one axis are one.
    assert len(_pairs(_bore("wide", 6.0, 2.0), _bore("narrow", 3.0, 10.0))) == 1


def test_coaxial_holes_with_metal_between_them_are_not_a_counterbore():
    # A Ø6 x 2 recess in the top of a 20 mm plate (z 18-20) and a Ø3 hole 10 deep from its bottom (z 0-10), on one axis.
    assert _pairs(_bore("wide", 6.0, 2.0, z_range=(18.0, 20.0)), _bore("narrow", 3.0, 10.0, z_range=(0.0, 10.0))) == []
    # The Ø3 hole running up to the recess's floor: one counterbored hole.
    assert len(_pairs(_bore("wide", 6.0, 2.0, z_range=(18.0, 20.0)), _bore("narrow", 3.0, 18.0, z_range=(0.0, 18.0)))) == 1


def test_a_counterbore_is_found_whichever_bore_is_listed_first():
    assert [(o, i) for o, i, _p in _pairs(_bore("narrow", 3.0, 10.0), _bore("wide", 6.0, 2.0))] == [("wide", "narrow")]


# ── The countersunk screw's clearance hole (Carriage Mount) ──────────────────

# A 20 x 20 x 3 flange: a Ø2.2 hole through it under a 90 degree Ø4.0 countersink, the seat of an M2 countersunk screw (ISO 7046-1 /
# ISO 2009 head Ø3.8). Ø2.2 is also the M2.5 tap drill. Beside it a Ø2.5 hole (the M3 tap drill) with a Ø3.0 entry chamfer: a tapped
# hole's countersink, 1.0 x its thread's diameter.
FLANGE_H, CLEARANCE, SEAT, TAPPED_ENTRY = 3.0, 2.2, 4.0, 3.0


def _countersunk_flange():
    flange = P.box((0, 0, 0), (20, 20, FLANGE_H))
    flange = P.cut(flange, _drilled(5, 10, FLANGE_H, CLEARANCE))
    flange = P.cut(flange, _countersink_tool(5, 10, FLANGE_H, SEAT))
    flange = P.cut(flange, _drilled(15, 10, FLANGE_H, TAP_DRILL))
    return P.cut(flange, _countersink_tool(15, 10, FLANGE_H, TAPPED_ENTRY))


def test_a_hole_under_a_screw_head_seat_is_a_clearance_hole():
    features = _features(_countersunk_flange())

    clearance = _holes_of(features, CLEARANCE)
    assert len(clearance) == 1
    assert clearance[0].variant in ("through", "blind")
    assert "spec" not in clearance[0].params and not clearance[0].params.get("helicoil_candidate")

    tapped = _holes_of(features, TAP_DRILL)
    assert len(tapped) == 1 and tapped[0].variant == "threaded" and tapped[0].params["spec"] == "M3×0.5"

    sinks = sorted(round(f.params["entry_diameter_mm"], 1) for f in _of(features, "Edge", "countersink"))
    assert sinks == [TAPPED_ENTRY, SEAT]


def test_screw_seat_ratio():
    assert thread_nominal_mm("M2.5×0.45") == 2.5 and thread_nominal_mm("M10×1.5") == 10.0 and thread_nominal_mm(None) is None
    assert COUNTERSUNK_SEAT_MIN_RATIO == 1.3
    assert is_screw_seat(4.0, "M2.5×0.45")          # Carriage Mount: 1.6 x
    assert is_screw_seat(5.5, "M4×0.7")             # an M3 head (ISO 2009) on its Ø3.2 clearance hole, read as M4: 1.375 x
    assert not is_screw_seat(3.0, "M3×0.5")         # a tapped hole's entry chamfer, 1.0 x
    assert not is_screw_seat(3.6, "M3×0.5")         # 1.2 x, the widest a tapped hole's chamfer is made
    assert not is_screw_seat(None, "M3×0.5")
    assert classify_hole(2.2, through=True, countersink_entry_mm=4.0) == ("through", None, False)
    assert classify_hole(2.2, through=False, countersink_entry_mm=4.0) == ("blind", None, False)
    assert classify_hole(2.2, through=True) == ("threaded", "M2.5×0.45", False)
    assert classify_hole(2.5, through=True, countersink_entry_mm=3.0) == ("threaded", "M3×0.5", False)
    assert classify_hole(4.5, through=True, countersink_entry_mm=8.4) == ("through", None, False)  # helicoil band, M4 head seat


# ── A pocket's rim chamfer is no countersink (Cannula End Bearing Housing) ───

# A 50 x 40 x 10 plate: a 20 x 12 pocket 6 deep with R2 inside corners, its rim chamfered 0.25 (the chamfer runs round each corner as a
# quarter cone over the corner's quarter cylinder), and a Ø4 hole through it under a 90 degree Ø4.5 countersink.
PLATE_H, POCKET_DEPTH, CORNER_R, RIM_CHAMFER, HOLE, HOLE_SINK = 10.0, 6.0, 2.0, 0.25, 4.0, 4.5


def _vertical_edges(shape):
    exp = TopExp_Explorer(shape, TopAbs_EDGE)
    while exp.More():
        edge = topods.Edge(exp.Current())
        curve = BRepAdaptor_Curve(edge)
        if curve.GetType() == GeomAbs_Line and abs(abs(curve.Line().Direction().Z()) - 1.0) < 1e-9:
            yield edge
        exp.Next()


def _rim_edge(shape, x0, x1, y0, y1, z):
    """An edge of the pocket's rim: on the plate's top, inside the pocket's footprint."""
    exp = TopExp_Explorer(shape, TopAbs_EDGE)
    while exp.More():
        edge = topods.Edge(exp.Current())
        b = Bnd_Box()
        brepbndlib.Add(edge, b)
        ex0, ey0, ez0, ex1, ey1, ez1 = b.Get()
        if abs(ez0 - z) < 1e-6 and abs(ez1 - z) < 1e-6 and ex0 >= x0 - 1e-6 and ex1 <= x1 + 1e-6 and ey0 >= y0 - 1e-6 and ey1 <= y1 + 1e-6:
            return edge
        exp.Next()
    raise AssertionError("no rim edge found")


def _plate_with_chamfered_pocket_and_countersunk_hole():
    tool = P.box((10, 10, PLATE_H - POCKET_DEPTH), (20, 12, POCKET_DEPTH + 1.0))
    fillet = BRepFilletAPI_MakeFillet(tool)
    for edge in _vertical_edges(tool):
        fillet.Add(CORNER_R, edge)
    plate = P.cut(P.box((0, 0, 0), (50, 40, PLATE_H)), fillet.Shape())
    chamfer = BRepFilletAPI_MakeChamfer(plate)
    chamfer.Add(RIM_CHAMFER, _rim_edge(plate, 10, 30, 10, 22, PLATE_H))  # the rim is one tangent chain: the whole rim is chamfered
    plate = chamfer.Shape()
    plate = P.cut(plate, _drilled(40, 20, PLATE_H, HOLE))
    return P.cut(plate, _countersink_tool(40, 20, PLATE_H, HOLE_SINK))


def test_a_pocket_rim_chamfer_round_a_corner_is_a_chamfer_and_a_hole_mouth_is_a_countersink():
    features = _features(_plate_with_chamfered_pocket_and_countersunk_hole())

    sinks = _of(features, "Edge", "countersink")
    assert [round(f.params["entry_diameter_mm"], 1) for f in sinks] == [HOLE_SINK], "only the hole's mouth is a countersink"
    hole = _holes_of(features, HOLE)
    assert len(hole) == 1 and hole[0].variant == "through"
    # The four R2 corners stay rounds (quarter turns), not holes; their rim chamfers are chamfers.
    corners = [f for f in _of(features, "Edge", "round") if f.params.get("concave") and f.params["radius_mm"] == pytest.approx(CORNER_R)]
    assert len(corners) == 4 and all(f.params["sweep_deg"] == pytest.approx(90.0, abs=1.0) for f in corners)
    corner_chamfers = [f for f in _of(features, "Edge", "chamfer") if f.params["diameter_mm"] == pytest.approx(2 * (CORNER_R + RIM_CHAMFER), abs=0.01)]
    assert len(corner_chamfers) == 4


def _cone(concave, adjacent):
    return {"centroid": (0.0, 0.0, 0.0), "half_angle_deg": 45.0, "ref_radius": 2.25, "max_radius": 2.25, "concave": concave,
            "adjacent_faces": adjacent, "face_indices": [99]}


def _wall(face, u_range, centroid=(0.0, 0.0, 0.0)):
    return {"kind": "blind_hole", "radius": 2.0, "centroid": centroid, "axis": (0.0, 0.0, 1.0), "u_range": u_range, "face_indices": [face]}


def test_classify_cone_needs_a_wall_all_the_way_round():
    # A quarter cylinder (a pocket's rounded corner) under the cone: a chamfer.
    assert classify_cone(_cone(True, [1]), [_wall(1, math.pi / 2)])[0] == "chamfer"
    # The two halves of one bore, faces not merged (the sheet-metal caller passes them so): a countersink, both halves its mouth.
    halves = [_wall(1, math.pi), _wall(2, math.pi)]
    assert classify_cone(_cone(True, [1, 2]), halves)[0] == "countersink"
    assert countersink_mouths([_cone(True, [1, 2])], halves) == {1: 4.5, 2: 4.5}
    # Two quarter arcs on different axis lines (two corners) do not add up to a hole.
    corners = [_wall(1, math.pi / 2), _wall(2, math.pi / 2, centroid=(5.0, 0.0, 0.0))]
    assert classify_cone(_cone(True, [1, 2]), corners)[0] == "chamfer"
    assert countersink_mouths([_cone(True, [1, 2])], corners) == {}
    # A merged bore: a countersink, as before.
    assert classify_cone(_cone(True, [1]), [_wall(1, 2 * math.pi)])[0] == "countersink"
