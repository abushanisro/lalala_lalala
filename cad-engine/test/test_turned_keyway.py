"""
A keyway or a slot milled into a turned diameter or a bore (machining_feature_recognizer._recognize_turned).

Its floor faces across the turning axis, so the collector that only kept floors facing along the axis never saw it, and the rounded ends
of a keyway read as two cross holes. Now the floor is collected and named by the direction of its long side: along the axis a Keyway,
across it a Slot/radial. The recess owns its floor, its side walls and its end arcs. Built on OCC solids with known sizes.
"""
import pytest

pytest.importorskip("OCC")

from OCC.Core.BRepAdaptor import BRepAdaptor_Surface  # noqa: E402
from OCC.Core.BRepBuilderAPI import BRepBuilderAPI_MakeEdge, BRepBuilderAPI_MakeFace, BRepBuilderAPI_MakePolygon, BRepBuilderAPI_MakeWire  # noqa: E402
from OCC.Core.BRepPrimAPI import BRepPrimAPI_MakePrism  # noqa: E402
from OCC.Core.GC import GC_MakeArcOfCircle  # noqa: E402
from OCC.Core.GeomAbs import GeomAbs_Cylinder, GeomAbs_Plane  # noqa: E402
from OCC.Core.gp import gp_Pnt, gp_Vec  # noqa: E402
from OCC.Core.TopAbs import TopAbs_FACE  # noqa: E402
from OCC.Core.TopExp import TopExp_Explorer  # noqa: E402

from machining.machining_feature_recognizer import (  # noqa: E402
    MachiningFeatureRecognizer, _part_bounding_box, build_machining_feature_graph_v2,
)

import machined_parts as P  # noqa: E402

# The stepped shaft below, along X: Ø16 from 0 to 40, then Ø24 to 60.
SMALL, LARGE = 16.0, 24.0
# Every keyway here is 5 wide with its floor 5 mm above the axis: 3 mm below the top of the Ø16, 7 mm below the top of the Ø24.
WIDTH, FLOOR_Z = 5.0, 5.0


def _shaft():
    return P.fuse(P.cylinder((0, 0, 0), (1, 0, 0), SMALL, 40.0), P.cylinder((40, 0, 0), (1, 0, 0), LARGE, 20.0))


def _obround(x0, x1, width, z0, height, y=0.0):
    """A round-ended cutter path: end centres at x0 and x1 on the line y, `width` wide, from z0 up by `height`. One floor, two half-turn ends."""
    r = width / 2.0
    a, b, c, d = gp_Pnt(x0, y - r, z0), gp_Pnt(x1, y - r, z0), gp_Pnt(x1, y + r, z0), gp_Pnt(x0, y + r, z0)
    mk = BRepBuilderAPI_MakeWire()
    mk.Add(BRepBuilderAPI_MakeEdge(a, b).Edge())
    mk.Add(BRepBuilderAPI_MakeEdge(GC_MakeArcOfCircle(b, gp_Pnt(x1 + r, y, z0), c).Value()).Edge())
    mk.Add(BRepBuilderAPI_MakeEdge(c, d).Edge())
    mk.Add(BRepBuilderAPI_MakeEdge(GC_MakeArcOfCircle(d, gp_Pnt(x0 - r, y, z0), a).Value()).Edge())
    return BRepPrimAPI_MakePrism(BRepBuilderAPI_MakeFace(mk.Wire()).Face(), gp_Vec(0, 0, height)).Shape()


def _keyway(x0=10.0, x1=25.0):
    """The cut of a round-ended keyway in the top of the shaft, end centres at x0 and x1."""
    return _obround(x0, x1, WIDTH, FLOOR_Z, 20.0)


def _shaft_with_keyway():
    """The Ø16 with a closed keyway 5 wide, 20 long overall (15 between its end centres), 3 deep."""
    return P.cut(_shaft(), _keyway())


def _recognize(shape, family="mill_turn"):
    return MachiningFeatureRecognizer().recognize(shape, family)


def _of(tree, ftype, variant=None):
    return [f for f in tree.features if f.type == ftype and (variant is None or f.variant == variant)]


