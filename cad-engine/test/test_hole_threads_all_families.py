"""
Every family's holes go through the tap-drill check the machining recogniser runs (shared.machining_geometry.annotate_hole_threads).

Only machined parts had their holes checked for a thread, so a casting, a forging or a sheet-metal part with an M3 hole drilled Ø2.5 was
drilled and never tapped. The feature lists below are shaped as the families' extractors write feature_graph_v2 (a casting's and a forging's
diameter on each occurrence, a sheet-metal part's on the feature), with the sizes of real parts (R_M-0230-021 MAIN CHASSIS, LINEAR BRACKET).
"""
import pytest

from shared.machining_geometry import annotate_hole_threads


def _hole(variant, occurrences, **feature):
    return {"feature_type": "SimpleHole", "variant": variant, "occurrences": occurrences, **feature}


def test_a_casting_or_forging_hole_at_a_tap_drill_size_is_tapped_and_keeps_its_variant():
    graph = {"features": [_hole("blind", [{"face_ids": [1], "diameter_mm": 2.529}, {"face_ids": [2], "diameter_mm": 6.0}])]}
    assert annotate_hole_threads(graph) == 1
    tapped, plain = graph["features"][0]["occurrences"]
    assert tapped == {"face_ids": [1], "diameter_mm": 2.529, "tapped": True, "spec": "M3×0.5", "detection": "geometry_heuristic"}
    assert "tapped" not in plain
    assert graph["features"][0]["variant"] == "blind"   # cast or drilled is decided by it, not by the thread


def test_a_sheet_metal_hole_reads_the_diameter_its_feature_carries():
    graph = {"features": [_hole("through", [{"face_ids": [2]}, {"face_ids": [3]}], diameter_mm=2.529)]}
    assert annotate_hole_threads(graph) == 2
    assert {o["spec"] for o in graph["features"][0]["occurrences"]} == {"M3×0.5"}


def test_a_perforation_listed_again_as_through_holes_is_not_tapped():
    # MAIN CHASSIS: the Ø1.6 perforation grid is also listed as through holes on the same faces; an M2 tap drill by size, but no thread.
    graph = {"features": [
        _hole("through", [{"face_ids": [19]}], diameter_mm=1.6),
        _hole("perforated", [{"face_ids": [19]}], diameter_mm=1.6),
    ]}
    assert annotate_hole_threads(graph) == 0


def test_a_hole_a_countersink_opens_into_is_a_clearance_hole():
    # LINEAR BRACKET: Ø3.2 holes (an M4 tap drill by size) under a countersink: clearance for a countersunk M3 screw.
    graph = {"features": [
        _hole("through", [{"face_ids": [72]}, {"face_ids": [80]}], diameter_mm=3.2),
        _hole("countersunk", [{"face_ids": [71]}]),
    ]}
    assert annotate_hole_threads(graph, {71: {3, 72}, 72: {37, 71}, 80: {81}}) == 1
    first, second = graph["features"][0]["occurrences"]
    assert "tapped" not in first                       # its wall meets the countersink's cone
    assert second["spec"] == "M4×0.7"                  # a plain Ø3.2 hole elsewhere is an M4 tap drill


def test_holes_already_threaded_and_other_kinds_are_left_alone():
    graph = {"features": [
        _hole("through", [{"face_ids": [1], "diameter_mm": 2.5, "spec": "M3x0.5 from the drawing"}]),
        _hole("stepped", [{"face_ids": [2], "diameter_mm": 2.5}]),
        {"feature_type": "MultiStepHole", "variant": "stepped", "occurrences": [{"face_ids": [3], "diameter_mm": 2.5}]},
        _hole("through", [{"face_ids": [4]}]),          # no diameter: nothing to read a thread from
    ]}
    assert annotate_hole_threads(graph) == 0
    assert graph["features"][0]["occurrences"][0]["spec"] == "M3x0.5 from the drawing"


def test_nothing_to_annotate():
    assert annotate_hole_threads(None) == 0
    assert annotate_hole_threads({}) == 0


def test_face_neighbours_sees_a_countersink_meet_its_hole():
    pytest.importorskip("OCC")
    from OCC.Core.BRepAlgoAPI import BRepAlgoAPI_Cut, BRepAlgoAPI_Fuse
    from OCC.Core.BRepPrimAPI import BRepPrimAPI_MakeBox, BRepPrimAPI_MakeCone, BRepPrimAPI_MakeCylinder
    from OCC.Core.BRepAdaptor import BRepAdaptor_Surface
    from OCC.Core.GeomAbs import GeomAbs_Cone, GeomAbs_Cylinder
    from OCC.Core.TopAbs import TopAbs_FACE
    from OCC.Core.TopExp import TopExp_Explorer
    from OCC.Core.TopoDS import topods
    from OCC.Core.gp import gp_Ax2, gp_Dir, gp_Pnt

    from shared.face_attributes import face_neighbours

    # A 4 mm plate with a Ø3.2 hole and a 90° countersink Ø6 at its top.
    plate = BRepPrimAPI_MakeBox(20.0, 20.0, 4.0).Shape()
    hole = BRepPrimAPI_MakeCylinder(gp_Ax2(gp_Pnt(10, 10, -1), gp_Dir(0, 0, 1)), 1.6, 6.0).Shape()
    sink = BRepPrimAPI_MakeCone(gp_Ax2(gp_Pnt(10, 10, 2.6), gp_Dir(0, 0, 1)), 1.6, 3.0, 1.4).Shape()
    shape = BRepAlgoAPI_Cut(plate, BRepAlgoAPI_Fuse(hole, sink).Shape()).Shape()
    kinds = {}
    exp = TopExp_Explorer(shape, TopAbs_FACE)
    i = 0
    while exp.More():
        kinds[i] = BRepAdaptor_Surface(topods.Face(exp.Current())).GetType()
        i += 1
        exp.Next()
    cones = [k for k, t in kinds.items() if t == GeomAbs_Cone]
    walls = [k for k, t in kinds.items() if t == GeomAbs_Cylinder]
    assert cones and walls
    neighbours = face_neighbours(shape)
    assert any(w in neighbours[c] for c in cones for w in walls)
