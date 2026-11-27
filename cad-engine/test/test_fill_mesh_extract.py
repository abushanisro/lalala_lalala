"""STEP -> fill mesh on parts whose walls and volumes are known, then through the solver."""
import numpy as np
import pytest

pytest.importorskip("OCC")

from OCC.Core.BRepAlgoAPI import BRepAlgoAPI_Cut, BRepAlgoAPI_Fuse  # noqa: E402
from OCC.Core.BRepPrimAPI import BRepPrimAPI_MakeBox, BRepPrimAPI_MakeCylinder  # noqa: E402
from OCC.Core.gp import gp_Ax2, gp_Dir, gp_Pnt  # noqa: E402

from injection_molding.fill_mesh_extract import MAX_FILL_TRIANGLES, extract_fill_mesh  # noqa: E402
from injection_molding.fill_solver import fill  # noqa: E402


def box(x, y, z, dx, dy, dz):
    return BRepPrimAPI_MakeBox(gp_Pnt(x, y, z), dx, dy, dz).Shape()


def cylinder(r, h, x=0.0, y=0.0, z=0.0):
    return BRepPrimAPI_MakeCylinder(gp_Ax2(gp_Pnt(x, y, z), gp_Dir(0, 0, 1)), r, h).Shape()


def tray():
    return BRepAlgoAPI_Cut(box(-50, -30, 0, 100, 60, 15), box(-47.5, -27.5, 2.5, 95, 55, 15)).Shape()


def cup():
    return BRepAlgoAPI_Cut(cylinder(25, 30), cylinder(22, 30, z=3)).Shape()


def plate_with_hole():
    return BRepAlgoAPI_Cut(box(0, 0, 0, 120, 60, 2), cylinder(12, 4, 50, 30, -1)).Shape()


def shape_ratio(mesh):
    c = mesh.corners()
    longest = np.linalg.norm(c[:, [1, 2, 0]] - c, axis=2).max(axis=1)
    return 2 * mesh.areas_mm2() / longest ** 2


PARTS = {
    "plate 1.5 mm": (lambda: box(0, 0, 0, 100, 40, 1.5), 1.5),
    "tray 2.5 mm": (tray, 2.5),
    "cup 3 mm": (cup, 3.0),
    "plate with a hole 2 mm": (plate_with_hole, 2.0),
}


@pytest.mark.parametrize("name", PARTS)
def test_known_parts_give_their_wall_their_volume_and_a_clean_connected_mesh(name):
    make, wall = PARTS[name]
    mesh, report = extract_fill_mesh(make())
    assert report["issues"] == [] and report["detached_pieces"] == 0
    assert mesh.thickness_mm == pytest.approx(wall, abs=0.05 * wall)
    assert report["volume_ratio"] == pytest.approx(1.0, abs=0.02)
    assert report["longest_edge_mm"] <= report["target_edge_mm"] and not report["resolution_limited"]
    assert np.percentile(shape_ratio(mesh), 5) > 0.1                 # no needles, hole or not
    assert len(mesh.triangles) <= MAX_FILL_TRIANGLES


def test_the_mesh_is_the_walls_mid_surface_and_a_floor_stays_joined_to_its_wall():
    mesh, _ = extract_fill_mesh(cup())                               # outer radius 25, wall 3, base 3: mid-surface radius 23.5, base at z = 1.5
    radius = np.hypot(mesh.nodes_mm[:, 0], mesh.nodes_mm[:, 1])
    assert radius.max() == pytest.approx(23.5, abs=0.1) and mesh.nodes_mm[:, 2].min() == pytest.approx(1.5, abs=0.05)
    junction = (radius > 23.0) & (mesh.nodes_mm[:, 2] < 2.0)         # the ring where base and wall meet is one ring of shared nodes
    assert junction.sum() >= 24


def test_every_triangle_keeps_the_face_it_came_from_so_a_gate_can_be_set_by_face():
    mesh, _ = extract_fill_mesh(tray())
    faces = set(mesh.face_id.tolist())
    assert len(faces) == 5                                           # the floor and the four outer walls
    assert all(len(mesh.nodes_on_face(f)) >= 4 for f in faces)


