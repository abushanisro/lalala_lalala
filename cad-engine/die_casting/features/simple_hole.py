"""
Die Casting SimpleHole / MultiStepHole.

The holes come from the recogniser every shell- and die-formed analysis shares (injection_molding/recognition/holes.recognize_holes, used by
the molding, forging, powder metal, additive, composite and roto/blow analyses): one hole however many faces carry its wall, only a cylinder
that wraps a full turn (an arc is a fillet, not a hole), in any direction (a cross hole across the pull is kept), blind when a face closes an
end, and bores stacked on one line as one MultiStepHole. The casting's own reading of a hole is kept: its axis, tool axis, L/D and, for a blind
hole, that L/D against the generic ceiling below.

Real sourced threshold used: memory/Die Casting/Lookup/tblDTCLimits.csv's one generic (process "Other", i.e. material/process-agnostic)
blind-hole L/D ceiling of 2.00, annotated as a disclosed fact, never a pass/fail verdict.

Not yet implemented (disclosed, not silently dropped): Ring and RingedHole, also real catalog feature types, are deferred.
"""
from __future__ import annotations

import math
from typing import Any, Dict, List, Optional, Tuple

from shared.machining_geometry import part_bounding_box

# memory/Die Casting/Lookup/tblDTCLimits.csv: Process="Other" (generic, not
# material/process-specific), Name="Blind Hole LD Ratio", Limit=2.00.
BLIND_HOLE_LD_CEILING = 2.00


def detect_holes(
    shape: Any,
    bbox_minmax: Optional[Dict[str, float]],
    primary_setup_axis: Optional[List[float]],
    meshes: Optional[List[Any]] = None,
) -> Dict[str, Any]:
    """
    The casting's holes, from the hole recogniser the molding, forging, powder metal, additive, composite and roto/blow analyses share
    (injection_molding/recognition/holes.recognize_holes): the faces of one bore however many there are, a cylinder that wraps at least
    FULL_SWEEP_DEG (a fillet or a boss's rounded corner is an arc, not a hole), any direction (a cross hole across the pull is kept), blind when
    a face closes an end. A stack of bores on one line is a MultiStepHole. The old candidate source (collect_cylinders about the setup axis)
    kept only through/blind bores about that axis and took each split face for a hole of its own.
    """
    from injection_molding.recognition.holes import recognize_holes
    from injection_molding.recognition.mesh import tessellate_faces

    pull: Tuple[float, float, float] = tuple(primary_setup_axis) if primary_setup_axis else (0.0, 0.0, 1.0)
    if meshes is None:
        bbox = bbox_minmax if bbox_minmax else part_bounding_box(shape)
        diagonal = math.sqrt(sum((bbox[f"{a}max"] - bbox[f"{a}min"]) ** 2 for a in "xyz"))
        meshes = tessellate_faces(shape, linear_deflection=max(0.1, diagonal * 0.001))
    found = recognize_holes(meshes, pull)

    simple_hole_candidates: List[Dict[str, Any]] = []
    multi_step_hole_candidates: List[Dict[str, Any]] = []
    claimed: List[int] = []
    for h in found["holes"]:
        face_ids = list(h["face_ids"])
        claimed += face_ids
        centroid = _faces_centroid(shape, face_ids)
        # The bores of a stack, widest first (as detect_multistep_holes listed them); cones (countersinks, drill points) are not steps.
        steps = sorted(
            ({"diameter_mm": st["diameter_mm"], "depth_mm": st["length_mm"]} for st in h.get("steps", []) if st.get("kind") == "cylinder"),
            key=lambda st: st["diameter_mm"], reverse=True,
        )
        if h["feature_type"] != "SimpleHole" and len(steps) >= 2:
            along = [st["diameter_mm"] for st in h["steps"] if st.get("kind") == "cylinder"]
            monotonic = all(a > b for a, b in zip(along, along[1:])) or all(a < b for a, b in zip(along, along[1:]))
            multi_step_hole_candidates.append({
                "recognition_status": "recognized",
                "recognition_evidence": f"{len(steps)} coaxial bores, diameters {[st['diameter_mm'] for st in steps]}",
                "face_ids": face_ids,
                "centroid_mm": list(centroid) if centroid else None,
                "steps": steps,
                "step_count": len(steps),
                "max_diameter_mm": steps[0]["diameter_mm"],
                "min_diameter_mm": steps[-1]["diameter_mm"],
                "monotonic": monotonic,
            })
            continue
        is_through = h["variant"] == "through"
        diameter_mm = float(h["diameter_mm"])
        depth_mm = float(h["depth_mm"])
        ld_ratio = round(depth_mm / diameter_mm, 2) if diameter_mm > 0 else None
        occ: Dict[str, Any] = {
            "recognition_status": "recognized",
            "recognition_evidence": (
                "through-hole: neither end closed" if is_through else "blind hole: a face closes one end"
            ),
            "face_ids": face_ids,
            "centroid_mm": list(centroid) if centroid else None,
            # Unit direction of the bore axis: with the centroid it locates the
            # axis line (hole-to-hole wall thickness for castability).
            "axis": [round(v, 6) for v in h["axis"]],
            "diameter_mm": diameter_mm,
            "depth_mm": depth_mm,
            "ld_ratio": ld_ratio,
            "blind": not is_through,
            "variant": "through" if is_through else "blind",
        }
        if not is_through and ld_ratio is not None:
            occ["exceeds_blind_hole_ld_ceiling"] = ld_ratio > BLIND_HOLE_LD_CEILING
            occ["blind_hole_ld_ceiling"] = BLIND_HOLE_LD_CEILING
        occ.update(_hole_tool_axis(shape, face_ids, h["axis"], depth_mm, is_through))
        simple_hole_candidates.append(occ)

    return {
        "simple_hole_candidates": simple_hole_candidates,
        "simple_hole_count": len(simple_hole_candidates),
        "multi_step_hole_candidates": multi_step_hole_candidates,
        "multi_step_hole_count": len(multi_step_hole_candidates),
        # Every hole's own face ids -- the base extractor subtracts this set
        # when building the NotSupported bucket.
        "claimed_face_ids": claimed,
    }


