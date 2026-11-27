"""What is read off a fill (weld lines, end of fill, air traps, clamp force, issues) on cases whose answer is known, and the service and route around it."""
import json

import numpy as np
import pytest

from injection_molding.fill_mesh import FillMesh
from injection_molding.fill_results import clamp_force_tonnes, end_of_fill, summarise, weld_lines
from injection_molding.fill_solver import CrossWLF, Newtonian as ConstantViscosity, fill

MELT = CrossWLF(n=0.3, tau_pa=2.5e4, d1=1e12, d2_k=263.15, a1=25.0, a2_k=51.6)   # test constants, not a real grade
RHEOLOGY = dict(n=0.3, tau_pa=2.5e4, d1_pa_s=1e12, d2_k=263.15, a1=25.0, a2_k=51.6)
REPORT = {"resolution_limited": False, "longest_edge_mm": 3.0, "target_edge_mm": 4.0}


class Newtonian:
    def viscosity(self, shear_rate, temp_k):
        return np.full_like(np.asarray(shear_rate, float), 500.0)


def plate(length=120.0, width=60.0, nx=48, ny=24, wall=2.0) -> FillMesh:
    x, y = np.meshgrid(np.linspace(0, length, nx + 1), np.linspace(0, width, ny + 1), indexing="ij")
    nodes = np.column_stack([x.ravel(), y.ravel(), np.zeros(x.size)])
    ids = np.arange(x.size).reshape(nx + 1, ny + 1)
    a, b, c, d = ids[:-1, :-1].ravel(), ids[1:, :-1].ravel(), ids[1:, 1:].ravel(), ids[:-1, 1:].ravel()
    tri = np.vstack([np.column_stack([a, b, c]), np.column_stack([a, c, d])])
    return FillMesh(nodes, tri, np.full(len(tri), wall), np.zeros(len(tri), int))


def run(mesh: FillMesh, gate, melt=MELT, seconds=1.0):
    return fill(mesh.nodes_mm, mesh.triangles, mesh.thickness_mm, gate, mesh.volume_mm3() / seconds, melt, 503.15)


def middles(welds):
    return np.array([(np.asarray(w["from_mm"]) + np.asarray(w["to_mm"])) / 2 for w in welds]).reshape(-1, 3)


def length(welds):
    return sum(float(np.linalg.norm(np.subtract(w["to_mm"], w["from_mm"]))) for w in welds)


def test_one_gate_on_a_plain_plate_makes_no_weld_line_and_one_vented_end_of_fill():
    mesh = plate()
    r = run(mesh, [mesh.nearest_node([0, 30, 0])])
    assert weld_lines(mesh, r.fill_time_s, r.front_velocity_mm_s) == []
    ends = end_of_fill(mesh, r.fill_time_s)
    assert len(ends) == 1 and ends[0]["vented_edge"] and ends[0]["at_mm"][0] == pytest.approx(120.0)
    assert ends[0]["time_s"] == pytest.approx(1.0, rel=1e-6)


def test_two_gates_meet_head_on_in_a_weld_line_half_way():
    mesh = plate()
    r = run(mesh, [mesh.nearest_node([0, 30, 0]), mesh.nearest_node([120, 30, 0])])
    welds = weld_lines(mesh, r.fill_time_s, r.front_velocity_mm_s)
    mid = middles(welds)
    assert length(welds) > 30 and np.abs(mid[:, 0] - 60).max() < 6             # a line across the plate at x = 60
    assert min(w["meeting_angle_deg"] for w in welds) < 45                       # head on where the fronts first touch
    assert all(w["meeting_angle_deg"] < 135 for w in welds)


def test_a_plate_gated_all_round_closes_on_an_air_trap_in_the_middle():
    mesh = plate(nx=40, ny=40, length=80.0, width=80.0)
    rim = np.flatnonzero((mesh.nodes_mm[:, 0] < 1e-9) | (mesh.nodes_mm[:, 0] > 80 - 1e-9) | (mesh.nodes_mm[:, 1] < 1e-9) | (mesh.nodes_mm[:, 1] > 80 - 1e-9))
    r = run(mesh, rim, melt=Newtonian())
    ends = end_of_fill(mesh, r.fill_time_s)
    assert len(ends) == 1 and not ends[0]["vented_edge"]
    assert np.linalg.norm(np.asarray(ends[0]["at_mm"])[:2] - [40, 40]) < 6
    found = summarise(mesh, r, [], ends, 1.0, 0.99, None, None, REPORT)
    assert found["summary"]["air_traps"] == 1 and [i["code"] for i in found["issues"]] == ["air_trap"]


