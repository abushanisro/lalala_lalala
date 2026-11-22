"""OCC-built machined parts with known dimensions, for the turning axis and the stock envelope."""
from OCC.Core.BRepAlgoAPI import BRepAlgoAPI_Cut, BRepAlgoAPI_Fuse
from OCC.Core.BRepPrimAPI import BRepPrimAPI_MakeBox, BRepPrimAPI_MakeCylinder
from OCC.Core.gp import gp_Ax2, gp_Dir, gp_Pnt


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
