"""Drive OrcaSlicer headlessly, then prove it did what it was told.

Five things about this toolchain cost real time to learn. Four are in the vault
under "Headless slicing for Bambu printers"; the fifth was measured while writing
this file. All five are load-bearing here:

 1. A hand-flattened profile with `from: "system"` and no `inherits` never
    slices — the compatibility check walks the inheritance chain itself, so it
    fails with "process not compatible with printer" whatever compatible_printers
    says. Exit -17, nothing useful on stderr.
 2. Overrides therefore ride in a *User overlay* that keeps `inherits`, and the
    overlay must carry its own `compatible_printers` — that key is not inherited
    for the compatibility check.
 3. `--outputdir` is prepended to `--export-3mf`, so the 3mf name must be bare.
 4. Vase mode fails silently — and not only in the direction the vault records.
    Asking for `spiral_mode: 1` with the shell settings left contradicting it does
    not drop spiral mode on 2.4.2: the slicer silently rewrote `wall_loops` 2 → 1
    and `sparse_infill_density` 15% → 0% to make vase mode possible, and exited 0
    (measured 2026-08-21). It resolves a contradiction in whichever direction it
    likes and tells you nothing either way, so the check has to be "every setting
    I sent is the setting in the file", not "spiral mode survived". The exit code
    is not evidence; only re-reading the produced file is (threemf.py).
 5. `inherits` satisfies the compatibility check and *nothing else* — it does not
    pull the parent's values through. Unset keys fall back to the printer's
    default process, not to the named parent. Measured 2026-08-21 on a 20 mm cube:
    an overlay inheriting "0.12mm Fine @BBL A1M" and setting only layer_height
    sliced at outer_wall_speed 60 (the 0.20mm Standard default) for 38m 0s;
    the same slice with the parent chain fully resolved into the overlay used
    outer_wall_speed 200 and took 28m 0s. Same layer count, 26% different time,
    no warning of any kind.

So the overlay is built by resolving the preset's whole `inherits` chain here in
Python and writing every resolved key explicitly, while *keeping* `inherits` so
the compatibility check still passes. That is not the flattening of trap 1 — the
chain is still there for Orca to walk; we have simply left nothing to fall back.

The same trick fixes the weight: via the CLI, `filament_density` resolves to 0 and
every slice reports "filament used [g] = 0". With the filament chain resolved into
a filament overlay, grams appear (3.75 g for the test cube).
"""
import os
import re
import shutil
import subprocess
import threading
import time

from . import stlio, threemf, util

HOME = os.path.expanduser("~")
ORCA = os.environ.get("BLUESHEET_ORCA", os.path.join(HOME, ".local/bin/orca.AppImage"))
PROFILES = os.environ.get("BLUESHEET_PROFILES", os.path.join(HOME, ".local/share/orca-profiles"))
DATADIR = os.environ.get("BLUESHEET_DATADIR", os.path.join(HOME, ".local/share/orca-datadir"))
VENDOR = "BBL"
MACHINE = "Bambu Lab A1 mini 0.4 nozzle"
BED = (180.0, 180.0, 180.0)