def test_clamp_force_is_pressure_times_the_area_seen_along_the_pull_direction():
    mesh = plate(length=100.0, width=20.0, nx=40, ny=8)
    gate = np.flatnonzero(mesh.nodes_mm[:, 0] < 1e-9)                            # a film gate: pressure falls in a straight line to the front
    r = run(mesh, gate, melt=Newtonian())
    force = clamp_force_tonnes(mesh, r.pressure_mpa, (0, 0, 1))
    assert force == pytest.approx(r.pressure_mpa.max() / 2 * 100 * 20 / 9806.65, rel=0.06)   # mean pressure x area
    assert clamp_force_tonnes(mesh, r.pressure_mpa, (0, 0, -3)) == pytest.approx(force)       # direction only, either sense
    assert clamp_force_tonnes(mesh, r.pressure_mpa, (1, 0, 0)) == pytest.approx(0.0, abs=1e-9)  # a plate shows no area from its edge


def test_a_strip_at_its_grades_flow_length_limit_needs_exactly_the_pressure_available():
    from injection_molding.fill_simulation import estimated_viscosity

    # 100 mm of flow in a 2 mm wall is a flow length ratio of 50. A grade whose limit is 50 at 80 MPa is then exactly at its limit;
    # a grade that can go twice as far (ratio 100) needs a quarter of the pressure for the same part.
    mesh = plate(length=100.0, width=20.0, nx=40, ny=8, wall=2.0)
    gate = np.flatnonzero(mesh.nodes_mm[:, 0] < 1e-9)
    for ratio, expected_mpa in ((50.0, 80.0), (100.0, 20.0)):
        eta = estimated_viscosity(ratio, 80.0, 1.0)
        r = run(mesh, gate, melt=ConstantViscosity(eta), seconds=1.0)
        assert r.switchover_pressure_mpa(0.95) == pytest.approx(0.95 * expected_mpa, rel=0.03)
    assert estimated_viscosity(175.0, 127.5, 1.2) == pytest.approx(416.3, rel=1e-3)      # ABS-like numbers: a plausible melt viscosity


def test_the_issues_name_a_short_shot_an_over_pressure_and_a_capped_mesh():
    one = plate(length=40.0, width=20.0, nx=16, ny=8)
    two = FillMesh(np.vstack([one.nodes_mm, one.nodes_mm + [200, 0, 0]]), np.vstack([one.triangles, one.triangles + len(one.nodes_mm)]),
                   np.full(2 * len(one.triangles), 2.0), np.zeros(2 * len(one.triangles), int))
    r = run(two, [0], melt=Newtonian())
    found = summarise(two, r, [], [], 1.0, 0.99, (0, 0, 1), 1e-3, {**REPORT, "resolution_limited": True})
    assert [i["code"] for i in found["issues"]] == ["short_shot", "pressure_over_limit", "resolution_limited"]
    assert found["summary"]["unfilled_volume_pct"] == pytest.approx(50.0, rel=1e-6)
    assert found["summary"]["clamp_force_t"] > 0
    assert "50.0%" in found["issues"][0]["message"]


# ---- on real CAD shapes --------------------------------------------------------------------------------------------------------------

pytest.importorskip("OCC")

from OCC.Core.BRepAlgoAPI import BRepAlgoAPI_Cut  # noqa: E402
from OCC.Core.BRepPrimAPI import BRepPrimAPI_MakeBox, BRepPrimAPI_MakeCylinder  # noqa: E402
from OCC.Core.gp import gp_Ax2, gp_Dir, gp_Pnt  # noqa: E402

from injection_molding.fill_mesh_extract import extract_fill_mesh  # noqa: E402
from injection_molding.fill_simulation import FillRequest, simulate  # noqa: E402


def box(x, y, z, dx, dy, dz):
    return BRepPrimAPI_MakeBox(gp_Pnt(x, y, z), dx, dy, dz).Shape()


def cylinder(r, h, x=0.0, y=0.0, z=0.0):
    return BRepPrimAPI_MakeCylinder(gp_Ax2(gp_Pnt(x, y, z), gp_Dir(0, 0, 1)), r, h).Shape()


@pytest.fixture(scope="module")
def cup():
    return extract_fill_mesh(BRepAlgoAPI_Cut(cylinder(25, 30), cylinder(22, 30, z=3)).Shape())[0]


