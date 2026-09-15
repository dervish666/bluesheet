"""Turn the gcode inside a sliced 3mf into toolpaths a browser can draw.

Shape of the output is fixed by the API contract:

    {layers: [{z, h, paths: [{type, pts: [x, y, x, y, ...]}]}], ...}

Three things make this less trivial than it sounds.

*Size.* A 700-layer print is tens of megabytes of gcode and, transcribed
literally, tens of megabytes of JSON. Nobody can draw five million points and no
iPad wants to parse them. Points are therefore simplified *during* the parse
(collinear runs collapse to their endpoints, which is exactly what a wall is),
and the serving side has a point budget it meets by dropping the least
informative content — sparse infill first, then whole layers — and says so in
the response rather than silently thinning.

*Dialect.* OrcaSlicer 2.4 marks features with `; FEATURE: Outer wall` and layers
with `; CHANGE_LAYER` / `; Z_HEIGHT:`, not the `;TYPE:`/`;LAYER_CHANGE` of the
PrusaSlicer family, and Bambu gcode is relative-E (M83). Arc fitting is *on* in
the A1 mini profiles, so G2/G3 appear and have to be flattened or curves come out
as chords. Coordinates are written like `Z.6` and `E-.8`, which float() accepts
and a naive regex does not.

*The prologue.* Everything before the first layer change is the A1's purge and
calibration line, which legitimately travels to X-30 and Y185. Including it would
put the bounding box off the bed and paint a stray line across the preview.
"""
import array
import math
import re
import zipfile

from . import threemf

FEATURE_TOKENS = {
    "outer wall": "outer", "inner wall": "inner", "overhang wall": "overhang",
    "sparse infill": "sparse", "internal solid infill": "solid",
    "top surface": "top", "bottom surface": "bottom",
    "internal bridge": "bridge", "bridge infill": "bridge", "bridge": "bridge",
    "support": "support", "support interface": "support-if",
    "support transition": "support", "skirt": "skirt", "brim": "brim",
    "gap infill": "gap", "ironing": "ironing", "prime tower": "prime",
    "custom": "custom", "wipe tower": "prime",
}
TYPE_NAMES = {
    "outer": "Outer wall", "inner": "Inner wall", "overhang": "Overhang wall",
    "sparse": "Sparse infill", "solid": "Solid infill", "top": "Top surface",
    "bottom": "Bottom surface", "bridge": "Bridge", "support": "Support",
    "support-if": "Support interface", "skirt": "Skirt", "brim": "Brim",
    "gap": "Gap infill", "ironing": "Ironing", "prime": "Prime tower",
    "custom": "Custom gcode", "travel": "Travel", "other": "Other",
}
# Dropped first when a request is over budget: infill is the bulk of the points
# and the least useful thing to look at.
SHEDDABLE = ("sparse", "solid", "ironing", "gap")

_SLUG = re.compile(r"[^a-z0-9]+")
SIMPLIFY_EPS = 0.02     # mm; a wall is straight to well under a nozzle width
MAX_COLLAPSE = 64       # consecutive points a simplify run may swallow
ARC_TOLERANCE = 0.05    # mm sagitta when flattening G2/G3


def _token(name):
    key = name.strip().lower()
    if key in FEATURE_TOKENS:
        return FEATURE_TOKENS[key]
    slug = _SLUG.sub("-", key).strip("-")
    return slug or "other"


class _Path:
    """A polyline being built, simplified as it grows.

    Points are held in an array('f') rather than a list: a large print has
    millions of them and 4 bytes each versus 32 for a boxed float is the
    difference between a 40 MB parse and a 400 MB one.
    """

    __slots__ = ("type", "pts", "_collapsed")

    def __init__(self, kind):
        self.type = kind
        self.pts = array.array("f")
        self._collapsed = 0

    def add(self, x, y):
        p = self.pts
        n = len(p)
        if n >= 4:
            x0, y0, x1, y1 = p[n - 4], p[n - 3], p[n - 2], p[n - 1]
            if self._collapsed < MAX_COLLAPSE and _perp(x0, y0, x, y, x1, y1) < SIMPLIFY_EPS:
                p[n - 2] = x   # the middle point carried no information
                p[n - 1] = y
                self._collapsed += 1
                return
        p.append(x)
        p.append(y)
        self._collapsed = 0

    def __len__(self):
        return len(self.pts) // 2


def _perp(x0, y0, x1, y1, px, py):
    """Distance from (px,py) to the segment (x0,y0)-(x1,y1)."""
    dx, dy = x1 - x0, y1 - y0
    seg = dx * dx + dy * dy
    if seg < 1e-12:
        return math.hypot(px - x0, py - y0)
    t = ((px - x0) * dx + (py - y0) * dy) / seg
    if t < 0.0:
        t = 0.0
    elif t > 1.0:
        t = 1.0
    return math.hypot(px - (x0 + t * dx), py - (y0 + t * dy))