# Curated shortlist for the UI. Keys are what the browser sends; values are the
# vendor preset names. Anything on disk can also be named in full by the caller.
PROCESS_PRESETS = {
    "draft": ("Draft · 0.28 mm", "0.28mm Extra Draft @BBL A1M"),
    "standard": ("Standard · 0.20 mm", "0.20mm Standard @BBL A1M"),
    "strength": ("Strength · 0.20 mm", "0.20mm Strength @BBL A1M"),
    "optimal": ("Optimal · 0.16 mm", "0.16mm Optimal @BBL A1M"),
    "fine": ("Fine · 0.12 mm", "0.12mm Fine @BBL A1M"),
    "extrafine": ("Extra fine · 0.08 mm", "0.08mm Extra Fine @BBL A1M"),
}
FILAMENT_PRESETS = {
    "pla": ("Bambu PLA Basic", "Bambu PLA Basic @BBL A1M"),
    "pla-matte": ("Bambu PLA Matte", "Bambu PLA Matte @BBL A1M"),
    "pla-silk": ("Bambu PLA Silk", "Bambu PLA Silk @BBL A1M"),
    "pla-cf": ("Bambu PLA-CF", "Bambu PLA-CF @BBL A1M"),
    "petg": ("Bambu PETG HF", "Bambu PETG HF @BBL A1M"),
    "petg-translucent": ("Bambu PETG Translucent", "Bambu PETG Translucent @BBL A1M"),
    "tpu": ("Bambu TPU 95A HF", "Bambu TPU 95A HF @BBL A1M"),
    "generic-pla": ("Generic PLA", "Generic PLA @BBL A1M"),
    "generic-petg": ("Generic PETG", "Generic PETG @BBL A1M"),
}
BED_TYPES = {
    "textured": "Textured PEI Plate",
    "smooth": "Smooth PEI Plate",
    "cool": "Cool Plate",
    "engineering": "Engineering Plate",
    "high-temp": "High Temp Plate",
    "supertack": "Cool Plate (SuperTack)",
}
BRIM_TYPES = {"auto": "auto_brim", "none": "no_brim", "outer": "outer_only",
              "inner": "inner_only", "both": "outer_and_inner"}

# Identity keys: ours to set, never copied from the resolved parent chain.
_IDENTITY = {"inherits", "from", "name", "type", "version", "setting_id",
             "instantiation", "description", "compatible_printers",
             "compatible_printers_condition", "is_custom_defined", "filament_id",
             "renamed_from", "sub_path"}

# Settings whose loss changes what comes off the bed. Every one is asserted
# against the produced file; a mismatch fails the slice rather than printing.
_CRITICAL = ("layer_height", "sparse_infill_density", "spiral_mode", "enable_support",
             "wall_loops", "filament_type")

_slice_lock = threading.Lock()
_preset_cache = {}
_preset_lock = threading.Lock()
_version_cache = {"value": None}


MAX_QUEUED = 3
_queued = [0]
_queue_guard = threading.Lock()


class SliceError(RuntimeError):
    """A slice that did not happen, or happened but produced the wrong thing."""

    def __init__(self, message, log_tail="", detail=None):
        super().__init__(message)
        self.log_tail = log_tail
        self.detail = detail or {}


class SliceBusy(SliceError):
    """Too many slices already waiting. Distinct so the API can answer 503 and a
    client knows to retry, rather than 422 which means the request was wrong."""


# ---------------------------------------------------------------- profiles

def preset_path(kind, name):
    return os.path.join(PROFILES, VENDOR, kind, name + ".json")


def load_preset(kind, name):
    path = preset_path(kind, name)
    if not os.path.isfile(path):
        return None
    return util.read_json(path)


def resolve_preset(kind, name, _seen=None):
    """Flatten a preset's whole `inherits` chain, child winning over parent.

    Cached: the chain is 3-4 files deep and gets walked on every slice request.
    """
    key = (kind, name)
    with _preset_lock:
        if key in _preset_cache:
            return dict(_preset_cache[key])
    seen = _seen or set()
    if name in seen:
        raise SliceError(f"circular inherits in {kind} preset {name!r}")
    seen.add(name)
    data = load_preset(kind, name)
    if data is None:
        raise SliceError(f"no such {kind} preset: {name!r}")
    parent = data.get("inherits")
    merged = resolve_preset(kind, parent, seen) if parent else {}
    merged.update(data)
    merged.pop("inherits", None)
    if not _seen:
        with _preset_lock:
            _preset_cache[key] = dict(merged)
    return merged


