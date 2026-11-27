"""What an engineer reads off a fill: melt-front velocity, weld lines, end-of-fill points, clamp force, and the list of issues.

Everything here is geometry on the solver's fill-time and pressure fields; no physics is added. numpy only.
"""
from typing import Any, Dict, List, Optional, Sequence

import numpy as np

from .fill_mesh import FillMesh, components
from .fill_solver import FillResult

WELD_MEETING_ANGLE_DEG = 135.0   # fronts meeting at less than this form a weld line; at more, a meld line (the usual convention)
_INTO_EDGE = 0.05                # both flows must run into the shared edge by at least this (cosine) to count as meeting
_TONNE_FORCE_N = 9806.65


def _unit(v: np.ndarray) -> np.ndarray:
    length = np.linalg.norm(v, axis=1, keepdims=True)
    return np.divide(v, length, out=np.zeros_like(v), where=length > 1e-12)


def _edges(triangles: np.ndarray):
    """Every triangle edge as sorted node pairs, with the triangle that owns it, ordered so that the two owners of a shared edge are adjacent."""
    pairs = np.sort(np.stack([triangles[:, [0, 1]], triangles[:, [1, 2]], triangles[:, [2, 0]]], axis=1).reshape(-1, 2), axis=1)
    owner = np.repeat(np.arange(len(triangles)), 3)
    order = np.lexsort((pairs[:, 1], pairs[:, 0]))
    return pairs[order], owner[order]


def _open_edge_nodes(mesh: FillMesh) -> np.ndarray:
    """Nodes on an edge that belongs to one triangle only: the free edge of the skin (a rim, a hole, the end of a wall)."""
    pairs, _ = _edges(mesh.triangles)
    same = (pairs[1:] == pairs[:-1]).all(axis=1)
    once = np.ones(len(pairs), bool)
    once[1:] &= ~same
    once[:-1] &= ~same
    on_edge = np.zeros(len(mesh.nodes_mm), bool)
    on_edge[pairs[once].ravel()] = True
    return on_edge


def weld_lines(mesh: FillMesh, fill_time_s: np.ndarray, velocity: np.ndarray) -> List[Dict[str, Any]]:
    """Mesh edges where two flows run into each other at a meeting angle under 135 degrees, earliest first. `velocity` is the solver's
    melt velocity as the front closed each triangle (from the pressure field, which is smooth; differentiating arrival times is not).

    Compared across an edge are the flows one element away on either side: the average direction around the vertex opposite the edge in each
    triangle. A front that has just turned a corner is wavy at the scale of one element, and neighbouring triangles then point at each other
    without two fronts meeting; a patch average cancels that and keeps a real meeting, whose two sides differ everywhere.
    The two triangles may lie in different planes (a wall meeting a floor), so each flow is split into its part along the edge and its part
    into the edge within its own triangle: that unfolds the pair flat about the edge before the angle is taken. A front that simply arrives at
    a free edge of the part is the end of fill (reported separately), so a triangle closed at a free-edge node does not count.
    """
    tri = mesh.triangles
    c = mesh.corners()
    normal = _unit(np.cross(c[:, 1] - c[:, 0], c[:, 2] - c[:, 0]))
    weight = np.repeat(mesh.areas_mm2(), 3)
    direction = _unit(velocity)
    around = np.stack([np.bincount(tri.ravel(), np.repeat(direction[:, k], 3) * weight, len(mesh.nodes_mm)) for k in range(3)], axis=1)

    pair = np.sort(np.stack([tri, tri[:, [1, 2, 0]]], axis=2), axis=2).reshape(-1, 2)
    order = np.lexsort((pair[:, 1], pair[:, 0]))
    twin = np.flatnonzero((pair[order][1:] == pair[order][:-1]).all(axis=1))
    a, b = order[twin] // 3, order[twin + 1] // 3
    opposite_a, opposite_b = tri[a, (order[twin] % 3 + 2) % 3], tri[b, (order[twin + 1] % 3 + 2) % 3]
    p0, p1 = mesh.nodes_mm[pair[order[twin], 0]], mesh.nodes_mm[pair[order[twin], 1]]
    along = _unit(p1 - p0)
    middle = (p0 + p1) / 2
    centroid = mesh.triangle_centroids_mm()

    def into(t):   # unit vector in triangle t's plane, across the edge, pointing at it
        d = middle - centroid[t]
        return _unit(d - (d * along).sum(axis=1, keepdims=True) * along)

    def flow(t, vertex):   # the patch-averaged direction at `vertex`, laid into triangle t's plane
        v = around[vertex]
        return _unit(v - (v * normal[t]).sum(axis=1, keepdims=True) * normal[t])

    va, vb = flow(a, opposite_a), flow(b, opposite_b)
    into_a, into_b = (va * into(a)).sum(axis=1), (vb * into(b)).sum(axis=1)
    cos_between = (va * along).sum(axis=1) * (vb * along).sum(axis=1) - into_a * into_b
    meeting = 180.0 - np.degrees(np.arccos(np.clip(cos_between, -1.0, 1.0)))   # 0 = head on, 180 = side by side
    times = np.where(np.isnan(fill_time_s), -np.inf, fill_time_s)[tri]
    closed_at = tri[np.arange(len(tri)), times.argmax(axis=1)]                  # the node whose filling closed each triangle
    inside = ~_open_edge_nodes(mesh)[closed_at]
    weld = (into_a > _INTO_EDGE) & (into_b > _INTO_EDGE) & (meeting < WELD_MEETING_ANGLE_DEG) & inside[a] & inside[b]
    formed = np.nanmax(fill_time_s[pair[order[twin]]], axis=1)
    found = np.flatnonzero(weld & np.isfinite(formed))
    if len(found):                                                              # a weld line is at least two edges end to end: a lone edge is noise
        ends = pair[order[twin[found]]]
        line = components(np.column_stack([ends, ends[:, 1]]))
        found = found[np.bincount(line, minlength=len(found))[line] > 1]
    found = found[np.argsort(formed[found])]
    return [{"from_mm": p0[i], "to_mm": p1[i], "time_s": float(formed[i]), "meeting_angle_deg": float(meeting[i])} for i in found]


