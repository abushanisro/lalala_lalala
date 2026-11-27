"""
A simple solid built from what a drawing states: the part's overall form (a block, a turned part, a sheet) and its holes.

A part that arrives as a 2D drawing only has no model to analyse and cost. This builds the plainest solid that agrees with the
drawing's own numbers, so the same analysis and cost engines that take a STEP file can take the part. It is a stand-in, and is
labelled as one wherever it is shown: the overall size, the turned profile and the holes are the drawing's; everything else about the
real part (pockets, fillets, chamfers, bends) is absent.

Where a hole goes is not read from the drawing (what a hole costs depends on its diameter, its depth and how many there are, not on
where it sits), so holes are set out evenly: on a grid across the largest face of a block or sheet, on a bolt circle in the flange of a
turned part. A hole that does not fit that way is left out and counted, never squeezed in.
"""
from __future__ import annotations

import math
import os
import tempfile
from typing import List, Literal, Optional, Tuple, Union

from pydantic import BaseModel, Field

MAX_MM = 20_000.0
MAX_HOLES = 400
FIT = 0.7          # a hole takes at most this share of the room it is given: its grid cell, or the flange it sits in
BLIND = 0.95       # a hole deeper than this share of the stock is a through hole


class Hole(BaseModel):
    diameter_mm: float = Field(gt=0, le=2000)
    depth_mm: Optional[float] = Field(default=None, gt=0, le=MAX_MM)    # None: through
    count: int = Field(ge=1, le=MAX_HOLES)


class Block(BaseModel):
    kind: Literal["block"]
    length_mm: float = Field(gt=0, le=MAX_MM)
    width_mm: float = Field(gt=0, le=MAX_MM)
    height_mm: float = Field(gt=0, le=MAX_MM)


class Sheet(BaseModel):
    kind: Literal["sheet"]
    length_mm: float = Field(gt=0, le=MAX_MM)
    width_mm: float = Field(gt=0, le=MAX_MM)
    thickness_mm: float = Field(gt=0, le=MAX_MM)


class Segment(BaseModel):
    diameter_mm: float = Field(gt=0, le=MAX_MM)
    length_mm: float = Field(gt=0, le=MAX_MM)


class Turned(BaseModel):
    kind: Literal["turned"]
    segments: List[Segment] = Field(min_length=1, max_length=40)
    bore_diameter_mm: Optional[float] = Field(default=None, gt=0, le=MAX_MM)


class DrawingSolidRequest(BaseModel):
    shape: Union[Block, Sheet, Turned] = Field(discriminator="kind")
    holes: List[Hole] = Field(default_factory=list, max_length=60)


def _expanded(holes: List[Hole]) -> List[Tuple[float, Optional[float]]]:
    """One (diameter, depth) per hole, the largest first."""
    each = [(h.diameter_mm, h.depth_mm) for h in holes for _ in range(h.count)]
    if len(each) > MAX_HOLES:
        raise ValueError(f"A drawing solid takes at most {MAX_HOLES} holes; this drawing has {len(each)}.")
    return sorted(each, key=lambda hole: -hole[0])


