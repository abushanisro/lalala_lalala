"""One fill simulation from a CAD shape: the mesh, the run when a gate is given, and the JSON the backend relays.

Coordinates in and out are part-centred millimetres (CAD minus the bounding-box centre): the frame the 3D viewer and the heatmap already use.
Without a gate the answer is the mesh alone, so the engineer can see it and click where the gate goes.
"""
import logging
import threading
import time
from collections import OrderedDict
from typing import Any, Callable, Dict, Optional, Tuple

import numpy as np
from pydantic import BaseModel, Field, model_validator

from .fill_mesh import FillMesh
from .fill_mesh_extract import extract_fill_mesh
from .fill_results import end_of_fill, summarise, weld_lines
from .fill_solver import CrossWLF, Newtonian, fill

logger = logging.getLogger(__name__)

VERSION = "fill_sim_v1"
TIME_BUDGET_S = 150.0   # one run (meshing and filling) stops with a clear answer after this: the engine's watchdog ends the whole process at 900 s
_CANNOT_RUN = {"no_triangles", "invalid_thickness", "not_thin_walled"}   # a mesh the solver cannot fill, or whose fill would not describe the part
_CURVE_POINTS = 400


class CrossWLFConstants(BaseModel):
    """The grade's own constants, from its datasheet or a rheometer fit. D3 (pressure dependence) is not modelled."""
    n: float = Field(gt=0, le=1)
    tau_pa: float = Field(gt=0)
    d1_pa_s: float = Field(gt=0)
    d2_k: float = Field(gt=0)
    a1: float = Field(gt=0)
    a2_k: float = Field(gt=0)


class FillRequest(BaseModel):
    gate_mm: Optional[Tuple[float, float, float]] = None       # part-centred; the nearest mesh node(s) become the gate
    gate_radius_mm: float = Field(0.0, ge=0, le=50)             # 0 = a pin gate at one node
    fill_time_s: Optional[float] = Field(None, gt=0, le=600)    # sets the flow rate: mesh volume / fill time
    melt_temp_c: Optional[float] = Field(None, gt=0, lt=500)
    rheology: Optional[CrossWLFConstants] = None                # the grade's own constants, or:
    flow_length_ratio: Optional[float] = Field(None, gt=0, le=2000)   # the grade's maximum flow length over wall thickness (see estimated_viscosity)
    pull: Optional[Tuple[float, float, float]] = None           # mold opening direction, for the clamp force; chosen from the part when not given
    max_injection_pressure_mpa: Optional[float] = Field(None, gt=0)   # pressure available at the gate
    target_edge_mm: Optional[float] = Field(None, gt=0)
    switchover: float = Field(0.99, ge=0.5, le=1.0)

    @model_validator(mode="after")
    def a_run_needs_its_inputs(self) -> "FillRequest":
        if self.gate_mm is None:
            return self
        if self.fill_time_s is None:
            raise ValueError("a simulation needs fill_time_s")
        if self.rheology is not None:
            if self.melt_temp_c is None:
                raise ValueError("a simulation with Cross-WLF constants needs melt_temp_c")
            if self.melt_temp_c + 273.15 <= self.rheology.d2_k:
                raise ValueError("the melt temperature must be above the Cross-WLF reference temperature D2")
        elif self.flow_length_ratio is None or self.max_injection_pressure_mpa is None:
            raise ValueError("a simulation needs the melt's viscosity: rheology (Cross-WLF), or flow_length_ratio with max_injection_pressure_mpa")
        if self.pull is not None and not np.linalg.norm(self.pull) > 0:
            raise ValueError("pull must not be the zero vector")
        return self


def estimated_viscosity(flow_length_ratio: float, pressure_mpa: float, fill_time_s: float) -> float:
    """The one viscosity (Pa s) a grade's flow length ratio supports.

    The reference data gives, per grade, the longest flow path a wall can be filled over (as a multiple R of the wall thickness) and the
    injection pressure. A strip R walls long, filled at a constant rate in time t, needs P = 12 eta R^2 / t whatever its thickness
    (P = 12 eta q L / h^3 with q = h L / t). So eta = P t / (12 R^2) is the viscosity at which a part at the grade's flow limit needs exactly
    the pressure available, in this run's fill time. Pressures computed with it say how near a part is to that limit: an estimate, not rheometry.
    """
    return pressure_mpa * 1e6 * fill_time_s / (12.0 * flow_length_ratio ** 2)


