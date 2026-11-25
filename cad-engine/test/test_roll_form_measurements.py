"""
sheet_metal/features/roll_form.py: what a roll-formed sheet part is measured for, on OCC-built profiles with known sizes, through the full
production extract() (the "roll_form" key every sheet part carries).

Every profile is a strip of thickness T = 2 whose mid-line is a polyline with each corner a bend of inner radius R = 3 (mid-line radius 4),
so its numbers follow by hand: a straight of the mid-line between two bends is the polyline's side less 4 mm at each bend, a 90 deg bend's
mid-line arc is 2 pi, and the strip width is the mid-line's length (= section area / T).

  - a C channel (web 100, flanges 40, 1000 long): strip 172.57, two 90 deg bends on the web (level 1), the flats in order 35 | 90 | 35
  - a hat (feet 30, walls 40, crown 60): four bends, the crown's two at level 1 and the feet's two at level 2, turning [1, -1, -1, 1]
  - a channel deeper than its web (flanges 100, web 50): both bends at level 1 (the web is the middle of the strip, not its widest flat)
  - a Z section (directions [1, -1]) and a panel with a trapezoidal rib (four bends, [1, -1, -1, 1], the crown the web)
  - a 50 x 30 angle with 8 mm holes at z = 100, 250, 400, a 10 x 30 rectangular hole and a notch in the edge: each at its station
  - the C channel perforated along its web and flanges: the section is cut between the holes, every hole at its station
  - a closed 40 x 40 square tube: closed, four bends, the web's two at level 1 and the far two at level 2
  - the C channel swept round a 400 mm radius through 60 deg (both ways round): the curve's radius and angle, the same strip and bends,
    a hole in the curved web at its station; measured although the drawn-shell detector also takes it for a drawn shell
  - an angled and a notched end cut
  - the C channel, a hat and a closed rectangular tube with sharp corners (no bend radius), and the sharp C curved along its length: each
    corner a bend of inner radius 0 ("sharp"), the flats read at the mid-surface
  - a round tube (two half turns meeting at the seam, its wall read from its skins), a flat-oval tube and an oval ring of four arcs
  - a flat plate, a bracket folded two ways (radiused, and sharp), a drawn cup, a drawn box and a half cup: null (not a profile)
"""
import math

import pytest

pytest.importorskip("OCC")

from OCC.Core.BRepAlgoAPI import BRepAlgoAPI_Cut, BRepAlgoAPI_Fuse  # noqa: E402
from OCC.Core.BRepBuilderAPI import (  # noqa: E402
    BRepBuilderAPI_MakeEdge,
    BRepBuilderAPI_MakeFace,
    BRepBuilderAPI_MakeWire,
    BRepBuilderAPI_Transform,
)
from OCC.Core.BRepGProp import brepgprop  # noqa: E402
from OCC.Core.BRepOffsetAPI import BRepOffsetAPI_MakePipe  # noqa: E402
from OCC.Core.BRepPrimAPI import (  # noqa: E402
    BRepPrimAPI_MakeBox,
    BRepPrimAPI_MakeCylinder,
    BRepPrimAPI_MakeHalfSpace,
    BRepPrimAPI_MakePrism,
)
from OCC.Core.GC import GC_MakeArcOfCircle  # noqa: E402
from OCC.Core.GProp import GProp_GProps  # noqa: E402
from OCC.Core.ShapeUpgrade import ShapeUpgrade_UnifySameDomain  # noqa: E402
from OCC.Core.gp import gp_Ax1, gp_Ax2, gp_Dir, gp_Pln, gp_Pnt, gp_Trsf, gp_Vec  # noqa: E402

from sheet_metal.features.roll_form import VERSION  # noqa: E402
from test_drawn_shell import _box, _cup, _extract  # noqa: E402
from test_hydroform_measurements import half_cup  # noqa: E402

T = 2.0
R = 3.0
RM = R + T / 2.0  # the mid-line radius of every bend
ARC90 = math.pi / 2.0 * RM  # a 90 deg bend's mid-line arc


# ── parts ───────────────────────────────────────────────────────────────────

def _p(z):
    return gp_Pnt(z.real, z.imag, 0.0)


def _wire(edges):
    mk = BRepBuilderAPI_MakeWire()
    for e in edges:
        mk.Add(e)
    return mk.Wire()


def _edges(pieces, reverse=False):
    out = []
    for pc in (reversed(pieces) if reverse else pieces):
        if pc[0] == "line":
            a, b = (pc[2], pc[1]) if reverse else (pc[1], pc[2])
            out.append(BRepBuilderAPI_MakeEdge(_p(a), _p(b)).Edge())
        else:
            a, m, b = (pc[3], pc[2], pc[1]) if reverse else (pc[1], pc[2], pc[3])
            out.append(BRepBuilderAPI_MakeEdge(GC_MakeArcOfCircle(_p(a), _p(m), _p(b)).Value()).Edge())
    return out