def available():
    """What the slicing toolchain looks like right now — for /api/health."""
    machine_ok = os.path.isfile(preset_path("machine", MACHINE))
    return {
        "orca": os.path.isfile(ORCA) and os.access(ORCA, os.X_OK),
        "orcaPath": ORCA,
        "profiles": os.path.isdir(os.path.join(PROFILES, VENDOR)) and machine_ok,
        "datadir": os.path.isdir(os.path.join(DATADIR, "system", VENDOR)),
        "machine": MACHINE,
        "version": _version_cache["value"],
        "bed": {"x": BED[0], "y": BED[1], "z": BED[2]},
        "profileList": [{"id": k, "label": v[0], "preset": v[1],
                         "layerH": _preset_layer_height(v[1])}
                        for k, v in PROCESS_PRESETS.items()
                        if os.path.isfile(preset_path("process", v[1]))],
        "filamentList": [{"id": k, "label": v[0], "preset": v[1]}
                         for k, v in FILAMENT_PRESETS.items()
                         if os.path.isfile(preset_path("filament", v[1]))],
        "bedTypes": [{"id": k, "label": v} for k, v in BED_TYPES.items()],
    }


def _preset_layer_height(preset):
    try:
        return util.as_number(resolve_preset("process", preset).get("layer_height"))
    except SliceError:
        return None


def probe_version(timeout=20):
    """OrcaSlicer prints its version in the usage banner; there is no --version.
    Runs once in a background thread at startup so /api/health never waits on an
    AppImage mount."""
    if not (os.path.isfile(ORCA) and os.access(ORCA, os.X_OK)):
        return None
    try:
        p = subprocess.run([ORCA, "--help"], capture_output=True, text=True,
                           timeout=timeout)
        m = re.search(r"OrcaSlicer[- ]([\d.]+)", (p.stdout or "") + (p.stderr or ""))
        _version_cache["value"] = m.group(1) if m else None
    except (OSError, subprocess.SubprocessError):
        _version_cache["value"] = None
    return _version_cache["value"]


def ensure_datadir():
    """Seed the vendor bundle into a datadir as a *system* profile set. This is
    what makes trap 1 avoidable: the presets we pass on the command line are the
    originals, and Orca can walk their chain because the bundle is installed."""
    marker = os.path.join(DATADIR, "system", VENDOR)
    if os.path.isdir(marker):
        return False
    src = os.path.join(PROFILES, VENDOR)
    if not os.path.isdir(src):
        raise SliceError(f"no vendor profiles at {src} — cannot slice")
    os.makedirs(os.path.join(DATADIR, "system"), exist_ok=True)
    shutil.copytree(src, marker, dirs_exist_ok=True)
    shutil.copy(os.path.join(PROFILES, VENDOR + ".json"),
                os.path.join(DATADIR, "system", VENDOR + ".json"))
    return True


# ---------------------------------------------------------------- settings

_OVERRIDE_KEY = re.compile(r"\A[a-z][a-z0-9_]{1,63}\Z")


