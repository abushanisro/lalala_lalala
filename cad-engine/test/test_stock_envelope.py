"""The stock envelope of a machined part (machining/stock_envelope.py, "stock", stk_v1) on OCC-built parts, against values worked out by hand."""
import hashlib
import math
from pathlib import Path

import pytest

pytest.importorskip("OCC")

from OCC.Core.BRepAdaptor import BRepAdaptor_Surface  # noqa: E402
from OCC.Core.GeomAbs import GeomAbs_Cylinder, GeomAbs_Plane  # noqa: E402
from OCC.Core.TopAbs import TopAbs_FACE  # noqa: E402
from OCC.Core.TopExp import TopExp_Explorer  # noqa: E402

from machining.stock_envelope import VERSION, measure_stock  # noqa: E402
from shared.planar_outline import enclosing_circle, enclosing_circle_diameter, regular_hexagon  # noqa: E402

import machined_parts as P  # noqa: E402

MM = 1e-3      # sizes are reported to a micron


def _surfaces(shape):
    """Each face's analytic surface, in face-id order: ("plane", a point on it, its direction) or ("cylinder", radius, its axis direction)."""
    out = []
    exp = TopExp_Explorer(shape, TopAbs_FACE)
    while exp.More():
        s = BRepAdaptor_Surface(exp.Current())
        if s.GetType() == GeomAbs_Plane:
            pl = s.Plane()
            p, d = pl.Location(), pl.Axis().Direction()
            out.append(("plane", (p.X(), p.Y(), p.Z()), (d.X(), d.Y(), d.Z())))
        elif s.GetType() == GeomAbs_Cylinder:
            c = s.Cylinder()
            d = c.Axis().Direction()
            out.append(("cylinder", c.Radius(), (d.X(), d.Y(), d.Z())))
        else:
            out.append(("other", None, None))
        exp.Next()
    return out


def planes_at(shape, axis, value):
    """The ids of the planar faces square to a model axis (0, 1, 2) at that coordinate."""
    return sorted(i for i, (kind, p, d) in enumerate(_surfaces(shape))
                  if kind == "plane" and abs(abs(d[axis]) - 1.0) < 1e-9 and abs(p[axis] - value) < 1e-6)


def cylinders_of(shape, diameter):
    return sorted(i for i, (kind, r, _) in enumerate(_surfaces(shape)) if kind == "cylinder" and abs(2.0 * r - diameter) < 1e-6)


def sides(stock):
    """The rectangle's stock surface as {side: {face id: area}}."""
    out = {"w+": {}, "w-": {}, "h+": {}, "h-": {}}
    for f in stock["stock_surface"]["rect"]:
        assert f["kind"] == "PlanarFace"
        out[f["side"]][f["face_id"]] = f["area_mm2"]
    return out


# ── A stepped shaft with cross holes and a keyway ──────────────────────────

def test_a_stepped_shaft_is_cut_from_round_bar_along_its_turning_axis():
    shaft = P.stepped_shaft_with_cross_holes_and_keyway()
    stock = measure_stock(shaft)
    assert stock["version"] == VERSION == "stk_v1"
    assert stock["axis"] == [1.0, 0.0, 0.0]
    assert stock["axis_source"] == "turned"
    assert stock["length_mm"] == pytest.approx(P.SHAFT_LENGTH, abs=MM)
    # The collar is the largest diameter: the round is its Ø20, and so is the square around it.
    assert stock["round"] == {"od_mm": pytest.approx(20.0, abs=MM)}
    assert stock["rect"]["width_mm"] == pytest.approx(20.0, abs=MM)
    assert stock["rect"]["height_mm"] == pytest.approx(20.0, abs=MM)
    assert stock["hex"] is None
    assert stock["bore"] == {"diameter_mm": pytest.approx(P.SHAFT_BORE, abs=MM)}
    # The saw cuts: the Ø12 end at x = 0 and the collar's end at x = 40.
    assert stock["end_faces"] == {"min": planes_at(shaft, 0, 0.0), "max": planes_at(shaft, 0, P.SHAFT_LENGTH)}
    assert len(stock["end_faces"]["min"]) == 1 and len(stock["end_faces"]["max"]) == 1
    # On the round stock's surface: the collar's Ø20 x 10 cylinder, not the Ø12.
    (collar,) = cylinders_of(shaft, 20.0)
    assert stock["stock_surface"]["round"] == [{"face_id": collar, "kind": "CurvedWall", "area_mm2": pytest.approx(math.pi * 20.0 * 10.0, abs=0.01)}]
    assert stock["stock_surface"]["rect"] == []
    assert stock["stock_surface"]["hex"] == []