def _skins(points, r_in, t, closed):
    """The two skins (left and right of travel) of a strip whose mid-line is the polyline `points`, every corner a bend of inner radius
    r_in, as lists of ("line", a, b) and ("arc", a, mid, b) pieces."""
    n = len(points)
    rm = r_in + t / 2.0
    corners = list(range(n)) if closed else list(range(1, n - 1))
    tangents = {}
    for k in corners:
        a, b, c = points[k - 1], points[k], points[(k + 1) % n]
        u1, u2 = (a - b) / abs(a - b), (c - b) / abs(c - b)
        half = math.acos(max(-1.0, min(1.0, (u1.conjugate() * u2).real))) / 2.0
        bis = (u1 + u2) / abs(u1 + u2)
        tangents[k] = (b + u1 * rm / math.tan(half), b + u2 * rm / math.tan(half), b + bis * rm / math.sin(half))
    skins = []
    for side in (1.0, -1.0):
        def off(p, q):
            return (q - p) / abs(q - p) * 1j * side * t / 2.0

        pieces = []
        prev = None if closed else points[0] + off(points[0], points[1])
        first = None
        for k in corners:
            p1, p2, centre = tangents[k]
            a, b, c = points[k - 1], points[k], points[(k + 1) % n]
            q1, q2 = p1 + off(a, b), p2 + off(b, c)
            mid = centre + (b - centre) / abs(b - centre) * abs(q1 - centre)
            if prev is None:
                first = q1
            else:
                pieces.append(("line", prev, q1))
            pieces.append(("arc", q1, mid, q2))
            prev = q2
        pieces.append(("line", prev, first if closed else points[-1] + off(points[-2], points[-1])))
        skins.append(pieces)
    return skins


def strip_section(points, r_in=R, t=T, closed=False):
    """The cross-section face (plane z = 0) of a sheet of thickness t whose mid-line is the polyline `points` [(x, y)], every corner a
    bend of inner radius r_in. closed: the polyline is a counter-clockwise loop (a tube)."""
    left, right = _skins([complex(*p) for p in points], r_in, t, closed)
    if closed:
        mk = BRepBuilderAPI_MakeFace(_wire(_edges(right)))  # turning left all the way round: the right skin is outside
        mk.Add(_wire(_edges(left, reverse=True)))
        return mk.Face()
    edges = (_edges(left) + [BRepBuilderAPI_MakeEdge(_p(left[-1][-1]), _p(right[-1][-1])).Edge()] + _edges(right, reverse=True)
             + [BRepBuilderAPI_MakeEdge(_p(right[0][1]), _p(left[0][1])).Edge()])
    return BRepBuilderAPI_MakeFace(_wire(edges)).Face()


def straight(face, length):
    return BRepPrimAPI_MakePrism(face, gp_Vec(0, 0, length)).Shape()


def cut(shape, tool):
    return BRepAlgoAPI_Cut(shape, tool).Shape()


def drill(shape, at, direction, diameter, reach=500.0):
    start = gp_Pnt(*(at[k] - direction[k] * reach / 2.0 for k in range(3)))
    return cut(shape, BRepPrimAPI_MakeCylinder(gp_Ax2(start, gp_Dir(*direction)), diameter / 2.0, reach).Shape())


def cut_box(shape, at, size):
    return cut(shape, BRepPrimAPI_MakeBox(gp_Pnt(*at), *size).Shape())


def c_section():
    """A C: web 100 wide at y = 0, flanges rising to y = 40 (outside sizes), as a mid-line."""
    h = T / 2.0
    return strip_section([(h, 40.0), (h, h), (100.0 - h, h), (100.0 - h, 40.0)])


def c_channel(length=1000.0):
    return straight(c_section(), length)


def hat():
    return straight(strip_section([(0, 0), (30, 0), (30, 40), (90, 40), (90, 0), (120, 0)]), 800.0)


def angle(length=500.0):
    return straight(strip_section([(50, 0), (0, 0), (0, 30)]), length)


def angle_with_holes():
    """The angle with 8 mm holes through the 50 mm leg at z = 100, 250, 400; a 10 x 30 rectangular hole through it at z = 305..335; and a
    notch 10 deep and 20 long out of the 30 mm leg's edge at z = 190..210."""
    s = angle()
    for z in (100.0, 250.0, 400.0):
        s = drill(s, (25.0, 0.0, z), (0, 1, 0), 8.0)
    s = cut_box(s, (20.0, -5.0, 305.0), (10.0, 10.0, 30.0))
    return cut_box(s, (-5.0, 20.0, 190.0), (10.0, 20.0, 20.0))


def square_tube():
    return straight(strip_section([(0, 0), (40, 0), (40, 40), (0, 40)], r_in=2.0, closed=True), 600.0)


def swept_c(about, r0=400.0, deg=60.0):
    """The C section swept along an arc of radius r0 through `deg`, starting at the origin along +z and turning about a line parallel to
    x (about="x": the web is bent into a cylinder) or to y (about="y": the web stays flat, the flanges are bent into cylinders)."""
    a = math.radians(deg)

    def at(f):
        c, s = r0 * math.cos(a * f) - r0, r0 * math.sin(a * f)
        return gp_Pnt(0, c, s) if about == "x" else gp_Pnt(c, 0, s)

    path = _wire([BRepBuilderAPI_MakeEdge(GC_MakeArcOfCircle(at(0.0), at(0.5), at(1.0)).Value()).Edge()])
    pipe = BRepOffsetAPI_MakePipe(path, c_section())
    pipe.Build()
    return pipe.Shape()


def c_channel_cut_ends():
    """The C channel with a 20 x 15 notch out of one flange at the z = 1000 end, and the z = 0 end cut at 30 deg from square (on a plane
    through (0, 0, 50) tilted about x: z = 50 - y tan 30)."""
    s = cut_box(c_channel(), (-5.0, 25.0, 985.0), (10.0, 20.0, 20.0))
    a = math.radians(30.0)
    plane = BRepBuilderAPI_MakeFace(gp_Pln(gp_Pnt(0, 0, 50.0), gp_Dir(0, math.sin(a), math.cos(a))), -2000, 2000, -2000, 2000).Face()
    return cut(s, BRepPrimAPI_MakeHalfSpace(plane, gp_Pnt(0, -10 * math.sin(a), 50.0 - 10 * math.cos(a))).Solid())


