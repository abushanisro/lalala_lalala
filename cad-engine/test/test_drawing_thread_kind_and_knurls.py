"""Thread callouts in the drawing analyzer (text only): whether a thread is external or internal, its stated length; and knurl callouts."""
from shared.drawing_analyzer import _extract_knurls, _extract_threads


def one(text: str) -> dict:
    threads = _extract_threads(text)
    assert len(threads) == 1, threads
    return threads[0]


def test_a_small_letter_class_is_an_external_thread():
    t = one("M12x1.75-6g")
    assert (t["size"], t["pitch"], t["pitchStated"], t["toleranceClass"], t["threadKind"]) == ("M12", 1.75, True, "6g", "external")


def test_a_capital_class_is_an_internal_thread():
    t = one("M3x0.5 - 6H")
    assert (t["size"], t["toleranceClass"], t["threadKind"]) == ("M3", "6H", "internal")


def test_a_two_part_class():
    assert one("M8x1.25-4h6h")["threadKind"] == "external"
    assert one("M8x1.25-5H6H")["threadKind"] == "internal"


def test_an_all_capitals_callout_says_nothing_by_the_letter_case_except_e_and_f():
    # "M10X1.5-6G" could be a 6g printed in capitals or a 6G internal: the class is kept, the kind is not guessed.
    t = one("M10X1.5-6G")
    assert (t["toleranceClass"], t["threadKind"]) == ("6G", None)
    # Only external threads take e and f.
    assert one("M10X1.5-6E")["threadKind"] == "external"


def test_un_classes():
    a = one("1/4-20 UNC-2A")
    assert (a["size"], a["tpi"], a["toleranceClass"], a["threadKind"]) == ("1/4-20", 20, "2A", "external")
    b = one("1/4-20 UNC-2B")
    assert (b["toleranceClass"], b["threadKind"]) == ("2B", "internal")


def test_the_same_size_external_and_internal_are_two_threads():
    threads = _extract_threads("SHAFT END: M10x1.5-6g   BORE: M10x1.5-6H")
    assert [(t["size"], t["threadKind"]) for t in threads] == [("M10", "external"), ("M10", "internal")]


def test_a_stated_length():
    t = one("M12x1.75-6g x 15 LG")
    assert (t["threadKind"], t["lengthMm"], t["pitch"]) == ("external", 15.0, 1.75)


def test_a_length_is_not_read_as_the_pitch():
    t = one("M6 X 10 DEEP")
    assert (t["pitch"], t["pitchStated"], t["lengthMm"]) == (1.0, False, 10.0)


def test_words_name_the_kind_when_no_class_does():
    assert one("M6x1.0 TAPPED THRU")["threadKind"] == "internal"
    assert one("M20x1.5 EXTERNAL")["threadKind"] == "external"
    assert one("EXT THREAD M20x1.5")["threadKind"] == "external"
    # The word belongs to the callout it follows, not to the next one.
    first, second = _extract_threads("M3  DETAIL B: M5 TAPPED")
    assert (first["size"], first["threadKind"], second["size"], second["threadKind"]) == ("M3", None, "M5", "internal")


def test_a_callout_with_no_class_and_no_words_states_no_kind():
    t = one("M8")
    assert (t["toleranceClass"], t["threadKind"], t["lengthMm"], t["pitchStated"]) == (None, None, None, False)


def test_a_later_callout_names_the_kind_of_a_bare_one():
    t = one("SECTION A-A: M10  DETAIL C: M10x1.5-6g")
    assert (t["threadKind"], t["toleranceClass"], t["pitch"], t["pitchStated"]) == ("external", "6g", 1.5, True)


def knurl(text: str) -> dict:
    knurls = _extract_knurls(text)
    assert len(knurls) == 1, knurls
    return knurls[0]


def test_a_diamond_knurl_with_its_pitch():
    k = knurl("DIAMOND KNURL 0.8 P")
    assert (k["pattern"], k["grade"], k["pitchMm"], k["tpi"], k["diameterMm"], k["lengthMm"]) == ("diamond", None, 0.8, None, None, None)
    assert k["extractionSource"] == "drawing_text"


def test_a_straight_knurl_in_threads_per_inch():
    k = knurl("STRAIGHT KNURL 30 TPI")
    assert (k["pattern"], k["tpi"], k["pitchMm"]) == ("straight", 30, None)


def test_a_graded_knurl():
    k = knurl("MEDIUM DIAMOND KNURL")
    assert (k["pattern"], k["grade"], k["pitchMm"], k["tpi"]) == ("diamond", "medium", None, None)


def test_a_din_82_knurl():
    k = knurl("KNURL RGE 1.0 DIN 82")
    assert (k["pattern"], k["pitchMm"]) == ("diamond", 1.0)
    # The code alone, beside its standard.
    alone = knurl("RAA 0.8 DIN 82")
    assert (alone["pattern"], alone["pitchMm"]) == ("straight", 0.8)


def test_a_knurl_with_its_diameter_and_length():
    k = knurl("Ø20 DIAMOND KNURL 10 LG")
    assert (k["pattern"], k["diameterMm"], k["lengthMm"]) == ("diamond", 20.0, 10.0)


def test_no_knurl():
    assert _extract_knurls("M12x1.75-6g  Ø20 h7  RA 1.6") == []
    # A stray code that is not beside DIN 82 is not a knurl.
    assert _extract_knurls("REV RGE 1") == []


def test_a_repeated_callout_is_one_knurl():
    assert len(_extract_knurls("DIAMOND KNURL 0.8 P\nSEE NOTE: DIAMOND KNURL 0.8 P")) == 1
