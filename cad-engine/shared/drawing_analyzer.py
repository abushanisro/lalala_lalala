"""
Drawing Analysis Service  —  POST /drawing/analyze

Pure library extraction — no AI, no API calls, no network required.

Strategy:
  1. PyMuPDF "blocks" mode: each text block with (x,y) coordinates.
  2. Title-block key-value pairs resolved by spatial proximity.
     Correctly handles SolidWorks/AutoCAD PDF title blocks where:
       - Label and value cells share a border (x can overlap slightly)
       - Multi-line value cells (take first line as primary value)
       - Label cells must be excluded from value candidates
  3. Flat-text regex catches anything spatial matching misses.
  4. Placeholder detection ("X.XX", "TBD", dashes) → "Not specified".
"""

from __future__ import annotations

import base64
import logging
import re
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

logger = logging.getLogger(__name__)
router = APIRouter()


# ─── Known title-block labels ─────────────────────────────────────────────────
# Used both to FIND label cells AND to EXCLUDE them from being selected as values.

_LABEL_KEYS: dict[str, re.Pattern] = {
    # "MATERIAL SPECIFICATION" is a real title-block label wording (confirmed
    # live) -- without this, the label cell's own text doesn't match here, Pass
    # 1 finds nothing, and the flat-text fallback (path 2 below) was matching
    # "MATERIAL" and capturing the label's own trailing word "SPECIFICATION"
    # as if it were the value.
    "material":   re.compile(r"^MATER(?:IAL)?(?:\s+SPEC(?:IFICATION)?)?$|^MATL$|^MAT$", re.I),
    "revision":   re.compile(r"^REV(?:ISION)?$|^ISSUE$|^REV\.$", re.I),
    "thickness":  re.compile(r"^(?:SHEET\s+)?THI?C?K(?:NESS)?$|^THK$", re.I),
    "tolerance":  re.compile(r"^(?:GENERAL\s+)?TOL(?:ERANCE)?$|^G\.TOL$", re.I),
    "finish":     re.compile(r"^SURFACE\s+FINISH$|^FINISH$|^Ra$", re.I),
    "coating":    re.compile(r"^SURFACE\s+TREAT(?:MENT)?$|^COATING$|^PLATING$", re.I),
    "treatment":  re.compile(r"^HEAT\s+TREAT(?:MENT)?$|^HT$", re.I),
    "drawing_no": re.compile(
        r"^(?:DRG|DWG|DOC)\.?\s*NO\.?$|^PART\s*NO\.?$|^DRAWING\s*NO\.?$", re.I
    ),
    "size":       re.compile(r"^SIZE$", re.I),
    "scale":      re.compile(r"^SCALE$", re.I),
    "date":       re.compile(r"^DATE$|^DRAWN\s*DATE$", re.I),
    "drawn":      re.compile(r"^DRAWN$|^CHECKED$|^APPROVED$", re.I),
    "title":      re.compile(r"^TITLE[:\s]*$|^DESCRIPTION$|^PART\s+NAME$", re.I),
    "name":       re.compile(r"^NAME$|^DATE$", re.I),
}

# All known labels combined — used to exclude label blocks from value candidates
_ALL_LABEL_RE = re.compile(
    r"""^(?:
        MATER(?:IAL)?(?:\s+SPEC(?:IFICATION)?)?|MATL? |
        REV(?:ISION)?|ISSUE                           |
        THI?C?K(?:NESS)?|THK                          |
        (?:GENERAL\s+)?TOL(?:ERANCE)?|G\.TOL          |
        (?:SURFACE\s+)?FINISH|Ra                       |
        (?:SURFACE\s+)?(?:COATING|PLATING|TREAT(?:MENT)?) |
        (?:HEAT\s+)?TREAT(?:MENT)?|HT                 |
        (?:DRG|DWG|DOC)\.?\s*NO\.?                    |
        (?:PART|DRAWING)\s*NO\.?                       |
        SCALE|DATE|DRAWN|CHECKED|APPROVED              |
        TITLE|DESCRIPTION|PART\s+NAME                  |
        WEIGHT|SHEET|PROJ(?:ECT)?                      |
        SIZE|NAME                                      |
        DO\s+NOT\s+SCALE|UNLESS\s+OTHERWISE           |
        DIMENSIONS|PROPRIETARY|UNLESS
    )\.?$""",
    re.IGNORECASE | re.VERBOSE,
)


def _is_label(text: str) -> bool:
    return bool(_ALL_LABEL_RE.match(text.replace("\n", " ").strip()))


# ─── Placeholder guard ────────────────────────────────────────────────────────

_PLACEHOLDER = re.compile(
    r"""^(?:
        [X#\-\s\.]+    |
        X+\.X+         |
        0+\.0+         |
        N/?A           |
        NONE           |
        TBD|TBC|TBR    |
        \?+            |
        SPECIFY        |
        SPEC(?:IFICATION)?   |
        AS\s+PER\s+\w+
    )$""",
    re.IGNORECASE | re.VERBOSE,
)

def _is_placeholder(s: str) -> bool:
    return bool(_PLACEHOLDER.match(s.strip())) if s else True


# ─── Material grade normalization ─────────────────────────────────────────────

_AL_WROUGHT = {
    "1100","2014","2024","3003","5052","5083","5754",
    "6060","6061","6063","6082","7050","7075",
}

def _fix_ocr(s: str) -> str:
    s = re.sub(r"(?<=\d)[IL]", "1", s)
    s = re.sub(r"[IL](?=\d{2})", "1", s)
    s = re.sub(r"(?<=\d)O(?=\d|$)", "0", s)
    return s