def corner_bracket():
    """A 100 x 100 base plate with a 30 mm flange standing on its x = 100 edge (bend along z) and on its z = 0 edge (bend along x)."""
    h = T / 2.0
    a = straight(strip_section([(0, h), (100 - h, h), (100 - h, 30)]), 100.0)
    b = straight(strip_section([(100, h), (h, h), (h, 30)]), 100.0)
    turn = gp_Trsf()
    turn.SetRotation(gp_Ax1(gp_Pnt(0, 0, 0), gp_Dir(0, 1, 0)), math.radians(-90.0))
    b = BRepBuilderAPI_Transform(b, turn, True).Shape()
    shift = gp_Trsf()
    shift.SetTranslation(gp_Vec(100.0, 0, 0))
    b = BRepBuilderAPI_Transform(b, shift, True).Shape()
    unify = ShapeUpgrade_UnifySameDomain(BRepAlgoAPI_Fuse(a, b).Shape(), True, True, True)
    unify.Build()
    return unify.Shape()


def sharp_section(points, t=T, closed=False):
    """The cross-section face (plane z = 0) of a sheet of thickness t whose mid-line is the polyline `points`, its corners sharp (mitred, no
    bend radius). closed: a counter-clockwise loop (a tube)."""
    from OCC.Core.BRepBuilderAPI import BRepBuilderAPI_MakePolygon

    pts = [complex(*p) for p in points]
    n = len(pts)

    def normal(a, b):
        return (b - a) / abs(b - a) * 1j

    def side(d):
        out = []
        for k in range(n):
            if not closed and k in (0, n - 1):
                out.append(pts[k] + d * (normal(pts[0], pts[1]) if k == 0 else normal(pts[-2], pts[-1])))
            else:
                n1, n2 = normal(pts[k - 1], pts[k]), normal(pts[k], pts[(k + 1) % n])
                out.append(pts[k] + d * (n1 + n2) / (1 + (n1.conjugate() * n2).real))
        return out

    def loop(zs):
        mk = BRepBuilderAPI_MakePolygon()
        for z in zs:
            mk.Add(gp_Pnt(z.real, z.imag, 0))
        mk.Close()
        return mk.Wire()

    left, right = side(t / 2.0), side(-t / 2.0)
    if not closed:
        return BRepBuilderAPI_MakeFace(loop(left + right[::-1])).Face()
    mk = BRepBuilderAPI_MakeFace(loop(right))  # turning left all the way round: the right skin is outside
    inner = loop(left)
    inner.Reverse()
    mk.Add(inner)
    return mk.Face()


def ring_section(outer_edges, inner_edges):
    """A closed section from its outer and inner outlines (lists of edges)."""
    mk = BRepBuilderAPI_MakeFace(_wire(outer_edges))
    inner = _wire(inner_edges)
    inner.Reverse()
    mk.Add(inner)
    return mk.Face()


def round_tube(od=50.0, wall=T, length=600.0):
    from OCC.Core.gp import gp_Circ

    ax = gp_Ax2(gp_Pnt(0, 0, 0), gp_Dir(0, 0, 1))
    return straight(ring_section([BRepBuilderAPI_MakeEdge(gp_Circ(ax, od / 2.0)).Edge()],
                                 [BRepBuilderAPI_MakeEdge(gp_Circ(ax, od / 2.0 - wall)).Edge()]), length)


def flat_oval_tube(flat=60.0, rm=15.0, t=T, length=500.0):
    """A flat-oval tube: its mid-line two straights `flat` long joined by half circles of mid-line radius rm."""
    def loop(r):
        def q(x, y):
            return gp_Pnt(x, y, 0)
        return [BRepBuilderAPI_MakeEdge(q(0, -r), q(flat, -r)).Edge(),
                BRepBuilderAPI_MakeEdge(GC_MakeArcOfCircle(q(flat, -r), q(flat + r, 0), q(flat, r)).Value()).Edge(),
                BRepBuilderAPI_MakeEdge(q(flat, r), q(0, r)).Edge(),
                BRepBuilderAPI_MakeEdge(GC_MakeArcOfCircle(q(0, r), q(-r, 0), q(0, -r)).Value()).Edge()]
    return straight(ring_section(loop(rm + t / 2.0), loop(rm - t / 2.0)), length)


# The four-arc oval: side arcs of mid-line radius 60 about (0, -/+30), end arcs of radius 20 about (+/-C, 0), tangent where they meet.
ARC_R1, ARC_R2, ARC_D = 60.0, 20.0, 30.0
ARC_C = math.sqrt((ARC_R1 - ARC_R2) ** 2 - ARC_D ** 2)
ARC_A = math.atan2(ARC_D, ARC_C)  # the tangent points' direction from the side arcs' centres