def _surfaces(shape):
    """Each face in face-id order: ("plane", its direction) or ("cylinder", its diameter), else ("other", None)."""
    out = []
    exp = TopExp_Explorer(shape, TopAbs_FACE)
    while exp.More():
        s = BRepAdaptor_Surface(exp.Current())
        if s.GetType() == GeomAbs_Plane:
            d = s.Plane().Axis().Direction()
            out.append(("plane", tuple(round(abs(v), 6) for v in (d.X(), d.Y(), d.Z()))))
        elif s.GetType() == GeomAbs_Cylinder:
            out.append(("cylinder", round(2.0 * s.Cylinder().Radius(), 6)))
        else:
            out.append(("other", None))
        exp.Next()
    return out


def _graph(shape, family="mill_turn"):
    b = _part_bounding_box(shape)
    centre = ((b["xmin"] + b["xmax"]) / 2, (b["ymin"] + b["ymax"]) / 2, (b["zmin"] + b["zmax"]) / 2)
    return build_machining_feature_graph_v2(_recognize(shape, family).to_dict(), centre, [], 0)


# ── A keyway on a turned diameter ───────────────────────────────────────────


def test_a_closed_round_ended_keyway_is_one_keyway_with_its_size():
    tree = _recognize(_shaft_with_keyway())
    (keyway,) = _of(tree, "Keyway")
    assert keyway.variant == "default"
    p = keyway.params
    # The floor's length is read from its mesh (shared/feature_extent.py, 0.1 mm deflection): the rounded ends come out a few hundredths short.
    assert p["length_mm"] == pytest.approx(20.0, abs=0.05)
    assert p["width_mm"] == pytest.approx(WIDTH, abs=0.01)
    assert p["depth_mm"] == pytest.approx(SMALL / 2 - FLOOR_Z, abs=0.01)
    assert p["walled_fraction"] == pytest.approx(1.0, abs=0.005)   # walled all round: closed at both ends
    assert p["width_confined"] is True
    assert p["centroid"] == pytest.approx((17.5, 0.0, FLOOR_Z), abs=0.01)
    assert _of(tree, "Slot") == []


def test_the_keyway_owns_its_floor_its_side_walls_and_its_end_arcs():
    shape = _shaft_with_keyway()
    (keyway,) = _of(_recognize(shape), "Keyway")
    surfaces = _surfaces(shape)
    owned = sorted(surfaces[i] for i in keyway.face_ids)
    assert owned == sorted([
        ("plane", (0.0, 0.0, 1.0)),                              # the floor
        ("plane", (0.0, 1.0, 0.0)), ("plane", (0.0, 1.0, 0.0)),  # the two side walls
        ("cylinder", WIDTH), ("cylinder", WIDTH),                # the two rounded ends
    ])


def test_the_rounded_ends_of_a_keyway_are_not_cross_holes():
    tree = _recognize(_shaft_with_keyway())
    assert _of(tree, "SimpleHole") == []
    # Every face has one owner: the ends are the keyway's and nobody else's.
    assert tree.coverage["multiply_claimed_faces"] == []


def test_a_cross_hole_through_the_axis_stays_a_cross_hole_beside_the_keyway():
    shape = P.cut(_shaft_with_keyway(), P.cylinder((33, -50, 0), (0, 1, 0), 4.0, 100.0))
    tree = _recognize(shape)
    (cross,) = _of(tree, "SimpleHole")
    assert cross.variant == "cross"
    assert cross.params["diameter_mm"] == pytest.approx(4.0)
    assert len(_of(tree, "Keyway")) == 1
    assert not set(cross.face_ids) & set(_of(tree, "Keyway")[0].face_ids)


def test_a_cross_hole_drilled_in_the_keyway_floor_stays_a_cross_hole():
    # A Ø3 hole down through the floor (a set screw seat): it goes down from the floor, it is not one of the keyway's walls.
    shape = P.cut(_shaft_with_keyway(), P.cylinder((17, 0, -20), (0, 0, 1), 3.0, 25.5))
    tree = _recognize(shape)
    assert [f.params["diameter_mm"] for f in _of(tree, "SimpleHole", "cross")] == [pytest.approx(3.0)]
    assert len(_of(tree, "Keyway")) == 1


def test_a_keyway_that_runs_out_of_the_shaft_end_is_open_at_that_end():
    # Round end at x = 15, the other end past the shaft's end face: 17.5 long, one end open.
    tree = _recognize(P.cut(_shaft(), _keyway(-10.0, 15.0)))
    (keyway,) = _of(tree, "Keyway")
    p = keyway.params
    length, straight, arc = 17.5, 15.0, 3.141592653589793 * WIDTH / 2
    assert p["length_mm"] == pytest.approx(length, abs=0.05)
    assert p["width_mm"] == pytest.approx(WIDTH, abs=0.01)
    # The two sides and the rounded end are walled, the mouth at the end face is not.
    assert p["walled_fraction"] == pytest.approx((2 * straight + arc) / (2 * straight + arc + WIDTH), abs=0.005)
    # More than a keyway open at both ends has (its two sides alone), so costing reads one end as closed.
    assert length / (length + WIDTH) + 0.02 < p["walled_fraction"] < 0.99
    assert _of(tree, "SimpleHole") == []