def _normalize_material(raw: str | None) -> str | None:
    if not raw:
        return None
    up = _fix_ocr(raw.upper().strip())
    if not up or _is_placeholder(up):
        return None
    # Aluminum alloy: 6061-T6, AA7075-T651, Al2024
    al = re.search(r"(?:AA|AL(?:UMINI?UM)?)?[\s\-]*(\d{4})[\s\-]*(T\d{1,3}\d*|H\d{2})?", up)
    if al and al.group(1) in _AL_WROUGHT:
        temper = f"-{al.group(2)}" if al.group(2) else ""
        return f"AA{al.group(1)}{temper}"
    # Stainless: SS316L, AISI 304, 316L
    ss = re.search(r"(?:SS|AISI|STAINLESS(?:\s+STEEL)?)[\s\-]*(\d{3}L?)", up)
    if ss:
        return f"SS{ss.group(1)}"
    return raw.strip()


# ─── PDF extraction ───────────────────────────────────────────────────────────

class _Block:
    __slots__ = ("x0", "y0", "x1", "y1", "text", "first_line")
    def __init__(self, x0: float, y0: float, x1: float, y1: float, text: str):
        self.x0, self.y0, self.x1, self.y1, self.text = x0, y0, x1, y1, text
        self.first_line = text.split("\n")[0].strip()

def _extract_blocks(pdf_bytes: bytes) -> tuple[list[_Block], str]:
    try:
        import fitz
    except ImportError:
        raise HTTPException(500, "PyMuPDF not installed — run: pip install PyMuPDF")

    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    if doc.page_count == 0:
        raise HTTPException(422, "PDF has no pages")

    all_blocks: list[_Block] = []
    flat_parts: list[str] = []

    for i, page in enumerate(doc):
        raw_blocks = page.get_text("blocks")
        for b in raw_blocks:
            if b[6] != 0:
                continue
            txt = b[4].strip()
            if txt:
                all_blocks.append(_Block(b[0], b[1], b[2], b[3], txt))
                flat_parts.append(txt)
        if i >= 1:
            break

    doc.close()
    flat = "\n".join(flat_parts)
    logger.info("PDF extracted: %d blocks, %d chars", len(all_blocks), len(flat))
    return all_blocks, flat


# ─── Spatial title-block matching ─────────────────────────────────────────────

def _nearest_value(label: _Block, candidates: list[_Block]) -> _Block | None:
    """
    Find the value block nearest to a label block.

    Key rules for CAD title blocks (tested against SolidWorks PDF output):
    - Value cell may START inside the label's x-range (shared border).
      Use label.x0 as the left boundary, not label.x1.
    - Value cell y0 may be slightly above label.y1 (cells overlap by a few px).
    - Must skip any block whose text is itself a known label.
    """
    h = max(label.y1 - label.y0, 8.0)
    best: _Block | None = None
    best_dist = float("inf")

    for c in candidates:
        # Never pick another label cell as a value
        if _is_label(c.first_line):
            continue

        # x: candidate must start at or after label's left edge
        if c.x0 < label.x0 - 5:
            continue
        # x: candidate must not be entirely to the left
        if c.x1 < label.x0:
            continue

        # y: candidate must be within the label row or up to 4 line-heights below
        y_diff = c.y0 - label.y0
        if y_diff < -h * 0.8 or y_diff > h * 5:
            continue

        # Distance: prefer right-of-label on same row, then below
        dx = max(0.0, c.x0 - label.x1)
        dy = max(0.0, c.y0 - label.y1)
        dist = dx + dy * 1.5

        if dist < best_dist:
            best_dist = dist
            best = c

    return best


def _extract_title_block(blocks: list[_Block]) -> dict[str, str]:
    pairs: dict[str, str] = {}
    used: set[int] = set()

    for i, blk in enumerate(blocks):
        single = blk.first_line
        for key, pat in _LABEL_KEYS.items():
            if key in pairs:
                continue
            if pat.match(single):
                non_used = [b for j, b in enumerate(blocks) if j != i and j not in used]
                val = _nearest_value(blk, non_used)
                if val:
                    idx = next(j for j, b in enumerate(blocks) if b is val)
                    used.add(idx)
                    # Take only first line — avoids "6061-T6\nA" picking up stray "A"
                    pairs[key] = val.first_line
                break
    return pairs


# ─── Regex helpers ────────────────────────────────────────────────────────────

def _find(pattern: str, text: str, flags: int = re.IGNORECASE) -> str | None:
    m = re.search(pattern, text, flags)
    return m.group(1).strip() if m else None

def _find_float(pattern: str, text: str) -> float | None:
    m = re.search(pattern, text, re.IGNORECASE)
    try:
        return float(m.group(1)) if m else None
    except (ValueError, TypeError):
        return None


# ─── Field extractors ─────────────────────────────────────────────────────────

def _extract_material(tb: dict[str, str], flat: str) -> tuple[str, float]:
    # 1) Title block (highest confidence)
    raw = tb.get("material", "")
    if raw and not _is_placeholder(raw) and not _is_label(raw):
        norm = _normalize_material(raw)
        if norm:
            return norm, 0.92

    # 2) Inline "MATERIAL: ..." in flat text. This has no coordinates to tell
    # a label cell's own trailing word from a real value (unlike path 1
    # above) -- confirmed live: "MATERIAL SPECIFICATION" as a title-block
    # label (no colon, no real value following it in the flat text) matched
    # "MATERIAL" and captured the label's own word "SPECIFICATION" as if it
    # were the material. _is_label guards the same way path 1 already does.
    for pat in (
        r"(?:MATERIAL|MATL|MAT)[:\s\-–]+([A-Z0-9][A-Z0-9 /\.\-]{1,30})",
        r"(?:SHEET\s+)?MATERIAL[:\s\-–]+([A-Z0-9][A-Z0-9 /\.\-]{1,30})",
    ):
        raw2 = _find(pat, flat)
        if raw2 and not _is_placeholder(raw2) and not _is_label(raw2):
            raw2 = re.split(r'\s{2,}|\t|\n', raw2)[0].strip()
            norm = _normalize_material(raw2)
            if norm:
                return norm, 0.85

    # 3) Bare aluminum temper designation anywhere in text (e.g. "6061-T6")
    al_m = re.search(r"\b(\d{4}[\s\-]T\d{1,3}\d*)\b", flat)
    if al_m:
        norm = _normalize_material(al_m.group(1))
        if norm:
            return norm, 0.80

    # 4) Known grade keywords
    m = re.search(
        r"\b(AA\d{4}(?:[\/\-]T\d{1,2})?|SS\d{3}L?|CRCA|DC01|DC03|"
        r"EN8|EN24|EN31|IS2062|MILD\s+STEEL|STAINLESS\s+STEEL|ALUMIN(?:I|U)UM)\b",
        flat, re.IGNORECASE,
    )
    if m:
        norm = _normalize_material(m.group(1))
        if norm:
            return norm, 0.65

    return "Not specified", 0.0