def arc_ring_tube(t=T, length=400.0):
    """A closed ring of four arcs and no flat (an oval rolled from strip)."""
    def loop(off):
        r1, r2, a = ARC_R1 + off, ARC_R2 + off, ARC_A

        def on(cx, cy, r, ang):
            return gp_Pnt(cx + r * math.cos(ang), cy + r * math.sin(ang), 0)

        def arc(cx, cy, r, a0, a1):
            return BRepBuilderAPI_MakeEdge(GC_MakeArcOfCircle(on(cx, cy, r, a0), on(cx, cy, r, (a0 + a1) / 2), on(cx, cy, r, a1)).Value()).Edge()
        return [arc(0, -ARC_D, r1, a, math.pi - a), arc(-ARC_C, 0, r2, math.pi - a, math.pi + a),
                arc(0, ARC_D, r1, math.pi + a, 2 * math.pi - a), arc(ARC_C, 0, r2, -a, a)]
    return straight(ring_section(loop(t / 2.0), loop(-t / 2.0)), length)


SHARP_C = [(1.0, 40.0), (1.0, 1.0), (99.0, 1.0), (99.0, 40.0)]  # the C channel's mid-line with sharp corners: flats 39 | 98 | 39


def sharp_swept_c(r0=400.0, deg=60.0):
    """The sharp-cornered C swept round r0 through `deg` (its web bent into a cylinder), as swept_c("x")."""
    a = math.radians(deg)

    def at(f):
        return gp_Pnt(0, r0 * math.cos(a * f) - r0, r0 * math.sin(a * f))
    path = _wire([BRepBuilderAPI_MakeEdge(GC_MakeArcOfCircle(at(0.0), at(0.5), at(1.0)).Value()).Edge()])
    pipe = BRepOffsetAPI_MakePipe(path, sharp_section(SHARP_C))
    pipe.Build()
    return pipe.Shape()


def sharp_corner_bracket():
    """A 100 x 100 x 2 base with sharp-cornered 30 mm flanges on two adjacent edges (three boxes fused): folded two ways."""
    a = BRepPrimAPI_MakeBox(gp_Pnt(0, 0, 0), 100, 2, 100).Shape()
    b = BRepPrimAPI_MakeBox(gp_Pnt(98, 0, 0), 2, 30, 100).Shape()
    c = BRepPrimAPI_MakeBox(gp_Pnt(0, 0, 0), 100, 30, 2).Shape()
    unify = ShapeUpgrade_UnifySameDomain(BRepAlgoAPI_Fuse(BRepAlgoAPI_Fuse(a, b).Shape(), c).Shape(), True, True, True)
    unify.Build()
    return unify.Shape()


def _rf(shape):
    result = _extract(shape)
    return result, result["roll_form"]


def _volume(shape):
    props = GProp_GProps()
    brepgprop.VolumeProperties(shape, props)
    return props.Mass()


def _seq(rf):
    return [b["flange_before_mm"] for b in rf["bends"]], rf["last_flange_mm"]


# ── straight profiles ───────────────────────────────────────────────────────

def test_c_channel_strip_bends_and_levels():
    shape = c_channel()
    result, rf = _rf(shape)
    assert rf["version"] == VERSION == "rf_v3"
    assert [abs(c) for c in rf["axis"]] == [0.0, 0.0, 1.0] and rf["axis_source"] == "bends"
    assert rf["length_mm"] == pytest.approx(1000.0, abs=0.01)
    assert rf["constant_section"] is True and rf["stock_fraction"] > 0.99
    assert rf["curve"] is None and rf["features"] == []
    assert rf["thickness_mm"] == pytest.approx(T)

    # Mid-line: web 100 - 2 x 5 = 90 between the bends, flanges 40 - 5 = 35, two 90 deg arcs at radius 4.
    strip = 90.0 + 2 * 35.0 + 2 * ARC90
    assert rf["strip_width_mm"] == pytest.approx(strip, abs=0.02)
    assert rf["strip_width_mm"] == pytest.approx(_volume(shape) / 1000.0 / T, abs=0.02)
    # At the neutral fibre (K 0.33, R < 2T): the extractor's own unfolded blank width.
    neutral = 90.0 + 70.0 + 2 * math.pi / 2 * (R + 0.33 * T)
    assert rf["strip_width_neutral_mm"] == pytest.approx(neutral, abs=0.02)
    assert rf["strip_width_neutral_mm"] == pytest.approx(result["flat_pattern_area_mm2"] / 1000.0, abs=0.05)
    assert rf["strip_width_check"] == {"flats_mm": pytest.approx(160.0, abs=0.01), "bend_arcs_mm": pytest.approx(2 * ARC90, abs=0.01),
                                       "agrees": True}

    sec = rf["section"]
    assert sec["width_mm"] == pytest.approx(100.0, abs=0.01) and sec["height_mm"] == pytest.approx(40.0, abs=0.01)
    assert sec["area_mm2"] == pytest.approx(strip * T, abs=0.05)
    assert sec["closed"] is False

    assert [b["angle_deg"] for b in rf["bends"]] == [90.0, 90.0]
    assert [b["inner_radius_mm"] for b in rf["bends"]] == [R, R]
    assert [b["sharp"] for b in rf["bends"]] == [False, False]
    assert [b["level"] for b in rf["bends"]] == [1, 1]
    assert [b["direction"] for b in rf["bends"]] == [1, 1]  # both turn the same way
    assert _seq(rf) == ([pytest.approx(35.0, abs=0.01), pytest.approx(90.0, abs=0.01)], pytest.approx(35.0, abs=0.01))
    assert all(len(b["face_ids"]) == 2 for b in rf["bends"])  # inner and outer skin
    assert rf["tube"] is None

    assert [(e["end"], e["kind"]) for e in rf["ends"]] == [("start", "square"), ("end", "square")]
    for e in rf["ends"]:
        assert e["cut_perimeter_mm"] == pytest.approx(strip, abs=0.05)  # a square cut runs the strip width
        assert len(e["face_ids"]) == 1


