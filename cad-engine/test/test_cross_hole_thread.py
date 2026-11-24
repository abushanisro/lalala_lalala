"""
A cross hole at a tap-drill size is tapped, as a bore is (shared/machining_geometry.classify_hole).

On the turned path every axial bore went through the tap-drill check but no cross hole did, so an M3 hole drilled Ø2.5 across a shaft
(the lead screw side shaft, FusionComponent) was drilled and never tapped, and a pattern of them dropped the thread the axial bolt circle
keeps. A tapped cross hole stays variant "cross" (a lathe drills and taps it radially with a live tool) and carries its thread as
params.spec; a pattern of them carries tap_spec and hole_type "tapped", as an axial bolt circle does; feature_graph_v2 marks both tapped.
Built on OCC solids with known sizes.
"""
import pytest

pytest.importorskip("OCC")

from machining.machining_feature_recognizer import (  # noqa: E402
    MachiningFeatureRecognizer,
    _part_bounding_box,
    build_machining_feature_graph_v2,
)

import machined_parts as P  # noqa: E402
from test_turned_keyway import _shaft  # noqa: E402

# The shaft is test_turned_keyway's: along X, Ø16 from 0 to 40, then Ø24 to 60.


def _recognize(shape):
    return MachiningFeatureRecognizer().recognize(shape, "mill_turn")


def _hole_features(tree):
    return [f for f in tree.features if f.type == "SimpleHole"]


def test_a_cross_hole_at_an_m3_tap_drill_is_tapped_and_stays_a_cross_hole():
    # Ø2.5 along Y through the X axis: an M3×0.5 tap drill.
    (cross,) = [f for f in _hole_features(_recognize(P.cut(_shaft(), P.cylinder((20, -50, 0), (0, 1, 0), 2.5, 100.0)))) if f.variant == "cross"]
    assert cross.params["spec"] == "M3×0.5"
    assert cross.params["detection"] == "geometry_heuristic"


def test_a_cross_hole_at_no_tap_drill_size_is_drilled_only():
    # Ø4 is no tap drill in the table (M5 drills at 4.1-4.4).
    (cross,) = [f for f in _hole_features(_recognize(P.cut(_shaft(), P.cylinder((20, -50, 0), (0, 1, 0), 4.0, 100.0)))) if f.variant == "cross"]
    assert "spec" not in cross.params


def test_a_pattern_of_tapped_cross_holes_is_tapped_and_feature_graph_v2_says_so():
    # Two Ø2.5 holes across the Ø16 section, a quarter turn apart round the axis: a radial pattern.
    part = P.cut(P.cut(_shaft(), P.cylinder((15, -50, 0), (0, 1, 0), 2.5, 100.0)), P.cylinder((15, 0, -50), (0, 0, 1), 2.5, 100.0))
    tree = _recognize(part)
    patterns = [f for f in _hole_features(tree) if f.variant == "pcd_pattern"]
    crosses = [f for f in _hole_features(tree) if f.variant == "cross"]
    tapped = patterns or crosses
    assert tapped, "the Ø2.5 holes are found"
    for f in patterns:
        assert f.params["tap_spec"] == "M3×0.5" and f.params["hole_type"] == "tapped"
    for f in crosses:
        assert f.params["spec"] == "M3×0.5"

    bb = _part_bounding_box(part)
    centre = ((bb["xmin"] + bb["xmax"]) / 2, (bb["ymin"] + bb["ymax"]) / 2, (bb["zmin"] + bb["zmax"]) / 2)
    graph = build_machining_feature_graph_v2(tree.to_dict(), centre, [], 0)
    holes = [f for f in graph["features"] if f["feature_type"] == "SimpleHole" and f["variant"] in ("pcd_pattern", "cross")]
    occurrences = [o for f in holes for o in f["occurrences"]]
    assert occurrences and all(o["tapped"] and o["spec"] == "M3×0.5" for o in occurrences)