def _arc_points(x0, y0, x1, y1, cx, cy, clockwise):
    """Flatten G2/G3 into segments no further than ARC_TOLERANCE from the true arc."""
    r = math.hypot(x0 - cx, y0 - cy)
    if r < 1e-9:
        return [(x1, y1)]
    a0 = math.atan2(y0 - cy, x0 - cx)
    a1 = math.atan2(y1 - cy, x1 - cx)
    sweep = a1 - a0
    if clockwise:
        while sweep >= 0:
            sweep -= 2 * math.pi
        while sweep < -2 * math.pi:
            sweep += 2 * math.pi
    else:
        while sweep <= 0:
            sweep += 2 * math.pi
        while sweep > 2 * math.pi:
            sweep -= 2 * math.pi
    # Sagitta of a chord subtending angle t on radius r is r(1-cos(t/2)).
    step = 2 * math.acos(max(-1.0, min(1.0, 1 - ARC_TOLERANCE / r))) if r > ARC_TOLERANCE else math.pi / 4
    n = max(1, min(720, int(math.ceil(abs(sweep) / max(step, 1e-3)))))
    return [(cx + r * math.cos(a0 + sweep * i / n), cy + r * math.sin(a0 + sweep * i / n))
            for i in range(1, n + 1)]


def parse(text, include_travel=False):
    """Parse plate gcode into layers of typed polylines."""
    layers = []
    cur_layer = None
    paths = []
    path = None
    kind = "other"
    x = y = z = 0.0
    e_rel = True
    last_e = 0.0
    lo = [math.inf, math.inf, math.inf]
    hi = [-math.inf, -math.inf, -math.inf]
    counts = {}
    started = False
    prologue = 0     # extruding moves dropped before the first layer change

    def close_path():
        nonlocal path
        if path is not None and len(path) > 1:
            paths.append(path)
            counts[path.type] = counts.get(path.type, 0) + len(path)
        path = None

    def close_layer():
        nonlocal cur_layer, paths
        close_path()
        if cur_layer is not None and paths:
            cur_layer["paths"] = paths
            layers.append(cur_layer)
        paths = []

    for line in text.split("\n"):
        if not line:
            continue
        c = line[0]
        if c == ";":
            # Marker comments. Cheap prefix tests before any string work: this
            # branch runs for a third of the lines in a large file.
            if line.startswith("; FEATURE:") or line.startswith(";TYPE:"):
                close_path()
                kind = _token(line.split(":", 1)[1])
            elif line.startswith("; CHANGE_LAYER") or line.startswith(";LAYER_CHANGE"):
                close_layer()
                started = True
                cur_layer = {"z": z, "h": 0.0}
            elif line.startswith("; Z_HEIGHT:") or line.startswith(";Z:"):
                if cur_layer is not None:
                    cur_layer["z"] = _num(line.split(":", 1)[1])
            elif line.startswith("; LAYER_HEIGHT:") or line.startswith(";HEIGHT:"):
                if cur_layer is not None:
                    cur_layer["h"] = _num(line.split(":", 1)[1])
            continue
        if c == "M":
            if line.startswith("M83"):
                e_rel = True
            elif line.startswith("M82"):
                e_rel = False
            continue
        if c != "G":
            continue

        code = line[1:2]
        if code not in "0123":
            continue
        if line[2:3].isdigit():
            continue  # G10/G11/G28/G90/G92 — a second digit means it is not a move
        if ";" in line:
            line = line.split(";", 1)[0]
        nx, ny, nz, ne, ai, aj = x, y, z, None, 0.0, 0.0
        for tok in line.split():
            head = tok[0]
            if head == "X":
                nx = _num(tok[1:])
            elif head == "Y":
                ny = _num(tok[1:])
            elif head == "Z":
                nz = _num(tok[1:])
            elif head == "E":
                ne = _num(tok[1:])
            elif head == "I":
                ai = _num(tok[1:])
            elif head == "J":
                aj = _num(tok[1:])

        if ne is None:
            extruding = False
        elif e_rel:
            extruding = ne > 1e-9
        else:
            extruding = ne > last_e + 1e-9
            last_e = ne
        if not e_rel and ne is not None:
            last_e = ne

        moved = nx != x or ny != y
        if extruding and moved and not started:
            prologue += 1
        if started and moved and (extruding or include_travel):
            this = kind if extruding else "travel"
            if path is None or path.type != this:
                close_path()
                path = _Path(this)
                path.add(x, y)
            if code in "23":
                for px, py in _arc_points(x, y, nx, ny, x + ai, y + aj, code == "2"):
                    path.add(px, py)
            else:
                path.add(nx, ny)
            for v, i in ((nx, 0), (ny, 1), (nz, 2)):
                if v < lo[i]:
                    lo[i] = v
                if v > hi[i]:
                    hi[i] = v
        elif moved or nz != z:
            close_path()   # a travel breaks the polyline even when not drawn
        x, y, z = nx, ny, nz

    close_layer()
    total = sum(counts.values())
    return {
        "layers": layers,
        "layerCount": len(layers),
        "points": total,
        "counts": counts,
        # The A1 mini purges a prime line along Y = -2.5 from X 68 to 113, which
        # is off the front of the bed and would wreck both the bounding box and
        # the preview. Orca 2.4 emits it *before* the first `; CHANGE_LAYER`
        # (measured: 6 moves at lines 1081-1084 of a two-object plate, 0 after),
        # so ignoring everything before that marker is enough — no coordinate
        # filter, which would eat real geometry near the front edge. Counted so
        # the exclusion is visible rather than assumed.
        "prologueMoves": prologue,
        "bbox": None if not layers else {
            "min": [lo[0], lo[1], lo[2]], "max": [hi[0], hi[1], hi[2]],
            "size": [hi[i] - lo[i] for i in range(3)],
            "center": [(hi[i] + lo[i]) / 2 for i in range(3)],
        },
    }