def test_hat_section_levels_one_and_two():
    _result, rf = _rf(hat())
    # Feet 30 - 4 = 26, walls 40 - 8 = 32, crown 60 - 8 = 52; four 90 deg arcs.
    assert rf["strip_width_mm"] == pytest.approx(2 * 26 + 2 * 32 + 52 + 4 * ARC90, abs=0.02)
    assert len(rf["bends"]) == 4
    assert [b["level"] for b in rf["bends"]] == [2, 1, 1, 2]  # the crown (the middle of the strip) is the web
    assert [b["direction"] for b in rf["bends"]] == [1, -1, -1, 1]
    flats, last = _seq(rf)
    assert flats == [pytest.approx(x, abs=0.01) for x in (26, 32, 52, 32)] and last == pytest.approx(26, abs=0.01)
    assert rf["section"]["width_mm"] == pytest.approx(120.0, abs=0.01) and rf["section"]["height_mm"] == pytest.approx(42.0, abs=0.01)
    assert rf["constant_section"] is True


def test_a_channel_deeper_than_its_web_is_formed_from_its_web():
    # Flanges 100, web 50: the web (40 between the bends) is narrower than the flanges (95), but it is the middle of the strip.
    h = T / 2.0
    _result, rf = _rf(straight(strip_section([(h, 100.0), (h, h), (50.0 - h, h), (50.0 - h, 100.0)]), 600.0))
    assert [b["level"] for b in rf["bends"]] == [1, 1] and [b["direction"] for b in rf["bends"]] == [1, 1]
    assert _seq(rf) == ([pytest.approx(95.0, abs=0.01), pytest.approx(40.0, abs=0.01)], pytest.approx(95.0, abs=0.01))
    # Width along the web, height across it: the section as it runs through the mill, web down.
    assert rf["section"]["width_mm"] == pytest.approx(50.0, abs=0.01) and rf["section"]["height_mm"] == pytest.approx(100.0, abs=0.01)


def test_z_section_bends_turn_opposite_ways():
    _result, rf = _rf(straight(strip_section([(0, 40), (0, 0), (60, 0), (60, -40)]), 700.0))
    assert [b["level"] for b in rf["bends"]] == [1, 1]
    assert [b["direction"] for b in rf["bends"]] == [1, -1]
    assert _seq(rf) == ([pytest.approx(36.0, abs=0.01), pytest.approx(52.0, abs=0.01)], pytest.approx(36.0, abs=0.01))


def test_a_rib_pressed_in_a_panel():
    # A 160 mm panel with a trapezoidal rib 15 high in its middle (walls rising 15 over 10): four bends of atan(15/10), the two at the rib's
    # foot turning one way and the two at its crown the other; the crown is the middle of the strip.
    _result, rf = _rf(straight(strip_section([(0, 0), (60, 0), (70, 15), (90, 15), (100, 0), (160, 0)]), 600.0))
    assert [b["direction"] for b in rf["bends"]] == [1, -1, -1, 1]
    assert [b["level"] for b in rf["bends"]] == [2, 1, 1, 2]
    turn = math.atan2(15.0, 10.0)
    assert [b["angle_deg"] for b in rf["bends"]] == [pytest.approx(math.degrees(turn), abs=0.01)] * 4
    run = RM * math.tan(turn / 2.0)  # each bend's tangent run along its flats
    flats, last = _seq(rf)
    assert flats == [pytest.approx(x, abs=0.01) for x in (60 - run, math.hypot(10, 15) - 2 * run, 20 - 2 * run, math.hypot(10, 15) - 2 * run)]
    assert last == pytest.approx(60 - run, abs=0.01)


def test_angle_with_holes_at_known_stations():
    _result, rf = _rf(angle_with_holes())
    assert rf["constant_section"] is True and rf["length_mm"] == pytest.approx(500.0, abs=0.01)
    assert len(rf["bends"]) == 1 and rf["bends"][0]["level"] == 1 and rf["bends"][0]["direction"] == 1
    # Listed from the narrower leg: 30 - 4 = 26, then 50 - 4 = 46.
    assert _seq(rf) == ([pytest.approx(26.0, abs=0.01)], pytest.approx(46.0, abs=0.01))
    assert rf["strip_width_mm"] == pytest.approx(26 + 46 + ARC90, abs=0.02)

    feats = rf["features"]
    holes = [f for f in feats if f["feature_type"] == "SimpleHole"]
    assert [h["station_mm"] for h in holes] == [pytest.approx(z, abs=0.01) for z in (100.0, 250.0, 400.0)]
    for h in holes:
        assert h["size_mm"] == pytest.approx(8.0, abs=0.01)
        assert h["area_mm2"] == pytest.approx(math.pi * 16, abs=0.1)
        assert h["perimeter_mm"] == pytest.approx(8 * math.pi, abs=0.02)
        assert h["depth_mm"] is None
    (rect,) = [f for f in feats if f["feature_type"] == "ComplexHole"]
    assert rect["station_mm"] == pytest.approx(320.0, abs=0.01)
    assert rect["size_mm"] == pytest.approx(30.0, abs=0.01)
    assert rect["area_mm2"] == pytest.approx(300.0, abs=0.1) and rect["perimeter_mm"] == pytest.approx(80.0, abs=0.01)
    (notch,) = [f for f in feats if f["feature_type"] == "Cutout"]
    assert notch["station_mm"] == pytest.approx(200.0, abs=0.01)
    assert notch["size_mm"] == pytest.approx(20.0, abs=0.01)
    assert notch["area_mm2"] == pytest.approx(200.0, abs=0.1) and notch["perimeter_mm"] == pytest.approx(40.0, abs=0.01)
    assert [f["station_mm"] for f in feats] == sorted(f["station_mm"] for f in feats)
    assert all(e["kind"] == "square" for e in rf["ends"])