def _numbers(values, digits: int) -> list:
    """A JSON-safe list: rounded, with None where the value does not exist (NaN is not JSON)."""
    a = np.round(np.asarray(values, float), digits)
    return np.where(np.isnan(a), None, a.astype(object)).tolist()


def _at_nodes(mesh: FillMesh, per_triangle: np.ndarray) -> np.ndarray:
    """Area-weighted average of a per-triangle value at each node, for smooth shading."""
    area = mesh.areas_mm2()
    n = len(mesh.nodes_mm)
    weight = np.bincount(mesh.triangles.ravel(), np.repeat(area, 3), n)
    return np.bincount(mesh.triangles.ravel(), np.repeat(per_triangle * area, 3), n) / np.maximum(weight, 1e-300)


def _pack_mesh(mesh: FillMesh) -> Dict[str, Any]:
    return {
        "nodes_mm": _numbers(mesh.nodes_mm - mesh.centre_mm, 3),
        "triangles": mesh.triangles.tolist(),
        "thickness_mm": _numbers(_at_nodes(mesh, mesh.thickness_mm), 3) if len(mesh.triangles) else [],
        "face_id": mesh.face_id.tolist(),
        "centre_mm": _numbers(mesh.centre_mm, 3),
    }


_MESHES: "OrderedDict[str, Tuple[FillMesh, Dict[str, Any]]]" = OrderedDict()
_MESHES_KEPT = 4
_MESHES_LOCK = threading.Lock()   # requests run on a thread pool


def _mesh_for(load_shape: Callable[[], Any], file_key: str, target_edge_mm: Optional[float], deadline: float) -> Tuple[FillMesh, Dict[str, Any]]:
    """The mesh of a file, kept for the next call: the engineer first asks for the mesh, clicks a gate, then runs, and extraction (seconds of
    thickness rays) is the same both times. `load_shape` is only called when the file has not been meshed yet."""
    key = f"{file_key}:{target_edge_mm}"
    with _MESHES_LOCK:
        kept = _MESHES.get(key)
        if kept is not None:
            _MESHES.move_to_end(key)
            return kept
    made = extract_fill_mesh(load_shape(), target_edge_mm=target_edge_mm, deadline=deadline)   # outside the lock: it takes seconds
    with _MESHES_LOCK:
        _MESHES[key] = made
        while len(_MESHES) > _MESHES_KEPT:
            _MESHES.popitem(last=False)
    return made