def test_a_hole_leaves_a_weld_line_directly_behind_it():
    mesh, _ = extract_fill_mesh(BRepAlgoAPI_Cut(box(0, 0, 0, 120, 60, 2), cylinder(12, 4, 50, 30, -1)).Shape())
    r = run(mesh, [mesh.nearest_node([0, 30, 1])])
    mid = middles(weld_lines(mesh, r.fill_time_s, r.front_velocity_mm_s))
    assert len(mid) >= 2 and (mid[:, 0] > 62).all() and (mid[:, 0] < 95).all() and np.abs(mid[:, 1] - 30).max() < 5


def test_a_cup_gated_at_the_rim_welds_on_the_wall_opposite_the_gate_and_ends_at_the_rim_there(cup):
    r = run(cup, [cup.nearest_node([23.5, 0, 30])])
    welds = weld_lines(cup, r.fill_time_s, r.front_velocity_mm_s)
    mid = middles(welds)
    assert length(welds) > 20 and (mid[:, 0] < -20).all() and np.abs(mid[:, 1]).max() < 8
    ends = end_of_fill(cup, r.fill_time_s)
    assert len(ends) == 1 and ends[0]["vented_edge"]
    assert np.linalg.norm(np.asarray(ends[0]["at_mm"]) - [-23.5, 0, 30]) < 6


def test_a_cup_gated_at_the_centre_of_its_base_fills_evenly_with_no_weld_line(cup):
    r = run(cup, [cup.nearest_node([0, 0, 1.5])])
    assert weld_lines(cup, r.fill_time_s, r.front_velocity_mm_s) == []
    rim = cup.nodes_mm[:, 2] > 29.5
    assert np.ptp(r.fill_time_s[rim]) < 0.03                                      # the whole rim within 3 % of the fill time
    assert all(e["vented_edge"] for e in end_of_fill(cup, r.fill_time_s))


def tray():
    return BRepAlgoAPI_Cut(box(-50, -30, 0, 100, 60, 15), box(-47.5, -27.5, 2.5, 95, 55, 15)).Shape()


def test_the_service_gives_the_mesh_alone_until_a_gate_is_set_then_a_fill_that_is_valid_json():
    preview = simulate(tray, "tray", FillRequest())
    assert preview["simulation"] is None and preview["report"]["issues"] == [] and preview["report"]["can_simulate"] is True
    nodes = np.array(preview["mesh"]["nodes_mm"])
    assert np.abs(nodes.min(axis=0) + nodes.max(axis=0)).max() < 3.0             # part-centred: the viewer's frame
    assert len(preview["mesh"]["thickness_mm"]) == len(nodes) and len(preview["mesh"]["face_id"]) == len(preview["mesh"]["triangles"])

    def must_not_reload():
        raise AssertionError("the mesh of a file already seen is reused")

    out = simulate(must_not_reload, "tray", FillRequest(gate_mm=(0, 0, -6.25), fill_time_s=1.5, melt_temp_c=230, rheology=RHEOLOGY))
    json.dumps(out, allow_nan=False)                                             # nothing a JSON parser would refuse
    sim = out["simulation"]
    assert sim["summary"]["fill_time_s"] == pytest.approx(1.5, rel=1e-6)          # the flow rate is set from the fill time asked for
    assert sim["summary"]["unfilled_volume_pct"] == 0 and sim["summary"]["clamp_force_t"] > 0
    assert sim["summary"]["switchover_pressure_mpa"] > 0 and sim["summary"]["wall_shear_stress_peak_mpa"] > 0
    for key in ("fill_time_s", "pressure_mpa", "front_speed_mm_s", "wall_shear_stress_mpa", "wall_shear_rate_per_s"):
        assert len(sim[key]) == len(nodes), key
    assert len(sim["velocity_mm_s"]) == len(out["mesh"]["triangles"])
    assert np.linalg.norm(np.array(sim["inputs"]["gate_mm"]) - [0, 0, -6.25]) < 4   # the nearest node of the floor's mid-surface
    assert len(sim["curve"]["time_s"]) == len(sim["curve"]["inlet_pressure_mpa"]) <= 400
    assert len(sim["assumptions"]) == 3 and "Isothermal" in sim["assumptions"][0]
    assert sim["inputs"]["viscosity"]["model"] == "cross_wlf"
    assert sim["inputs"]["pull"] == {"vector": [0.0, 0.0, 1.0], "source": "automatic"}   # not given: chosen from the part, as the analysis does

    estimate = simulate(must_not_reload, "tray", FillRequest(gate_mm=(0, 0, -6.25), fill_time_s=1.5, flow_length_ratio=175, max_injection_pressure_mpa=127.5))
    json.dumps(estimate, allow_nan=False)
    sim = estimate["simulation"]
    assert sim["inputs"]["viscosity"]["model"] == "flow_length_estimate" and sim["inputs"]["viscosity"]["effective_viscosity_pa_s"] > 0
    assert len(sim["assumptions"]) == 4 and "175 wall thicknesses" in sim["assumptions"][0]
    assert 0 < sim["summary"]["switchover_pressure_mpa"] < 127.5                  # a small tray is far inside this grade's flow limit


