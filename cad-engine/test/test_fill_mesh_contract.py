"""The FillMesh contract and its quality checks, on small meshes whose faults are known (no OpenCASCADE needed)."""
import numpy as np
import pytest

from injection_molding.fill_mesh import FillMesh, check


def square(n=2, thickness=2.0):
    """An n x n grid of 10 mm squares in the z=0 plane, two triangles each, counter-clockwise seen from +z."""
    x, y = np.meshgrid(np.arange(n + 1.0), np.arange(n + 1.0), indexing="ij")
    nodes = 10.0 * np.column_stack([x.ravel(), y.ravel(), np.zeros(x.size)])
    ids = np.arange(x.size).reshape(n + 1, n + 1)
    a, b, c, d = ids[:-1, :-1].ravel(), ids[1:, :-1].ravel(), ids[1:, 1:].ravel(), ids[:-1, 1:].ravel()
    tri = np.vstack([np.column_stack([a, b, c]), np.column_stack([a, c, d])])
    return FillMesh(nodes, tri, np.full(len(tri), thickness), np.arange(len(tri)) % 3)


def codes(mesh):
    return {i.code for i in check(mesh)}


def with_(mesh, **kw):
    return FillMesh(**{**mesh.__dict__, **kw})


def test_a_clean_mesh_has_no_issues_and_reports_its_volume():
    m = square(3)
    assert check(m) == []
    assert m.volume_mm3() == 3 * 3 * 100 * 2.0


def test_slivers_zero_area_and_bad_thickness_are_flagged_with_the_offending_triangles():
    m = square(2)
    nodes = m.nodes_mm.copy()
    nodes[4] = nodes[3] + [1e-9, 0, 0]                      # collapses the triangles around node 4 onto an edge
    assert "degenerate_triangle" in codes(with_(m, nodes_mm=nodes))
    for bad in (np.nan, 0.0, -1.0, 500.0):
        t = m.thickness_mm.copy()
        t[0] = bad
        issue = [i for i in check(with_(m, thickness_mm=t)) if i.code == "invalid_thickness"][0]
        assert issue.triangles == [0]


def test_two_separate_regions_are_reported_with_their_sizes():
    a, b = square(2), square(2)
    both = FillMesh(np.vstack([a.nodes_mm, b.nodes_mm + [100, 0, 0]]), np.vstack([a.triangles, b.triangles + len(a.nodes_mm)]),
                    np.full(16, 2.0), np.zeros(16, int))
    issue = [i for i in check(both) if i.code == "disconnected"][0]
    assert "[8, 8]" in issue.message


def test_three_triangles_on_one_edge_is_non_manifold_and_a_flipped_triangle_is_inconsistent():
    m = square(1)
    nodes = np.vstack([m.nodes_mm, [[5.0, 5.0, 10.0]]])
    third = np.vstack([m.triangles, [[0, 3, 4]]])           # (0,3) is the shared diagonal: now three triangles meet on it
    mesh = FillMesh(nodes, third, np.full(3, 2.0), np.zeros(3, int))
    assert "non_manifold" in codes(mesh)
    flipped = m.triangles.copy()
    flipped[1] = flipped[1][::-1]
    assert "inconsistent_orientation" in codes(with_(m, triangles=flipped))


def test_an_empty_mesh_is_an_issue_not_a_crash():
    empty = FillMesh(np.zeros((0, 3)), np.zeros((0, 3), int), np.zeros(0), np.zeros(0, int))
    assert codes(empty) == {"no_triangles"}


def shape_ratio(mesh):
    """Shortest altitude over longest edge, per triangle: 0.87 for an equilateral triangle, 0 for a needle."""
    c = mesh.corners()
    longest = np.linalg.norm(c[:, [1, 2, 0]] - c, axis=2).max(axis=1)
    return 2 * mesh.areas_mm2() / longest ** 2


def test_refinement_meets_the_edge_target_and_keeps_the_mesh_watertight_oriented_and_the_volume():
    m = square(1, thickness=1.5)                              # one 10 mm square, two triangles
    r = m.refined(3.0, 10000)
    assert r.longest_edge_mm() <= 3.0 and check(r) == []
    assert r.volume_mm3() == pytest.approx(m.volume_mm3())
    up = np.cross(r.corners()[:, 1] - r.corners()[:, 0], r.corners()[:, 2] - r.corners()[:, 0])[:, 2]
    assert (up > 0).all()                                      # still counter-clockwise from +z
    assert len(np.unique(r.nodes_mm, axis=0)) == len(r.nodes_mm)  # neighbours share their midpoints
    assert len(m.refined(0.01, 40).triangles) <= 40            # stops at the triangle cap


def test_refinement_turns_a_fan_of_needles_into_well_shaped_triangles():
    # what a CAD tessellator leaves on a flat face with a hole: every triangle runs from a far corner to two neighbouring points of the hole's arc
    arc = np.radians(np.linspace(180, 270, 7))                 # a 12 mm hole at (60, 60), cut in 3 mm segments, seen from the corner at the origin
    nodes = np.vstack([[0.0, 0.0, 0.0], np.column_stack([60 + 12 * np.cos(arc), 60 + 12 * np.sin(arc), np.zeros(7)])])
    tri = np.column_stack([np.zeros(6, int), np.arange(2, 8), np.arange(1, 7)])
    fan = FillMesh(nodes, tri, np.full(6, 2.0), np.zeros(6, int))
    assert shape_ratio(fan).max() < 0.08                       # needles
    r = fan.refined(4.0, 20000)
    assert np.percentile(shape_ratio(r), 5) > 0.2 and check(r) == []
    assert r.longest_edge_mm() <= 4.0 and r.volume_mm3() == pytest.approx(fan.volume_mm3())


def test_an_edge_is_never_flipped_across_a_crease_or_between_two_cad_faces():
    # an L: a 10 x 10 floor and a 10 x 10 wall standing on its x = 10 edge. However it is refined, the fold stays an edge of the mesh.
    flat = square(1)
    wall = flat.nodes_mm[:, [2, 1, 0]] + [10, 0, 0]                                 # (x, y, 0) -> (10, y, x)
    nodes, remap = np.unique(np.round(np.vstack([flat.nodes_mm, wall]), 9), axis=0, return_inverse=True)
    tri = remap.ravel()[np.vstack([flat.triangles, flat.triangles + 4])]
    folded = FillMesh(nodes, tri, np.full(4, 2.0), np.array([0, 0, 1, 1]))
    assert check(folded) == []
    r = folded.refined(2.0, 20000)
    in_floor, in_wall = np.abs(r.nodes_mm[:, 2]) < 1e-9, np.abs(r.nodes_mm[:, 0] - 10) < 1e-9
    assert in_floor[r.triangles[r.face_id == 0]].all() and in_wall[r.triangles[r.face_id == 1]].all()
    assert check(r) == [] and r.volume_mm3() == pytest.approx(400.0)


def test_gate_mapping_by_click_radius_and_face():
    m = square(4)
    assert m.nearest_node([21, 20, 3]) == int(np.flatnonzero((m.nodes_mm[:, 0] == 20) & (m.nodes_mm[:, 1] == 20))[0])
    assert len(m.nodes_near([20, 20, 0], 10.0)) == 5            # the node and its four grid neighbours
    assert len(m.nodes_near([24, 24, 0], 0.01)) == 1       # a click between nodes still gives a gate: the nearest
    assert set(m.nodes_on_face(0)) <= set(np.unique(m.triangles))
