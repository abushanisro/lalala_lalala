"""
A recess floor that faces along the turning axis (machining_feature_recognizer._classify_prismatic_turned).

Such a floor lies across the axis, so it is never a keyway: a keyway's floor faces across the axis and its long side runs along it
(test_turned_keyway.py). An elongated one walled on both sides of its width is a slot across an end face or a shoulder, Slot/radial. One
walled on a single side is the end wall of a milled flat (a D flat, a wrench flat, a tang): it was read as a keyway as long as the flat's
chord and as deep as the flat is long, and is now no feature. The flat itself has no feature either. Built on OCC solids with known sizes.
"""
import pytest

pytest.importorskip("OCC")

from machining.machining_feature_recognizer import (  # noqa: E402
    MachiningFeatureRecognizer, _part_bounding_box, build_machining_feature_graph_v2,
)

import machined_parts as P  # noqa: E402
from test_turned_keyway import _shaft, _shaft_with_keyway, _surfaces  # noqa: E402

# The shaft is test_turned_keyway's: along X, Ø16 from 0 to 40, then Ø24 to 60.
# A flat 3 mm deep on the Ø16 (5 mm from the axis) is 2 * sqrt(8^2 - 5^2) = 12.49 wide.
FLAT_Z = 5.0
# The drive slot across the Ø16's end face: 3 wide, 4 deep.
SLOT_WIDTH, SLOT_DEPTH = 3.0, 4.0


def _flat(x0, length, z=FLAT_Z):
    """The cut of a flat `z` from the axis (below it when negative), from x0 for `length` along the shaft."""
    return P.box((x0, -20, z if z > 0 else z - 20), (length, 40, 20))


def _recognize(shape, family="mill_turn"):
    return MachiningFeatureRecognizer().recognize(shape, family)


def _of(tree, ftype):
    return [f for f in tree.features if f.type == ftype]


def _diameters(tree):
    return sorted(f.params["diameter_mm"] for f in tree.features if f.type == "Ring" and f.variant == "outer_diameter")


# ── The end wall of a flat ──────────────────────────────────────────────────


def test_a_flat_milled_at_a_shaft_end_gives_no_keyway_and_no_slot():
    # 15 long from the end face: its end wall faces along the shaft, 12.49 x 3, and was a Keyway 12.49 x 3 x 15.
    tree = _recognize(P.cut(_shaft(), _flat(-1, 16)))
    assert _of(tree, "Keyway") == [] and _of(tree, "Slot") == []
    assert _diameters(tree) == [16.0, 24.0]


def test_two_wrench_flats_give_no_keyway_and_no_slot():
    # Two flats 6 from the axis, 20 long in the middle of the Ø16: four end walls, which were four Keyways 10.58 x 2 x 20.
    shape = P.cut(P.cut(_shaft(), _flat(10, 20, 6.0)), _flat(10, 20, -6.0))
    tree = _recognize(shape)
    assert _of(tree, "Keyway") == [] and _of(tree, "Slot") == []
    assert _diameters(tree) == [16.0, 24.0]


def test_a_tang_at_a_shaft_end_gives_no_keyway_and_no_slot():
    # Two flats 2 from the axis leave a tongue 4 thick, 5 long: its two shoulders are walled on one side each.
    tree = _recognize(P.cut(P.cut(_shaft(), _flat(-1, 6, 2.0)), _flat(-1, 6, -2.0)))
    assert _of(tree, "Keyway") == [] and _of(tree, "Slot") == []


def test_a_step_milled_across_half_an_end_face_gives_no_keyway_and_no_slot():
    tree = _recognize(P.cut(_shaft(), P.box((-1, -20, 0), (5, 40, 20))))
    assert _of(tree, "Keyway") == [] and _of(tree, "Slot") == []


# ── A slot across an end face ───────────────────────────────────────────────


def _shaft_with_drive_slot():
    return P.cut(_shaft(), P.box((-1, -SLOT_WIDTH / 2, -20), (SLOT_DEPTH + 1, SLOT_WIDTH, 40)))


