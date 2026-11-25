"""
A concave torus is a groove only when its cross-section is a groove's (machining/toroid_features.py).

Before (geo_v88) every concave toroidal face was a groove -- Slot:groove on a milled part, Ring:groove on a turned one -- and
the backend priced each as a full circle of its major diameter. On the Cannula Holder Right (liner sample) every concave torus is
a quarter-round inside fillet (profile 90 degrees) along a partial arc: R18/r2 sweeping 14 and 8.8 degrees, R4.5/r2 142 and 154,
R8/r2 40 and 50. Its six "grooves" were priced over 411 mm of path; the arcs are 55 mm.

Now each toroid states its sweep, profile, path (R x sweep: the path of the centre of a ball of radius r), axis and side, and:
- concave with a profile of at least 135 degrees: a groove (Ring:groove only on the lathe -- on the turning line, all the way
  round -- else Slot:groove), with its depth and width;
- concave with a smaller profile: an inside fillet, Edge:round with concave=True; on the lathe, a shoulder fillet the finish
  turning forms (turned_shoulder=True);
- convex: Edge:round, as before.

Built on OCC solids with known sizes; the real sample is read when CAD_LINER_SAMPLES_DIR names the unzipped liner.zip.
"""
import math
import os

import pytest

pytest.importorskip("OCC")

from OCC.Core.BRepAdaptor import BRepAdaptor_Curve, BRepAdaptor_Surface  # noqa: E402
from OCC.Core.BRepAlgoAPI import BRepAlgoAPI_Cut, BRepAlgoAPI_Fuse  # noqa: E402
from OCC.Core.BRepBuilderAPI import BRepBuilderAPI_MakeFace  # noqa: E402
from OCC.Core.BRepFilletAPI import BRepFilletAPI_MakeFillet  # noqa: E402
from OCC.Core.BRepGProp import brepgprop  # noqa: E402
from OCC.Core.GProp import GProp_GProps  # noqa: E402
from OCC.Core.BRepPrimAPI import BRepPrimAPI_MakeBox, BRepPrimAPI_MakeCylinder, BRepPrimAPI_MakeTorus  # noqa: E402
from OCC.Core.Geom import Geom_ToroidalSurface  # noqa: E402
from OCC.Core.GeomAbs import GeomAbs_Circle, GeomAbs_Line, GeomAbs_Plane  # noqa: E402
from OCC.Core.TopAbs import TopAbs_EDGE, TopAbs_FACE  # noqa: E402
from OCC.Core.TopExp import TopExp_Explorer  # noqa: E402
from OCC.Core.TopoDS import topods  # noqa: E402
from OCC.Core.gp import gp_Ax2, gp_Ax3, gp_Dir, gp_Pnt  # noqa: E402

from machining.machining_feature_recognizer import MachiningFeatureRecognizer, build_machining_feature_graph_v2  # noqa: E402
from machining.toroid_features import (  # noqa: E402
    FULL_TURN_MIN_SWEEP_DEG, GROOVE_MIN_PROFILE_DEG, classify_toroid, groove_section, merge_torus_patches, torus_face_facts,
)

Z = (0.0, 0.0, 1.0)


def _features(shape, family):
    return MachiningFeatureRecognizer().recognize(shape, family).features


def _toroids(features):
    return [f for f in features if "major_diameter_mm" in f.params]


def _edges(shape):
    exp = TopExp_Explorer(shape, TopAbs_EDGE)
    while exp.More():
        yield topods.Edge(exp.Current())
        exp.Next()


def _faces(shape):
    exp = TopExp_Explorer(shape, TopAbs_FACE)
    while exp.More():
        yield topods.Face(exp.Current())
        exp.Next()


def _fillet(shape, edges, r):
    mk = BRepFilletAPI_MakeFillet(shape)
    for e in edges:
        mk.Add(r, e)
    mk.Build()
    assert mk.IsDone(), "the fillet itself failed: the fixture is broken"
    return mk.Shape()


# ── Shapes ──────────────────────────────────────────────────────────────────────

CORNER_R, FLOOR_R = 5.0, 2.0


