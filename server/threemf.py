"""Read a sliced 3mf back and report what it will *actually* do on the printer.

The slicer's exit code lies. It returns 0 for a slice that silently dropped the
settings you asked for — vase mode is the notorious case: lose `spiral_mode` and
you get a solid 250 g brick, a clean exit and nothing in the output that says so.
So every slice Bluesheet produces is re-opened here and its embedded plate gcode is
read: the `; key = value` config block is ground truth for the settings, and the
estimates live in the HEADER_BLOCK as prose ("; model printing time: 28m 11s"),
not as machine-readable fields.

Two layout facts make this cheap on big files. The header and config blocks sit
at the *top* of the gcode, and the filament totals sit in the last few hundred
bytes; nothing we need is in the middle. A zip member cannot be seeked, so the
stream is walked once with a rolling tail buffer and the (potentially 80 MB)
body is decompressed and thrown away rather than held as a string.
"""
import re
import xml.etree.ElementTree as ET
import zipfile

from . import util

PLATE_GCODE = re.compile(r"^Metadata/plate_(\d+)\.gcode$")
_SETTING = re.compile(r"^; ([a-z_0-9]+) = (.*)$", re.M)
_END_OF_INTEREST = b"; EXECUTABLE_BLOCK_START"

# Prose estimates, in the order we like to report them.
_ESTIMATES = (
    ("timeText", r"^; model printing time: ([^;\n]+)"),
    ("totalTimeText", r"total estimated time: (.+)$"),
    ("firstLayerText", r"^; estimated first layer printing time \(normal mode\) = (.+)$"),
    ("layers", r"^; total layer number: (\d+)"),
    ("heightMm", r"^; max_z_height: ([\d.]+)"),
    ("filamentMm", r"^; filament used \[mm\] ?= ?([\d.]+)"),
    ("filamentCm3", r"^; filament used \[cm3\] ?= ?([\d.]+)"),
    ("grams", r"^; filament used \[g\] ?= ?([\d.]+)"),
    ("cost", r"^; filament cost ?= ?([\d.]+)"),
)
_NUMERIC = {"layers": int, "heightMm": float, "filamentMm": float,
            "filamentCm3": float, "grams": float, "cost": float}


class ThreeMFError(Exception):
    pass


def plate_members(zf):
    """[(plate_number, member_name), ...] sorted by plate number."""
    out = []
    for name in zf.namelist():
        m = PLATE_GCODE.match(name)
        if m:
            out.append((int(m.group(1)), name))
    out.sort()
    return out


def _scan(zf, member, head_cap=4 * 1024 * 1024, tail_bytes=4096):
    """Return (head_text, tail_text) for a gcode member without materialising it.

    Stops *collecting* the head at the executable block but keeps reading, because
    the filament totals are written after the last M-code and there is no way to
    seek to them in a deflate stream.
    """
    head = bytearray()
    tail = b""
    done_head = False
    with zf.open(member) as f:
        while True:
            chunk = f.read(1 << 20)
            if not chunk:
                break
            if not done_head:
                head += chunk
                if _END_OF_INTEREST in head or len(head) >= head_cap:
                    done_head = True
                    del head[head_cap:]
            tail = (tail + chunk)[-tail_bytes:]
    return (head.decode("utf-8", "replace"), tail.decode("utf-8", "replace"))


def settings_of(text):
    """The `; key = value` config block as a dict of strings."""
    return dict(_SETTING.findall(text))


def estimates_of(head, tail):
    out = {}
    both = head + "\n" + tail
    for key, pattern in _ESTIMATES:
        m = re.search(pattern, both, re.M)
        if m:
            value = m.group(1).strip()
            cast = _NUMERIC.get(key)
            if cast:
                try:
                    value = cast(value)
                except ValueError:
                    continue
            out[key] = value
    out["timeSec"] = util.parse_time_text(out.get("timeText"))
    out["totalTimeSec"] = util.parse_time_text(out.get("totalTimeText"))
    return out