# ── A rectangular block with a pocket ──────────────────────────────────────

def test_a_block_is_cut_from_rectangular_bar_along_its_longest_side():
    block = P.block_with_pocket()   # 80 x 50 x 30 along X, Y, Z
    stock = measure_stock(block)
    assert stock["axis"] == [1.0, 0.0, 0.0]
    assert stock["axis_source"] == "box"
    assert stock["length_mm"] == pytest.approx(80.0, abs=MM)
    # Seen along X: 50 wide (Y, the first direction across X: angle 0) by 30 high (Z).
    assert stock["rect"] == {"width_mm": pytest.approx(50.0, abs=MM), "height_mm": pytest.approx(30.0, abs=MM), "angle_deg": 0.0}
    assert stock["round"]["od_mm"] == pytest.approx(math.hypot(50.0, 30.0), abs=MM)   # 58.310
    assert stock["hex"] is None and stock["bore"] is None
    assert stock["end_faces"] == {"min": planes_at(block, 0, 0.0), "max": planes_at(block, 0, 80.0)}
    # The four sides: y = 50 and y = 0 bound the width (80 x 30 each); the top, less the pocket's opening, and the bottom bound the height.
    got = sides(stock)
    assert got["w+"] == {planes_at(block, 1, 50.0)[0]: pytest.approx(2400.0, abs=0.01)}
    assert got["w-"] == {planes_at(block, 1, 0.0)[0]: pytest.approx(2400.0, abs=0.01)}
    assert got["h+"] == {planes_at(block, 2, 30.0)[0]: pytest.approx(80.0 * 50.0 - 40.0 * 20.0, abs=0.01)}
    assert got["h-"] == {planes_at(block, 2, 0.0)[0]: pytest.approx(4000.0, abs=0.01)}
    # The pocket's floor (z = 20) is inside the stock, on no side.
    assert planes_at(block, 2, 20.0)[0] not in {f["face_id"] for f in stock["stock_surface"]["rect"]}
    assert stock["stock_surface"]["round"] == []


def test_a_block_modelled_off_the_model_axes_is_measured_in_its_own_box():
    # The same block turned 30 degrees about Z: its box in the model's axes is 94 x 83 x 30, its own is still 80 x 50 x 30.
    block = P.rotated(P.block_with_pocket(), (0, 0, 1), 30.0)
    stock = measure_stock(block)
    assert stock["axis"] == pytest.approx([math.cos(math.radians(30)), math.sin(math.radians(30)), 0.0], abs=1e-6)
    assert stock["axis_source"] == "box"
    assert stock["length_mm"] == pytest.approx(80.0, abs=MM)
    assert stock["rect"]["width_mm"] == pytest.approx(50.0, abs=MM)
    assert stock["rect"]["height_mm"] == pytest.approx(30.0, abs=MM)
    got = sides(stock)
    assert sorted(round(a, 1) for side in ("w+", "w-") for a in got[side].values()) == [2400.0, 2400.0]
    assert sorted(round(a, 1) for side in ("h+", "h-") for a in got[side].values()) == [3200.0, 4000.0]
    assert len(stock["end_faces"]["min"]) == 1 and len(stock["end_faces"]["max"]) == 1


# ── A hexagon part ─────────────────────────────────────────────────────────