def _extract_drawing_number(tb: dict[str, str], flat: str, part_hint: str | None) -> str:
    raw = tb.get("drawing_no", "")
    if raw:
        return raw.strip()
    if part_hint:
        return part_hint.strip()
    m = re.search(r"\b([A-Z]{2,6}-\d{3,6}-[A-Z0-9]{1,2})\b", flat)
    return m.group(1) if m else ""


def _extract_revision(tb: dict[str, str], flat: str, drawing_no: str) -> str:
    raw = tb.get("revision", "")
    if raw and not _is_placeholder(raw) and not _is_label(raw):
        # Direct single letter/number
        if re.match(r"^[A-Z0-9]{1,2}$", raw.strip(), re.I):
            return raw.strip().upper()
        # Drawing number format: RMP-00030-A → "A"
        m = re.match(r"[A-Z\d]+-\d+-([A-Z0-9]{1,2})$", raw.strip(), re.I)
        if m:
            return m.group(1).upper()

    # Infer from drawing number
    dn = drawing_no or tb.get("drawing_no", "")
    if dn:
        m2 = re.search(r"[A-Z\d]{2,}-\d{3,}-([A-Z0-9]{1,2})(?:\b|$)", dn, re.I)
        if m2:
            return m2.group(1).upper()

    # Flat text "REV A" (single char only)
    rev = _find(r"REV(?:ISION)?[\s.:]+([A-Z0-9]{1,2})\b", flat)
    if rev and not _is_placeholder(rev):
        return rev.upper()

    # Last resort: drawing number in flat text
    m3 = re.search(r"\b[A-Z]{2,6}-\d{3,6}-([A-Z0-9]{1,2})\b", flat)
    return m3.group(1).upper() if m3 else ""


def _extract_sheet_thickness(tb: dict[str, str], flat: str) -> tuple[float, float]:
    raw = tb.get("thickness", "")
    if raw and not _is_placeholder(raw):
        m = re.search(r"(\d+(?:\.\d+)?)", raw)
        if m:
            v = float(m.group(1))
            if 0.3 <= v <= 25.0:
                return v, 0.95
    patterns = [
        (r"(?:SHEET\s+)?(?:THICKNESS|THK(?:NS)?)[:\s\-–]+(\d+(?:\.\d+)?)\s*(?:MM)?", 0.90),
        (r"\bt\s*=\s*(\d+(?:\.\d+)?)\s*(?:MM)?", 0.85),
        (r"(\d+(?:\.\d+)?)\s*MM\s+(?:CRCA|MS|STEEL|SS|AA|ALUMINUM)", 0.80),
    ]
    for pat, conf in patterns:
        v = _find_float(pat, flat)
        if v and 0.3 <= v <= 25.0:
            return v, conf
    return 0.0, 0.0


def _extract_tolerance(tb: dict[str, str], flat: str) -> tuple[float, float]:
    raw = tb.get("tolerance", "")
    if raw and not _is_placeholder(raw):
        m = re.search(r"[±]\s*(\d+(?:\.\d+)?)", raw)
        if m:
            return float(m.group(1)), 0.90
    vals: list[tuple[float, float]] = []
    for m in re.finditer(r"[±Ø⊕◎⊙]\s*(\d+\.\d+)", flat):
        try:
            vals.append((float(m.group(1)), 0.85))
        except ValueError:
            pass
    for m in re.finditer(r"±\s*(\d+(?:\.\d+)?)", flat):
        try:
            vals.append((float(m.group(1)), 0.80))
        except ValueError:
            pass
    if vals:
        best = min(vals, key=lambda x: x[0])
        return best[0], best[1]
    if re.search(r"ISO\s*2768[\s\-]*[fm]|DIN\s*ISO\s*2768", flat, re.I):
        return 0.1, 0.50
    return 0.0, 0.0


def _extract_surface_finish(tb: dict[str, str], flat: str) -> tuple[float, float]:
    raw = tb.get("finish", "")
    if raw and not _is_placeholder(raw):
        m = re.search(r"(\d+(?:\.\d+)?)", raw)
        if m:
            return float(m.group(1)), 0.90
    # Handles both "Ra 1.6" and "1.6um Ra" and "1.6 Ra" formats
    m = re.search(
        r"Ra\s*(\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)\s*(?:µm|um|μm)?\s*Ra",
        flat, re.I,
    )
    if m:
        try:
            return float(m.group(1) or m.group(2)), 0.90
        except (ValueError, TypeError):
            pass
    return 0.0, 0.0


def _extract_coating(tb: dict[str, str], flat: str) -> str:
    raw = tb.get("coating", "")
    if raw and not _is_placeholder(raw) and not _is_label(raw):
        return raw.strip()
    # Priority: hardcoat anodize (aerospace/industrial standard)
    if re.search(r"TYPE\s+III\s+HARDCOAT|HARD\s+ANODIZ", flat, re.I):
        return "Type III Hardcoat Anodizing"
    if re.search(r"TYPE\s+II\s+ANODIZ", flat, re.I):
        return "Type II Anodizing"
    coatings = [
        "ZINC PLATED","ZINC PHOSPHATE","HOT DIP GALVANIZED","GALVANIZED",
        "POWDER COAT","POWDER COATED","ANODIZED","ANODISE",
        "CHROME PLATED","NICKEL PLATED","ELECTROLESS NICKEL",
        "PAINT","E-COAT","ELECTROCOAT","BLACK OXIDE","PASSIVATION","DACROMET",
    ]
    up = flat.upper()
    for c in coatings:
        if c in up:
            return c.title()
    return "None"