def slice_info(zf):
    """Metadata/slice_info.config — the slicer's own verdict on the plate.

    Worth having for one field above all: `outside`, which is Orca telling us the
    model does not fit the bed. Cheaper and more trustworthy than bounding-boxing
    the extrusion moves ourselves, and it does not need the whole gcode.
    """
    info = {"plate": {}, "filaments": [], "objects": []}
    try:
        raw = zf.read("Metadata/slice_info.config")
    except KeyError:
        return info
    try:
        root = ET.fromstring(raw)
    except ET.ParseError:
        return info
    plate = root.find("plate")
    if plate is None:
        return info
    for md in plate.findall("metadata"):
        info["plate"][md.get("key", "")] = md.get("value", "")
    for fil in plate.findall("filament"):
        info["filaments"].append({
            "id": fil.get("id"), "type": fil.get("type"), "color": fil.get("color"),
            "usedM": util.as_number(fil.get("used_m"), 0.0),
            "usedG": util.as_number(fil.get("used_g"), 0.0),
        })
    for obj in plate.findall("object"):
        info["objects"].append(obj.get("name", ""))
    return info


# Settings worth reporting back with every slice: the ones that change what comes
# off the bed, plus the ones that prove we sliced for the right machine.
REPORT_KEYS = (
    "layer_height", "initial_layer_print_height", "sparse_infill_density",
    "sparse_infill_pattern", "wall_loops", "top_shell_layers", "bottom_shell_layers",
    "spiral_mode", "enable_support", "support_type", "brim_type", "brim_width",
    "filament_type", "filament_density", "nozzle_diameter", "printer_model",
    "curr_bed_type", "print_settings_id", "filament_settings_id", "printer_settings_id",
)


def summarize(path, plate=1):
    """Everything we know about a sliced file, read from the file itself."""
    with zipfile.ZipFile(path) as zf:
        plates = plate_members(zf)
        if not plates:
            raise ThreeMFError("no plate gcode inside the 3mf — the slice produced "
                               "geometry only (usually a profile compatibility failure)")
        member = dict(plates).get(plate, plates[0][1])
        head, tail = _scan(zf, member)
        info = slice_info(zf)
    settings = settings_of(head)
    if not settings:
        raise ThreeMFError(f"no config block in {member} — file is not a sliced 3mf")
    est = estimates_of(head, tail)

    # Orca only fills `filament used [g]` when it can see a density, and via the
    # CLI it usually cannot (see slicer.filament_density). Fall back to the volume,
    # which is always present, times whatever density did land.
    density = util.as_number(settings.get("filament_density", "").strip("[]\" "), 0.0)
    if not est.get("grams") and est.get("filamentCm3") and density:
        est["grams"] = round(est["filamentCm3"] * density, 2)
        est["gramsEstimated"] = True

    return {
        "plate": plate,
        "member": member,
        "settings": {k: settings[k] for k in REPORT_KEYS if k in settings},
        "allSettings": settings,
        "estimates": est,
        "sliceInfo": info,
        "outsideBed": str(info["plate"].get("outside", "")).lower() == "true",
        "supportUsed": str(info["plate"].get("support_used", "")).lower() == "true",
    }


def _norm_pct(text):
    return str(text).strip().rstrip("%")


def verify(settings, wanted):
    """Assert the settings we asked for are the settings in the file.

    `wanted` is {gcode_key: (kind, value)} with kind in num|pct|str. Returns a list
    of rows, one per key, each {key, want, got, ok} — the caller decides whether a
    mismatch is fatal. Every row is reported, not just the failures, because the
    passing rows are the evidence that the check actually ran.
    """
    rows = []
    for key, (kind, value) in sorted(wanted.items()):
        got = settings.get(key)
        if got is None:
            ok = False
        elif kind == "num":
            a, b = util.as_number(got), util.as_number(value)
            ok = a is not None and b is not None and abs(a - b) < 1e-6
        elif kind == "pct":
            a, b = util.as_number(_norm_pct(got)), util.as_number(_norm_pct(value))
            ok = a is not None and b is not None and abs(a - b) < 1e-6
        else:
            ok = str(got).strip() == str(value).strip()
        rows.append({"key": key, "want": str(value), "got": got, "ok": bool(ok)})
    return rows