def end_of_fill(mesh: FillMesh, fill_time_s: np.ndarray, prominence: float = 0.02) -> List[Dict[str, Any]]:
    """Where the air is pushed to: nodes that fill after everything around them. On an open edge of the mesh the air can be vented; inside the
    part it is an air trap. A point counts only if every way from it to a later-filling point first drops by `prominence` of the fill time,
    so an edge the front reaches all at once is one point, not one per node."""
    pairs, _ = _edges(mesh.triangles)
    on_edge = _open_edge_nodes(mesh)

    time = np.where(np.isnan(fill_time_s), -np.inf, fill_time_s)
    if not np.isfinite(time).any():
        return []
    both = np.vstack([pairs, pairs[:, ::-1]])
    both = both[np.argsort(both[:, 0], kind="stable")]
    start = np.searchsorted(both[:, 0], np.arange(len(time) + 1))
    neighbours = lambda i: both[start[i]:start[i + 1], 1]
    rank = np.empty(len(time), int)
    rank[np.lexsort((np.arange(len(time)), time))] = np.arange(len(time))        # ties broken by node id
    latest = np.full(len(time), -1)
    np.maximum.at(latest, both[:, 0], rank[both[:, 1]])
    drop = prominence * float(time[np.isfinite(time)].max())
    found = []
    for i in np.flatnonzero(np.isfinite(time) & (rank > latest) & (latest >= 0)):
        seen, queue, beaten = {int(i)}, [int(i)], False
        while queue and not beaten:                                              # flood the nodes within `drop` of this one
            for j in neighbours(queue.pop()):
                j = int(j)
                if j in seen or time[j] < time[i] - drop:
                    continue
                if rank[j] > rank[i]:
                    beaten = True
                    break
                seen.add(j)
                queue.append(j)
        if not beaten:
            found.append(i)
    found.sort(key=lambda i: -time[i])
    return [{"at_mm": mesh.nodes_mm[i], "time_s": float(time[i]), "vented_edge": bool(on_edge[i])} for i in found]