def _plate(length: float, width: float, thickness: float, holes: List[Hole]):
    """A box with its holes on an even grid across the length x width face, drilled down its thickness."""
    from OCC.Core.BRepPrimAPI import BRepPrimAPI_MakeBox, BRepPrimAPI_MakeCylinder
    from OCC.Core.gp import gp_Ax2, gp_Dir, gp_Pnt

    solid = BRepPrimAPI_MakeBox(length, width, thickness).Shape()
    each = _expanded(holes)
    if not each:
        return solid, 0, 0
    columns = max(1, math.ceil(math.sqrt(len(each) * length / width)))
    rows = math.ceil(len(each) / columns)
    room = min(length / columns, width / rows)
    cutters = []
    for index, (diameter, depth) in enumerate(each):
        if diameter > FIT * room:
            continue
        x = (index % columns + 0.5) * length / columns
        y = (index // columns + 0.5) * width / rows
        through = depth is None or depth >= BLIND * thickness
        start, height = (-1.0, thickness + 2.0) if through else (thickness - depth, depth + 1.0)      # a blind hole opens on the top face
        cutters.append(BRepPrimAPI_MakeCylinder(gp_Ax2(gp_Pnt(x, y, start), gp_Dir(0, 0, 1)), diameter / 2, height).Shape())
    return _cut(solid, cutters), len(cutters), len(each) - len(cutters)


def _turned(shape: Turned, holes: List[Hole]):
    """The diameter steps turned about the Z axis as one solid (hollow when there is a bore), with holes on a bolt circle in its flange."""
    from OCC.Core.BRepBuilderAPI import BRepBuilderAPI_MakeFace, BRepBuilderAPI_MakePolygon
    from OCC.Core.BRepPrimAPI import BRepPrimAPI_MakeCylinder, BRepPrimAPI_MakeRevol
    from OCC.Core.gp import gp_Ax1, gp_Ax2, gp_Dir, gp_Pnt

    radii = [s.diameter_mm / 2 for s in shape.segments]
    bore = shape.bore_diameter_mm / 2 if shape.bore_diameter_mm else 0.0
    if bore >= min(radii):
        raise ValueError("The bore is not smaller than the smallest diameter of the turned part.")
    # The half profile in the XZ plane, from the bore (or the axis) out to each step and back.
    profile = BRepBuilderAPI_MakePolygon()
    z = 0.0
    profile.Add(gp_Pnt(bore, 0, 0))
    for radius, segment in zip(radii, shape.segments):
        profile.Add(gp_Pnt(radius, 0, z))
        z += segment.length_mm
        profile.Add(gp_Pnt(radius, 0, z))
    profile.Add(gp_Pnt(bore, 0, z))
    profile.Close()
    solid = BRepPrimAPI_MakeRevol(BRepBuilderAPI_MakeFace(profile.Wire()).Face(), gp_Ax1(gp_Pnt(0, 0, 0), gp_Dir(0, 0, 1))).Shape()

    each = _expanded(holes)
    if not each:
        return solid, 0, 0
    # The flange is the largest step; its holes sit midway between its rim and the larger of its neighbours (or the bore).
    flange = max(range(len(radii)), key=lambda i: radii[i])
    inner = max([bore] + [radii[i] for i in (flange - 1, flange + 1) if 0 <= i < len(radii)])
    land = radii[flange] - inner
    circle = (radii[flange] + inner) / 2
    bottom = sum(s.length_mm for s in shape.segments[:flange])
    thickness = shape.segments[flange].length_mm
    cutters = []
    for index, (diameter, depth) in enumerate(each):
        chord = 2 * circle * math.sin(math.pi / len(each)) if len(each) > 1 else float("inf")      # room between neighbours on the circle
        if diameter > FIT * land or diameter > FIT * chord:
            continue
        angle = 2 * math.pi * index / len(each)
        through = depth is None or depth >= BLIND * thickness
        start, height = (bottom - 1.0, thickness + 2.0) if through else (bottom + thickness - depth, depth + 1.0)
        centre = gp_Pnt(circle * math.cos(angle), circle * math.sin(angle), start)
        cutters.append(BRepPrimAPI_MakeCylinder(gp_Ax2(centre, gp_Dir(0, 0, 1)), diameter / 2, height).Shape())
    return _cut(solid, cutters), len(cutters), len(each) - len(cutters)


def _cut(solid, cutters):
    if not cutters:
        return solid
    from OCC.Core.BRep import BRep_Builder
    from OCC.Core.BRepAlgoAPI import BRepAlgoAPI_Cut
    from OCC.Core.TopoDS import TopoDS_Compound

    tools = TopoDS_Compound()
    builder = BRep_Builder()
    builder.MakeCompound(tools)
    for cutter in cutters:
        builder.Add(tools, cutter)
    cut = BRepAlgoAPI_Cut(solid, tools)
    if not cut.IsDone():
        raise ValueError("The holes could not be cut into the solid.")
    return cut.Shape()


def build(request: DrawingSolidRequest):
    """The solid, how many holes it has, and how many were left out because they did not fit."""
    shape = request.shape
    if isinstance(shape, Turned):
        return _turned(shape, request.holes)
    if isinstance(shape, Block):
        return _plate(shape.length_mm, shape.width_mm, shape.height_mm, request.holes)
    return _plate(shape.length_mm, shape.width_mm, shape.thickness_mm, request.holes)


def step_bytes(solid) -> bytes:
    """The solid as a STEP file."""
    from shared.assembly import write_step

    handle, path = tempfile.mkstemp(suffix=".step")
    os.close(handle)
    try:
        write_step(solid, path)
        with open(path, "rb") as written:
            return written.read()
    finally:
        os.remove(path)