def _pocket_with_floor_fillets():
    """A 60 x 40 x 20 block with a 40 x 20 pocket 10 deep, its corners rounded R5 and its floor edges filleted R2: at each corner the
    floor fillet runs round a quarter turn, a torus of R = 5 - 2 = 3 and r = 2 whose cross-section is a quarter round."""
    tool = BRepPrimAPI_MakeBox(gp_Pnt(10, 10, 10), 40.0, 20.0, 20.0).Shape()
    vertical = [e for e in _edges(tool) if BRepAdaptor_Curve(e).GetType() == GeomAbs_Line
                and abs(BRepAdaptor_Curve(e).Line().Direction().Z()) > 0.99]
    tool = _fillet(tool, {e.__hash__(): e for e in vertical}.values(), CORNER_R)
    block = BRepAlgoAPI_Cut(BRepPrimAPI_MakeBox(60.0, 40.0, 20.0).Shape(), tool).Shape()
    floor = next(f for f in _faces(block) if BRepAdaptor_Surface(f).GetType() == GeomAbs_Plane
                 and abs(BRepAdaptor_Surface(f).Plane().Axis().Direction().Z()) > 0.99 and abs(_centroid(f)[2] - 10.0) < 1e-6)
    return _fillet(block, list(_edges(floor)), FLOOR_R)


def _centroid(face):
    props = GProp_GProps()
    brepgprop.SurfaceProperties(face, props)
    c = props.CentreOfMass()
    return (c.X(), c.Y(), c.Z())


SHAFT_R, GROOVE_R = 10.0, 2.0


def _grooved_shaft(centre=(0.0, 0.0, 20.0)):
    """A Ø20 x 40 shaft with a full-turn half-round groove of r2 cut round it (the shaft minus a torus of R10 r2 on its axis)."""
    shaft = BRepPrimAPI_MakeCylinder(SHAFT_R, 40.0).Shape()
    torus = BRepPrimAPI_MakeTorus(gp_Ax2(gp_Pnt(*centre), gp_Dir(0, 0, 1)), SHAFT_R, GROOVE_R).Shape()
    return BRepAlgoAPI_Cut(shaft, torus).Shape()


BODY_R, NECK_R, SHOULDER_R = 15.0, 8.0, 2.0


def _shoulder_fillet_shaft():
    """A Ø30 x 20 body with a Ø16 x 30 neck on it, the inside corner at the shoulder filleted R2: a full-turn torus of R = 8 + 2 and
    r = 2, a quarter round, on the shaft's axis."""
    body = BRepPrimAPI_MakeCylinder(BODY_R, 20.0).Shape()
    neck = BRepPrimAPI_MakeCylinder(gp_Ax2(gp_Pnt(0, 0, 20), gp_Dir(0, 0, 1)), NECK_R, 30.0).Shape()
    shaft = BRepAlgoAPI_Fuse(body, neck).Shape()
    corner = [e for e in _edges(shaft) if BRepAdaptor_Curve(e).GetType() == GeomAbs_Circle
              and abs(BRepAdaptor_Curve(e).Circle().Radius() - NECK_R) < 1e-6
              and abs(BRepAdaptor_Curve(e).Circle().Location().Z() - 20.0) < 1e-6]
    assert corner, "the shoulder edge is missing: the fixture is broken"
    return _fillet(shaft, corner[:1], SHOULDER_R)


def _torus_face(major_r, minor_r, u0_deg, u1_deg, v0_deg=0.0, v1_deg=90.0, axis=Z):
    surf = Geom_ToroidalSurface(gp_Ax3(gp_Pnt(0, 0, 0), gp_Dir(*axis)), major_r, minor_r)
    return BRepBuilderAPI_MakeFace(surf, math.radians(u0_deg), math.radians(u1_deg), math.radians(v0_deg), math.radians(v1_deg), 1e-7).Face()


# ── Measured facts ─────────────────────────────────────────────────────────────

def test_a_torus_face_states_its_sweep_profile_and_the_path_of_a_ball_along_it():
    # The Cannula Holder Right's R18/r2 fillet face: 14 degrees of its major circle, a quarter of its cross-section.
    facts = torus_face_facts(_torus_face(18.0, 2.0, 306.2, 320.2), 7)
    assert math.degrees(facts["sweep_rad"]) == pytest.approx(14.0)
    assert math.degrees(facts["profile_rad"]) == pytest.approx(90.0)
    # R x sweep: the centre of a ball of r2 runs along the major circle (not R - r or R + r, the face's own edges).
    assert 18.0 * facts["sweep_rad"] == pytest.approx(4.398, abs=1e-3)
    assert facts["axis"] == pytest.approx(Z) and facts["face_indices"] == [7]