def test_a_keyway_across_two_diameters_is_as_deep_as_its_deepest_wall():
    tree = _recognize(P.cut(_shaft(), _keyway(30.0, 48.0)))
    (keyway,) = _of(tree, "Keyway")
    assert keyway.params["length_mm"] == pytest.approx(23.0, abs=0.05)
    assert keyway.params["depth_mm"] == pytest.approx(LARGE / 2 - FLOOR_Z, abs=0.01)   # 7 in the Ø24, 3 in the Ø16
    assert keyway.params["walled_fraction"] == pytest.approx(1.0, abs=0.005)
    assert _of(tree, "SimpleHole") == []


def test_two_keyways_cut_opposite_each_other_are_two_keyways():
    # Their ends lie on the same axis lines and together sweep a full turn: still the keyways' ends, not two holes.
    shape = P.cut(P.cut(_shaft(), _keyway()), P.rotated(_keyway(), (1, 0, 0), 180.0))
    tree = _recognize(shape)
    assert len(_of(tree, "Keyway")) == 2
    assert _of(tree, "SimpleHole") == []


def test_a_keyway_is_found_however_the_part_sits_in_the_model():
    shape = P.rotated(P.rotated(_shaft_with_keyway(), (0, 0, 1), 33.0), (1, 0, 0), 57.0)
    tree = _recognize(shape)
    (keyway,) = _of(tree, "Keyway")
    assert keyway.params["length_mm"] == pytest.approx(20.0, abs=0.05)
    assert keyway.params["depth_mm"] == pytest.approx(3.0, abs=0.01)
    assert _of(tree, "SimpleHole") == []


def test_a_plain_stepped_shaft_has_no_keyway_and_no_slot():
    tree = _recognize(_shaft(), "turned")
    assert _of(tree, "Keyway") == [] and _of(tree, "Slot") == []
    assert sorted(f.params["diameter_mm"] for f in _of(tree, "Ring", "outer_diameter")) == [SMALL, LARGE]


# ── A keyway in a bore ──────────────────────────────────────────────────────


def _hub(keyway_length=27.0):
    """A Ø40 x 25 hub with a Ø20 bore and a keyway 6 wide whose floor is 12.8 from the axis, cut from x = -1 for `keyway_length`."""
    hub = P.cut(P.cylinder((0, 0, 0), (1, 0, 0), 40.0, 25.0), P.cylinder((-1, 0, 0), (1, 0, 0), 20.0, 27.0))
    return P.cut(hub, P.box((-1, -3, 0), (keyway_length, 6, 12.8)))


def test_a_keyway_through_a_hub_bore_is_open_at_both_ends():
    tree = _recognize(_hub())
    (keyway,) = _of(tree, "Keyway")
    p = keyway.params
    assert (p["length_mm"], p["width_mm"]) == (pytest.approx(25.0, abs=0.01), pytest.approx(6.0, abs=0.01))
    # From the floor to where the side walls meet the bore: 12.8 - sqrt(10^2 - 3^2).
    assert p["depth_mm"] == pytest.approx(12.8 - 91 ** 0.5, abs=0.01)
    # Only its two sides are walled: the share costing reads as open at both ends (a broach passes through).
    assert p["walled_fraction"] == pytest.approx(25.0 / (25.0 + 6.0), abs=0.005)
    assert len(keyway.face_ids) == 3   # the floor and its two side walls
    assert [f.variant for f in _of(tree, "SimpleHole")] == ["through"]   # the bore itself


def test_a_keyway_that_stops_inside_the_bore_is_closed_at_that_end():
    tree = _recognize(_hub(keyway_length=16.0))
    (keyway,) = _of(tree, "Keyway")
    assert keyway.params["length_mm"] == pytest.approx(15.0, abs=0.01)
    assert keyway.params["walled_fraction"] == pytest.approx((2 * 15.0 + 6.0) / (2 * 15.0 + 2 * 6.0), abs=0.005)
    assert len(keyway.face_ids) == 4   # the floor, two side walls and the end wall


