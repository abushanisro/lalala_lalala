"""Thread callouts in the drawing analyzer (text only): whether a callout states how many threads there are."""
from shared.drawing_analyzer import _extract_threads


def by_size(text: str) -> dict[str, dict]:
    return {t["size"]: t for t in _extract_threads(text)}


def test_a_count_before_the_size_is_stated():
    t = by_size("4 X M6X1.0 TAPPED THRU  2 X 1/4-20 UNC")
    assert (t["M6"]["count"], t["M6"]["countStated"]) == (4, True)
    assert (t["1/4-20"]["count"], t["1/4-20"]["countStated"]) == (2, True)


def test_a_size_named_alone_states_no_count():
    # R_M-0230-031 CANNULA END BEARING HOUSING: "M3" beside one hole of a pattern the 3D model taps six times. Its 1 is the
    # analyser's default, never the drawing's word, so it is not compared with the model's count.
    t = by_size("M3 TAPPED 10 DEEP  #8-32 UNC")
    assert (t["M3"]["count"], t["M3"]["countStated"]) == (1, False)
    assert (t["#8-32"]["count"], t["#8-32"]["countStated"]) == (1, False)


def test_a_later_callout_that_states_the_count_replaces_a_bare_one():
    t = by_size("SECTION A-A: M3  DETAIL B: 6 X M3 TAPPED  1/4-20  2 X 1/4-20")
    assert (t["M3"]["count"], t["M3"]["countStated"]) == (6, True)
    assert (t["1/4-20"]["count"], t["1/4-20"]["countStated"]) == (2, True)
    assert len(_extract_threads("SECTION A-A: M3  DETAIL B: 6 X M3 TAPPED")) == 1


def test_a_stated_count_is_never_overwritten_by_a_repeat():
    t = by_size("4 X M5  VIEW C: 2 X M5  M5")
    assert (t["M5"]["count"], t["M5"]["countStated"]) == (4, True)