def test_two_patches_of_one_torus_are_one_toroid_whose_sweep_and_path_add_up():
    halves = [torus_face_facts(_torus_face(10.0, 2.0, 0.0, 180.0, 90.0, 270.0), 3),
              torus_face_facts(_torus_face(10.0, 2.0, 180.0, 360.0, 90.0, 270.0), 4)]
    (tor,) = merge_torus_patches(halves)
    assert math.degrees(tor["sweep_rad"]) == pytest.approx(360.0)
    assert tor["face_indices"] == [3, 4]
    assert classify_toroid(tor)[2]["path_length_mm"] == pytest.approx(2 * math.pi * 10.0, abs=1e-3)


def test_patches_on_other_tori_or_with_another_profile_stay_apart():
    a = torus_face_facts(_torus_face(10.0, 2.0, 0.0, 90.0), 1)
    other_r = torus_face_facts(_torus_face(10.0, 2.5, 90.0, 180.0), 2)
    other_profile = torus_face_facts(_torus_face(10.0, 2.0, 90.0, 180.0, 90.0, 180.0), 3)
    assert len(merge_torus_patches([a, other_r, other_profile])) == 3


# ── Rules ──────────────────────────────────────────────────────────────────────

def _tor(profile_deg, sweep_deg=360.0, concave=True, centre=(0.0, 0.0, 0.0), axis=Z, major_r=10.0, minor_r=2.0):
    return {"major_radius": major_r, "minor_radius": minor_r, "is_concave": concave, "sweep_rad": math.radians(sweep_deg),
            "profile_rad": math.radians(profile_deg), "axis": axis, "centre": centre, "centroid": (0.0, 0.0, 0.0), "face_indices": [0]}


def test_the_groove_profile_threshold():
    assert classify_toroid(_tor(GROOVE_MIN_PROFILE_DEG))[:2] == ("Slot", "groove")
    assert classify_toroid(_tor(GROOVE_MIN_PROFILE_DEG - 1.0))[:2] == ("Edge", "round")
    assert classify_toroid(_tor(180.0, concave=False))[:2] == ("Edge", "round")  # a convex bead is a rounded edge


def test_a_groove_states_its_depth_and_width():
    assert groove_section(2.0, math.pi) == pytest.approx((2.0, 4.0))  # half round: r deep, 2r wide
    depth, width = groove_section(2.0, math.radians(135.0))
    assert depth == pytest.approx(2.0 * (1 - math.cos(math.radians(67.5))))
    assert width == pytest.approx(4.0 * math.sin(math.radians(67.5)))
    assert groove_section(2.0, math.radians(270.0))[1] == pytest.approx(4.0)  # an undercut groove's width is capped at its ball's


def test_on_the_lathe_only_a_full_turn_on_the_turning_line_is_turned():
    on = dict(turned=True, turning_axis=Z, on_axis=(0.0, 0.0, 0.0))
    assert classify_toroid(_tor(180.0), **on)[:2] == ("Ring", "groove")
    assert classify_toroid(_tor(180.0, sweep_deg=FULL_TURN_MIN_SWEEP_DEG - 1.0), **on)[:2] == ("Slot", "groove")
    assert classify_toroid(_tor(180.0, centre=(5.0, 0.0, 0.0)), **on)[:2] == ("Slot", "groove")  # off the turning line: milled
    assert classify_toroid(_tor(180.0, axis=(1.0, 0.0, 0.0)), **on)[:2] == ("Slot", "groove")
    assert classify_toroid(_tor(180.0), turned=True, turning_axis=Z, on_axis=None)[:2] == ("Slot", "groove")  # no turned diameter
    ftype, variant, params = classify_toroid(_tor(90.0), **on)
    assert (ftype, variant, params["turned_shoulder"]) == ("Edge", "round", True)
    assert "turned_shoulder" not in classify_toroid(_tor(90.0, centre=(5.0, 0.0, 0.0)), **on)[2]
    assert "turned_shoulder" not in classify_toroid(_tor(90.0))[2]  # a milled part has no lathe


# ── Whole parts ────────────────────────────────────────────────────────────────

def test_a_pockets_floor_fillet_round_its_corners_is_a_fillet_along_a_quarter_turn_not_a_groove():
    features = _features(_pocket_with_floor_fillets(), "milled")
    assert not [f for f in features if f.variant == "groove"]
    corners = [f for f in _toroids(features) if f.params["concave"]]
    assert len(corners) == 4
    for f in corners:
        assert (f.type, f.variant) == ("Edge", "round")
        assert f.params["major_diameter_mm"] == pytest.approx(2 * (CORNER_R - FLOOR_R))
        assert f.params["radius_mm"] == pytest.approx(FLOOR_R)
        assert f.params["sweep_deg"] == pytest.approx(90.0)
        assert f.params["profile_deg"] == pytest.approx(90.0)
        assert f.params["path_length_mm"] == pytest.approx((CORNER_R - FLOOR_R) * math.pi / 2, abs=1e-3)
        assert "depth_mm" not in f.params and "turned_shoulder" not in f.params