def simulate(load_shape: Callable[[], Any], file_key: str, request: FillRequest) -> Dict[str, Any]:
    """`load_shape` gives the CAD shape; `file_key` identifies the file's content (its hash), so the mesh of a file already seen is reused."""
    started = time.monotonic()
    deadline = started + TIME_BUDGET_S
    mesh, report = _mesh_for(load_shape, file_key, request.target_edge_mm, deadline)
    meshed = time.monotonic()
    can_simulate = not any(issue["code"] in _CANNOT_RUN for issue in report["issues"])
    out: Dict[str, Any] = {"version": VERSION, "mesh": _pack_mesh(mesh), "report": {**report, "can_simulate": can_simulate}, "simulation": None}
    if request.gate_mm is None or not can_simulate:
        logger.info("fill mesh: %d triangles in %.1f s, issues %s", len(mesh.triangles), meshed - started, [i["code"] for i in report["issues"]])
        return out

    gate = mesh.nodes_near(np.add(request.gate_mm, mesh.centre_mm), request.gate_radius_mm)
    flow = mesh.volume_mm3() / request.fill_time_s
    r = request.rheology
    if r is not None:
        melt, viscosity = CrossWLF(r.n, r.tau_pa, r.d1_pa_s, r.d2_k, r.a1, r.a2_k), {"model": "cross_wlf", **r.model_dump()}
    else:
        eta = estimated_viscosity(request.flow_length_ratio, request.max_injection_pressure_mpa, request.fill_time_s)
        melt = Newtonian(eta)
        viscosity = {"model": "flow_length_estimate", "effective_viscosity_pa_s": round(eta, 2), "flow_length_ratio": request.flow_length_ratio,
                     "pressure_mpa": request.max_injection_pressure_mpa}
    pull, pull_source = (request.pull, "given") if request.pull is not None else (report.get("pull_direction"), "automatic")
    result = fill(mesh.nodes_mm, mesh.triangles, mesh.thickness_mm, gate, flow, melt, (request.melt_temp_c or 0.0) + 273.15, request.switchover, deadline=deadline)
    filled = time.monotonic()
    velocity = result.front_velocity_mm_s
    welds = weld_lines(mesh, result.fill_time_s, velocity)
    ends = end_of_fill(mesh, result.fill_time_s)
    centred = lambda p: _numbers(np.asarray(p) - mesh.centre_mm, 3)
    keep = np.unique(np.linspace(0, len(result.time_s) - 1, _CURVE_POINTS).astype(int)) if len(result.time_s) else np.array([], int)
    out["simulation"] = {
        "inputs": {
            "gate_mm": centred(mesh.nodes_mm[gate].mean(axis=0)), "gate_nodes": gate.tolist(), "fill_time_s": request.fill_time_s,
            "melt_temp_c": request.melt_temp_c, "flow_rate_mm3_s": round(flow, 3), "switchover": request.switchover, "viscosity": viscosity,
            "pull": {"vector": list(pull), "source": pull_source} if pull is not None else None,
        },
        "fill_time_s": _numbers(result.fill_time_s, 5),
        "pressure_mpa": _numbers(result.pressure_mpa, 4),
        "front_speed_mm_s": _numbers(_at_nodes(mesh, np.linalg.norm(velocity, axis=1)), 2),
        "wall_shear_stress_mpa": _numbers(_at_nodes(mesh, result.wall_shear_stress_mpa), 5),
        "wall_shear_rate_per_s": _numbers(_at_nodes(mesh, result.wall_shear_rate_1_s), 1),
        "velocity_mm_s": _numbers(velocity, 2),
        "weld_lines": [{"from_mm": centred(w["from_mm"]), "to_mm": centred(w["to_mm"]), "time_s": round(w["time_s"], 5),
                        "meeting_angle_deg": round(w["meeting_angle_deg"], 1)} for w in welds],
        "end_of_fill": [{"at_mm": centred(e["at_mm"]), "time_s": round(e["time_s"], 5), "vented_edge": e["vented_edge"]} for e in ends],
        "curve": {"time_s": _numbers(result.time_s[keep], 5), "inlet_pressure_mpa": _numbers(result.inlet_pressure_mpa[keep], 4),
                  "filled_fraction": _numbers(result.filled_fraction[keep], 5)},
        "assumptions": ([] if r is not None else [
            f"Viscosity is one number, {viscosity['effective_viscosity_pa_s']:g} Pa s, set so that a part at the grade's flow length limit "
            f"({request.flow_length_ratio:g} wall thicknesses) needs exactly {request.max_injection_pressure_mpa:g} MPa. Pressure and shear stress "
            f"are estimates against that limit; the fill pattern does not depend on it."]) + [
            "Isothermal: the melt keeps its inlet temperature, so nothing freezes. Pressure is a lower bound on thin, long flow paths.",
            "Constant flow rate from one gate; no runner, no packing, no compressibility.",
            "Ribs and bosses are not flow channels: they appear as a thicker wall where they sit.",
        ],
        **summarise(mesh, result, welds, ends, flow, request.switchover, pull, request.max_injection_pressure_mpa, report),
    }
    # what is wrong with the mesh qualifies every number of the run, so it is listed with the run's own issues
    out["simulation"]["issues"] = [{"code": i["code"], "severity": "warning", "message": i["message"]} for i in report["issues"]] + out["simulation"]["issues"]
    logger.info("fill simulation: %d triangles, mesh %.1f s, fill %.1f s, issues %s", len(mesh.triangles), meshed - started, filled - meshed,
                [i["code"] for i in out["simulation"]["issues"]])
    if r is None:
        out["simulation"]["issues"].insert(0, {"code": "pressure_estimated", "severity": "info", "message":
                                               "Pressure and shear stress are estimated from the grade's flow length ratio, not from its viscosity curve. "
                                               "The fill pattern, weld lines and air traps do not depend on it."})
    summary = out["simulation"]["summary"]
    out["simulation"]["summary"] = {k: round(v, 4) if isinstance(v, float) else v for k, v in summary.items()}
    return out
