"""The turning axis (shared/machining_geometry.py): chosen by the area of the part's outer cylinders, not by how many cylindrical faces share
a direction, and the turned part it makes of a shaft two diameters long."""
import math

import pytest

pytest.importorskip("OCC")

from shared.machining_geometry import dominant_cylinder_axis, turned_diameter_count, turned_envelope, turning_axis  # noqa: E402
from shared.part_family import MILL_TURN, MILLED  # noqa: E402

import machined_parts as P  # noqa: E402


@pytest.fixture
def analysed(tmp_path):
    """An analysis in a cache of its own: with no file behind the shape, the optimizer's cache key is its face, edge and vertex counts, and
    the default cache directory is shared by every test."""
    def run(shape):
        from shared.memory_optimizer import AdvancedCADMemoryOptimizer
        optimizer = AdvancedCADMemoryOptimizer(cache_dir=str(tmp_path))
        return optimizer.analyze_and_optimize(shape).geometry_features.manufacturing_features["manufacturing_intelligence"]
    return run


def test_a_shafts_turned_diameters_decide_its_axis_not_its_more_numerous_cross_hole_faces():
    shaft = P.stepped_shaft_with_cross_holes_and_keyway()
    # Three faces run along the shaft (two diameters and the bore), six across it (three cross holes, each cut in two by the bore).
    assert dominant_cylinder_axis(shaft) == (1.0, 0.0, 0.0)
    assert turned_diameter_count(shaft) == 2
    line = turning_axis(shaft)
    assert sorted(round(2 * c["radius"], 3) for c in line["diameters"]) == sorted(P.SHAFT_DIAMETERS)
    assert line["largest_radius_mm"] == pytest.approx(10.0)
    # The line is the collar's own axis: y = z = 0.
    assert line["point"][1] == pytest.approx(0.0, abs=1e-9) and line["point"][2] == pytest.approx(0.0, abs=1e-9)


def test_the_shaft_lies_within_its_largest_turned_diameter():
    env = turned_envelope(P.stepped_shaft_with_cross_holes_and_keyway())
    assert env["largest_turned_od_mm"] == pytest.approx(20.0)
    assert env["swing_diameter_mm"] == pytest.approx(20.0, abs=1e-6)
    assert env["within"] is True


def test_the_shaft_is_a_mill_turn_part_with_its_diameters_found(analysed):
    # 40 long on Ø20: two diameters long, so neither the disc gate (mid/max > 0.80) nor the rod gate (max/mid > 2.5) sees a turned part.
    shaft = P.stepped_shaft_with_cross_holes_and_keyway()
    mi = analysed(shaft)
    assert mi["detected_family"] == MILL_TURN
    assert mi["classification_signals"]["turned_od_count"] == 2
    assert mi["classification_signals"]["largest_turned_od_mm"] == pytest.approx(20.0)
    assert any("within its largest turned outer diameter" in r for r in mi["classification_reason"])

    from machining.machining_feature_recognizer import MachiningFeatureRecognizer
    tree = MachiningFeatureRecognizer().recognize(shaft, mi["detected_family"])
    diameters = sorted(f.params["diameter_mm"] for f in tree.features if f.type == "Ring" and f.variant == "outer_diameter")
    assert diameters == sorted(P.SHAFT_DIAMETERS)
    bores = [f for f in tree.features if f.type == "SimpleHole" and f.variant in ("through", "threaded") and f.params.get("distance_from_axis_mm") == 0.0]
    assert [f.params["diameter_mm"] for f in bores] == [P.SHAFT_BORE]
    assert len([f for f in tree.features if f.type == "SimpleHole" and f.variant == "cross"]) >= len(P.SHAFT_CROSS_HOLES_X)


def test_a_part_reaching_past_its_turned_diameter_is_not_within_it(analysed):
    # A Ø20 x 10 hub on a 60 x 60 x 10 plate: the hub is a turned diameter on the part's centre line, the plate's corners swing far outside it.
    part = P.fuse(P.box((-30, -30, 0), (60, 60, 10)), P.cylinder((0, 0, 10), (0, 0, 1), 20.0, 10.0))
    env = turned_envelope(part)
    assert env["largest_turned_od_mm"] == pytest.approx(20.0)
    assert env["swing_diameter_mm"] == pytest.approx(2 * math.hypot(30, 30), abs=1e-3)
    assert env["within"] is False
    assert analysed(part)["detected_family"] == MILLED


def test_holes_decide_the_axis_only_when_the_part_has_no_outer_cylinder():
    # A block with one Ø20 bore along X (wall area 2513 mm2) and three Ø4 holes along Z (503 mm2 each): by area the bore's direction.
    block = P.cut(P.box((0, -20, -20), (40, 40, 40)), P.cylinder((-1, 0, 0), (1, 0, 0), 20.0, 42.0))
    for y in (-15.0, 15.0):
        block = P.cut(block, P.cylinder((5, y, -21), (0, 0, 1), 4.0, 42.0))
    block = P.cut(block, P.cylinder((35, 15, -21), (0, 0, 1), 4.0, 42.0))
    assert dominant_cylinder_axis(block) == (1.0, 0.0, 0.0)
    assert turned_diameter_count(block) == 0
    # A turned pin on it, however small, decides: Ø6 x 5 along Y (94 mm2 of outer cylinder).
    with_pin = P.fuse(block, P.cylinder((20, 20, 0), (0, 1, 0), 6.0, 5.0))
    assert dominant_cylinder_axis(with_pin) == (0.0, 1.0, 0.0)


def test_an_axis_off_the_model_axes_is_returned_as_it_is():
    # Along (1, -1, 0): taking each component's absolute value named the axis (1, 1, 0), square to the shaft.
    s = 1.0 / math.sqrt(2.0)
    shaft = P.cylinder((0, 0, 0), (1, -1, 0), 10.0, 40.0)
    assert dominant_cylinder_axis(shaft) == pytest.approx((s, -s, 0.0), abs=1e-9)
    assert turned_diameter_count(shaft) == 1
    # Either way round the cylinder was built, the axis has one name.
    assert dominant_cylinder_axis(P.cylinder((0, 0, 0), (-1, 1, 0), 10.0, 40.0)) == pytest.approx((s, -s, 0.0), abs=1e-9)