def perforated_channel():
    """The C channel with 6 mm holes through the web every 16 mm from z = 20 (60 of them: one at mid-length, and at 0.31 and 0.69 of it) and
    5 mm holes through both flanges every 24 mm from z = 30 (40 each)."""
    from OCC.Core.TopTools import TopTools_ListOfShape

    tools = TopTools_ListOfShape()
    for k in range(60):
        tools.Append(BRepPrimAPI_MakeCylinder(gp_Ax2(gp_Pnt(50, -10, 20 + 16 * k), gp_Dir(0, 1, 0)), 3.0, 20).Shape())
    for k in range(40):
        tools.Append(BRepPrimAPI_MakeCylinder(gp_Ax2(gp_Pnt(-10, 25, 30 + 24 * k), gp_Dir(1, 0, 0)), 2.5, 120).Shape())
    args = TopTools_ListOfShape()
    args.Append(c_channel())
    op = BRepAlgoAPI_Cut()
    op.SetArguments(args)
    op.SetTools(tools)
    op.Build()
    return op.Shape()


def test_a_perforated_channel_is_cut_between_its_holes():
    # Holes at mid-length and at 0.31 and 0.69 of it: the section is cut in a gap between features, not through a hole.
    _result, rf = _rf(perforated_channel())
    assert rf["constant_section"] is True
    assert rf["section"]["area_mm2"] == pytest.approx((90.0 + 70.0 + 2 * ARC90) * T, abs=0.05)
    assert [b["level"] for b in rf["bends"]] == [1, 1]
    holes = rf["features"]
    assert len(holes) == 140 and all(h["feature_type"] == "SimpleHole" for h in holes)
    web = sorted(h["station_mm"] for h in holes if h["size_mm"] == 6.0)
    assert web == [pytest.approx(20 + 16 * k, abs=0.01) for k in range(60)]
    assert sum(1 for h in holes if h["size_mm"] == 5.0) == 80


def test_closed_square_tube():
    _result, rf = _rf(square_tube())
    sec = rf["section"]
    assert sec["closed"] is True and sec["stock_form"] == "SQUARE_TUBE"
    assert sec["width_mm"] == pytest.approx(42.0, abs=0.01) and sec["height_mm"] == pytest.approx(42.0, abs=0.01)
    # Four flats of 40 - 2 x 3 = 34 and four 90 deg arcs at the mid-line radius 2 + 1.
    assert rf["strip_width_mm"] == pytest.approx(4 * 34 + 4 * math.pi / 2 * 3, abs=0.02)
    assert [b["inner_radius_mm"] for b in rf["bends"]] == [2.0] * 4
    # From the web round the tube: its two bends at level 1, the far two at level 2; every flat counted once.
    assert [b["level"] for b in rf["bends"]] == [1, 2, 2, 1]
    flats, last = _seq(rf)
    assert flats == [pytest.approx(34.0, abs=0.01)] * 4 and last == 0.0
    assert [e["cut_perimeter_mm"] for e in rf["ends"]] == [pytest.approx(rf["strip_width_mm"], abs=0.05)] * 2


def test_angled_and_notched_end_cuts():
    _result, rf = _rf(c_channel_cut_ends())
    start, end = rf["ends"]
    assert start["end"] == "start" and start["kind"] == "angled" and start["cut_angle_deg"] == pytest.approx(30.0, abs=0.01)
    assert end["end"] == "end" and end["kind"] == "notched" and len(end["face_ids"]) == 3
    # From the cut's lowest point (z = 50 - 40 tan 30, the flange tips) to z = 1000.
    assert rf["length_mm"] == pytest.approx(1000.0 - (50.0 - 40.0 * math.tan(math.radians(30.0))), abs=0.01)
    assert rf["constant_section"] is True and rf["features"] == []


# ── profiles modelled without bend radii ────────────────────────────────────
# Each corner is sharp: the flats meet at an edge. A flat is read at the mid-surface (the mean of its skins, which differ by t tan(angle/2)
# at a sharp corner), so the flats add up to the strip; the neutral fibre bends about the inner corner (K 0.33).

def _sharp_neutral(strip, corners_deg):
    return strip + sum(math.radians(a) * 0.33 * T - T * math.tan(math.radians(a) / 2.0) for a in corners_deg)