def _extract_heat_treatment(tb: dict[str, str], flat: str) -> str:
    raw = tb.get("treatment", "")
    if raw and not _is_placeholder(raw) and not _is_label(raw):
        return raw.strip()
    treatments = [
        "CASE HARDENED","THROUGH HARDENED","HARDENED",
        "ANNEALED","NORMALIZED","NORMALISED",
        "QUENCH","TEMPERED","STRESS RELIEVED","CARBURIZED","NITRIDED",
    ]
    up = flat.upper()
    for t in treatments:
        if t in up:
            return t.title()
    return "None"


# A chemical milling (chem-mill / chemical etching) callout: the drawing names
# the process, typically as a note ("CHEM MILL PER ...", "CHEMICAL MILL AREAS
# SHOWN", "CHEM-MILLED") or in a title-block treatment/process field. Returns
# the matched callout text, or "None". Only the process name is detected; which
# pockets are etched is not read from the drawing.
_CHEM_MILL_RE = re.compile(
    r"\b(CHEM(?:ICAL(?:LY)?)?[\s\-]*MILL(?:ED|ING)?|CHEM(?:ICAL(?:LY)?)?[\s\-]*ETCH(?:ED|ING)?)\b",
    re.I,
)


def _extract_chemical_milling(tb: dict[str, str], flat: str) -> str:
    for key in ("treatment", "process"):
        raw = tb.get(key, "")
        if raw and not _is_placeholder(raw) and not _is_label(raw) and _CHEM_MILL_RE.search(raw):
            return raw.strip()
    m = _CHEM_MILL_RE.search(flat)
    return m.group(1).strip().upper() if m else "None"


# Gear quality callout: new AGMA ("AGMA A8", "AGMA 2015 A6"), old AGMA
# ("AGMA Q10") or DIN ("DIN 3962 QUALITY 7", "DIN 7"). Returned normalized as
# "A8" / "Q10" / "DIN7", or "None". The process a quality needs comes from the
# reference tblGearQuality, not from here.
_GEAR_QUALITY_RE = [
    (re.compile(r"\bAGMA(?:\s*\d{4})?[\s\-:]*(?:QUALITY\s*)?(A\d{1,2})\b", re.I), lambda m: m.group(1).upper()),
    (re.compile(r"\bAGMA(?:\s*\d{3,4})?[\s\-:]*(?:QUALITY\s*)?(Q\d{1,2})\b", re.I), lambda m: m.group(1).upper()),
    (re.compile(r"\bDIN(?:\s*3962)?[\s\-:]*(?:QUALITY|QUAL\.?|CLASS)?\s*(\d{1,2})\b(?!\s*[\-/]\s*\d)", re.I), lambda m: f"DIN{int(m.group(1))}"),
]


def _extract_gear_quality(flat: str) -> str:
    for rx, norm in _GEAR_QUALITY_RE:
        m = rx.search(flat)
        if m:
            return norm(m)
    return "None"


# Named gear finishing / cutting processes on the drawing ("SHAVE",
# "GEAR SHAPING", ...), and a polygon callout ("HEX", "ROTARY BROACH",
# "POLYGON") that lets a CAD polygon ring be treated as a polygon rather than
# an ordinary pocket. Each returns the matched text or "None".
_GEAR_SHAVING_RE = re.compile(r"\b(?:GEAR\s+)?SHAV(?:E|ED|ING)\b", re.I)
_GEAR_SHAPING_RE = re.compile(r"\b(?:GEAR\s+SHAP(?:E|ED|ING)|SHAPED\s+(?:GEAR|TEETH|SPLINE)|SHAPER\s+CUT)\b", re.I)
_POLYGON_RE = re.compile(r"\b(ROTARY[\s\-]*BROACH(?:ED|ING)?|POLYGON(?:\s+TURN(?:ED|ING))?|HEX(?:AGON(?:AL)?)?\s+(?:SOCKET|HOLE|BROACH(?:ED)?|DRIVE)|SQUARE\s+(?:SOCKET|DRIVE))\b", re.I)


# Machining allowance: the stock a casting drawing asks for on its machined faces. Two forms are read, exactly as printed:
#   - the ISO 8062-3 general-tolerance callout "ISO 8062-3 – DCTG 10 – RMA 6 (RMAG H)" (older: "ISO 8062-CT12-RMA 6 (H)"):
#     RMA is the allowance the drawing requires, in mm; RMAG and DCTG are the grades. No ISO table value is looked up here.
#   - a note: "MACHINING ALLOWANCE 3 MM", "3 MM STOCK ON MACHINED FACES", "LEAVE 4 MM MACHINING STOCK", "ALLOW 2.5 MM FOR MACHINING".
# A value counts only with a millimetre unit; two different values are not chosen between (the text is kept, the value is not).
# The callouts are part-wide: the drawing text does not say which face a note points at.
_NUM = r"(\d+(?:[.,]\d+)?)"
_SEP = r"[\s\-–—:]*"
_ISO_8062_RE = re.compile(
    rf"ISO{_SEP}8062(?:{_SEP}-?3)?(?:{_SEP}(?:D?CTG?{_SEP}(\d{{1,2}})))?(?:{_SEP}RMA{_SEP}{_NUM}(?:\s*MM)?)?(?:{_SEP}\(?\s*(?:RMAG{_SEP})?([A-K])\s*\)?(?![A-Z]))?",
    re.I,
)
_ISO_RMAG_RE = re.compile(rf"RMAG{_SEP}([A-K])\b", re.I)
_ALLOWANCE_NOTE_RES = [
    re.compile(rf"MACHIN(?:ING|E){_SEP}(?:ALLOWANCE|STOCK)(?:{_SEP}OF)?{_SEP}{_NUM}\s*MM\b", re.I),
    re.compile(rf"{_NUM}\s*MM\s+(?:MACHIN(?:ING|E)\s+)?(?:ALLOWANCE|STOCK)\b", re.I),
    re.compile(rf"\bALLOW\s+{_NUM}\s*MM\s+(?:FOR\s+)?MACHIN", re.I),
]
_ALLOWANCE_MENTION_RE = re.compile(r"MACHIN(?:ING|E)\s+(?:ALLOWANCE|STOCK)\b[^\n]{0,60}|(?:ALLOWANCE|STOCK)\s+FOR\s+MACHIN\w*[^\n]{0,40}", re.I)