def test_a_full_turn_half_round_groove_on_a_shaft_is_a_plunged_ring_groove_with_its_depth_and_width():
    features = _features(_grooved_shaft(), "turned")
    (groove,) = _toroids(features)
    assert (groove.type, groove.variant) == ("Ring", "groove")
    p = groove.params
    assert p["sweep_deg"] == pytest.approx(360.0) and p["profile_deg"] == pytest.approx(180.0)
    assert p["depth_mm"] == pytest.approx(GROOVE_R) and p["width_mm"] == pytest.approx(2 * GROOVE_R)
    assert p["path_length_mm"] == pytest.approx(2 * math.pi * SHAFT_R, abs=1e-3)
    assert p["concave"] is True and p["axis"] == pytest.approx(list(Z))
    # The same groove on a part the engine mills is milled.
    (milled,) = _toroids(_features(_grooved_shaft(), "milled"))
    assert (milled.type, milled.variant) == ("Slot", "groove")


def test_a_shoulder_fillet_on_a_turned_part_is_a_fillet_the_finish_turning_forms():
    (fillet,) = _toroids(_features(_shoulder_fillet_shaft(), "turned"))
    assert (fillet.type, fillet.variant) == ("Edge", "round")
    p = fillet.params
    assert p["concave"] is True and p["turned_shoulder"] is True
    assert p["major_diameter_mm"] == pytest.approx(2 * (NECK_R + SHOULDER_R)) and p["radius_mm"] == pytest.approx(SHOULDER_R)
    assert p["sweep_deg"] == pytest.approx(360.0) and p["profile_deg"] == pytest.approx(90.0)
    # Milled, it is an inside fillet cut along its path.
    (milled,) = _toroids(_features(_shoulder_fillet_shaft(), "milled"))
    assert (milled.type, milled.variant, milled.params["concave"]) == ("Edge", "round", True)
    assert "turned_shoulder" not in milled.params


def test_the_feature_graph_carries_the_groove_and_fillet_facts():
    tree = MachiningFeatureRecognizer().recognize(_grooved_shaft(), "turned")
    graph = build_machining_feature_graph_v2(tree.to_dict(), (0, 0, 0), [], 0)
    (entry,) = [e for e in graph["features"] if e["variant"] == "groove"]
    occ = entry["occurrences"][0]
    assert (entry["feature_type"], entry["diameter_mm"]) == ("Ring", 20.0)
    assert occ["depth_mm"] == pytest.approx(2.0) and occ["width_mm"] == pytest.approx(4.0)
    assert occ["path_length_mm"] == pytest.approx(62.832, abs=1e-3) and occ["concave"] is True
    assert occ["material_removed_mm3"] == 0.0


# ── The real sample ────────────────────────────────────────────────────────────

_LINER = os.environ.get("CAD_LINER_SAMPLES_DIR")


@pytest.mark.skipif(not _LINER, reason="CAD_LINER_SAMPLES_DIR does not name the unzipped liner.zip samples")
def test_cannula_holder_rights_concave_tori_are_fillets_along_55_mm_of_arc():
    from OCC.Core.STEPControl import STEPControl_Reader  # type: ignore

    reader = STEPControl_Reader()
    reader.ReadFile(os.path.join(_LINER, "Linear SA P2", "Cannula Holder Right.step"))
    reader.TransferRoots()
    shape = reader.OneShape()
    face2 = list(_faces(shape))[2]
    facts = torus_face_facts(face2, 2)
    assert math.degrees(facts["sweep_rad"]) == pytest.approx(14.0, abs=0.05)
    assert facts["major_radius"] * facts["sweep_rad"] == pytest.approx(4.40, abs=0.01)

    concave = [f for f in _toroids(_features(shape, "milled")) if f.params["concave"]]
    assert {(f.type, f.variant) for f in concave} == {("Edge", "round")}
    assert all(f.params["profile_deg"] == pytest.approx(90.0) for f in concave)
    assert sum(f.params["path_length_mm"] for f in concave) == pytest.approx(55.16, abs=0.05)  # was priced over 411 mm
