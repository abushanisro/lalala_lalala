"""
Where a cross hole is about the turning axis (shared/machining_geometry.collect_cylinders): its distance from the axis and its angle round it.

Both were read from the cylinder's stored origin, an arbitrary point of the hole's own axis: a hole drilled straight through the turning
axis was as far from it as that point happened to lie (50 mm for a cutter started 50 mm outside the shaft), and holes spaced round the
axis were a pattern only when their origins were. The distance is now the one between the two lines, 0 when they meet, and the angle is
that of the middle of the hole's wall. An axial hole is measured as before: every point of its axis is equally far from the turning axis.
Built on OCC solids with known sizes.
"""
import math

import pytest

pytest.importorskip("OCC")

from machining.machining_feature_recognizer import MachiningFeatureRecognizer  # noqa: E402

import machined_parts as P  # noqa: E402
from test_turned_keyway import _shaft  # noqa: E402

# The shaft is test_turned_keyway's: along X, Ø16 from 0 to 40, then Ø24 to 60.
# The tube: a Ø30 x 25 bushing along Z with a Ø18 bore, its wall 6 thick.
HOLES_Z = 12.0


def _recognize(shape, family="mill_turn"):
    return MachiningFeatureRecognizer().recognize(shape, family)


def _holes(tree, variant):
    return [f for f in tree.features if f.type == "SimpleHole" and f.variant == variant]


# ── Distance from the axis ──────────────────────────────────────────────────


def test_a_cross_hole_through_the_axis_is_on_it_wherever_its_cutter_started():
    # Along Y through the X axis, the cutter started 50 mm outside the shaft: that was its distance.
    (cross,) = _holes(_recognize(P.cut(_shaft(), P.cylinder((20, -50, 0), (0, 1, 0), 4.0, 100.0))), "cross")
    assert cross.params["diameter_mm"] == pytest.approx(4.0)
    assert cross.params["distance_from_axis_mm"] == pytest.approx(0.0, abs=1e-6)
    assert cross.params["angle_deg"] == 0.0   # it lies on both sides of the axis: no angle round it


@pytest.mark.parametrize("tool", [
    P.cylinder((20, -50, 3), (0, 1, 0), 3.0, 100.0),
    P.cylinder((20, 80, 3), (0, -1, 0), 3.0, 200.0),   # the same hole, cut from the other side from farther out
], ids=["from -Y", "from +Y"])
def test_a_cross_hole_that_passes_the_axis_is_as_far_from_it_as_the_two_lines_are(tool):
    # Along Y, 3 mm above the axis.
    (cross,) = _holes(_recognize(P.cut(_shaft(), tool)), "cross")
    assert cross.params["distance_from_axis_mm"] == pytest.approx(3.0, abs=1e-6)
    assert cross.params["angle_deg"] == pytest.approx(90.0, abs=0.1)   # on the +Z side, a quarter turn from +Y about X


@pytest.mark.parametrize("tool", [
    P.cylinder((61, 0, 9), (-1, 0, 0), 3.0, 11.0),
    P.cylinder((45, 0, 9), (1, 0, 0), 3.0, 20.0),   # the same hole, its cylinder started inside the shaft
], ids=["from the end face", "from inside"])
def test_an_axial_hole_off_the_centreline_reports_its_offset_as_before(tool):
    # 10 deep in the collar's end face, 9 mm from the axis.
    (hole,) = _holes(_recognize(P.cut(_shaft(), tool)), "blind")
    assert hole.params["diameter_mm"] == pytest.approx(3.0)
    assert hole.params["distance_from_axis_mm"] == pytest.approx(9.0, abs=1e-6)


def test_two_cross_holes_through_the_axis_at_two_stations_stay_two_cross_holes():
    shape = P.cut(P.cut(_shaft(), P.cylinder((10, -50, 0), (0, 1, 0), 4.0, 100.0)), P.cylinder((25, 0, -50), (0, 0, 1), 4.0, 100.0))
    tree = _recognize(shape)
    assert [f.params["distance_from_axis_mm"] for f in _holes(tree, "cross")] == [pytest.approx(0.0, abs=1e-6)] * 2
    assert _holes(tree, "pcd_pattern") == []


# ── Angle round the axis: holes spaced round a tube ─────────────────────────


def _tube_with_radial_holes(origin_radius, count=4):
    """The tube with `count` Ø4 holes through its wall, equally spaced, each cylinder started `origin_radius` from the axis."""
    tube = P.bushing(od=30.0, bore=18.0, length=25.0)
    for k in range(count):
        a = 2 * math.pi * k / count
        dx, dy = math.cos(a), math.sin(a)
        if origin_radius == 0.0:
            tool = P.cylinder((0, 0, HOLES_Z), (dx, dy, 0), 4.0, 20.0)                                   # from the axis outwards
        else:
            tool = P.cylinder((origin_radius * dx, origin_radius * dy, HOLES_Z), (-dx, -dy, 0), 4.0, origin_radius - 8.0)   # from outside inwards
        tube = P.cut(tube, tool)
    return tube


@pytest.mark.parametrize("origin_radius", [0.0, 20.0], ids=["origins on the axis", "origins outside the tube"])
def test_radial_holes_round_a_tube_are_one_pattern_wherever_their_cylinders_started(origin_radius):
    # With their origins on the axis they had no angle and stayed four cross holes.
    tree = _recognize(_tube_with_radial_holes(origin_radius))
    (pattern,) = _holes(tree, "pcd_pattern")
    assert pattern.params["hole_count"] == 4
    assert pattern.params["hole_diameter_mm"] == pytest.approx(4.0)
    assert pattern.params["depth_mm"] == pytest.approx(6.0, abs=0.3)   # the wall; a little more where the hole meets the bore
    assert pattern.params["pcd_mm"] == 0.0   # the holes' axes meet on the turning axis
    assert len(pattern.face_ids) == 4
    assert _holes(tree, "cross") == []


def test_a_hole_drilled_right_across_a_tube_is_two_radial_holes_opposite_each_other():
    # One cylinder, cut in two by the bore: its two walls are half a turn apart round the axis.
    tree = _recognize(P.cut(P.bushing(od=30.0, bore=18.0, length=25.0), P.cylinder((-20, 0, HOLES_Z), (1, 0, 0), 4.0, 40.0)))
    (pattern,) = _holes(tree, "pcd_pattern")
    assert (pattern.params["hole_count"], pattern.params["hole_diameter_mm"]) == (2, pytest.approx(4.0))
    assert len(pattern.face_ids) == 2
    assert _holes(tree, "cross") == []
