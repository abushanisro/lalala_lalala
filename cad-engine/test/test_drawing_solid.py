"""The solid built from a drawing's own numbers: its volume is the form's less its holes, and it reads back as a STEP file."""
import math
import os
import tempfile

import pytest

pytest.importorskip("OCC.Core.BRepPrimAPI")

from shared.drawing_solid import DrawingSolidRequest, build, step_bytes  # noqa: E402
from shared.services import StepReader  # noqa: E402
from shared.solid_measures import measure_solid  # noqa: E402


def solid(shape, holes=()):
    return build(DrawingSolidRequest(shape=shape, holes=list(holes)))


def volume(shape) -> float:
    return float(measure_solid(shape)["volume"])


def extents(shape):
    box = measure_solid(shape)["bounding_box"]
    return [box["length"], box["width"], box["height"]]


def cylinder(diameter, height):
    return math.pi * (diameter / 2) ** 2 * height


BRACKET = {"kind": "block", "length_mm": 120, "width_mm": 60, "height_mm": 12}


def test_a_block_is_its_length_width_and_height():
    made, placed, left_out = solid(BRACKET)
    assert (placed, left_out) == (0, 0)
    assert volume(made) == pytest.approx(120 * 60 * 12, rel=1e-6)
    assert extents(made) == pytest.approx([120, 60, 12], abs=1e-3)


def test_a_through_hole_goes_down_the_thickness_and_a_blind_hole_stops_at_its_depth():
    # The test drawing's bracket: four 6.6 holes through, two tapped holes 10 deep.
    made, placed, left_out = solid(BRACKET, [{"diameter_mm": 6.6, "depth_mm": None, "count": 4}, {"diameter_mm": 6, "depth_mm": 10, "count": 2}])
    assert (placed, left_out) == (6, 0)
    assert volume(made) == pytest.approx(120 * 60 * 12 - 4 * cylinder(6.6, 12) - 2 * cylinder(6, 10), rel=1e-4)


def test_a_blind_hole_as_deep_as_the_stock_is_a_through_hole():
    made, _, _ = solid(BRACKET, [{"diameter_mm": 8, "depth_mm": 12, "count": 1}])
    assert volume(made) == pytest.approx(120 * 60 * 12 - cylinder(8, 12), rel=1e-4)


def test_a_hole_that_does_not_fit_is_left_out_and_counted_not_squeezed_in():
    made, placed, left_out = solid(BRACKET, [{"diameter_mm": 55, "depth_mm": None, "count": 1}, {"diameter_mm": 5, "depth_mm": None, "count": 3}])
    assert (placed, left_out) == (3, 1)                       # 55 mm does not fit a quarter of a 120 x 60 face
    assert volume(made) == pytest.approx(120 * 60 * 12 - 3 * cylinder(5, 12), rel=1e-4)


def test_a_sheet_is_a_thin_block():
    made, placed, _ = solid({"kind": "sheet", "length_mm": 300, "width_mm": 200, "thickness_mm": 2}, [{"diameter_mm": 10, "depth_mm": None, "count": 8}])
    assert placed == 8
    assert volume(made) == pytest.approx(300 * 200 * 2 - 8 * cylinder(10, 2), rel=1e-4)


SHAFT = {"kind": "turned", "segments": [{"diameter_mm": 80, "length_mm": 15}, {"diameter_mm": 40, "length_mm": 60}], "bore_diameter_mm": None}


def test_a_turned_part_is_its_diameter_steps_one_after_another():
    made, _, _ = solid(SHAFT)
    assert volume(made) == pytest.approx(cylinder(80, 15) + cylinder(40, 60), rel=1e-4)
    assert extents(made) == pytest.approx([80, 80, 75], abs=1e-2)


def test_a_bore_runs_through_the_whole_turned_part():
    made, _, _ = solid({**SHAFT, "bore_diameter_mm": 20})
    assert volume(made) == pytest.approx(cylinder(80, 15) + cylinder(40, 60) - cylinder(20, 75), rel=1e-4)


def test_holes_on_a_turned_part_go_on_a_bolt_circle_through_its_flange():
    made, placed, left_out = solid(SHAFT, [{"diameter_mm": 9, "depth_mm": None, "count": 6}])
    assert (placed, left_out) == (6, 0)                       # the flange has 20 mm of land outside the 40 mm step
    assert volume(made) == pytest.approx(cylinder(80, 15) + cylinder(40, 60) - 6 * cylinder(9, 15), rel=1e-4)


def test_a_hole_wider_than_the_flange_land_is_left_out():
    _, placed, left_out = solid(SHAFT, [{"diameter_mm": 18, "depth_mm": None, "count": 4}])
    assert (placed, left_out) == (0, 4)


def test_a_bore_as_wide_as_the_part_is_refused():
    with pytest.raises(ValueError, match="bore"):
        solid({**SHAFT, "bore_diameter_mm": 40})


def test_what_is_not_a_size_is_refused_before_anything_is_built():
    with pytest.raises(ValueError):
        DrawingSolidRequest(shape={"kind": "block", "length_mm": 120, "width_mm": 0, "height_mm": 12})
    with pytest.raises(ValueError):
        DrawingSolidRequest(shape={"kind": "cone", "length_mm": 1})
    with pytest.raises(ValueError, match="at most 400 holes"):
        solid(BRACKET, [{"diameter_mm": 1, "depth_mm": None, "count": 300}, {"diameter_mm": 1, "depth_mm": None, "count": 300}])


def test_the_solid_reads_back_from_its_step_file_with_the_same_volume():
    made, _, _ = solid(BRACKET, [{"diameter_mm": 6.6, "depth_mm": None, "count": 4}])
    data = step_bytes(made)
    assert data.startswith(b"ISO-10303-21")
    handle, path = tempfile.mkstemp(suffix=".step")
    os.close(handle)
    try:
        with open(path, "wb") as f:
            f.write(data)
        assert volume(StepReader().read(path)) == pytest.approx(volume(made), rel=1e-6)
    finally:
        os.remove(path)
