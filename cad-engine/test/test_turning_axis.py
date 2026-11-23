"""The turning axis (shared/machining_geometry.py): chosen by the area of the part's outer cylinders, not by how many cylindrical faces share
a direction, and the turned part it makes of a shaft two diameters long."""
import math

import pytest

pytest.importorskip("OCC")

from shared.machining_geometry import dominant_cylinder_axis, turned_diameter_count, turned_envelope, turning_axis, turning_line_point  # noqa: E402
from shared.part_family import MILL_TURN, MILLED, TURNED_FAMILIES  # noqa: E402

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


# ── The line the part is turned about ───────────────────────────────────────
# Located by the turned cylinders themselves (turning_line_point): the axis line the part's outer cylinders cover the most area about,
# of those the part's centre of mass lies inside. The centre of the bounding box was taken for it. That centre moves with the mesh (the
# analysis meshes the shape first, and the box of a meshed shape is read from the mesh's nodes) and leaves the axis of a part that is
# not the same on both sides of it: a turned diameter then lay off the axis and was no turned diameter at all.


def _stepped_shaft():
    """Along X: Ø16 from 0 to 40, then Ø24 to 60."""
    return P.fuse(P.cylinder((0, 0, 0), (1, 0, 0), 16.0, 40.0), P.cylinder((40, 0, 0), (1, 0, 0), 24.0, 20.0))


def _ring_diameters(shape, family):
    from machining.machining_feature_recognizer import MachiningFeatureRecognizer
    tree = MachiningFeatureRecognizer().recognize(shape, family)
    return sorted(f.params["diameter_mm"] for f in tree.features if f.type == "Ring" and f.variant == "outer_diameter")


@pytest.mark.parametrize("build, diameters", [
    (_stepped_shaft, [16.0, 24.0]),
    (lambda: P.cylinder((0, 0, 0), (1, 0, 0), 30.0, 80.0), [30.0]),
    (P.bushing, [30.0]),
], ids=["stepped shaft", "cylinder", "bushing"])
def test_a_plain_turned_part_is_turned_with_its_diameters_once_the_analysis_has_meshed_it(analysed, build, diameters):
    # The analysis meshes the shape before anything is measured. The mesh's box sat 0.02 mm off these parts' axes: the stepped shaft
    # and the bushing were milled and the cylinder was sheet metal, each with no turned diameter.
    shape = build()
    mi = analysed(shape)
    assert mi["detected_family"] in TURNED_FAMILIES
    assert mi["classification_signals"]["turned_od_count"] == len(diameters)
    assert mi["classification_signals"]["largest_turned_od_mm"] == pytest.approx(max(diameters))
    # Recognised on the shape as the analysis left it: meshed.
    assert _ring_diameters(shape, mi["detected_family"]) == diameters


def test_the_meshed_bushing_keeps_its_bore_on_the_axis(analysed):
    from machining.machining_feature_recognizer import MachiningFeatureRecognizer
    shape = P.bushing()
    family = analysed(shape)["detected_family"]
    (bore,) = [f for f in MachiningFeatureRecognizer().recognize(shape, family).features if f.type == "SimpleHole"]
    assert (bore.variant, bore.params["diameter_mm"]) == ("through", 18.0)
    assert bore.params["distance_from_axis_mm"] == 0.0


def test_the_turning_line_is_the_shafts_own_axis():
    point = turning_line_point(_stepped_shaft(), (1.0, 0.0, 0.0))
    assert point[1] == pytest.approx(0.0, abs=1e-9) and point[2] == pytest.approx(0.0, abs=1e-9)


def test_a_shaft_with_a_flat_along_its_whole_length_keeps_its_turned_diameters():
    # A D shaft, the flat 6 from the axis on both diameters: its box runs from -12 to 6, its centre 3 mm off the axis.
    shaft = P.cut(_stepped_shaft(), P.box((-1, -20, 6), (62, 40, 20)))
    line = turning_axis(shaft)
    assert sorted(round(2 * c["radius"], 3) for c in line["diameters"]) == [16.0, 24.0]
    assert line["point"][1] == pytest.approx(0.0, abs=1e-9) and line["point"][2] == pytest.approx(0.0, abs=1e-9)
    assert _ring_diameters(shaft, "mill_turn") == [16.0, 24.0]


def test_a_stepped_shaft_lying_askew_in_the_model_keeps_its_diameters_and_its_cross_holes_distance():
    # Its box is not centred on its axis: the collar is at one end. A Ø3 cross hole passes 3 mm from the axis.
    from machining.machining_feature_recognizer import MachiningFeatureRecognizer
    shaft = P.cut(_stepped_shaft(), P.cylinder((20, -50, 3), (0, 1, 0), 3.0, 100.0))
    askew = P.rotated(P.rotated(shaft, (0, 0, 1), 33.0), (1, 0, 0), 57.0)
    assert turned_diameter_count(askew) == 2
    tree = MachiningFeatureRecognizer().recognize(askew, "mill_turn")
    assert sorted(f.params["diameter_mm"] for f in tree.features if f.type == "Ring") == [16.0, 24.0]
    (cross,) = [f for f in tree.features if f.type == "SimpleHole" and f.variant == "cross"]
    assert cross.params["distance_from_axis_mm"] == pytest.approx(3.0, abs=1e-6)


def test_a_boss_beside_the_middle_of_a_block_is_not_a_turned_diameter():
    # A Ø10 boss near a corner of an 80 x 50 x 30 block: the block is not centred in it, so no line is turned about.
    part = P.fuse(P.box((0, 0, 0), (80, 50, 30)), P.cylinder((15, 12, 30), (0, 0, 1), 10.0, 8.0))
    assert turning_line_point(part, (0.0, 0.0, 1.0)) is None
    assert turned_diameter_count(part) == 0


def test_a_hub_on_the_middle_of_a_plate_is_a_turned_diameter_on_its_own_axis():
    point = turning_line_point(P.plate_with_hub(), (0.0, 0.0, 1.0))
    assert point[0] == pytest.approx(0.0, abs=1e-9) and point[1] == pytest.approx(0.0, abs=1e-9)
    assert turned_diameter_count(P.plate_with_hub()) == 1
