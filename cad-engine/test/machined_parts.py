"""OCC-built machined parts with known dimensions, for the turning axis and the stock envelope."""
import math

from OCC.Core.BRepAlgoAPI import BRepAlgoAPI_Cut, BRepAlgoAPI_Fuse
from OCC.Core.BRepBuilderAPI import BRepBuilderAPI_MakeFace, BRepBuilderAPI_MakePolygon, BRepBuilderAPI_Transform
from OCC.Core.BRepPrimAPI import BRepPrimAPI_MakeBox, BRepPrimAPI_MakeCone, BRepPrimAPI_MakeCylinder, BRepPrimAPI_MakePrism
from OCC.Core.gp import gp_Ax1, gp_Ax2, gp_Dir, gp_Pnt, gp_Trsf, gp_Vec


def cylinder(at, direction, diameter, length):
    return BRepPrimAPI_MakeCylinder(gp_Ax2(gp_Pnt(*at), gp_Dir(*direction)), diameter / 2.0, length).Shape()


def box(at, size):
    return BRepPrimAPI_MakeBox(gp_Pnt(*at), *size).Shape()


def cut(shape, tool):
    return BRepAlgoAPI_Cut(shape, tool).Shape()


def fuse(a, b):
    return BRepAlgoAPI_Fuse(a, b).Shape()


# The stepped shaft below, along X from 0 to SHAFT_LENGTH.
SHAFT_LENGTH = 40.0
SHAFT_DIAMETERS = (12.0, 20.0)
SHAFT_BORE = 6.0
SHAFT_CROSS_HOLES_X = (6.0, 10.0, 14.0)


def stepped_shaft_with_cross_holes_and_keyway():
    """
    A shaft along X: Ø12 x 30 then a Ø20 x 10 collar, a Ø6 bore through its whole length, three Ø3 cross holes along Y through the Ø12 (each
    cut in two by the bore: six cross-hole faces against three faces along the axis) and a 4 wide x 10 long keyway 2 deep in the top of the
    Ø12. The proportions of the real shaft the turning axis was fixed on: 2 diameters long, so neither a disc nor a rod to the bounding box.
    """
    shaft = fuse(cylinder((0, 0, 0), (1, 0, 0), SHAFT_DIAMETERS[0], 30.0), cylinder((30, 0, 0), (1, 0, 0), SHAFT_DIAMETERS[1], 10.0))
    shaft = cut(shaft, cylinder((-1, 0, 0), (1, 0, 0), SHAFT_BORE, SHAFT_LENGTH + 2.0))
    for x in SHAFT_CROSS_HOLES_X:
        shaft = cut(shaft, cylinder((x, -50, 0), (0, 1, 0), 3.0, 100.0))
    return cut(shaft, box((18, -2, 4), (10, 4, 5)))


def rotated(shape, about, degrees):
    """The shape turned about a model axis through the origin."""
    t = gp_Trsf()
    t.SetRotation(gp_Ax1(gp_Pnt(0, 0, 0), gp_Dir(*about)), math.radians(degrees))
    return BRepBuilderAPI_Transform(shape, t, True).Shape()


def block_with_pocket():
    """An 80 x 50 x 30 block (X, Y, Z from the origin) with a 40 x 20 pocket 10 deep in its top."""
    return cut(box((0, 0, 0), (80, 50, 30)), box((20, 15, 20), (40, 20, 20)))


def hex_bar_with_bore(across_flats=20.0, length=50.0, bore=8.0):
    """A hexagon bar along X, flats at z = +/- across_flats / 2, with a bore through its whole length."""
    r = across_flats / math.sqrt(3.0)   # centre to corner
    mk = BRepBuilderAPI_MakePolygon()
    for k in range(6):
        mk.Add(gp_Pnt(0.0, r * math.cos(math.radians(60 * k)), r * math.sin(math.radians(60 * k))))
    mk.Close()
    bar = BRepPrimAPI_MakePrism(BRepBuilderAPI_MakeFace(mk.Wire()).Face(), gp_Vec(length, 0, 0)).Shape()
    return cut(bar, cylinder((-1, 0, 0), (1, 0, 0), bore, length + 2.0))


def bushing(od=30.0, bore=18.0, length=25.0):
    """A bushing along Z from the origin."""
    return cut(cylinder((0, 0, 0), (0, 0, 1), od, length), cylinder((0, 0, -1), (0, 0, 1), bore, length + 2.0))


def stepped_bushing():
    """A Ø30 x 25 bushing along Z whose bore is Ø18 for 15 then Ø12 for the last 10."""
    body = cut(cylinder((0, 0, 0), (0, 0, 1), 30.0, 25.0), cylinder((0, 0, -1), (0, 0, 1), 18.0, 16.0))
    return cut(body, cylinder((0, 0, 14), (0, 0, 1), 12.0, 12.0))


def shaft_with_d_bore():
    """A Ø20 x 40 shaft along X with a Ø10 bore that has a flat 3 mm from its axis (a D bore): the round that passes it is Ø6."""
    hole = cut(cylinder((-1, 0, 0), (1, 0, 0), 10.0, 42.0), box((-2, -10, 3), (44, 20, 10)))
    return cut(cylinder((0, 0, 0), (1, 0, 0), 20.0, 40.0), hole)


def plate_with_holes():
    """A 200 x 120 x 6 plate with four Ø8 holes."""
    plate = box((0, 0, 0), (200, 120, 6))
    for x, y in ((20, 20), (180, 20), (20, 100), (180, 100)):
        plate = cut(plate, cylinder((x, y, -1), (0, 0, 1), 8.0, 8.0))
    return plate


def spindle():
    """Two Ø20 cones base to base along X, 60 long: no flat end, no cylinder, no flat side."""
    a = BRepPrimAPI_MakeCone(gp_Ax2(gp_Pnt(0, 0, 0), gp_Dir(1, 0, 0)), 0.0, 10.0, 30.0).Shape()
    b = BRepPrimAPI_MakeCone(gp_Ax2(gp_Pnt(30, 0, 0), gp_Dir(1, 0, 0)), 10.0, 0.0, 30.0).Shape()
    return fuse(a, b)


def plate_with_hub():
    """A 60 x 60 x 10 plate with a Ø20 x 10 hub on the middle of its top: a turned diameter on a part that is no round bar."""
    return fuse(box((-30, -30, 0), (60, 60, 10)), cylinder((0, 0, 10), (0, 0, 1), 20.0, 10.0))