def clamp_force_tonnes(mesh: FillMesh, pressure_mpa: np.ndarray, pull: Sequence[float]) -> float:
    """Force that opens the mold along `pull`: pressure x area projected on the parting plane. One cavity, filling only (packing is usually higher)."""
    c = mesh.corners()
    area_vector = np.cross(c[:, 1] - c[:, 0], c[:, 2] - c[:, 0]) / 2
    direction = np.asarray(pull, float) / np.linalg.norm(pull)
    pressure = np.nan_to_num(pressure_mpa)[mesh.triangles].mean(axis=1)
    return float((pressure * np.abs(area_vector @ direction)).sum() / _TONNE_FORCE_N)


def _percentile_by_area(values: np.ndarray, area: np.ndarray, share: float) -> float:
    wet = values > 0
    if not wet.any():
        return 0.0
    order = np.argsort(values[wet])
    cumulative = np.cumsum(area[wet][order])
    return float(values[wet][order][np.searchsorted(cumulative, share * cumulative[-1])])


def summarise(mesh: FillMesh, result: FillResult, welds: list, ends: list, flow_mm3_s: float, switchover: float,
              pull: Optional[Sequence[float]], max_injection_pressure_mpa: Optional[float], report: Dict[str, Any]) -> Dict[str, Any]:
    """Headline numbers and the issues an engineer must act on. Peak shear values are the 99th percentile by area: the single largest element sits
    on a gate node, which is a point source."""
    area = mesh.areas_mm2()
    node_volume = np.bincount(mesh.triangles.ravel(), np.repeat(area * mesh.thickness_mm / 3, 3), len(mesh.nodes_mm))
    unfilled_pct = 100.0 * float(node_volume[np.isnan(result.fill_time_s)].sum() / node_volume.sum())
    switchover_pressure = result.switchover_pressure_mpa(switchover) if len(result.time_s) else 0.0
    traps = [e for e in ends if not e["vented_edge"]]
    summary = {
        "fill_time_s": float(np.nanmax(result.fill_time_s)),
        "flow_rate_mm3_s": float(flow_mm3_s),
        "volume_mm3": mesh.volume_mm3(),
        "switchover_pressure_mpa": switchover_pressure,
        "wall_shear_stress_peak_mpa": _percentile_by_area(result.wall_shear_stress_mpa, area, 0.99),
        "wall_shear_rate_peak_per_s": _percentile_by_area(result.wall_shear_rate_1_s, area, 0.99),
        "front_speed_median_mm_s": _percentile_by_area(np.linalg.norm(result.front_velocity_mm_s, axis=1), area, 0.5),
        "unfilled_volume_pct": unfilled_pct,
        "weld_line_length_mm": float(sum(np.linalg.norm(np.subtract(w["to_mm"], w["from_mm"])) for w in welds)),
        "air_traps": len(traps),
        "vented_end_points": len(ends) - len(traps),
        "clamp_force_t": clamp_force_tonnes(mesh, result.pressure_mpa, pull) if pull is not None else None,
    }
    issues: List[Dict[str, str]] = []
    if unfilled_pct > 0:
        issues.append({"code": "short_shot", "severity": "error",
                       "message": f"{unfilled_pct:.1f}% of the volume has no path from the gate and never fills."})
    if max_injection_pressure_mpa is not None and switchover_pressure > max_injection_pressure_mpa:
        issues.append({"code": "pressure_over_limit", "severity": "error",
                       "message": f"Injection pressure at switchover is {switchover_pressure:.0f} MPa, over the {max_injection_pressure_mpa:.0f} MPa limit: "
                                  f"expect a short shot or a slower fill. Thicken the wall, move or add a gate, or raise the melt temperature."})
    if traps:
        issues.append({"code": "air_trap", "severity": "warning",
                       "message": f"{len(traps)} air trap(s): the melt closes on a point inside the part, away from any edge. Move the gate or add a vent pin there."})
    if welds:
        issues.append({"code": "weld_line", "severity": "warning",
                       "message": f"{summary['weld_line_length_mm']:.0f} mm of weld line (fronts meeting at under {WELD_MEETING_ANGLE_DEG:.0f} degrees): "
                                  f"weaker and visible. Keep them off load paths and show surfaces."})
    if report.get("resolution_limited"):
        issues.append({"code": "resolution_limited", "severity": "info",
                       "message": f"Mesh edges are {report['longest_edge_mm']:.1f} mm against a {report['target_edge_mm']:.1f} mm target (triangle limit reached): "
                                  f"fine detail of the fill pattern is smoothed."})
    return {"summary": summary, "issues": issues}