def test_sharp_cornered_c_channel():
    _result, rf = _rf(straight(sharp_section(SHARP_C), 1000.0))
    assert rf["axis_source"] == "bends" and [abs(c) for c in rf["axis"]] == [0.0, 0.0, 1.0]
    assert rf["constant_section"] is True and rf["length_mm"] == pytest.approx(1000.0, abs=0.01)
    assert rf["strip_width_mm"] == pytest.approx(39 + 98 + 39, abs=0.01)
    assert rf["strip_width_check"] == {"flats_mm": pytest.approx(176.0, abs=0.01), "bend_arcs_mm": 0.0, "agrees": True}
    assert rf["strip_width_neutral_mm"] == pytest.approx(_sharp_neutral(176.0, [90, 90]), abs=0.02)
    assert [(b["angle_deg"], b["inner_radius_mm"], b["sharp"], b["level"], b["face_ids"]) for b in rf["bends"]] == [
        (90.0, 0.0, True, 1, []), (90.0, 0.0, True, 1, [])]  # a sharp corner has no face of its own
    assert _seq(rf) == ([pytest.approx(39.0, abs=0.01), pytest.approx(98.0, abs=0.01)], pytest.approx(39.0, abs=0.01))
    sec = rf["section"]
    assert sec["width_mm"] == pytest.approx(100.0, abs=0.01) and sec["height_mm"] == pytest.approx(40.0, abs=0.01)
    assert sec["area_mm2"] == pytest.approx(176.0 * T, abs=0.01) and sec["closed"] is False
    assert [e["cut_perimeter_mm"] for e in rf["ends"]] == [pytest.approx(176.0, abs=0.01)] * 2


def test_sharp_cornered_hat():
    _result, rf = _rf(straight(sharp_section([(0, 0), (30, 0), (30, 40), (90, 40), (90, 0), (120, 0)]), 800.0))
    assert rf["strip_width_mm"] == pytest.approx(30 + 40 + 60 + 40 + 30, abs=0.01)
    assert [b["level"] for b in rf["bends"]] == [2, 1, 1, 2] and all(b["sharp"] for b in rf["bends"])
    assert [b["direction"] for b in rf["bends"]] == [1, -1, -1, 1]
    assert [b["angle_deg"] for b in rf["bends"]] == [90.0] * 4
    flats, last = _seq(rf)
    assert flats == [pytest.approx(x, abs=0.01) for x in (30, 40, 60, 40)] and last == pytest.approx(30.0, abs=0.01)
    assert rf["strip_width_neutral_mm"] == pytest.approx(_sharp_neutral(200.0, [90] * 4), abs=0.02)


def test_sharp_cornered_closed_rectangular_tube():
    _result, rf = _rf(straight(sharp_section([(0, 0), (60, 0), (60, 40), (0, 40)], closed=True), 600.0))
    sec = rf["section"]
    assert sec["closed"] is True and sec["stock_form"] == "RECTANGULAR_TUBE"
    assert rf["strip_width_mm"] == pytest.approx(2 * 60 + 2 * 40, abs=0.01)
    # From the web (a 60 mm side) round the tube: every corner sharp, every flat counted once.
    assert [b["level"] for b in rf["bends"]] == [1, 2, 2, 1] and all(b["sharp"] for b in rf["bends"])
    flats, last = _seq(rf)
    assert flats == [pytest.approx(x, abs=0.01) for x in (60, 40, 60, 40)] and last == 0.0
    assert rf["tube"] == {"outer_diameter_mm": None, "outer_width_mm": pytest.approx(62.0, abs=0.01),
                          "outer_height_mm": pytest.approx(42.0, abs=0.01), "wall_mm": pytest.approx(T, abs=0.001)}


def test_sharp_cornered_channel_curved_along_its_length():
    _result, rf = _rf(sharp_swept_c())
    props = GProp_GProps()
    brepgprop.SurfaceProperties(sharp_section(SHARP_C), props)
    radius = 400.0 + props.CentreOfMass().Y()
    assert rf["axis_source"] == "curve"
    assert rf["curve"]["radius_mm"] == pytest.approx(radius, abs=0.01) and rf["curve"]["angle_deg"] == pytest.approx(60.0, abs=0.01)
    assert rf["length_mm"] == pytest.approx(radius * math.pi / 3.0, abs=0.02)
    assert rf["strip_width_mm"] == pytest.approx(176.0, abs=0.01)
    assert [(b["angle_deg"], b["sharp"], b["level"]) for b in rf["bends"]] == [(90.0, True, 1), (90.0, True, 1)]
    assert [e["kind"] for e in rf["ends"]] == ["square", "square"] and rf["features"] == []


# ── tubes with no flat ──────────────────────────────────────────────────────

def test_round_tube_two_half_turns_meeting_at_the_seam():
    result, rf = _rf(round_tube())
    # No flats: the extractor has no faces to read a thickness between (its sheet_thickness_mm is a fallback); the tube's wall is read from
    # its concentric skins.
    assert rf["thickness_mm"] == pytest.approx(T, abs=0.001)
    sec = rf["section"]
    assert sec["closed"] is True and sec["stock_form"] == "ROUND_TUBE"
    assert rf["tube"] == {"outer_diameter_mm": pytest.approx(50.0, abs=0.01), "outer_width_mm": pytest.approx(50.0, abs=0.01),
                          "outer_height_mm": pytest.approx(50.0, abs=0.01), "wall_mm": pytest.approx(T, abs=0.001)}
    assert rf["strip_width_mm"] == pytest.approx(math.pi * (50.0 - T), abs=0.02)  # the mid-line circumference
    assert [(b["angle_deg"], b["inner_radius_mm"], b["sharp"], b["flange_before_mm"], b["level"]) for b in rf["bends"]] == [
        (180.0, 23.0, False, 0.0, 1), (180.0, 23.0, False, 0.0, 1)]
    assert rf["last_flange_mm"] == 0.0
    assert rf["constant_section"] is True and rf["length_mm"] == pytest.approx(600.0, abs=0.01)
    assert [e["cut_perimeter_mm"] for e in rf["ends"]] == [pytest.approx(math.pi * 48.0, abs=0.05)] * 2