def normalise(raw):
    """Validate and canonicalise the settings a browser sent.

    The result is what gets hashed for the cache key, so it must be total: two
    requests that mean the same slice must produce the same dict, and anything
    the caller did not specify must be resolved to its real value here rather
    than left to the slicer's fallbacks.
    """
    raw = raw if isinstance(raw, dict) else {}
    profile = raw.get("profile") or "standard"
    if profile in PROCESS_PRESETS:
        process = PROCESS_PRESETS[profile][1]
    elif isinstance(profile, str) and os.path.isfile(preset_path("process", profile)):
        process = profile  # an exact vendor preset name
    else:
        raise SliceError(f"unknown profile {profile!r}; expected one of "
                         f"{sorted(PROCESS_PRESETS)} or a vendor preset name")

    filament = raw.get("filament") or "pla"
    if filament in FILAMENT_PRESETS:
        fil_preset = FILAMENT_PRESETS[filament][1]
    elif isinstance(filament, str) and os.path.isfile(preset_path("filament", filament)):
        fil_preset = filament
    else:
        raise SliceError(f"unknown filament {filament!r}; expected one of "
                         f"{sorted(FILAMENT_PRESETS)} or a vendor preset name")

    for kind, name in (("process", process), ("filament", fil_preset),
                       ("machine", MACHINE)):
        if not os.path.isfile(preset_path(kind, name)):
            raise SliceError(f"{kind} preset {name!r} is not installed in "
                             f"{os.path.join(PROFILES, VENDOR, kind)}")

    resolved = resolve_preset("process", process)
    warnings = []

    layer_h = util.as_number(raw.get("layerH"))
    if layer_h is None:
        layer_h = util.as_number(resolved.get("layer_height"), 0.2)
    else:
        # 0.4 nozzle: below ~0.06 the extruder cannot keep up and above 0.75×
        # nozzle the layers do not bond. Clamp rather than refuse, and say so.
        clamped = util.clamp(layer_h, 0.06, 0.30)
        if abs(clamped - layer_h) > 1e-9:
            warnings.append(f"layer height {layer_h} mm is outside 0.06–0.30 mm "
                            f"for a 0.4 nozzle; using {clamped} mm")
            layer_h = clamped
    layer_h = round(layer_h, 3)

    infill = raw.get("infill")
    infill = util.as_number(resolved.get("sparse_infill_density", "15%").rstrip("%"), 15.0) \
        if infill is None else util.as_number(infill, 15.0, 0.0, 100.0)
    infill = round(infill, 1)

    spiral = bool(raw.get("spiral"))
    supports = bool(raw.get("supports"))
    if spiral and supports:
        warnings.append("vase mode cannot use supports; supports disabled")
        supports = False

    bed = raw.get("plate") or raw.get("bed") or "textured"
    if bed in BED_TYPES:
        bed_name = BED_TYPES[bed]
    elif bed in BED_TYPES.values():
        bed_name = bed
    else:
        raise SliceError(f"unknown plate type {bed!r}; expected one of {sorted(BED_TYPES)}")

    brim = raw.get("brim") or "auto"
    if brim not in BRIM_TYPES:
        raise SliceError(f"unknown brim {brim!r}; expected one of {sorted(BRIM_TYPES)}")

    overrides = {}
    managed = {"layer_height", "sparse_infill_density", "enable_support"}
    if spiral:
        managed |= {"spiral_mode", "wall_loops", "top_shell_layers",
                    "bottom_shell_layers", "detect_thin_wall"}
    for key, value in (raw.get("overrides") or {}).items():
        if not _OVERRIDE_KEY.match(str(key)):
            raise SliceError(f"bad override key {key!r}")
        if key in managed:
            raise SliceError(f"override {key!r} fights a setting Bluesheet derives from "
                             f"the request; set it through layerH/infill/supports/"
                             f"spiral instead")
        if isinstance(value, (str, int, float)) and not isinstance(value, bool):
            overrides[str(key)] = str(value)
        elif isinstance(value, bool):
            overrides[str(key)] = "1" if value else "0"
        elif isinstance(value, list) and all(isinstance(v, (str, int, float)) for v in value):
            overrides[str(key)] = [str(v) for v in value]
        else:
            raise SliceError(f"override {key!r} must be a string, number, bool or list")

    return {
        "profile": profile if profile in PROCESS_PRESETS else "custom",
        "process": process,
        "filament": filament if filament in FILAMENT_PRESETS else "custom",
        "filamentPreset": fil_preset,
        "layerH": layer_h,
        "infill": infill,
        "supports": supports,
        "spiral": spiral,
        "plate": bed_name,
        "brim": brim,
        "machine": MACHINE,
        "arrange": bool(raw.get("arrange", True)),
        "frame": "bed" if str(raw.get("frame", "")).lower() == "bed" else "plate",
        "overrides": overrides,
        "warnings": warnings,
    }


def _process_overrides(s, resolved):
    """The keys we set on top of the resolved parent chain."""
    over = {
        "layer_height": str(s["layerH"]),
        "sparse_infill_density": f"{s['infill']:g}%",
        "enable_support": "1" if s["supports"] else "0",
        "brim_type": BRIM_TYPES[s["brim"]],
        # Timelapse parks the head between layers and is pure risk on an
        # unattended print nobody is filming.
        "timelapse_type": "0",
    }
    if s["spiral"]:
        # Vase mode is a conspiracy of five settings. Orca drops spiral_mode
        # silently if any of them disagrees, and a dropped spiral_mode is a solid
        # brick with a clean exit code — the exact failure this module exists for.
        over.update({
            "spiral_mode": "1",
            "wall_loops": "1",
            "top_shell_layers": "0",
            "sparse_infill_density": "0%",
            "bottom_shell_layers": "5",
            "detect_thin_wall": "0",
            "enable_support": "0",
            "reduce_crossing_wall": "1",
        })
    else:
        over["spiral_mode"] = "0"
    # A first layer thinner than the layers above it squashes less and sticks
    # worse; the presets ship 0.2 mm, so a 0.28 mm draft slice would otherwise
    # start on a thinner layer than it prints. Orca does not warn about this.
    first = util.as_number(_first(resolved.get("initial_layer_print_height")), 0.2)
    if s["layerH"] > first:
        over["initial_layer_print_height"] = str(s["layerH"])
    over.update(s["overrides"])
    return over