# ── A slot across the shaft ─────────────────────────────────────────────────


def test_a_slot_milled_across_the_shaft_is_a_radial_slot_not_a_keyway():
    # 4 mm along the axis, right across the Ø16 at the keyway's depth: its long side is the chord, across the axis.
    shape = P.cut(_shaft(), P.box((18, -20, FLOOR_Z), (4, 40, 20)))
    tree = _recognize(shape)
    (slot,) = _of(tree, "Slot")
    assert slot.variant == "radial"
    chord = 2 * (8.0 ** 2 - FLOOR_Z ** 2) ** 0.5
    p = slot.params
    assert p["length_mm"] == pytest.approx(chord, abs=0.01)
    assert p["width_mm"] == pytest.approx(4.0, abs=0.01)
    assert p["depth_mm"] == pytest.approx(3.0, abs=0.01)
    assert p["width_confined"] is True
    assert p["walled_fraction"] == pytest.approx(chord / (chord + 4.0), abs=0.005)   # its two walls; both ends run out of the diameter
    # The slot owns its floor and its two walls, which face along the axis and are not keyways of their own.
    assert sorted(_surfaces(shape)[i] for i in slot.face_ids) == [("plane", (0.0, 0.0, 1.0)), ("plane", (1.0, 0.0, 0.0)), ("plane", (1.0, 0.0, 0.0))]
    assert _of(tree, "Keyway") == []
    assert tree.coverage["multiply_claimed_faces"] == []


def test_a_round_ended_slot_across_the_shaft_is_a_radial_slot_with_its_ends():
    # The keyway's cutter path turned a quarter turn about the floor's normal: 12 long across the axis on a Ø24.
    shape = P.cut(P.cylinder((-30, 0, 0), (1, 0, 0), LARGE, 60.0), P.rotated(_obround(-4, 4, 4.0, 9.0, 20.0), (0, 0, 1), 90.0))
    tree = _recognize(shape)
    (slot,) = _of(tree, "Slot", "radial")
    assert slot.params["length_mm"] == pytest.approx(12.0, abs=0.05)
    assert slot.params["width_mm"] == pytest.approx(4.0, abs=0.01)
    assert slot.params["walled_fraction"] == pytest.approx(1.0, abs=0.005)
    assert _of(tree, "Keyway") == [] and _of(tree, "SimpleHole") == []


# ── What is not a keyway ────────────────────────────────────────────────────


def test_the_flat_of_a_d_shaped_bore_is_not_a_keyway():
    # The flat faces the axis and the bore's own wall rises round it, past the axis: a side of the hole, not a recess cut into it.
    tree = _recognize(P.shaft_with_d_bore(), "turned")
    assert _of(tree, "Keyway") == [] and _of(tree, "Slot") == []
    assert len([f for f in _of(tree, "SimpleHole") if f.variant != "cross"]) == 1


def _hexagon_socket(across_flats=10.0, depth=12.0):
    r = across_flats / 3 ** 0.5
    mk = BRepBuilderAPI_MakePolygon()
    for y, z in ((r, 0.0), (r / 2, across_flats / 2), (-r / 2, across_flats / 2), (-r, 0.0), (-r / 2, -across_flats / 2), (r / 2, -across_flats / 2)):
        mk.Add(gp_Pnt(-1.0, y, z))
    mk.Close()
    return BRepPrimAPI_MakePrism(BRepBuilderAPI_MakeFace(mk.Wire()).Face(), gp_Vec(depth + 1.0, 0, 0)).Shape()


@pytest.mark.parametrize("socket", [_hexagon_socket(), P.box((-1, -5, -5), (16, 10, 10))], ids=["hexagon", "square"])
def test_the_flats_of_a_socket_in_the_end_of_a_shaft_are_not_keyways(socket):
    tree = _recognize(P.cut(P.cylinder((0, 0, 0), (1, 0, 0), 30.0, 30.0), socket))
    assert _of(tree, "Keyway") == [] and _of(tree, "Slot") == []


def test_a_flat_bottomed_cross_hole_that_breaks_out_of_the_diameter_stays_a_cross_hole():
    # A Ø14 spot face 2 deep on the Ø16: its floor runs out of the diameter on both sides, walled only by the hole's own two arcs.
    tree = _recognize(P.cut(_shaft(), P.cylinder((20, 0, 6), (0, 0, 1), 14.0, 20.0)))
    assert _of(tree, "Keyway") == [] and _of(tree, "Slot") == []
    (cross,) = _of(tree, "SimpleHole")
    assert cross.variant == "cross" and cross.params["diameter_mm"] == pytest.approx(14.0)


