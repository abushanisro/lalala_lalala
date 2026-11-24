"""pcb.feature_extractor: a printed circuit board's thickness, outline, holes, cutouts and the bodies on it, from OCC-built models of known size."""
import pytest

pytest.importorskip("OCC")

from OCC.Core.BRep import BRep_Builder  # noqa: E402
from OCC.Core.BRepAlgoAPI import BRepAlgoAPI_Cut  # noqa: E402
from OCC.Core.BRepPrimAPI import BRepPrimAPI_MakeBox, BRepPrimAPI_MakeCylinder  # noqa: E402
from OCC.Core.TopoDS import TopoDS_Compound  # noqa: E402
from OCC.Core.gp import gp_Ax2, gp_Dir, gp_Pnt  # noqa: E402

from pcb.feature_extractor import PcbStepFeatureExtractor  # noqa: E402


def box(x, y, z, at=(0.0, 0.0, 0.0)):
    return BRepPrimAPI_MakeBox(gp_Pnt(*at), x, y, z).Shape()


def cylinder(r, h, at=(0.0, 0.0, 0.0)):
    return BRepPrimAPI_MakeCylinder(gp_Ax2(gp_Pnt(*at), gp_Dir(0, 0, 1)), r, h).Shape()


def cut(a, b):
    return BRepAlgoAPI_Cut(a, b).Shape()


def compound(*shapes):
    c = TopoDS_Compound()
    b = BRep_Builder()
    b.MakeCompound(c)
    for s in shapes:
        b.Add(c, s)
    return c


def board(t=1.6):
    """A 100 x 80 board `t` thick: 4 mounting holes of 3.2 mm, 6 vias of 0.8 mm, a 20 x 4 mm slot."""
    b = box(100, 80, t)
    for x, y in ((5, 5), (95, 5), (5, 75), (95, 75)):
        b = cut(b, cylinder(1.6, t + 2, at=(x, y, -1)))
    for i in range(6):
        b = cut(b, cylinder(0.4, t + 2, at=(30 + 5 * i, 40, -1)))
    return cut(b, box(20, 4, t + 2, at=(60, 20, -1)))


def test_bare_board():
    f = PcbStepFeatureExtractor().extract(board())
    b = f["board"]
    assert f["extraction_version"] == "pcb-step-1"
    assert b["thickness_mm"] == pytest.approx(1.6, abs=1e-6)
    assert (b["length_mm"], b["width_mm"]) == (pytest.approx(100, abs=0.01), pytest.approx(80, abs=0.01))
    assert b["area_mm2"] == pytest.approx(8000, rel=1e-3)
    assert b["perimeter_mm"] == pytest.approx(360, abs=0.01)
    assert f["holes"] == [{"diameter_mm": 0.8, "count": 6}, {"diameter_mm": 3.2, "count": 4}]
    assert [c["perimeter_mm"] for c in f["cutouts"]] == [pytest.approx(48, abs=0.01)]
    assert f["components"] == {"top": 0, "bottom": 0}


def test_board_among_its_components():
    """An ECAD export: the board with parts standing on both sides. The board, not the model's box, is measured; the parts are counted by side."""
    t = 1.0
    parts = [box(10, 10, 3, at=(20, 20, t)), box(6, 3, 1, at=(50, 50, t)), box(30, 30, 25, at=(60, 40, t)), box(5, 5, 2, at=(40, 10, -2))]
    f = PcbStepFeatureExtractor().extract(compound(board(t), *parts))
    assert f["board"]["thickness_mm"] == pytest.approx(1.0, abs=1e-6)
    assert (f["board"]["length_mm"], f["board"]["width_mm"]) == (pytest.approx(100, abs=0.01), pytest.approx(80, abs=0.01))
    assert f["components"] == {"top": 3, "bottom": 1}
    assert sum(h["count"] for h in f["holes"]) == 10


def test_a_block_is_no_board():
    f = PcbStepFeatureExtractor().extract(box(60, 40, 30))
    assert f["board"] is None
    assert "no board found" in f["unresolved"][0]