def _mm(text: str) -> float:
    return float(text.replace(",", "."))


def _extract_machining_allowance(flat: str) -> dict[str, Any] | None:
    """The drawing's machining allowance callout: {text, allowance_mm, rmag, dctg}, or None when the drawing has none."""
    texts: list[str] = []
    values: set[float] = set()
    rmag: str | None = None
    dctg: int | None = None

    for m in _ISO_8062_RE.finditer(flat):
        grade_ct, rma, grade = m.group(1), m.group(2), m.group(3)
        if not (rma or grade or _ISO_RMAG_RE.search(m.group(0))):
            continue  # "ISO 8062-3 DCTG 10" alone is a dimensional tolerance, not an allowance
        texts.append(" ".join(m.group(0).split()))
        if rma:
            values.add(_mm(rma))
        if grade:
            rmag = grade.upper()
        if grade_ct:
            dctg = int(grade_ct)

    noted = False
    for rx in _ALLOWANCE_NOTE_RES:
        for m in rx.finditer(flat):
            texts.append(" ".join(m.group(0).split()))
            values.add(_mm(m.group(1)))
            noted = True
    if not noted and not texts:
        mention = _ALLOWANCE_MENTION_RE.search(flat)
        if mention:
            texts.append(" ".join(mention.group(0).split()))

    if not texts:
        return None
    unique = list(dict.fromkeys(texts))
    return {
        "text": " | ".join(unique)[:300],
        "allowance_mm": values.pop() if len(values) == 1 else None,
        "rmag": rmag,
        "dctg": dctg,
    }


def _match_or_none(rx: "re.Pattern[str]", flat: str) -> str:
    m = rx.search(flat)
    return m.group(0).strip().upper() if m else "None"


def _extract_general_tolerance(tb: dict[str, str], flat: str) -> str:
    raw = tb.get("tolerance", "")
    if raw and not _is_placeholder(raw) and re.search(r"ISO|DIN|ASME", raw, re.I):
        return raw.strip()
    m = re.search(
        r"(ISO\s*2768[\s\-]*[a-zA-Z]{1,3}|DIN\s*ISO\s*2768[\s\-]*[a-zA-Z]{1,3}|ASME\s*Y14\.5[\s\-]*\d{4})",
        flat, re.I,
    )
    return m.group(1).strip() if m else ""


def _extract_dimensions(flat: str) -> dict[str, float]:
    m = re.search(r"(\d+(?:\.\d+)?)\s*[xX×]\s*(\d+(?:\.\d+)?)\s*[xX×]\s*(\d+(?:\.\d+)?)", flat)
    if m:
        vals = sorted([float(m.group(i)) for i in (1, 2, 3)], reverse=True)
        return {"L": vals[0], "W": vals[1], "H": vals[2]}
    return {"L": 0, "W": 0, "H": 0}


# A thread's tolerance class after its size (ISO 965-1: "6g", "6H", "4h6h"): internal threads take the capitals G and H, external ones the
# small letters e, f, g and h. A class must end the token ("4X" before another callout is not one).
_THREAD_CLASS = r"(?:\s*[-–]?\s*(\d[a-hA-H](?:\d[a-hA-H])?)(?![A-Za-z0-9]))?"
# A stated length after the callout: "M12x1.75-6g x 15 LG", "M6 x 10 DEEP".
_THREAD_LENGTH = r"(?:\s*[xX×]\s*(\d+(?:\.\d+)?)\s*(?:MM\s*)?(?:LG|LONG|DP|DEEP)\b)?"
# What the callout's own words say: an external or an internal (tapped) thread.
_EXTERNAL_WORD = re.compile(r"\bEXT(?:ERNAL)?\b", re.I)
_INTERNAL_WORD = re.compile(r"\b(?:INT(?:ERNAL)?|TAP(?:PED)?)\b", re.I)
_WORD_BEFORE = re.compile(r"\b(EXT(?:ERNAL)?|INT(?:ERNAL)?)\.?\s*(?:THREAD|THD)?\s*[:\-]?\s*$", re.I)
# The start of the next callout, where the text that belongs to this one ends.
_NEXT_CALLOUT = re.compile(r"\n|\bM\d|#\d|\d/\d|\d+\s*[xX×]\s*M\d", re.I)


def _thread_kind_of_class(cls: str, callout: str) -> str | None:
    """
    The kind of thread an ISO 965-1 tolerance class names. Small letters are external (6g, 4h6h), capitals internal (6H, 7G); e and f are
    external only. A callout written all in capitals ("M10X1.5-6G") says nothing by the letter's case: there only E or F decides.
    """
    letter = cls[1]
    if letter.islower() or letter in "EF":
        return "external"
    return "internal" if any(ch.islower() for ch in callout) else None


def _thread_kind_of_words(flat: str, start: int, end: int) -> str | None:
    """EXT / EXTERNAL or INT / INTERNAL / TAP / TAPPED in the callout's own text (after it, up to the next callout) or just before it."""
    after = flat[end:end + 30]
    stop = _NEXT_CALLOUT.search(after)
    if stop:
        after = after[:stop.start()]
    if _EXTERNAL_WORD.search(after):
        return "external"
    if _INTERNAL_WORD.search(after):
        return "internal"
    before = flat[max(0, start - 25):start].rsplit("\n", 1)[-1]
    w = _WORD_BEFORE.search(before)
    if w:
        return "external" if w.group(1).upper().startswith("EXT") else "internal"
    return None