def _num(s):
    """float() that survives gcode's dialect: leading dots, trailing junk, and
    the occasional bare letter."""
    try:
        return float(s)
    except ValueError:
        m = re.match(r"[-+]?(?:\d*\.?\d+)", s)
        return float(m.group(0)) if m else 0.0


MAX_GCODE_BYTES = 400 * 1024 * 1024


def parse_3mf(path, plate=1, include_travel=False):
    with zipfile.ZipFile(path) as zf:
        plates = threemf.plate_members(zf)
        if not plates:
            raise threemf.ThreeMFError("no plate gcode in this 3mf")
        member = dict(plates).get(plate, plates[0][1])
        # Decompressed size is known before decompressing, and the decode doubles
        # it — worth refusing rather than swapping the laptop to death.
        size = zf.getinfo(member).file_size
        if size > MAX_GCODE_BYTES:
            raise threemf.ThreeMFError(
                f"{member} is {size / 1e6:.0f} MB of gcode, too large to parse "
                f"(limit {MAX_GCODE_BYTES / 1e6:.0f} MB)")
        text = zf.read(member).decode("utf-8", "replace")
    return parse(text, include_travel=include_travel)


def to_jsonable(parsed):
    """Convert the array-backed parse into plain lists for JSON/caching.

    Coordinates are rounded to 3 dp on the way out: a tenth of a micron is far
    below anything a printer or a screen can express, and the shorter numbers cut
    the serialised size by about a third.
    """
    out_layers = []
    for layer in parsed["layers"]:
        out_layers.append({
            "z": round(layer["z"], 3),
            "h": round(layer.get("h", 0.0), 3),
            "paths": [{"type": p.type, "pts": [round(v, 3) for v in p.pts]}
                      for p in layer["paths"]],
        })
    return {
        "layers": out_layers,
        "layerCount": parsed["layerCount"],
        "points": parsed["points"],
        "counts": parsed["counts"],
        "prologueMoves": parsed.get("prologueMoves", 0),
        "bbox": parsed["bbox"],
    }


def view(doc, max_points=250_000, layer_from=0, layer_to=None, stride=1,
         types=None, drop=()):
    """Cut a jsonable parse down to something worth sending.

    Returns the payload plus a `downsample` block describing exactly what was
    removed, because a preview that quietly hides half the toolpaths is a lie the
    viewer would have no way to notice.
    """
    layers = doc["layers"]
    n = len(layers)
    layer_to = n if layer_to is None else max(0, min(n, layer_to))
    layer_from = max(0, min(layer_from, layer_to))
    stride = max(1, int(stride))
    dropped = list(drop)
    wanted = set(types) if types else None

    def build(stride_now, dropping):
        out = []
        pts = 0
        for i in range(layer_from, layer_to, stride_now):
            layer = layers[i]
            keep = []
            for p in layer["paths"]:
                if p["type"] in dropping:
                    continue
                if wanted is not None and p["type"] not in wanted:
                    continue
                keep.append(p)
                pts += len(p["pts"]) // 2
            if keep:
                out.append({"i": i, "z": layer["z"], "h": layer["h"], "paths": keep})
        return out, pts

    selected, points = build(stride, set(dropped))
    # Shed the bulky, least informative content before thinning layers: losing
    # every third layer is more visible than losing infill.
    for kind in SHEDDABLE:
        if points <= max_points:
            break
        dropped.append(kind)
        selected, points = build(stride, set(dropped))
    while points > max_points and stride < 64:
        stride *= 2
        selected, points = build(stride, set(dropped))

    return {
        "layers": selected,
        "layerCount": doc["layerCount"],
        "bbox": doc["bbox"],
        "typeNames": TYPE_NAMES,
        "prologueMoves": doc.get("prologueMoves", 0),
        "downsample": {
            "points": points,
            "budget": max_points,
            "stride": stride,
            "droppedTypes": dropped,
            "range": [layer_from, layer_to],
            "sourcePoints": doc["points"],
        },
    }