def test_a_part_that_is_not_thin_walled_gets_its_mesh_and_the_reason_but_no_simulation():
    from OCC.Core.BRepAlgoAPI import BRepAlgoAPI_Fuse

    mostly_solid = lambda: BRepAlgoAPI_Fuse(box(0, 0, 0, 40, 40, 30), box(40, 0, 0, 60, 40, 2)).Shape()
    out = simulate(mostly_solid, "block-with-fin", FillRequest(gate_mm=(30, 0, -14), fill_time_s=1, melt_temp_c=230, rheology=RHEOLOGY))
    assert out["simulation"] is None and [i["code"] for i in out["report"]["issues"]] == ["not_thin_walled"]
    assert out["report"]["can_simulate"] is False


@pytest.mark.parametrize("request_fields, message", [
    (dict(gate_mm=(0, 0, 0)), "needs fill_time_s"),
    (dict(gate_mm=(0, 0, 0), fill_time_s=1), "needs the melt's viscosity"),
    (dict(gate_mm=(0, 0, 0), fill_time_s=1, flow_length_ratio=175), "needs the melt's viscosity"),
    (dict(gate_mm=(0, 0, 0), fill_time_s=1, rheology=RHEOLOGY), "needs melt_temp_c"),
    (dict(gate_mm=(0, 0, 0), fill_time_s=1, melt_temp_c=-20, rheology=RHEOLOGY), "melt_temp_c"),
    (dict(gate_mm=(0, 0, 0), fill_time_s=1, melt_temp_c=230, rheology={**RHEOLOGY, "d2_k": 600}), "above the Cross-WLF reference temperature"),
    (dict(gate_mm=(0, 0, 0), fill_time_s=1, melt_temp_c=230, rheology={**RHEOLOGY, "n": 1.4}), "n"),
    (dict(gate_mm=(0, 0, 0), fill_time_s=1, melt_temp_c=230, rheology=RHEOLOGY, pull=(0, 0, 0)), "zero vector"),
])
def test_a_run_without_its_inputs_or_with_impossible_ones_is_refused_with_the_reason(request_fields, message):
    with pytest.raises(ValueError, match=message):
        FillRequest(**request_fields)


def test_the_route_answers_with_the_simulation_and_refuses_bad_parameters_a_missing_key_and_a_switched_off_server(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient
    from OCC.Core.STEPControl import STEPControl_AsIs, STEPControl_Writer

    import main

    path = str(tmp_path / "tray.step")
    writer = STEPControl_Writer()
    writer.Transfer(tray(), STEPControl_AsIs)
    writer.Write(path)
    upload = lambda: {"file": ("tray.step", open(path, "rb").read(), "application/step")}
    key = {"X-API-Key": main._CAD_API_KEY}
    params = {"gate_mm": [0, 0, -6.25], "fill_time_s": 1.0, "melt_temp_c": 230, "rheology": RHEOLOGY}
    with TestClient(main.app) as client:
        assert client.post("/simulate/fill", files=upload(), data={"params": json.dumps(params)}).status_code == 403
        bad = client.post("/simulate/fill", files=upload(), data={"params": json.dumps({**params, "fill_time_s": -1})}, headers=key)
        assert bad.status_code == 422 and "fill_time_s" in bad.json()["detail"]
        mesh_only = client.post("/simulate/fill", files=upload(), headers=key)
        assert mesh_only.status_code == 200 and mesh_only.json()["simulation"] is None and len(mesh_only.json()["mesh"]["triangles"]) > 100
        done = client.post("/simulate/fill", files=upload(), data={"params": json.dumps(params)}, headers=key)
        assert done.status_code == 200 and done.json()["simulation"]["summary"]["fill_time_s"] == pytest.approx(1.0, rel=1e-6)
        monkeypatch.setattr(main.config, "fill_simulation_enabled", False)
        off = client.post("/simulate/fill", files=upload(), data={"params": json.dumps(params)}, headers=key)
        assert off.status_code == 404 and "switched off" in off.json()["detail"]   # never a 5xx: that would read as an engine outage