def _hole_tool_axis(shape: Any, face_ids: List[int], axis, depth_mm: float, is_through: bool) -> Dict[str, Any]:
    """Tool axis of a hole (feature_graph_v2 contract, setup-axis-rule.ts):
    a through hole is reachable from either end (bidirectional, along its
    axis); a blind hole only from its open end. The open end is the one a ray
    from the hole centre along the axis leaves without meeting a face within
    half the depth (the other end meets the real floor face). Neither or both
    ends open on a blind hole: no single tool axis, so none is given."""
    ax = [float(v) for v in axis]
    if is_through:
        return {"tool_axis": [round(v, 6) for v in ax], "tool_axis_bidirectional": True}
    centroid = _faces_centroid(shape, face_ids)
    if centroid is None:
        return {}
    reach = depth_mm / 2.0 + 1.0
    open_pos = _clear_within(shape, centroid, ax, reach)
    open_neg = _clear_within(shape, centroid, [-v for v in ax], reach)
    if open_pos == open_neg:
        return {}
    d = ax if open_pos else [-v for v in ax]
    return {"tool_axis": [round(v, 6) for v in d], "tool_axis_bidirectional": False}


def _clear_within(shape: Any, origin, direction, dist: float) -> bool:
    """True when a ray from `origin` along `direction` meets no face of
    `shape` within `dist` mm."""
    from OCC.Core.IntCurvesFace import IntCurvesFace_ShapeIntersector  # type: ignore
    from OCC.Core.gp import gp_Lin, gp_Pnt, gp_Dir  # type: ignore

    intersector = IntCurvesFace_ShapeIntersector()
    intersector.Load(shape, 1e-6)
    intersector.Perform(gp_Lin(gp_Pnt(*[float(v) for v in origin]), gp_Dir(*direction)), 1e-3, dist)
    return bool(intersector.IsDone()) and intersector.NbPnt() == 0


def _faces_centroid(shape: Any, face_ids: List[int]):
    """Area centroid of the bore faces: on the hole axis, halfway along it."""
    from OCC.Core.TopExp import TopExp_Explorer  # type: ignore
    from OCC.Core.TopAbs import TopAbs_FACE  # type: ignore
    from OCC.Core.BRepGProp import brepgprop  # type: ignore
    from OCC.Core.GProp import GProp_GProps  # type: ignore

    wanted = set(face_ids)
    if not wanted:
        return None
    props = GProp_GProps()
    idx = 0
    exp = TopExp_Explorer(shape, TopAbs_FACE)
    while exp.More():
        if idx in wanted:
            brepgprop.SurfaceProperties(exp.Current(), props)
        idx += 1
        exp.Next()
    if props.Mass() <= 0:
        return None
    c = props.CentreOfMass()
    return (c.X(), c.Y(), c.Z())