def test_a_hexagon_part_gives_its_across_flats_and_the_flats_on_the_hex_stock():
    bar = P.hex_bar_with_bore(across_flats=20.0, length=50.0, bore=8.0)
    stock = measure_stock(bar)
    assert stock["axis"] == [1.0, 0.0, 0.0]
    assert stock["axis_source"] == "box"          # a bore is no turned outer diameter
    assert stock["length_mm"] == pytest.approx(50.0, abs=MM)
    assert stock["hex"] == {"across_flats_mm": pytest.approx(20.0, abs=MM)}
    across_corners = 2.0 * 20.0 / math.sqrt(3.0)   # 23.094
    assert stock["round"]["od_mm"] == pytest.approx(across_corners, abs=MM)
    assert stock["rect"]["width_mm"] == pytest.approx(across_corners, abs=MM)
    assert stock["rect"]["height_mm"] == pytest.approx(20.0, abs=MM)
    assert stock["bore"] == {"diameter_mm": pytest.approx(8.0, abs=MM)}
    # Six flats, each one side (20 / sqrt 3 = 11.547) by the length.
    flats = stock["stock_surface"]["hex"]
    assert len(flats) == 6
    assert all(f["kind"] == "PlanarFace" and f["area_mm2"] == pytest.approx(20.0 / math.sqrt(3.0) * 50.0, abs=0.01) for f in flats)
    # The rectangle lies flush on one pair of opposite flats (any of the three): they bound its height; its width ends on two corners.
    got = sides(stock)
    assert len(got["h+"]) == 1 and len(got["h-"]) == 1 and got["h+"].keys() != got["h-"].keys()
    assert set(got["h+"]) | set(got["h-"]) <= {f["face_id"] for f in flats}
    assert got["w+"] == {} and got["w-"] == {}
    assert stock["stock_surface"]["round"] == []


# ── A bushing: round tube stock ────────────────────────────────────────────

def test_a_bushing_gives_its_through_bore():
    bushing = P.bushing(od=30.0, bore=18.0, length=25.0)
    stock = measure_stock(bushing)
    assert stock["axis"] == [0.0, 0.0, 1.0]
    assert stock["axis_source"] == "turned"
    assert stock["length_mm"] == pytest.approx(25.0, abs=MM)
    assert stock["round"]["od_mm"] == pytest.approx(30.0, abs=MM)
    assert stock["bore"] == {"diameter_mm": pytest.approx(18.0, abs=MM)}
    (outside,) = cylinders_of(bushing, 30.0)
    assert stock["stock_surface"]["round"] == [{"face_id": outside, "kind": "CurvedWall", "area_mm2": pytest.approx(math.pi * 30.0 * 25.0, abs=0.01)}]
    assert stock["end_faces"] == {"min": planes_at(bushing, 2, 0.0), "max": planes_at(bushing, 2, 25.0)}


def test_the_bore_is_the_round_that_passes_the_whole_part():
    # A stepped bore, Ø18 then Ø12: its smallest step.
    assert measure_stock(P.stepped_bushing())["bore"] == {"diameter_mm": pytest.approx(12.0, abs=MM)}
    # A Ø10 bore with a flat 3 mm from its axis: the Ø6 inside the flat (tube with a Ø10 bore would have no metal for the flat).
    d_bore = measure_stock(P.shaft_with_d_bore())
    assert d_bore["bore"] == {"diameter_mm": pytest.approx(6.0, abs=MM)}
    assert d_bore["round"]["od_mm"] == pytest.approx(20.0, abs=MM)
    # A blind hole on the axis passes nothing.
    blind = P.cut(P.cylinder((0, 0, 0), (0, 0, 1), 30.0, 25.0), P.cylinder((0, 0, 10), (0, 0, 1), 18.0, 20.0))
    assert measure_stock(blind)["bore"] is None


# ── A wide thin plate ──────────────────────────────────────────────────────

def test_a_plate_is_a_wide_thin_rectangle_along_its_length():
    plate = P.plate_with_holes()   # 200 x 120 x 6
    stock = measure_stock(plate)
    assert stock["axis"] == [1.0, 0.0, 0.0]
    assert stock["axis_source"] == "box"
    assert stock["length_mm"] == pytest.approx(200.0, abs=MM)
    assert stock["rect"] == {"width_mm": pytest.approx(120.0, abs=MM), "height_mm": pytest.approx(6.0, abs=MM), "angle_deg": 0.0}
    assert stock["round"]["od_mm"] == pytest.approx(math.hypot(120.0, 6.0), abs=MM)   # 120.150
    assert stock["hex"] is None and stock["bore"] is None
    got = sides(stock)
    # The plate's two faces (less four Ø8 holes) bound the 6 mm, its long edges the 120.
    face_area = 200.0 * 120.0 - 4.0 * math.pi * 16.0
    assert got["h+"] == {planes_at(plate, 2, 6.0)[0]: pytest.approx(face_area, abs=0.01)}
    assert got["h-"] == {planes_at(plate, 2, 0.0)[0]: pytest.approx(face_area, abs=0.01)}
    assert got["w+"] == {planes_at(plate, 1, 120.0)[0]: pytest.approx(1200.0, abs=0.01)}
    assert got["w-"] == {planes_at(plate, 1, 0.0)[0]: pytest.approx(1200.0, abs=0.01)}
    assert stock["end_faces"] == {"min": planes_at(plate, 0, 0.0), "max": planes_at(plate, 0, 200.0)}


