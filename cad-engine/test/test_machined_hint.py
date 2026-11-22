"""family_hint machined: the part's Process is a machining process that is not one family (Machining). It is analysed as a machined part and
the geometry picks the family, so a shaft is not forced to milled."""
import itertools

import pytest

pytest.importorskip("OCC")

from shared.memory_optimizer import AdvancedCADMemoryOptimizer  # noqa: E402
from shared.part_family import ALL_FAMILIES, MACHINED_HINT, MACHINED_HINTS, MACHINING_FAMILIES, MILL_TURN, MILLED, SHEET_METAL, TWO_MODEL_HINT  # noqa: E402

import machined_parts as P  # noqa: E402


@pytest.fixture
def analysed(tmp_path):
    """Each analysis in a cache of its own: with no file behind the shape, the optimizer's cache key is its face, edge and vertex counts,
    which any two boxes share (and the default cache directory is shared by every test)."""
    runs = itertools.count()

    def run(shape, hint=""):
        optimizer = AdvancedCADMemoryOptimizer(cache_dir=str(tmp_path / str(next(runs))))
        return optimizer.analyze_and_optimize(shape, family_hint=hint).geometry_features.manufacturing_features["manufacturing_intelligence"]
    return run


def test_machined_is_a_hint_not_a_family():
    assert MACHINED_HINT == "machined"
    assert MACHINED_HINT not in ALL_FAMILIES
    assert MACHINED_HINTS == {MACHINED_HINT, TWO_MODEL_HINT}


def test_a_shaft_whose_process_is_machining_is_analysed_as_the_turned_part_it_is(analysed):
    shaft = P.stepped_shaft_with_cross_holes_and_keyway()
    mi = analysed(shaft, MACHINED_HINT)
    assert mi["detected_family"] == MILL_TURN == mi["geometric_family"]
    # The geometry's own verdict and confidence stand: nothing was overridden.
    assert mi["family_confidence"] == analysed(shaft)["family_confidence"]
    assert not any("family_hint" in r for r in mi["classification_reason"])
    # Naming the one family still forces it (a process costed as a single family, or the engineer's own choice).
    forced = analysed(shaft, MILLED)
    assert forced["detected_family"] == MILLED and forced["geometric_family"] == MILL_TURN
    assert "manual family_hint=milled" in forced["classification_reason"][0]


def test_a_block_whose_process_is_machining_stays_milled(analysed):
    mi = analysed(P.block_with_pocket(), MACHINED_HINT)
    assert mi["detected_family"] == MILLED == mi["geometric_family"]
    assert not any("family_hint" in r for r in mi["classification_reason"])


def test_a_part_the_geometry_reads_as_another_process_is_analysed_as_milled_and_says_so(analysed):
    # A 2 mm plate reads as sheet metal by its geometry; its Process is Machining, so it is a machined plate.
    plate = P.box((0, 0, 0), (200, 150, 2))
    assert analysed(plate)["detected_family"] == SHEET_METAL
    mi = analysed(plate, MACHINED_HINT)
    assert mi["detected_family"] == MILLED
    assert mi["geometric_family"] == SHEET_METAL
    assert mi["family_confidence"] == 1.0
    assert mi["classification_reason"][0] == "family_hint=machined: the part's Process is a machining process, analysed as milled"
    assert mi["classification_reason"][1].startswith("geometry alone reads sheet_metal")


def test_the_hint_never_becomes_the_family(analysed):
    for shape in (P.stepped_shaft_with_cross_holes_and_keyway(), P.block_with_pocket(), P.box((0, 0, 0), (200, 150, 2))):
        assert analysed(shape, MACHINED_HINT)["detected_family"] in MACHINING_FAMILIES


def test_a_two_model_part_is_treated_the_same_way_under_its_own_name(analysed):
    mi = analysed(P.box((0, 0, 0), (200, 150, 2)), TWO_MODEL_HINT)
    assert mi["detected_family"] == MILLED
    assert mi["classification_reason"][0] == "family_hint=two_model: a 2-Model Machining part is machined, analysed as milled"
    assert analysed(P.stepped_shaft_with_cross_holes_and_keyway(), TWO_MODEL_HINT)["detected_family"] == MILL_TURN