def _extract_threads(flat: str) -> list[dict]:
    """
    Detect both metric (M4×0.7) and imperial UNC/UNF (3/8-16, #8-32) thread callouts.
    Format on drawings: [count ×] <size> [× pitch] [-class] [× length LG] [Tapped Thru / Tapped Blind / UNC/UNF[-2A]]
    Each callout keeps what it states of the thread's kind: its tolerance class (ISO 965-1 6g / 6H, UN 2A / 2B) or its words (EXTERNAL,
    TAPPED); null when it states neither. De-duplication key is the size and that kind, so an M10 6g and an M10 6H are two threads.
    """
    results: list[dict] = []

    def prior_of(size_str: str, kind: str | None) -> dict | None:
        """The entry a callout repeats: the same size and kind, else (either side naming no kind) the same size."""
        same = [e for e in results if e["size"] == size_str]
        if kind is None:
            return same[0] if same else None
        exact = next((e for e in same if e["threadKind"] == kind), None)
        return exact or next((e for e in same if e["threadKind"] is None), None)

    def stated_again(size_str: str, count_s: str | None, kind: str | None, cls: str | None, length: float | None,
                     pitch: float | None = None) -> bool:
        """A size already read: its callout is kept, except that what a later callout states and the earlier one did not (a count "4 × M3"
        over the default 1 of a bare "M3", the thread's kind and class, its length, its pitch) is taken from the later one."""
        prior = prior_of(size_str, kind)
        if prior is None:
            return False
        if count_s is not None and not prior["countStated"]:
            prior["count"] = int(count_s)
            prior["countStated"] = True
        if kind is not None and prior["threadKind"] is None:
            prior["threadKind"] = kind
        if cls is not None and prior["toleranceClass"] is None:
            prior["toleranceClass"] = cls
        if length is not None and prior["lengthMm"] is None:
            prior["lengthMm"] = length
        if pitch is not None and prior.get("pitchStated") is False:
            prior["pitch"] = pitch
            prior["pitchStated"] = True
        return True

    # ── Metric: 2 × M4 × 0.7, M6x1.0, M10, M12x1.75-6g x 15 LG ─────────────
    # A pitch is a number after the size that is not the length the callout states ("M6 X 10 DEEP" is 10 deep, not a 10 mm pitch).
    for m in re.finditer(
        r"(?:(\d+)\s*[xX×]\s*)?M(\d+(?:\.\d+)?)"
        r"(?:\s*[xX×]\s*(\d+(?:\.\d+)?)(?![\d.])(?!\s*(?:MM\s*)?(?:LG|LONG|DP|DEEP)\b))?"
        + _THREAD_CLASS + _THREAD_LENGTH,
        flat, re.I,
    ):
        size_str = f"M{m.group(2)}"
        cls = m.group(4)
        kind = _thread_kind_of_class(cls, m.group(0)) if cls else None
        if kind is None:
            kind = _thread_kind_of_words(flat, m.start(), m.end())
        length = float(m.group(5)) if m.group(5) else None
        pitch_stated = float(m.group(3)) if m.group(3) else None
        if stated_again(size_str, m.group(1), kind, cls, length, pitch_stated):
            continue
        try:
            count = int(m.group(1)) if m.group(1) else 1
            pitch = pitch_stated if pitch_stated is not None else _default_pitch(float(m.group(2)))
            entry = {
                "size": size_str, "pitch": pitch, "count": count,
                # A callout that names the size alone ("M3") states no count: 1 is a default, not the drawing's word.
                "countStated": m.group(1) is not None,
                # Likewise a pitch: with none written, the pitch above is the analyser's coarse-series default.
                "pitchStated": pitch_stated is not None,
                "toleranceClass": cls,
                "threadKind": kind,
                "lengthMm": length,
                "standard": "metric",
                "extractionConfidence": 0.85,
                "extractionSource": "drawing_text",
            }
            results.append(entry)
        except (ValueError, TypeError):
            pass

    # ── Imperial UNC/UNF: 1 × 3/8-16, #8-32, 1/4-20 UNC-2A ─────────────────
    # Pattern: optional [count ×] then  (#N  or  N/D)  then  -TPI  then the optional series and class (2A external, 2B internal).
    # TPI guard (4–80) avoids false positives from page numbers or dates.
    for m in re.finditer(
        r"(?:(\d+)\s*[xX×]\s*)?(?:#(\d{1,2})|(\d{1,2})/(\d{1,2}))-(\d{1,3})\b"
        r"(?:\s*(?:UNC|UNF|UNEF|UNS|UN)\b)?(?:\s*-\s*([123][AB])\b)?" + _THREAD_LENGTH,
        flat, re.I,
    ):
        count_s, num_dia, fn, fd, tpi_s = (
            m.group(1), m.group(2), m.group(3), m.group(4), m.group(5)
        )
        cls = m.group(6).upper() if m.group(6) else None
        try:
            tpi = int(tpi_s)
            if not (4 <= tpi <= 80):
                continue
            if num_dia is not None:
                size_str = f"#{num_dia}-{tpi}"
            else:
                # Sanity: denominator must be a valid fraction (2,4,8,16,32,64)
                if int(fd) not in (2, 4, 8, 16, 32, 64):
                    continue
                size_str = f"{fn}/{fd}-{tpi}"
            kind = ("external" if cls.endswith("A") else "internal") if cls else _thread_kind_of_words(flat, m.start(), m.end())
            length = float(m.group(7)) if m.group(7) else None
            if stated_again(size_str, count_s, kind, cls, length):
                continue
            count = int(count_s) if count_s else 1
            entry = {
                "size": size_str,
                "tpi": tpi,
                "count": count,
                "countStated": count_s is not None,
                "toleranceClass": cls,
                "threadKind": kind,
                "lengthMm": length,
                "standard": "imperial",
                "extractionConfidence": 0.85,
                "extractionSource": "drawing_text",
            }
            results.append(entry)
        except (ValueError, TypeError):
            pass

    return results


