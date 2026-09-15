"""The bundled TTFs, described well enough for a font picker.

The browser loads the actual outlines itself (js/kernel/text.js parses the file);
this only needs to say what is in assets/fonts without the UI having to download
three megabytes of font to find out. So the sfnt tables are read here directly —
`name` for the human names, `head` for unitsPerEm, `maxp` for the glyph count —
which is a couple of dozen lines and saves shipping a metadata sidecar that would
drift out of step with the files.
"""
import os
import struct

from . import util

FONT_EXT = (".ttf", ".otf")
# Windows/Unicode BMP first: it is what modern fonts actually fill in, and it is
# UTF-16BE rather than the Mac tables' undeclared legacy encodings.
_PREFERRED = ((3, 1), (3, 0), (0, 3), (0, 4), (1, 0))
_NAME_IDS = {1: "family", 2: "subfamily", 4: "fullName", 5: "version",
             6: "postScriptName", 13: "licence", 16: "typographicFamily"}


def _tables(data):
    if len(data) < 12:
        raise ValueError("not a font: too short")
    tag = data[:4]
    if tag not in (b"\x00\x01\x00\x00", b"true", b"OTTO", b"ttcf"):
        raise ValueError(f"unrecognised sfnt tag {tag!r}")
    if tag == b"ttcf":
        (offset,) = struct.unpack_from(">I", data, 12)  # first font in a collection
        return _tables(data[:0] + data) if offset == 0 else _dir_at(data, offset)
    return _dir_at(data, 0)


def _dir_at(data, base):
    (num,) = struct.unpack_from(">H", data, base + 4)
    out = {}
    for i in range(num):
        off = base + 12 + i * 16
        if off + 16 > len(data):
            break
        tag, _sum, start, length = struct.unpack_from(">4sIII", data, off)
        out[tag.decode("latin-1").strip()] = (start, length)
    return out


def _decode(raw, platform, encoding):
    if (platform, encoding) in ((3, 1), (3, 0), (0, 3), (0, 4)) or platform == 0:
        try:
            return raw.decode("utf-16-be").strip("\x00").strip()
        except UnicodeDecodeError:
            pass
    return raw.decode("latin-1", "replace").strip("\x00").strip()


def read_names(data, tables):
    if "name" not in tables:
        return {}
    start, length = tables["name"]
    if start + 6 > len(data):
        return {}
    _fmt, count, string_off = struct.unpack_from(">HHH", data, start)
    best = {}
    for i in range(count):
        rec = start + 6 + i * 12
        if rec + 12 > len(data):
            break
        plat, enc, _lang, name_id, slen, soff = struct.unpack_from(">HHHHHH", data, rec)
        key = _NAME_IDS.get(name_id)
        if not key:
            continue
        pos = start + string_off + soff
        if pos + slen > len(data):
            continue
        rank = _PREFERRED.index((plat, enc)) if (plat, enc) in _PREFERRED else len(_PREFERRED)
        if key in best and best[key][0] <= rank:
            continue
        best[key] = (rank, _decode(data[pos:pos + slen], plat, enc))
    return {k: v[1] for k, v in best.items()}


def describe(path):
    with open(path, "rb") as f:
        data = f.read()
    tables = _tables(data)
    info = read_names(data, tables)
    if "head" in tables:
        start, _ = tables["head"]
        if start + 20 <= len(data):
            (upem,) = struct.unpack_from(">H", data, start + 18)
            info["unitsPerEm"] = upem
    if "maxp" in tables:
        start, _ = tables["maxp"]
        if start + 6 <= len(data):
            (glyphs,) = struct.unpack_from(">H", data, start + 4)
            info["glyphs"] = glyphs
    info["outlines"] = "cff" if "CFF" in tables else "glyf" if "glyf" in tables else "unknown"
    return info


_cache = {"key": None, "value": []}


def listing():
    """Every bundled font, with its licence file if one sits beside it.

    Cached against the directory's mtime: /api/health reports the count, and
    re-parsing half a megabyte of sfnt tables on every poll is a silly way to
    spend a laptop.
    """
    try:
        key = os.stat(util.FONT_DIR).st_mtime_ns
    except OSError:
        key = None
    if _cache["key"] == key and key is not None:
        return _cache["value"]
    out = _build()
    _cache["key"], _cache["value"] = key, out
    return out


def _build():
    out = []
    try:
        names = sorted(os.listdir(util.FONT_DIR))
    except OSError:
        return out
    licences = {n for n in names if n.upper().endswith(".LICENSE.TXT")
                or n.upper().endswith(".LICENCE.TXT")}
    for name in names:
        if not name.lower().endswith(FONT_EXT) or name.startswith("."):
            continue
        path = os.path.join(util.FONT_DIR, name)
        stem = os.path.splitext(name)[0]
        entry = {
            "id": stem,
            "file": name,
            "url": "/assets/fonts/" + name,
            "bytes": os.path.getsize(path),
        }
        try:
            entry.update(describe(path))
        except (OSError, ValueError, struct.error) as e:
            # A font we cannot describe is still a font the browser may be able to
            # use, so it is listed with the reason rather than hidden.
            entry["error"] = str(e)
        licence = next((l for l in licences if l.startswith(stem)), None)
        if licence:
            entry["licence"] = {"file": licence, "url": "/assets/fonts/" + licence}
        # A sensible default for a picker that has not loaded anything yet.
        entry["label"] = entry.get("fullName") or entry.get("family") or stem
        out.append(entry)
    return out
