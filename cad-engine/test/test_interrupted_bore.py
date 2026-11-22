"""
A hole whose wall does not go all the way round cannot be tapped: a tap needs a round hole.

The tap-drill heuristic reads a thread from a hole's diameter alone (shared/machining_geometry.classify_hole). A bore closed by a flat (a D
bore, a double D) or opened by a keyway is not asked: it keeps its plain variant, with no thread and no helicoil flag, and carries the flats
that close it. A round hole in a tap-drill band is read as threaded, as before. Built on OCC solids with known sizes.
"""
import pytest

pytest.importorskip("OCC")

from machining.machining_feature_recognizer import (  # noqa: E402
    MachiningFeatureRecognizer, _part_bounding_box, build_machining_feature_graph_v2,
)
from shared.machining_geometry import classify_hole  # noqa: E402

import machined_parts as P  # noqa: E402

# Ø7 is a tap drill for M8 x 1.25 (the band is 6.6 to 7.0), and so is Ø6.8.
THREAD = "M8×1.25"
FLAT = 3.0   # the flat's distance from the bore's axis
CHORD = 2 * (3.5 ** 2 - FLAT ** 2) ** 0.5   # the width of that flat in a Ø7 bore


def _shaft():
    """A Ø14 x 32 shaft along X."""
    return P.cylinder((0, 0, 0), (1, 0, 0), 14.0, 32.0)


def _d_cut(diameter, length, flats=(FLAT,)):
    """A round cut along X from x = -1 that leaves a flat at each of `flats` (its distance from the axis, above it when positive)."""
    tool = P.cylinder((-1, 0, 0), (1, 0, 0), diameter, length)
    for z in flats:
        tool = P.cut(tool, P.box((-2, -diameter, z if z > 0 else z - diameter), (length + 2, 2 * diameter, diameter)))
    return tool


def _recognize(shape, family="turned"):
    return MachiningFeatureRecognizer().recognize(shape, family)


def _holes(tree):
    return [f for f in tree.features if f.type == "SimpleHole"]


def _no_thread(params):
    return not {"spec", "detection", "helicoil_candidate", "through"} & set(params)


# ── The heuristic itself ────────────────────────────────────────────────────


def test_a_round_hole_in_a_tap_drill_band_is_read_as_threaded():
    assert classify_hole(7.0, through=True) == ("threaded", THREAD, False)
    assert classify_hole(7.0, through=True, full_turn=True) == ("threaded", THREAD, False)
    assert classify_hole(8.9, through=False) == ("threaded", THREAD, True)   # the helicoil band


def test_a_hole_whose_wall_is_interrupted_is_never_read_as_threaded():
    assert classify_hole(7.0, through=True, full_turn=False) == ("through", None, False)
    assert classify_hole(7.0, through=False, full_turn=False) == ("blind", None, False)
    assert classify_hole(8.9, through=False, full_turn=False) == ("blind", None, False)


# ── Turned parts ────────────────────────────────────────────────────────────


def test_a_d_bore_in_a_tap_drill_band_is_a_plain_through_hole():
    (bore,) = _holes(_recognize(P.cut(_shaft(), _d_cut(7.0, 34.0))))
    assert bore.variant == "through"
    p = bore.params
    assert _no_thread(p)
    assert p["diameter_mm"] == pytest.approx(7.0)
    assert p["depth_mm"] == pytest.approx(32.0, abs=0.01)
    assert p["distance_from_axis_mm"] == pytest.approx(0.0, abs=0.01)
    assert p["deep_hole"] is True   # 32 / 7: its depth annotations are those of any bore
    # The flat that closes it: its own width, and the hole's size from the flat to the far side of the bore.
    assert p["flat_count"] == 1
    assert p["flat_mm"] == pytest.approx(CHORD, abs=0.01)
    assert p["across_flat_mm"] == pytest.approx(3.5 + FLAT, abs=0.01)


def test_the_same_shaft_with_a_round_bore_is_still_read_as_threaded():
    (bore,) = _holes(_recognize(P.cut(_shaft(), P.cylinder((-1, 0, 0), (1, 0, 0), 6.8, 34.0))))
    assert bore.variant == "threaded"
    p = bore.params
    assert (p["spec"], p["detection"], p["through"]) == (THREAD, "geometry_heuristic", True)
    assert bore.confidence == pytest.approx(0.55)
    assert not {"flat_count", "flat_mm", "across_flat_mm"} & set(p)


