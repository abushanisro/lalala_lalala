"""
A flat milled on a turned diameter is a Flat (machining_feature_recognizer._classify_turned_flat): a floor facing across the turning axis that
meets a turned diameter in an outside corner, lies inside it with the axis behind it, and is walled on at most one side of its width. Since
geo_v83 such a floor had no feature at all, so a flat was not costed.

Every part here is read as an upload is (shared.part_analysis.analyze_part on a STEP file: the shape is meshed before anything is measured),
and each flat carries its length along the axis, its width (the chord), its depth below the diameter it is cut into, that diameter, its
area, its faces, and in the feature graph the circular segment it cuts off that diameter over its length. A keyway and a drive slot are read
as before. Built on OCC solids with known sizes.
"""
import hashlib
import math
from pathlib import Path

import pytest

pytest.importorskip("OCC")

import machined_parts as P  # noqa: E402
from test_turned_keyway import _shaft, _shaft_with_keyway, _surfaces  # noqa: E402

# The shaft is test_turned_keyway's: along X, Ø16 from 0 to 40, then Ø24 to 60.
R = 8.0


def _flat(x0, length, z):
    """The cut of a flat `z` from the axis (below it when negative), from x0 for `length` along the shaft."""
    return P.box((x0, -20, z if z > 0 else z - 20), (length, 40, 20))


def _chord(r, d):
    return 2.0 * math.sqrt(r * r - d * d)


def _segment(r, d):
    """The area a plane `d` from the axis cuts off a round of radius r."""
    return r * r * math.acos(d / r) - d * math.sqrt(r * r - d * d)


# Two wrench flats 6 from the axis, 20 long in the middle of the Ø16; a D flat 5 from the axis, 15 long from the end face; a tang, two flats
# 2 from the axis leaving a tongue 4 thick, 5 long; a D shaft, a Ø20 x 50 with a flat 7 from the axis along its whole length (no wall).
PARTS = {
    "wrench flats": lambda: P.cut(P.cut(_shaft(), _flat(10, 20, 6.0)), _flat(10, 20, -6.0)),
    "D flat": lambda: P.cut(_shaft(), _flat(-1, 16, 5.0)),
    "tang": lambda: P.cut(P.cut(_shaft(), _flat(-1, 6, 2.0)), _flat(-1, 6, -2.0)),
    "D shaft": lambda: P.cut(P.cylinder((0, 0, 0), (1, 0, 0), 20.0, 50.0), P.box((-1, -20, 7), (52, 40, 20))),
    "keyway": _shaft_with_keyway,
    "drive slot": lambda: P.cut(_shaft(), P.box((-1, -1.5, -20), (5, 3, 40))),
}


def _write_step(shape, path: Path) -> str:
    from OCC.Core.IFSelect import IFSelect_RetDone
    from OCC.Core.STEPControl import STEPControl_AsIs, STEPControl_Writer
    writer = STEPControl_Writer()
    writer.Transfer(shape, STEPControl_AsIs)
    assert writer.Write(str(path)) == IFSelect_RetDone
    return str(path)


@pytest.fixture(scope="module")
def analysed(tmp_path_factory):
    """Each part's machining_features and its shape as read back from its STEP file, analysed once."""
    from shared.memory_optimizer import AdvancedCADMemoryOptimizer
    from shared.part_analysis import ComponentFeatureCache, analyze_part
    from shared.services import StepReader
    out = {}
    for name, build in PARTS.items():
        tmp = tmp_path_factory.mktemp(name.replace(" ", "_"))
        step = _write_step(build(), tmp / "part.step")
        shape = StepReader().read(step)
        result = analyze_part(
            shape=shape, step_path=step, filename="part.step", file_hash=hashlib.sha256(Path(step).read_bytes()).hexdigest(),
            memory_optimizer=AdvancedCADMemoryOptimizer(cache_dir=str(tmp / "cache")), component_cache=ComponentFeatureCache(tmp / "cf"),
            face_graph_max_faces=5000, force_reanalysis=True,
        )
        out[name] = (result["machining_features"], shape)
    return out


def _of(mf, ftype):
    return [f for f in mf["features"] if f["type"] == ftype]


def _group(mf, ftype):
    return [g for g in mf["feature_graph_v2"]["features"] if g["feature_type"] == ftype]


@pytest.mark.parametrize("name", ["wrench flats", "D flat", "tang", "D shaft"])
def test_a_flat_on_a_turned_part_is_a_flat_and_nothing_else(analysed, name):
    mf, _shape = analysed[name]
    assert mf["family"] in ("turned", "mill_turn")
    assert _of(mf, "Flat")
    assert _of(mf, "Keyway") == [] and _of(mf, "Slot") == [] and [f for f in _of(mf, "SimpleHole") if f["variant"] == "cross"] == []
    assert all(f["variant"] == "default" for f in _of(mf, "Flat"))
    # Its faces are its own: no face of the part is claimed twice.
    assert mf["face_coverage"]["multiply_claimed_faces"] == []