# ─── Knurls ───────────────────────────────────────────────────────────────────
# A knurl callout: "MEDIUM DIAMOND KNURL", "STRAIGHT KNURL 30 TPI", "DIAMOND KNURL 0.8 P", or a DIN 82 code ("RGE 1.0 DIN 82": the form
# letters, then the pitch in mm). DIN 82 forms: RAA straight, RBL / RBR left / right diagonal, RGE / RGV diamond (raised / sunk points),
# RKE / RKV crossed (raised / sunk points).
_KNURL_WORD = re.compile(
    r"(?:\b(FINE|MEDIUM|COARSE)\s+)?(?:\b(DIAMOND|STRAIGHT|DIAGONAL|CROSS(?:ED)?)\s+)?KNURL(?:ED|ING)?\b", re.I)
_KNURL_DIN = re.compile(r"\bR(AA|BL|BR|GE|GV|KE|KV)\s*(\d+(?:[.,]\d+)?)(?![\d.,])", re.I)
_DIN_82 = re.compile(r"\bDIN\s*82\b", re.I)
_DIN_PATTERN = {"AA": "straight", "BL": "diagonal", "BR": "diagonal", "GE": "diamond", "GV": "diamond", "KE": "crossed", "KV": "crossed"}
_KNURL_PITCH = re.compile(r"(?<![\d.])(\d+(?:\.\d+)?)\s*(?:MM\s*)?P(?:ITCH)?\b", re.I)
_KNURL_TPI = re.compile(r"(?<![\d.])(\d{1,3})\s*T\.?P\.?I\b", re.I)
_KNURL_DIAMETER = re.compile(r"[Ø⌀]\s*(\d+(?:\.\d+)?)")
_KNURL_LENGTH = re.compile(r"(?<![\d.])(\d+(?:\.\d+)?)\s*(?:MM\s*)?(?:LG|LONG|LENGTH)\b", re.I)


def _same_line(flat: str, start: int, end: int, reach: int = 40) -> tuple[str, str]:
    """The text on the callout's own line just before and just after it (up to `reach` characters each way)."""
    before = flat[max(0, start - reach):start].rsplit("\n", 1)[-1]
    after = flat[end:end + reach].split("\n", 1)[0]
    return before, after


def _knurl_details(text: str) -> dict:
    """What a knurl callout's text states: its pitch (mm), threads per inch, diameter and length; null for what it does not."""
    pitch = _KNURL_PITCH.search(text)
    tpi = _KNURL_TPI.search(text)
    dia = _KNURL_DIAMETER.search(text)
    length = _KNURL_LENGTH.search(text)
    return {
        "pitchMm": float(pitch.group(1)) if pitch else None,
        "tpi": int(tpi.group(1)) if tpi else None,
        "diameterMm": float(dia.group(1)) if dia else None,
        "lengthMm": float(length.group(1)) if length else None,
    }


def _extract_knurls(flat: str) -> list[dict]:
    """
    Knurl callouts, each with what its text states: the pattern (diamond, straight, diagonal, crossed), the grade (fine, medium, coarse),
    the pitch in mm or in threads per inch, the diameter knurled (Ø20) and its length (10 LG). A value the callout does not state is null;
    nothing is filled in. A DIN 82 code counts on its own only beside "DIN 82" (or within a knurl callout), so a stray "RGE 1" is not one.
    """
    results: list[dict] = []
    seen: set[tuple] = set()
    used_din: set[int] = set()

    def add(entry: dict) -> None:
        key = (entry["pattern"], entry["grade"], entry["pitchMm"], entry["tpi"], entry["diameterMm"], entry["lengthMm"])
        if key not in seen:
            seen.add(key)
            results.append(entry)

    for m in _KNURL_WORD.finditer(flat):
        before, after = _same_line(flat, m.start(), m.end())
        found = _knurl_details(before + " " + after)
        pattern = m.group(2).lower() if m.group(2) else None
        if pattern == "cross":
            pattern = "crossed"
        din = next(_KNURL_DIN.finditer(flat, max(0, m.start() - 40), min(len(flat), m.end() + 40)), None)
        if din is not None:
            used_din.add(din.start())
            pattern = pattern or _DIN_PATTERN[din.group(1).upper()]
            found["pitchMm"] = float(din.group(2).replace(",", "."))
        add({
            "pattern": pattern, "grade": m.group(1).lower() if m.group(1) else None, **found,
            "text": " ".join((before[-20:] + m.group(0) + after).split())[:120], "extractionSource": "drawing_text",
        })

    for d in _KNURL_DIN.finditer(flat):
        if d.start() in used_din:
            continue
        before, after = _same_line(flat, d.start(), d.end())
        if not _DIN_82.search(after[:20]) and not _DIN_82.search(before[-20:]):
            continue
        found = _knurl_details(before + " " + after)
        found["pitchMm"] = float(d.group(2).replace(",", "."))
        add({
            "pattern": _DIN_PATTERN[d.group(1).upper()], "grade": None, **found,
            "text": " ".join((d.group(0) + after[:20]).split())[:120], "extractionSource": "drawing_text",
        })

    return results


def _default_pitch(d: float) -> float:
    table = {3:0.5, 4:0.7, 5:0.8, 6:1.0, 8:1.25, 10:1.5, 12:1.75, 16:2.0, 20:2.5, 24:3.0}
    return table.get(int(d), 1.0)


def _extract_bend_count(flat: str) -> int:
    m = re.search(r"(\d+)\s*(?:BENDS?|FOLDS?)", flat, re.I)
    if m:
        try:
            return int(m.group(1))
        except ValueError:
            pass
    return len(re.findall(r"\bBEND\s+(?:UP|DOWN|INWARD|OUTWARD|LINE)\b", flat, re.I))