def test_a_drive_slot_across_an_end_face_is_one_radial_slot():
    shape = _shaft_with_drive_slot()
    tree = _recognize(shape)
    (slot,) = _of(tree, "Slot")
    assert slot.variant == "radial"
    p = slot.params
    # Right across the Ø16 through its axis: as long as the chord its side walls cut, 3 wide.
    assert p["length_mm"] == pytest.approx(2 * (8.0 ** 2 - (SLOT_WIDTH / 2) ** 2) ** 0.5, abs=0.3)
    assert p["width_mm"] == pytest.approx(SLOT_WIDTH, abs=0.01)
    assert p["depth_mm"] == pytest.approx(SLOT_DEPTH, abs=0.01)
    assert p["width_confined"] is True
    assert 0.8 < p["walled_fraction"] < 0.9   # its two walls; both ends run out of the diameter
    assert p["centroid"] == pytest.approx((SLOT_DEPTH, 0.0, 0.0), abs=0.01)
    # Its floor: the face that looks along the shaft.
    assert [_surfaces(shape)[i] for i in slot.face_ids] == [("plane", (1.0, 0.0, 0.0))]
    assert _of(tree, "Keyway") == []
    assert _diameters(tree) == [16.0, 24.0]


def test_a_slot_closed_inside_an_end_face_is_a_radial_slot():
    # 3 x 10, 4 deep, its four walls inside the Ø16.
    tree = _recognize(P.cut(_shaft(), P.box((-1, -SLOT_WIDTH / 2, -5), (SLOT_DEPTH + 1, SLOT_WIDTH, 10))))
    (slot,) = _of(tree, "Slot")
    assert slot.variant == "radial"
    assert (slot.params["length_mm"], slot.params["width_mm"], slot.params["depth_mm"]) == (pytest.approx(10.0, abs=0.01), pytest.approx(3.0, abs=0.01), pytest.approx(4.0, abs=0.01))
    assert slot.params["walled_fraction"] == pytest.approx(1.0, abs=0.005)
    assert _of(tree, "Keyway") == []


def test_the_drive_slot_reaches_the_feature_graph_measured_as_a_slot_on_a_diameter_is():
    shape = _shaft_with_drive_slot()
    b = _part_bounding_box(shape)
    centre = ((b["xmin"] + b["xmax"]) / 2, (b["ymin"] + b["ymax"]) / 2, (b["zmin"] + b["zmax"]) / 2)
    graph = build_machining_feature_graph_v2(_recognize(shape).to_dict(), centre, [], 0)
    (group,) = [f for f in graph["features"] if f["feature_type"] == "Slot"]
    assert (group["id"], group["variant"]) == ("Slot-radial_c1", "radial")
    (occ,) = group["occurrences"]
    assert occ["depth_mm"] == pytest.approx(SLOT_DEPTH, abs=0.01)
    assert occ["width_confined"] is True
    # The floor's own area times the depth.
    area = _recognize(shape).features[-1].params["area_mm2"]
    assert occ["material_removed_mm3"] == pytest.approx(area * SLOT_DEPTH, rel=0.001)
    assert not [f for f in graph["features"] if f["feature_type"] == "Keyway"]


# ── A real keyway is read as before ─────────────────────────────────────────


def test_a_keyway_on_a_diameter_is_still_one_keyway():
    tree = _recognize(_shaft_with_keyway())
    (keyway,) = _of(tree, "Keyway")
    assert (keyway.params["length_mm"], keyway.params["width_mm"], keyway.params["depth_mm"]) == (
        pytest.approx(20.0, abs=0.05), pytest.approx(5.0, abs=0.01), pytest.approx(3.0, abs=0.01))
    assert _of(tree, "Slot") == []


def test_a_keyway_beside_a_flat_is_still_the_only_keyway():
    # The keyway in the top of the Ø16 and a flat on its underside, 15 long from the end face.
    tree = _recognize(P.cut(_shaft_with_keyway(), _flat(-1, 16, -FLAT_Z)))
    assert len(_of(tree, "Keyway")) == 1 and _of(tree, "Slot") == []