def test_a_blind_d_bore_is_a_plain_blind_hole():
    (bore,) = _holes(_recognize(P.cut(_shaft(), _d_cut(7.0, 13.0))))
    assert bore.variant == "blind"
    assert _no_thread(bore.params)
    assert bore.params["depth_mm"] == pytest.approx(12.0, abs=0.01)
    assert (bore.params["flat_count"], bore.params["across_flat_mm"]) == (1, pytest.approx(6.5, abs=0.01))


def test_a_double_d_bore_is_a_plain_hole_with_its_two_flats():
    (bore,) = _holes(_recognize(P.cut(_shaft(), _d_cut(7.0, 34.0, flats=(FLAT, -FLAT)))))
    assert bore.variant == "through"
    assert _no_thread(bore.params)
    assert bore.params["flat_count"] == 2
    assert bore.params["flat_mm"] == pytest.approx(CHORD, abs=0.01)
    assert bore.params["across_flat_mm"] == pytest.approx(2 * FLAT, abs=0.01)   # between the two flats


def test_a_bore_opened_by_a_keyway_is_not_read_as_threaded():
    # A Ø20 x 15 hub with a Ø6.8 bore and a keyway 2 wide: the keyway takes 34 degrees out of the bore's wall.
    hub = P.cut(P.cylinder((0, 0, 0), (1, 0, 0), 20.0, 15.0), P.cylinder((-1, 0, 0), (1, 0, 0), 6.8, 17.0))
    tree = _recognize(P.cut(hub, P.box((-1, -1, 0), (17, 2, 4.4))), "mill_turn")
    (bore,) = _holes(tree)
    assert bore.variant == "through"
    assert _no_thread(bore.params)
    assert "flat_count" not in bore.params   # a keyway is not a flat: it is its own feature
    assert [f.type for f in tree.features if f.type == "Keyway"] == ["Keyway"]


def test_the_d_bore_reaches_the_feature_graph_untapped():
    shape = P.cut(_shaft(), _d_cut(7.0, 34.0))
    b = _part_bounding_box(shape)
    centre = ((b["xmin"] + b["xmax"]) / 2, (b["ymin"] + b["ymax"]) / 2, (b["zmin"] + b["zmax"]) / 2)
    graph = build_machining_feature_graph_v2(_recognize(shape).to_dict(), centre, [], 0)
    (group,) = [f for f in graph["features"] if f["feature_type"] == "SimpleHole"]
    assert (group["id"], group["variant"], group["diameter_mm"]) == ("SimpleHole-through_d7.0_c1", "through", 7.0)
    (occ,) = group["occurrences"]
    assert occ["tapped"] is False and occ["spec"] is None
    assert occ["depth_mm"] == pytest.approx(32.0, abs=0.01)


# ── Milled parts ────────────────────────────────────────────────────────────


def _block(cut):
    """A 40 x 40 x 12 block with the cut (made along X) turned to run along Z through its middle."""
    return P.cut(P.box((-20, -20, 0), (40, 40, 12)), P.rotated(cut, (0, 1, 0), -90.0))


def test_a_milled_block_with_a_d_shaped_hole_has_no_threaded_hole():
    # The milled path keeps a cylinder that sweeps less than a bore as a round, before any hole is classified: the heuristic is never asked.
    tree = _recognize(_block(_d_cut(7.0, 14.0)), "milled")
    assert _holes(tree) == []
    (arc,) = [f for f in tree.features if f.type == "Edge" and f.variant == "round"]
    assert arc.params["radius_mm"] == pytest.approx(3.5)
    assert arc.params["sweep_deg"] == pytest.approx(298.0, abs=0.5)
    assert arc.params["concave"] is True


def test_a_milled_block_with_a_round_hole_in_the_band_is_still_read_as_threaded():
    (bore,) = _holes(_recognize(_block(P.cylinder((-1, 0, 0), (1, 0, 0), 6.8, 14.0)), "milled"))
    assert bore.variant == "threaded"
    assert (bore.params["spec"], bore.params["detection"], bore.params["through"]) == (THREAD, "geometry_heuristic", True)