def _write_overlay(kind, parent, overrides, path):
    cfg = {k: v for k, v in resolve_preset(kind, parent).items() if k not in _IDENTITY}
    cfg.update({
        "type": kind,
        "name": f"{parent} [bluesheet]",
        "from": "User",
        "inherits": parent,
        "version": "02.01.00.19",
        "compatible_printers": [MACHINE],
    })
    if kind == "process":
        cfg["compatible_printers_condition"] = ""
    cfg.update(overrides)
    util.atomic_write_json(path, cfg, indent=1)
    return cfg


def expectations(process_cfg, filament_cfg):
    """What the produced 3mf must say, keyed by gcode setting name.

    Read from the overlays we actually wrote rather than from the request, so the
    assertion is exactly "the file says what I sent" — including for a caller who
    reached past the friendly settings into `overrides`.
    """
    want = {
        "layer_height": ("num", _first(process_cfg.get("layer_height"))),
        "spiral_mode": ("str", _first(process_cfg.get("spiral_mode", "0"))),
        "enable_support": ("str", _first(process_cfg.get("enable_support", "0"))),
        "sparse_infill_density": ("pct", _first(process_cfg.get("sparse_infill_density"))),
        "wall_loops": ("num", _first(process_cfg.get("wall_loops", "2"))),
        "filament_type": ("str", _first(filament_cfg.get("filament_type", "PLA"))),
    }
    return {k: v for k, v in want.items() if k in _CRITICAL and v[1] is not None}


def _first(value):
    """Orca stores many settings as one-element lists (per extruder)."""
    return value[0] if isinstance(value, list) and value else value


# ---------------------------------------------------------------- slicing

def job_id(objects, settings):
    """Content hash of exactly what determines the output: the geometry bytes,
    where each object sits, and the canonical settings. Identical input returns
    the cached slice without running the AppImage."""
    parts = [util.canonical(settings)]
    for obj in objects:
        parts.append(util.digest(obj["data"], length=32))
        parts.append(f"{obj.get('x', 0):.4f},{obj.get('y', 0):.4f},{obj.get('rot', 0):.3f}")
    return util.digest(*parts, length=16)


def cached(jid):
    """The stored result for a job id, if the 3mf is still on disk."""
    if not util.is_safe_id(jid):
        return None
    d = os.path.join(util.SLICE_DIR, jid)
    meta = util.read_json(os.path.join(d, "meta.json"))
    if meta and os.path.isfile(os.path.join(d, "job.3mf")):
        return meta
    return None


def job_dir(jid):
    return os.path.join(util.SLICE_DIR, jid)