def test_a_flat_along_the_whole_shaft_is_not_a_keyway():
    # A D shaft: nothing stands on the flat, so nothing was cut into a channel.
    tree = _recognize(P.cut(_shaft(), P.box((-1, -20, 6), (62, 40, 20))))
    assert _of(tree, "Keyway") == [] and _of(tree, "Slot") == []


# ── The feature graph costing reads ─────────────────────────────────────────


def test_the_keyway_reaches_the_feature_graph_with_the_fields_costing_reads():
    graph = _graph(_shaft_with_keyway())
    (group,) = [f for f in graph["features"] if f["feature_type"] == "Keyway"]
    assert (group["id"], group["variant"]) == ("Keyway-default_c1", "default")
    (occ,) = group["occurrences"]
    assert occ["length_mm"] == pytest.approx(20.0, abs=0.05)
    assert occ["width_mm"] == pytest.approx(WIDTH, abs=0.01)
    assert occ["depth_mm"] == pytest.approx(3.0, abs=0.01)
    assert occ["walled_fraction"] == pytest.approx(1.0, abs=0.005)
    assert occ["width_confined"] is True
    assert len(occ["face_ids"]) == 5
    # The floor's own area (a rectangle and two half discs) times the depth.
    assert occ["material_removed_mm3"] == pytest.approx((15.0 * WIDTH + 3.141592653589793 * (WIDTH / 2) ** 2) * 3.0, rel=0.01)
    assert not [f for f in graph["features"] if f["feature_type"] == "SimpleHole"]


def test_a_radial_slot_reaches_the_feature_graph_measured_the_same_way():
    graph = _graph(P.cut(_shaft(), P.box((18, -20, FLOOR_Z), (4, 40, 20))))
    (group,) = [f for f in graph["features"] if f["feature_type"] == "Slot"]
    assert (group["id"], group["variant"]) == ("Slot-radial_c1", "radial")
    (occ,) = group["occurrences"]
    assert occ["depth_mm"] == pytest.approx(3.0, abs=0.01)
    assert occ["width_confined"] is True
    assert 0.7 < occ["walled_fraction"] < 0.8
    assert len(occ["face_ids"]) == 3


# ── A milled part is read as before ─────────────────────────────────────────


def test_a_milled_block_with_a_round_ended_slot_is_read_as_before():
    # A 60 x 40 x 20 block with a blind slot 8 wide, 30 long, 6 deep in its top. The values are the recogniser's output before floors
    # facing across a turning axis were collected: the milled path collects along its datum axis only, and must not have moved.
    shape = P.cut(P.box((0, 0, 0), (60, 40, 20)), _obround(15, 37, 8.0, 14.0, 10.0, y=20.0))
    tree = _recognize(shape, "milled")
    assert [(f.id, f.type, f.variant, f.face_ids) for f in tree.features] == [
        ("slot_0", "Slot", "straight", [6, 8]),
        ("Keyway_0", "Keyway", "default", [10]),
        ("PlanarFace_0", "PlanarFace", "default", [0]),
        ("PlanarFace_1", "PlanarFace", "default", [1]),
        ("PlanarFace_2", "PlanarFace", "default", [2]),
        ("PlanarFace_3", "PlanarFace", "default", [3]),
        ("PlanarFace_4", "PlanarFace", "default", [4]),
        ("PlanarFace_5", "PlanarFace", "default", [5]),
        ("PlanarFace_6", "PlanarFace", "default", [7]),
        ("PlanarFace_7", "PlanarFace", "default", [9]),
    ]
    slot, keyway = tree.features[0], tree.features[1]
    assert slot.params == {
        "width_mm": 8.0, "length_mm": 30.0, "centre_distance_mm": 22.0, "end_radius_mm": 4.0, "depth_mm": 6.0,
        "area_mm2": 226.265, "centroid": pytest.approx([26.0, 20.0, 17.0]),
    }
    assert keyway.params == {
        "length_mm": 29.942, "width_mm": 8.0, "depth_mm": 6.0, "centroid": pytest.approx((26.0, 20.0, 14.0)),
        "area_mm2": 226.265, "walled_fraction": 1.0, "width_confined": True,
    }