def _extract_process(flat: str, thickness: float, material: str) -> str:
    up = flat.upper()
    if any(k in up for k in ("LASER CUT","PRESS BRAKE","PUNCH","BLANK")):
        return "Sheet Metal Laser Cutting"
    if "INJECTION MOULD" in up or "INJECTION MOLD" in up:
        return "Injection Moulding"
    if "DIE CAST" in up or "DIECASTING" in up:
        return "Die Casting"
    if "CAST" in up and "BROADCAST" not in up:
        return "Sand Casting"
    if "TURN" in up or "LATHE" in up:
        return "CNC Turning"
    # Sheet metal if explicit sheet or thin material
    if any(k in up for k in ("CRCA","SHEET METAL")):
        return "Sheet Metal Fabrication"
    if thickness > 0 and thickness < 6.0:
        return "Sheet Metal Fabrication"
    # Default to machining (catches aluminum billet, etc.)
    return "CNC Machining"


def _extract_notes(flat: str) -> str:
    m = re.search(r"NOTES?[:\s]*\n([\s\S]{10,400}?)(?:\n{2,}|\Z)", flat, re.I)
    return m.group(1).strip()[:300] if m else ""


# ─── Fallback ─────────────────────────────────────────────────────────────────

_FALLBACK: dict[str, Any] = {
    "material": "Not specified", "material_confidence": 0.0,
    "process": "Not specified",
    "dimensions_mm": {"L": 0, "W": 0, "H": 0},
    "tightest_tolerance_mm": 0, "tolerance_confidence": 0.0,
    "surface_finish_ra": 0, "surface_finish_confidence": 0.0,
    "sheet_thickness_mm": 0, "sheet_thickness_confidence": 0.0,
    "bend_count": 0,
    "heat_treatment": "None", "coating": "None", "chemical_milling": "None",
    "gear_quality": "None", "gear_shaving": "None", "gear_shaping": "None", "polygon_callout": "None",
    "complexity": "medium",
    "threads": [], "knurls": [], "gdt_callouts": [], "clearanceHoles": [],
    "general_tolerances": "",
    "machining_allowance": None,
    "drawing_revision": "", "drawing_number": "",
    "drawing_notes": "",
    "drawing_intelligence_confidence": 0.0,
}


# ─── Request / endpoint ───────────────────────────────────────────────────────

class AnalyzeDrawingRequest(BaseModel):
    imageBase64: str
    mediaType: str = "image/png"
    partNumber: str | None = None


@router.post("/analyze")
async def analyze_drawing(body: AnalyzeDrawingRequest) -> dict[str, Any]:
    if body.mediaType != "application/pdf":
        result = dict(_FALLBACK)
        result["drawing_notes"] = (
            "Image drawings require OCR. Upload as a vector PDF "
            "exported from your CAD system for automatic field extraction."
        )
        result["analyzedAt"] = datetime.now(timezone.utc).isoformat()
        return result

    try:
        pdf_bytes = base64.b64decode(body.imageBase64)
        blocks, flat = _extract_blocks(pdf_bytes)
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("PDF extraction failed")
        raise HTTPException(422, f"PDF extraction failed: {exc}") from exc

    if not flat.strip():
        result = dict(_FALLBACK)
        result["drawing_notes"] = (
            "No text found — this PDF appears to be scanned/rasterized. "
            "Export from your CAD system as a vector PDF for text extraction."
        )
        result["analyzedAt"] = datetime.now(timezone.utc).isoformat()
        return result

    # Pass 1 — spatial title block key-value matching
    tb = _extract_title_block(blocks)
    logger.debug("Title block pairs: %s", tb)

    drawing_no = _extract_drawing_number(tb, flat, body.partNumber)
    material, mat_conf     = _extract_material(tb, flat)
    sheet_thick, thick_conf = _extract_sheet_thickness(tb, flat)
    tolerance, tol_conf    = _extract_tolerance(tb, flat)
    surface_ra, ra_conf    = _extract_surface_finish(tb, flat)
    revision               = _extract_revision(tb, flat, drawing_no)
    coating                = _extract_coating(tb, flat)

    found = sum([mat_conf > 0, sheet_thick > 0, tolerance > 0, surface_ra > 0, bool(revision)])
    intelligence = round(min(1.0, found / 4), 2)

    result: dict[str, Any] = {
        "material":                    material,
        "material_confidence":         round(mat_conf, 2),
        "process":                     _extract_process(flat, sheet_thick, material),
        "dimensions_mm":               _extract_dimensions(flat),
        "tightest_tolerance_mm":       tolerance,
        "tolerance_confidence":        round(tol_conf, 2),
        "surface_finish_ra":           surface_ra,
        "surface_finish_confidence":   round(ra_conf, 2),
        "sheet_thickness_mm":          sheet_thick,
        "sheet_thickness_confidence":  round(thick_conf, 2),
        "bend_count":                  _extract_bend_count(flat),
        "heat_treatment":              _extract_heat_treatment(tb, flat),
        "chemical_milling":            _extract_chemical_milling(tb, flat),
        "gear_quality":                _extract_gear_quality(flat),
        "gear_shaving":                _match_or_none(_GEAR_SHAVING_RE, flat),
        "gear_shaping":                _match_or_none(_GEAR_SHAPING_RE, flat),
        "polygon_callout":             _match_or_none(_POLYGON_RE, flat),
        "coating":                     coating,
        "complexity":                  "medium",
        "threads":                     _extract_threads(flat),
        "knurls":                      _extract_knurls(flat),
        "gdt_callouts":                [],
        "clearanceHoles":              [],
        "general_tolerances":          _extract_general_tolerance(tb, flat),
        "machining_allowance":         _extract_machining_allowance(flat),
        "drawing_revision":            revision,
        "drawing_number":              drawing_no,
        "drawing_notes":               _extract_notes(flat),
        "drawing_intelligence_confidence": intelligence,
        "analyzedAt":                  datetime.now(timezone.utc).isoformat(),
    }

    logger.info(
        "Drawing parsed: no=%s rev=%s material=%s(%.2f) thk=%.1f tol=%.3f "
        "ra=%.1f coating=%s threads=%d knurls=%d tb_keys=%s",
        drawing_no, revision, material, mat_conf,
        sheet_thick, tolerance, surface_ra, coating,
        len(result["threads"]), len(result["knurls"]), list(tb.keys()),
    )
    return result