def slice_objects(objects, raw_settings, timeout=600, force=False):
    """Slice one or more STLs into a 3mf and return the verified metadata.

    `objects` is [{data: bytes, name: str, x?: mm, y?: mm, rot?: deg}] in Bluesheet's
    plate coordinates (origin at the bed centre, which is where the browser draws).
    """
    if not objects:
        raise SliceError("nothing to slice")
    settings = normalise(raw_settings)
    jid = job_id(objects, settings)

    if not force:
        hit = cached(jid)
        if hit:
            hit = dict(hit, cached=True)
            return hit

    if not (os.path.isfile(ORCA) and os.access(ORCA, os.X_OK)):
        raise SliceError(f"OrcaSlicer AppImage not found or not executable at {ORCA}")

    # One AppImage at a time: it saturates the CPU and this laptop is also running
    # ~50 other services. The lock is held across the whole job so a duplicate
    # request that arrives mid-slice finds the finished cache entry afterwards.
    # The queue is bounded because every waiter is a parked HTTP thread, and an
    # impatient browser retrying a slow slice should be told to wait rather than
    # quietly stacking up work nobody is still watching.
    with _queue_guard:
        if _queued[0] >= MAX_QUEUED:
            raise SliceBusy(f"{_queued[0]} slices are already queued; try again "
                            f"in a moment")
        _queued[0] += 1
    try:
        with _slice_lock:
            hit = cached(jid)
            if hit and not force:
                return dict(hit, cached=True)
            return _run_job(jid, objects, settings, timeout)
    finally:
        with _queue_guard:
            _queued[0] -= 1


def _run_job(jid, objects, settings, timeout):
    ensure_datadir()
    d = job_dir(jid)
    if os.path.isdir(d):
        shutil.rmtree(d, ignore_errors=True)
    os.makedirs(os.path.join(d, "presets"), exist_ok=True)

    stl_paths, placed, bounds, provenance = _prepare(objects, settings, d)

    process_over = _process_overrides(settings, resolve_preset("process", settings["process"]))
    process_cfg = _write_overlay("process", settings["process"], process_over,
                                 os.path.join(d, "presets", "process.json"))
    filament_cfg = _write_overlay("filament", settings["filamentPreset"], {},
                                  os.path.join(d, "presets", "filament.json"))

    log_path = os.path.join(d, "slice.log")
    cmd = [
        ORCA,
        "--datadir", DATADIR,
        "--logfile", log_path,
        "--load-settings", ";".join([preset_path("machine", MACHINE),
                                     os.path.join(d, "presets", "process.json")]),
        "--load-filaments", os.path.join(d, "presets", "filament.json"),
        "--curr-bed-type", settings["plate"],
        "--orient", "0",
        "--arrange", "1" if settings["arrange"] else "0",
        "--slice", "0",
        # Trap 3: --outputdir is prepended to --export-3mf, so this name is bare.
        "--export-3mf", "job.3mf",
        "--outputdir", d,
    ] + stl_paths

    started = time.time()
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout,
                              cwd=d, env=_child_env())
        rc = proc.returncode
        stderr = (proc.stderr or "")[-2000:]
    except subprocess.TimeoutExpired:
        raise SliceError(f"OrcaSlicer did not finish within {timeout}s",
                         log_tail=_tail(log_path))
    except OSError as e:
        raise SliceError(f"could not run OrcaSlicer: {e}")
    elapsed = time.time() - started

    out_3mf = os.path.join(d, "job.3mf")
    if not os.path.isfile(out_3mf):
        raise SliceError(
            f"slice produced no 3mf (exit {rc}) — the reason is only ever in the "
            f"logfile, never on stderr",
            log_tail=_tail(log_path) or stderr)

    # The exit code is not evidence. This is.
    summary = threemf.summarize(out_3mf)
    checks = threemf.verify(summary["allSettings"],
                            expectations(process_cfg, filament_cfg))
    failed = [c for c in checks if not c["ok"]]
    if failed:
        raise SliceError(
            "the slicer dropped settings it did not report: "
            + "; ".join(f"{c['key']} wanted {c['want']}, file says {c['got']}"
                        for c in failed),
            log_tail=_tail(log_path), detail={"checks": checks})
    if summary["outsideBed"]:
        raise SliceError("the arrangement does not fit the 180 × 180 mm bed "
                         "(the slicer flagged the plate as outside)",
                         detail={"bbox": bounds})

    est = summary["estimates"]
    meta = {
        "id": jid,
        "created": util.iso(),
        "cached": False,
        "sliceSec": round(elapsed, 2),
        "exit": rc,
        "objects": [{"name": placed[i]["name"],
                     "x": util.as_number(obj.get("x"), 0.0),
                     "y": util.as_number(obj.get("y"), 0.0),
                     "rot": util.as_number(obj.get("rot"), 0.0),
                     "bytes": len(obj["data"]),
                     "bbox": placed[i]["box"]}
                    for i, obj in enumerate(objects)],
        "provenance": provenance,
        "settings": settings,
        "timeText": est.get("timeText", "?"),
        "timeSec": est.get("timeSec", 0),
        "totalTimeText": est.get("totalTimeText"),
        "totalTimeSec": est.get("totalTimeSec", 0),
        "grams": est.get("grams", 0.0),
        "gramsEstimated": bool(est.get("gramsEstimated")),
        "filamentCm3": est.get("filamentCm3", 0.0),
        "filamentMm": est.get("filamentMm", 0.0),
        "cost": est.get("cost"),
        "layers": est.get("layers", 0),
        "heightMm": est.get("heightMm", 0.0),
        "bbox": bounds,
        "verified": [c for c in checks],
        "applied": summary["settings"],
        "supportUsed": summary["supportUsed"],
        "bytes": os.path.getsize(out_3mf),
        "log": _tail(log_path, lines=12),
        "warnings": list(settings["warnings"]),
    }
    if not meta["grams"]:
        meta["warnings"].append("the slicer reported no filament weight for this job")
    util.atomic_write_json(os.path.join(d, "meta.json"), meta, indent=1)
    util.prune_dirs(util.SLICE_DIR, keep=40, max_bytes=2 * 1024 ** 3, protect={jid})
    return meta