def test_a_rib_is_left_out_and_reported_not_turned_into_a_region_the_melt_cannot_reach():
    ribbed = BRepAlgoAPI_Fuse(tray(), box(-47.5, -0.75, 2.5, 95, 1.5, 10)).Shape()
    mesh, report = extract_fill_mesh(ribbed)
    assert report["issues"] == []                                    # one connected mesh: no false short shot
    assert report["detached_pieces"] >= 1 and 0 < report["detached_volume_pct"] < 15
    assert report["volume_ratio"] < 1.0                              # the rib's volume is not in the mesh, and the report says so


def test_a_solid_block_is_refused_with_the_reason_not_given_a_made_up_mesh():
    mesh, report = extract_fill_mesh(box(0, 0, 0, 30, 30, 30))       # no thin wall: nothing faces a far wall at the measured thickness
    assert report["triangles_kept"] == 0 and len(mesh.triangles) == 0
    assert [i["code"] for i in report["issues"]] == ["no_triangles"] and report["volume_ratio"] is None


def test_a_block_with_one_thin_fin_is_called_not_thin_walled_and_a_part_missing_a_fifth_of_its_volume_says_so():
    mostly_solid = BRepAlgoAPI_Fuse(box(0, 0, 0, 40, 40, 30), box(40, 0, 0, 60, 40, 2)).Shape()      # the fin is 9 % of the volume
    _, report = extract_fill_mesh(mostly_solid)
    assert [i["code"] for i in report["issues"]] == ["not_thin_walled"] and report["volume_ratio"] < 0.2
    heavy_ribs = tray()
    for y in (-18, -6, 6, 18):
        heavy_ribs = BRepAlgoAPI_Fuse(heavy_ribs, box(-47.5, y - 1.5, 2.5, 95, 3, 12)).Shape()         # four 3 mm ribs: a quarter of the volume
    _, report = extract_fill_mesh(heavy_ribs)
    assert [i["code"] for i in report["issues"]] == ["volume_mismatch"] and 0.5 < report["volume_ratio"] < 0.9


def test_the_target_edge_sets_the_mesh_density_and_a_capped_mesh_says_so():
    coarse, _ = extract_fill_mesh(box(0, 0, 0, 100, 30, 2), target_edge_mm=20.0)
    fine, report = extract_fill_mesh(box(0, 0, 0, 100, 30, 2), target_edge_mm=3.0)
    assert len(fine.triangles) > 3 * len(coarse.triangles) and report["issues"] == []
    assert report["longest_edge_mm"] <= 3.0 and not report["resolution_limited"]
    big, capped = extract_fill_mesh(box(0, 0, 0, 600, 300, 2), target_edge_mm=1.0)
    assert len(big.triangles) <= MAX_FILL_TRIANGLES and capped["resolution_limited"]


def test_step_to_solver_end_to_end_matches_hele_shaw_on_a_plate():
    length, width, wall, eta, q = 100.0, 40.0, 2.0, 500.0, 8000.0
    mesh, report = extract_fill_mesh(box(0, 0, 0, length, width, wall))
    assert report["issues"] == []

    class Newtonian:
        def viscosity(self, shear_rate, temp_k):
            return np.full_like(np.asarray(shear_rate, float), eta)

    gate = np.flatnonzero(mesh.nodes_mm[:, 0] < mesh.nodes_mm[:, 0].min() + 1e-6)         # a film gate along the x = 0 edge
    result = fill(mesh.nodes_mm, mesh.triangles, mesh.thickness_mm, gate, q, Newtonian(), 500.0)
    assert np.nanmax(result.fill_time_s) == pytest.approx(mesh.volume_mm3() / q, rel=1e-6)
    expected = 12 * eta * (q * 1e-9 / (width * 1e-3)) * (0.95 * length * 1e-3) / (wall * 1e-3) ** 3 * 1e-6
    assert result.switchover_pressure_mpa(0.95) == pytest.approx(expected, rel=0.05)