@pytest.mark.parametrize("name, count, length, d, diameter", [
    ("wrench flats", 2, 20.0, 6.0, 16.0),
    ("D flat", 1, 15.0, 5.0, 16.0),
    ("tang", 2, 5.0, 2.0, 16.0),
    ("D shaft", 1, 50.0, 7.0, 20.0),
], ids=["wrench flats", "D flat", "tang", "D shaft"])
def test_each_flat_carries_its_size_and_the_diameter_it_is_cut_into(analysed, name, count, length, d, diameter):
    mf, _shape = analysed[name]
    flats = _of(mf, "Flat")
    assert len(flats) == count
    r = diameter / 2.0
    for flat in flats:
        p = flat["params"]
        assert p["length_mm"] == pytest.approx(length, abs=0.01)
        # Its width across the axis is the chord of the round at its plane; its depth is below that round, not the height of a wall.
        assert p["width_mm"] == pytest.approx(_chord(r, d), abs=0.01)
        assert p["depth_mm"] == pytest.approx(r - d, abs=0.01)
        assert p["diameter_mm"] == pytest.approx(diameter, abs=0.001)
        assert p["area_mm2"] == pytest.approx(length * _chord(r, d), rel=0.001)
        assert len(p["centroid"]) == 3


def test_the_flats_lie_where_they_were_cut(analysed):
    mf, _shape = analysed["wrench flats"]
    # One above the axis and one below it, both in the middle of their 20 mm.
    centroids = sorted(tuple(f["params"]["centroid"]) for f in _of(mf, "Flat"))
    assert centroids[0] == pytest.approx((20.0, 0.0, -6.0), abs=0.01)
    assert centroids[1] == pytest.approx((20.0, 0.0, 6.0), abs=0.01)


@pytest.mark.parametrize("name, walls", [("wrench flats", 2), ("D flat", 1), ("tang", 1), ("D shaft", 0)])
def test_a_flat_owns_its_floor_and_its_end_walls(analysed, name, walls):
    mf, shape = analysed[name]
    surfaces = _surfaces(shape)
    for flat in _of(mf, "Flat"):
        kinds = sorted(surfaces[i] for i in flat["face_ids"])
        # The floor faces across the axis (Z); an end wall faces along it (X).
        assert kinds == sorted([("plane", (0.0, 0.0, 1.0))] + [("plane", (1.0, 0.0, 0.0))] * walls)
        assert (flat["params"]["walled_fraction"] > 0) == (walls > 0)


@pytest.mark.parametrize("name, count, length, d, diameter", [
    ("wrench flats", 2, 20.0, 6.0, 16.0),
    ("D flat", 1, 15.0, 5.0, 16.0),
    ("tang", 2, 5.0, 2.0, 16.0),
    ("D shaft", 1, 50.0, 7.0, 20.0),
], ids=["wrench flats", "D flat", "tang", "D shaft"])
def test_the_feature_graph_carries_each_flat_and_the_segment_it_cuts_off(analysed, name, count, length, d, diameter):
    mf, _shape = analysed[name]
    (group,) = _group(mf, "Flat")
    assert (group["id"], group["variant"]) == (f"Flat-default_c{count}", "default")
    r = diameter / 2.0
    for occ in group["occurrences"]:
        assert (occ["length_mm"], occ["width_mm"], occ["depth_mm"], occ["diameter_mm"]) == (
            pytest.approx(length, abs=0.01), pytest.approx(_chord(r, d), abs=0.01), pytest.approx(r - d, abs=0.01), pytest.approx(diameter))
        assert occ["area_mm2"] > 0 and occ["face_ids"]
        # The circular segment between the flat and its round, over the flat's length; not the floor's area times its depth.
        assert occ["material_removed_mm3"] == pytest.approx(length * _segment(r, d), rel=0.001)
        assert occ["material_removed_mm3"] < occ["area_mm2"] * occ["depth_mm"]


def test_the_turned_diameters_are_kept_beside_the_flats(analysed):
    for name in ("wrench flats", "D flat", "tang"):
        mf, _shape = analysed[name]
        assert sorted(f["params"]["diameter_mm"] for f in _of(mf, "Ring") if f["variant"] == "outer_diameter") == [16.0, 24.0]


# ── A keyway and a drive slot are read as before ────────────────────────────


def test_a_keyway_is_still_one_keyway_and_no_flat(analysed):
    mf, _shape = analysed["keyway"]
    (keyway,) = _of(mf, "Keyway")
    p = keyway["params"]
    assert (p["length_mm"], p["width_mm"], p["depth_mm"]) == (pytest.approx(20.0, abs=0.05), pytest.approx(5.0, abs=0.01), pytest.approx(3.0, abs=0.01))
    assert len(keyway["face_ids"]) == 5
    # Its side walls face across the axis and meet the round, with the axis in front of them: they are no flats.
    assert _of(mf, "Flat") == [] and _of(mf, "Slot") == []


def test_a_drive_slot_is_still_one_radial_slot_and_no_flat(analysed):
    mf, shape = analysed["drive slot"]
    (slot,) = _of(mf, "Slot")
    assert slot["variant"] == "radial"
    assert (slot["params"]["width_mm"], slot["params"]["depth_mm"]) == (pytest.approx(3.0, abs=0.01), pytest.approx(4.0, abs=0.01))
    assert [_surfaces(shape)[i] for i in slot["face_ids"]] == [("plane", (1.0, 0.0, 0.0))]
    assert _of(mf, "Flat") == [] and _of(mf, "Keyway") == []