def _prepare(objects, settings, out_dir):
    """Write each object's STL where the slicer will find it, in the right frame.

    Three coordinate conventions meet here and getting them confused puts a print
    off the front of the bed:

    * Bluesheet's *plate* frame — origin at the bed centre, which is how the browser
      draws and how a generator's mesh comes out (centred, resting on z=0).
    * The printer's frame — origin at the bed's front-left corner, 0–180.
    * Whatever the caller already did. `js/kernel/pack.js` packs a plate in the
      browser and converts to printer coordinates itself, then asks for
      `arrange: false`; translating that again would shift it by another 90 mm.

    So: with `arrange` the slicer places things and we only apply rotation, which
    the CLI cannot do. Without it, an object carrying an x/y is translated from
    plate to printer coordinates here, and an object carrying none is taken to be
    in printer coordinates already — which is the only thing "do not arrange, and
    I gave you no position" can mean.
    """
    frame = (settings.get("frame") or "plate").lower()
    arrange = settings["arrange"]
    stl_paths, placed, provenance = [], [], []
    union = None
    half_x, half_y = BED[0] / 2, BED[1] / 2

    # The frame is a property of the *request*, never of an individual object.
    # Deciding per object meant a plate whose first bin happened to sit at x=0
    # was read as "already in printer coordinates" and ended up 90 mm away from
    # the rest of the plate, in the corner. Ask once, for all of them.
    explicit = _has_placement(objects)
    if frame == "bed" and explicit:
        raise SliceError("frame 'bed' means the geometry is already in printer "
                         "coordinates, so per-object x/y/rot cannot also apply — "
                         "send one or the other")
    pass_through = frame == "bed" or (not arrange and not explicit)

    for i, obj in enumerate(objects):
        data = obj["data"]
        dx = util.as_number(obj.get("x"), 0.0)
        dy = util.as_number(obj.get("y"), 0.0)
        rot = util.as_number(obj.get("rot"), 0.0)
        if arrange:
            if rot:
                data = stlio.place(data, 0.0, 0.0, rot)
                box = stlio.bounds_of(data)
            else:
                # The HTTP layer has already measured this to validate it; a
                # second pass over a million triangles buys nothing.
                box = obj.get("bbox") or stlio.bounds_of(data)
        elif pass_through:
            # rot is necessarily 0 here: pass_through means either frame 'bed'
            # (which refuses per-object placement above) or no placement at all.
            box = _shift_box(obj.get("bbox") or stlio.bounds_of(data), -half_x, -half_y)
        else:
            data = stlio.place(data, half_x + dx, half_y + dy, rot)
            box = _shift_box(stlio.bounds_of(data), -half_x, -half_y)

        _check_fits(obj.get("name") or f"object-{i}", box, arrange)
        union = _union_bbox(union, box)
        placed.append({"name": obj.get("name") or f"object-{i}", "box": box})

        text = stlio.header_text(obj["data"])
        if text:
            provenance.append(text)
        path = os.path.join(out_dir, f"object-{i}.stl")
        util.atomic_write_bytes(path, data)
        stl_paths.append(path)

    if not arrange:
        _check_no_overlap(placed)
    return stl_paths, placed, union, provenance