# ── Nothing on the envelope ────────────────────────────────────────────────

def test_a_part_with_nothing_on_its_envelope_lists_no_face():
    spindle = P.spindle()   # two cones base to base, Ø20 x 60 along X
    stock = measure_stock(spindle)
    assert stock["axis"] == [1.0, 0.0, 0.0]
    assert stock["axis_source"] == "box"
    assert stock["length_mm"] == pytest.approx(60.0, abs=MM)
    assert stock["round"]["od_mm"] == pytest.approx(20.0, abs=MM)
    assert stock["rect"]["width_mm"] == pytest.approx(20.0, abs=MM)
    assert stock["rect"]["height_mm"] == pytest.approx(20.0, abs=MM)
    assert stock["hex"] is None and stock["bore"] is None
    # It ends in two points and touches the round along one circle: no end face, no face on any stock surface.
    assert stock["end_faces"] == {"min": [], "max": []}
    assert stock["stock_surface"] == {"round": [], "rect": [], "hex": []}


# ── The turning axis against the box ───────────────────────────────────────

def test_a_turned_boss_on_a_plate_does_not_make_it_round_bar():
    # A Ø20 hub on a 60 x 60 x 10 plate: round bar about the hub would be Ø84.9 x 20 (113 cm3); the plate's own box is 60 x 60 x 20 (72 cm3).
    part = P.plate_with_hub()
    stock = measure_stock(part)
    assert stock["axis_source"] == "box"
    assert stock["axis"] == [1.0, 0.0, 0.0]
    assert stock["length_mm"] == pytest.approx(60.0, abs=MM)
    assert stock["rect"]["width_mm"] == pytest.approx(60.0, abs=MM)
    assert stock["rect"]["height_mm"] == pytest.approx(20.0, abs=MM)


def test_a_blend_standing_a_few_microns_proud_leaves_the_round_at_the_turned_diameter():
    # A Ø14 x 20 shaft with a sliver 4 microns proud of it (what a blend surface leaves on a real export): the round is still 14.
    shaft = P.fuse(P.cylinder((0, 0, 0), (1, 0, 0), 14.0, 20.0), P.box((8, -0.05, 6.9), (4, 0.1, 0.104)))
    stock = measure_stock(shaft)
    assert stock["axis_source"] == "turned"
    assert stock["round"]["od_mm"] == 14.0
    assert [f["face_id"] for f in stock["stock_surface"]["round"]] == cylinders_of(shaft, 14.0)
    # Two keys standing 2 mm proud are a larger swing (their corners, 9 out and 2 across: Ø18.439), and no cylinder lies on that round.
    keyed = P.fuse(P.fuse(P.cylinder((0, 0, 0), (1, 0, 0), 14.0, 20.0), P.box((8, -2, 5), (4, 4, 4))), P.box((8, -2, -9), (4, 4, 4)))
    stock = measure_stock(keyed)
    assert stock["round"]["od_mm"] == pytest.approx(2.0 * math.hypot(9.0, 2.0), abs=MM)
    assert stock["stock_surface"]["round"] == []


# ── The outline geometry behind it (shared/planar_outline.py) ──────────────