def test_flat_oval_tube():
    _result, rf = _rf(flat_oval_tube())
    assert rf["section"]["closed"] is True
    assert rf["strip_width_mm"] == pytest.approx(2 * 60.0 + 2 * math.pi * 15.0, abs=0.02)
    assert [(b["angle_deg"], b["inner_radius_mm"], b["level"]) for b in rf["bends"]] == [(180.0, 14.0, 1), (180.0, 14.0, 1)]
    flats, last = _seq(rf)
    assert flats == [pytest.approx(60.0, abs=0.01)] * 2 and last == 0.0
    assert rf["tube"] == {"outer_diameter_mm": None, "outer_width_mm": pytest.approx(92.0, abs=0.01),
                          "outer_height_mm": pytest.approx(32.0, abs=0.01), "wall_mm": pytest.approx(T, abs=0.001)}


def test_oval_ring_of_arcs():
    _result, rf = _rf(arc_ring_tube())
    assert rf["thickness_mm"] == pytest.approx(T, abs=0.001) and rf["section"]["closed"] is True
    side, end = math.pi - 2 * ARC_A, 2 * ARC_A  # the arcs' angles
    assert rf["strip_width_mm"] == pytest.approx(2 * ARC_R1 * side + 2 * ARC_R2 * end, abs=0.05)
    angles = sorted(b["angle_deg"] for b in rf["bends"])
    assert angles == [pytest.approx(math.degrees(x), abs=0.01) for x in (side, side, end, end)]
    assert sorted(b["inner_radius_mm"] for b in rf["bends"]) == [ARC_R2 - 1, ARC_R2 - 1, ARC_R1 - 1, ARC_R1 - 1]
    assert all(b["level"] == 1 and b["flange_before_mm"] == 0.0 for b in rf["bends"]) and rf["last_flange_mm"] == 0.0


# ── curved profiles ─────────────────────────────────────────────────────────

def _section_centroid():
    props = GProp_GProps()
    brepgprop.SurfaceProperties(c_section(), props)
    c = props.CentreOfMass()
    return c.X(), c.Y()


def test_channel_curved_with_its_web_flat():
    result, rf = _rf(swept_c("y"))
    # The drawn-shell detector takes the twinned tori for a drawn form; the roll-forming measurement does not depend on that verdict.
    assert result["drawn_shell"] is not None
    assert rf["axis_source"] == "curve"
    curve = rf["curve"]
    assert curve["angle_deg"] == pytest.approx(60.0, abs=0.01)
    assert curve["radius_mm"] == pytest.approx(400.0 + _section_centroid()[0], abs=0.01)  # the section centroid, 50 mm out
    assert curve["radius_mm"] == pytest.approx(450.0, abs=0.01)
    assert [abs(c) for c in curve["axis"]] == [0.0, 1.0, 0.0]
    assert rf["length_mm"] == pytest.approx(450.0 * math.pi / 3.0, abs=0.02)
    assert rf["constant_section"] is True
    assert rf["strip_width_mm"] == pytest.approx(90.0 + 70.0 + 2 * ARC90, abs=0.02)
    assert [b["level"] for b in rf["bends"]] == [1, 1] and [b["angle_deg"] for b in rf["bends"]] == [90.0, 90.0]
    assert _seq(rf) == ([pytest.approx(35.0, abs=0.01), pytest.approx(90.0, abs=0.01)], pytest.approx(35.0, abs=0.01))
    assert [e["kind"] for e in rf["ends"]] == ["square", "square"]


def test_channel_curved_with_its_web_bent_and_a_hole_at_its_station():
    shape = swept_c("x")
    a = math.radians(30.0)
    shape = drill(shape, (50.0, -400 + 401 * math.cos(a), 401 * math.sin(a)), (0, math.cos(a), math.sin(a)), 10.0, reach=20.0)
    _result, rf = _rf(shape)
    radius = 400.0 + _section_centroid()[1]
    assert rf["curve"]["radius_mm"] == pytest.approx(radius, abs=0.01)
    assert rf["curve"]["angle_deg"] == pytest.approx(60.0, abs=0.01)
    assert rf["length_mm"] == pytest.approx(radius * math.pi / 3.0, abs=0.02)
    assert rf["section"]["width_mm"] == pytest.approx(100.0, abs=0.01) and rf["section"]["height_mm"] == pytest.approx(40.0, abs=0.01)
    assert rf["strip_width_mm"] == pytest.approx(90.0 + 70.0 + 2 * ARC90, abs=0.02)
    assert [b["inner_radius_mm"] for b in rf["bends"]] == [R, R]
    (hole,) = rf["features"]
    assert hole["feature_type"] == "SimpleHole" and hole["size_mm"] == pytest.approx(10.0, abs=0.01)
    assert hole["station_mm"] == pytest.approx(radius * math.pi / 6.0, abs=0.05)  # half way round


# ── not profiles ────────────────────────────────────────────────────────────

@pytest.mark.parametrize("make", [
    lambda: BRepPrimAPI_MakeBox(300, 100, 2).Shape(),  # a flat plate
    corner_bracket,  # folded two ways
    _cup,  # drawn: revolved about its axis, but reaching it
    _box,  # drawn: radii three ways
    half_cup,  # a flange round half a disc: open, but the disc reaches the axis
    sharp_corner_bracket,  # folded two ways, with sharp corners
], ids=["flat-plate", "corner-bracket", "drawn-cup", "drawn-box", "half-cup", "sharp-corner-bracket"])
def test_parts_that_are_not_profiles_measure_null(make):
    result, rf = _rf(make())
    assert "roll_form" in result and rf is None