def _shift_box(box, dx, dy):
    lo = [box["min"][0] + dx, box["min"][1] + dy, box["min"][2]]
    hi = [box["max"][0] + dx, box["max"][1] + dy, box["max"][2]]
    return {"min": lo, "max": hi, "size": [hi[i] - lo[i] for i in range(3)],
            "center": [(hi[i] + lo[i]) / 2 for i in range(3)]}


# Brim and extrusion width put the printed extent a couple of millimetres outside
# the model's own bounds; measured at 2.2 mm on a five-object plate.
EDGE_ALLOWANCE = 2.5


def _check_fits(name, box, arrange):
    """Refuse with a measurement rather than silently scaling — the plan is
    explicit that nothing gets quietly shrunk to fit."""
    size = box["size"]
    for axis, limit, label in ((0, BED[0], "X"), (1, BED[1], "Y"), (2, BED[2], "Z")):
        if size[axis] > limit:
            raise SliceError(f"{name} is {size[axis]:.1f} mm in {label}; the A1 mini "
                             f"bed is {limit:.0f} mm")
    if box["min"][2] < -0.001:
        raise SliceError(f"{name} dips {abs(box['min'][2]):.2f} mm below the plate; "
                         f"a generator must return a mesh resting on z=0")
    if arrange:
        return
    for axis, half, label in ((0, BED[0] / 2, "X"), (1, BED[1] / 2, "Y")):
        if box["min"][axis] < -half - EDGE_ALLOWANCE or box["max"][axis] > half + EDGE_ALLOWANCE:
            raise SliceError(
                f"{name} sits at {label} {box['min'][axis]:.1f}…{box['max'][axis]:.1f} mm "
                f"from the bed centre, outside the ±{half:.0f} mm plate")


def _check_no_overlap(placed):
    """Two objects in the same place slice into one merged blob and the preview
    was a lie. The slicer will not tell us; it only reports being off the bed."""
    for i in range(len(placed)):
        for j in range(i + 1, len(placed)):
            a, b = placed[i]["box"], placed[j]["box"]
            if (a["min"][0] < b["max"][0] and b["min"][0] < a["max"][0]
                    and a["min"][1] < b["max"][1] and b["min"][1] < a["max"][1]):
                raise SliceError(f"{placed[i]['name']} and {placed[j]['name']} overlap "
                                 f"on the plate; move one of them")


def _has_placement(objects):
    return any(util.as_number(o.get("x"), 0.0) or util.as_number(o.get("y"), 0.0)
               or util.as_number(o.get("rot"), 0.0) for o in objects)


def _union_bbox(acc, b):
    if acc is None:
        return b
    lo = [min(acc["min"][i], b["min"][i]) for i in range(3)]
    hi = [max(acc["max"][i], b["max"][i]) for i in range(3)]
    return {"min": lo, "max": hi, "size": [hi[i] - lo[i] for i in range(3)],
            "center": [(hi[i] + lo[i]) / 2 for i in range(3)]}


def _child_env():
    """The AppImage wants a writable HOME and a temp dir; it must not inherit a
    display it cannot use (thumbnail rendering fails harmlessly either way, but a
    half-open X connection makes it slower)."""
    env = dict(os.environ)
    env.pop("DISPLAY", None)
    env.pop("WAYLAND_DISPLAY", None)
    env.setdefault("HOME", HOME)
    return env


def _tail(path, lines=25):
    try:
        with open(path, "r", errors="replace") as f:
            return "".join(f.readlines()[-lines:])
    except OSError:
        return ""