def test_the_smallest_circle_is_exact_for_an_outline_of_any_number_of_points():
    # A triangle with rounded corners, 1080 points: its circle passes through three of them. The few-point search bar and tube uses
    # stops trying triples past 60 points.
    corners = ((0.0, 0.0), (40.0, 0.0), (20.0, 30.0))
    pts = [(cx + 2.0 * math.cos(math.radians(a)), cy + 2.0 * math.sin(math.radians(a))) for cx, cy in corners for a in range(360)]
    centre, radius = enclosing_circle(pts)
    assert all(math.dist(centre, p) <= radius + 1e-9 for p in pts)
    # The circle through the three corner centres is about (20, 25/3) with radius 65/3; the corner rounds add their 2.
    assert centre == pytest.approx((20.0, 25.0 / 3.0), abs=1e-3)
    assert radius == pytest.approx(65.0 / 3.0 + 2.0, abs=1e-3)
    # On a section's few points the two agree.
    square = [(0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0)]
    assert 2.0 * enclosing_circle(square)[1] == pytest.approx(enclosing_circle_diameter(square))


def test_a_regular_hexagon_is_told_from_a_circle_and_a_rectangle():
    hexagon = [(10.0 * math.cos(math.radians(60 * k)), 10.0 * math.sin(math.radians(60 * k))) for k in range(6)]
    found = regular_hexagon(hexagon)
    assert found is not None and found["across_flats_mm"] == pytest.approx(10.0 * math.sqrt(3.0))
    assert len(found["corners"]) == 6
    circle = [(10.0 * math.cos(math.radians(a)), 10.0 * math.sin(math.radians(a))) for a in range(0, 360, 4)]
    assert regular_hexagon(circle) is None
    assert regular_hexagon([(0.0, 0.0), (20.0, 0.0), (20.0, 10.0), (0.0, 10.0)]) is None


# ── In the analysis ────────────────────────────────────────────────────────

def _write_step(shape, path: Path) -> str:
    from OCC.Core.IFSelect import IFSelect_RetDone
    from OCC.Core.STEPControl import STEPControl_AsIs, STEPControl_Writer
    writer = STEPControl_Writer()
    writer.Transfer(shape, STEPControl_AsIs)
    assert writer.Write(str(path)) == IFSelect_RetDone
    return str(path)


def _analyse(step_path: str, tmp_path: Path, family_hint: str = ""):
    from shared.memory_optimizer import AdvancedCADMemoryOptimizer
    from shared.part_analysis import ComponentFeatureCache, analyze_part
    from shared.services import StepReader
    return analyze_part(
        shape=StepReader().read(step_path), step_path=step_path, filename=Path(step_path).name,
        file_hash=hashlib.sha256(Path(step_path).read_bytes()).hexdigest(),
        memory_optimizer=AdvancedCADMemoryOptimizer(cache_dir=str(tmp_path / "cache")), component_cache=ComponentFeatureCache(tmp_path / "cf"),
        face_graph_max_faces=5000, force_reanalysis=True, family_hint=family_hint,
    )


def test_every_machined_part_carries_its_stock_in_machining_features(tmp_path):
    step = _write_step(P.stepped_shaft_with_cross_holes_and_keyway(), tmp_path / "shaft.step")
    result = _analyse(step, tmp_path)
    stock = result["machining_features"]["stock"]
    assert stock["version"] == "stk_v1"
    assert stock["axis_source"] == "turned" and stock["round"]["od_mm"] == pytest.approx(20.0, abs=MM)
    # Its face ids are the ones the rest of machining_features uses: the collar's is a face of the face map and of a feature.
    collar = stock["stock_surface"]["round"][0]["face_id"]
    assert collar in {f for feature in result["machining_features"]["features"] for f in feature["face_ids"]}
    assert collar < len(result["machining_features"]["face_map"])


def test_a_stock_measurement_that_fails_is_null_and_the_analysis_still_succeeds(tmp_path, monkeypatch):
    import machining.stock_envelope as stock_envelope

    def boom(_shape):
        raise RuntimeError("no stock today")
    monkeypatch.setattr(stock_envelope, "measure_stock", boom)
    result = _analyse(_write_step(P.block_with_pocket(), tmp_path / "block.step"), tmp_path)
    assert result["success"] is True
    assert result["machining_features"]["stock"] is None
    assert result["machining_features"]["features"]


def test_a_part_that_is_not_machined_carries_no_stock(tmp_path):
    result = _analyse(_write_step(P.box((0, 0, 0), (200, 150, 2)), tmp_path / "sheet.step"), tmp_path, family_hint="sheet_metal")
    assert "stock" not in (result.get("machining_features") or {})
