"""
A cone is a countersink only when it is the mouth of a hole (shared/machining_geometry.classify_cone).

A countersink is a concave cone that touches the wall of the hole it opens into. The chamfer of a shoulder on a bored shaft is a convex
cone on the outside of the part: it shares the turning axis with the bore and nothing else, and it was read as a countersink of the bore
(Lead Screw side shaft: the chamfer of the Ø14 shoulder, a countersink Ø14 of the Ø7 bore). Built on OCC solids with known sizes.
"""
import pytest

pytest.importorskip("OCC")

from OCC.Core.BRepPrimAPI import BRepPrimAPI_MakeCone  # noqa: E402
from OCC.Core.gp import gp_Ax2, gp_Dir, gp_Pnt  # noqa: E402

from machining.machining_feature_recognizer import MachiningFeatureRecognizer  # noqa: E402

import machined_parts as P  # noqa: E402

# The shaft below, along X: a Ø12 spigot from 0 to 3, then Ø20 to 30, with a Ø7 bore through it. The Ø20's shoulder is chamfered
# 1 x 45 degrees. The bore is cut from x = -1 and the shoulder is at x = 3: the two surfaces' origins are 4 mm apart on one axis, as
# close as the pairing of a cone with a bore asks for.
SPIGOT, BODY, BORE, LENGTH = 12.0, 20.0, 7.0, 30.0
SHOULDER_X, CHAMFER = 3.0, 1.0
# The countersink at the bore's mouth in the spigot's end face: 90 degrees, Ø10 at the face.
SINK = 10.0


def _cone(at, direction, d0, d1, length):
    """A cone frustum from diameter d0 at `at` to d1, `length` along `direction`."""
    return BRepPrimAPI_MakeCone(gp_Ax2(gp_Pnt(*at), gp_Dir(*direction)), d0 / 2.0, d1 / 2.0, length).Shape()


def _shaft():
    x = (1, 0, 0)
    body = P.fuse(P.cylinder((0, 0, 0), x, SPIGOT, SHOULDER_X), _cone((SHOULDER_X, 0, 0), x, BODY - 2 * CHAMFER, BODY, CHAMFER))
    body = P.fuse(body, P.cylinder((SHOULDER_X + CHAMFER, 0, 0), x, BODY, LENGTH - SHOULDER_X - CHAMFER))
    return P.cut(body, P.cylinder((-1, 0, 0), x, BORE, LENGTH + 2.0))


def _countersunk_shaft():
    # The cutter's cone, from 1 mm outside the end face down to the bore's diameter.
    depth = (SINK - BORE) / 2.0
    return P.cut(_shaft(), _cone((-1, 0, 0), (1, 0, 0), SINK + 2.0, BORE, depth + 1.0))


def _recognize(shape, family="turned"):
    return MachiningFeatureRecognizer().recognize(shape, family)


def _edges(tree, variant):
    return [f for f in tree.features if f.type == "Edge" and f.variant == variant]


# ── Turned parts ────────────────────────────────────────────────────────────


def test_the_chamfer_of_a_shoulder_on_a_bored_shaft_is_a_chamfer_of_that_diameter():
    tree = _recognize(_shaft())
    assert _edges(tree, "countersink") == []
    (chamfer,) = _edges(tree, "chamfer")
    assert chamfer.params["diameter_mm"] == pytest.approx(BODY)
    assert chamfer.params["half_angle_deg"] == pytest.approx(45.0)
    assert chamfer.params["centroid"] == pytest.approx((SHOULDER_X, 0.0, 0.0), abs=1e-6)
    assert len(chamfer.face_ids) == 1
    # The bore and the diameters are read as they were.
    assert [(f.variant, f.params["diameter_mm"]) for f in tree.features if f.type == "SimpleHole"] == [("threaded", BORE)]
    assert sorted(f.params["diameter_mm"] for f in tree.features if f.type == "Ring") == [SPIGOT, BODY]


def test_a_countersink_at_the_bores_mouth_is_still_a_countersink_beside_the_shoulder_chamfer():
    tree = _recognize(_countersunk_shaft())
    (sink,) = _edges(tree, "countersink")
    assert sink.params["entry_diameter_mm"] == pytest.approx(SINK)
    assert sink.params["bore_diameter_mm"] == pytest.approx(BORE)
    assert sink.params["half_angle_deg"] == pytest.approx(45.0)
    (chamfer,) = _edges(tree, "chamfer")
    assert chamfer.params["diameter_mm"] == pytest.approx(BODY)
    assert not set(sink.face_ids) & set(chamfer.face_ids)


def test_the_shoulder_chamfer_is_a_chamfer_however_the_shaft_sits_in_the_model():
    tree = _recognize(P.rotated(P.rotated(_countersunk_shaft(), (0, 0, 1), 33.0), (1, 0, 0), 57.0))
    assert [f.params["entry_diameter_mm"] for f in _edges(tree, "countersink")] == [pytest.approx(SINK)]
    assert [f.params["diameter_mm"] for f in _edges(tree, "chamfer")] == [pytest.approx(BODY)]


# ── Milled parts ────────────────────────────────────────────────────────────


def test_a_milled_block_with_a_countersunk_hole_is_read_as_before():
    # A 40 x 40 x 12 block with a Ø6 hole drilled from its top and countersunk 90 degrees to Ø12. The values are the recogniser's output
    # before a cone had to be concave and touch its hole (the hole read as blind too: the countersink leaves its wall 9 of the 12 mm).
    z = (0, 0, -1)
    block = P.cut(P.box((0, 0, 0), (40, 40, 12)), P.cylinder((20, 20, 13), z, 6.0, 14.0))
    tree = _recognize(P.cut(block, _cone((20, 20, 13), z, 14.0, 6.0, 4.0)), "milled")
    (sink,) = _edges(tree, "countersink")
    assert sink.params == {"entry_diameter_mm": 12.0, "bore_diameter_mm": 6.0, "half_angle_deg": 45.0, "centroid": (20.0, 20.0, 13.0)}
    assert _edges(tree, "chamfer") == []
    assert [(f.variant, f.params["diameter_mm"], f.params["depth_mm"]) for f in tree.features if f.type == "SimpleHole"] == [("blind", 6.0, 9.0)]


def test_the_chamfered_rim_of_a_bored_boss_on_a_milled_block_is_a_chamfer():
    # A Ø20 x 6 boss on the block, its top rim chamfered 1 x 45 degrees, with a Ø6 hole drilled down its middle from 1 mm above it:
    # the rim's cone is convex and 2 mm from the hole's origin on one axis. It was a countersink Ø20 of the hole.
    up = (0, 0, 1)
    boss = P.fuse(P.cylinder((20, 20, 12), up, 20.0, 5.0), _cone((20, 20, 17), up, 20.0, 18.0, 1.0))
    part = P.cut(P.fuse(P.box((0, 0, 0), (40, 40, 12)), boss), P.cylinder((20, 20, 19), (0, 0, -1), 6.0, 20.0))
    tree = _recognize(part, "milled")
    assert _edges(tree, "countersink") == []
    (chamfer,) = _edges(tree, "chamfer")
    assert chamfer.params["diameter_mm"] == pytest.approx(20.0)
    assert chamfer.params["half_angle_deg"] == pytest.approx(45.0)
