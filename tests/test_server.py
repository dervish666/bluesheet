#!/usr/bin/env python3
"""Unit tests for Bluesheet's Python side. Standard library only: python3 tests/test_server.py

The one test in here that matters more than the others is `print_default_does_not_start`.
A comment saying "upload only by default" is not a guard, so this drives the real
handler with a spy in place of the printer and asserts the spy was never called —
and then, so the test cannot be one that always passes, drives it again with a
valid confirmation token and asserts the spy *was* called.
"""
import base64
import http.client
import importlib.util
import json
import math
import os
import shutil
import struct
import sys
import tempfile
import threading
import time
from http.server import ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)
# The print route now tells the Made log about uploads, and the log's store is
# process-wide and rooted at BLUESHEET_MADE_DIR. Without this, every run left a
# "cube20 / testjob00000001" job in the real log (it did, on 2026-09-03).
os.environ.setdefault("BLUESHEET_MADE_DIR", tempfile.mkdtemp(prefix="bluesheet-test-made-"))

from server import elevation, fonts, gcode, library, printer, slicer, stlio, util  # noqa: E402

# server.py shares its name with the server/ package, and the package wins the
# import — so the entry point is loaded by path.
_spec = importlib.util.spec_from_file_location("bluesheet_entry", os.path.join(ROOT, "server.py"))
entry = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(entry)

PASSED = []
FAILED = []
# Quiet by default (the summary is what a gate greps for); -v prints every check,
# which is how a passing assertion becomes quotable evidence rather than a claim.
VERBOSE = any(a in ("-v", "--verbose") for a in sys.argv[1:])


def check(name, condition, detail=""):
    (PASSED if condition else FAILED).append(name)
    if not condition:
        print(f"FAIL  {name}  {detail}")
    elif VERBOSE:
        print(f"ok    {name}{('  ' + str(detail)) if detail else ''}")
    return bool(condition)


def near(name, got, want, tol=1e-6):
    ok = got is not None and abs(got - want) <= tol
    return check(name, ok, f"got {got!r} want {want!r}")


def throws(name, fn, exc=Exception):
    try:
        fn()
    except exc:
        return check(name, True)
    except Exception as e:
        return check(name, False, f"raised {type(e).__name__}: {e}")
    return check(name, False, "did not raise")


# ---------------------------------------------------------------- util

def test_util():
    check("digest separates parts", util.digest("ab", "c") != util.digest("a", "bc"))
    check("digest is stable", util.digest("x") == util.digest("x"))
    check("safe id accepts", util.is_safe_id("a1-b_c"))
    for bad in ("../x", "a/b", ".hidden", "", "x" * 80, "a\n", None, 7):
        check(f"safe id rejects {bad!r}", not util.is_safe_id(bad))
    near("duration 1h25m11s", util.parse_time_text("1h 25m 11s"), 5111)
    near("duration 45s", util.parse_time_text("45s"), 45)
    near("duration empty", util.parse_time_text(""), 0)
    check("fmt duration", util.fmt_duration(5111) == "1h 25m 11s")
    check("as_number rejects bool", util.as_number(True, 9) == 9)
    check("as_number rejects nan", util.as_number(float("nan"), 3) == 3)
    check("as_number clamps", util.as_number(500, 0, 0, 100) == 100)
    check("as_number rejects junk", util.as_number("banana", -1) == -1)

    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "sub", "x.json")
        util.atomic_write_json(path, {"a": 1})
        check("atomic write round trip", util.read_json(path) == {"a": 1})
        with open(path, "w") as f:
            f.write("{not json")
        check("corrupt json reads as default", util.read_json(path, "fallback") == "fallback")
        check("no temp files left", [n for n in os.listdir(os.path.dirname(path))] == ["x.json"])

    cache = util.Lru(2)
    cache.put("a", 1)
    cache.put("b", 2)
    cache.get("a")
    cache.put("c", 3)
    check("lru evicts least recent", cache.get("b") is None and cache.get("a") == 1)


# ---------------------------------------------------------------- stl

def cube_stl(size=20.0, header="Bluesheet test cube"):
    s = size
    v = [(x * s - s / 2, y * s - s / 2, z * s) for x, y, z in
         [(0, 0, 0), (1, 0, 0), (1, 1, 0), (0, 1, 0),
          (0, 0, 1), (1, 0, 1), (1, 1, 1), (0, 1, 1)]]
    faces = [(0, 3, 2), (0, 2, 1), (4, 5, 6), (4, 6, 7), (0, 1, 5), (0, 5, 4),
             (1, 2, 6), (1, 6, 5), (2, 3, 7), (2, 7, 6), (3, 0, 4), (3, 4, 7)]
    tris = [(*v[a], *v[b], *v[c]) for a, b, c in faces]
    return stlio.write_binary(tris, header)


def test_stl():
    data = cube_stl()
    tris = stlio.read_triangles(data)
    check("cube has 12 triangles", len(tris) == 12, len(tris))
    box = stlio.bbox(tris)
    check("cube bbox", box["size"] == [20.0, 20.0, 20.0], box)
    near("cube sits on the plate", box["min"][2], 0.0)
    check("header round trips", stlio.header_text(data) == "Bluesheet test cube")

    moved = stlio.place(data, 30, -10)
    mbox = stlio.bbox(stlio.read_triangles(moved))
    near("place translates x", mbox["center"][0], 30.0, 1e-4)
    near("place translates y", mbox["center"][1], -10.0, 1e-4)
    near("place keeps z", mbox["min"][2], 0.0, 1e-4)
    check("place keeps provenance", stlio.header_text(moved) == "Bluesheet test cube")

    spun = stlio.bbox(stlio.read_triangles(stlio.place(data, 0, 0, 45)))
    near("45 degree rotation widens the footprint", spun["size"][0], 20 * math.sqrt(2), 1e-3)

    ascii_stl = (b"solid s\nfacet normal 0 0 1\nouter loop\n"
                 b"vertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\n"
                 b"endloop\nendfacet\nendsolid s\n")
    check("ascii detected", stlio.looks_ascii(ascii_stl))
    check("ascii parsed", len(stlio.read_triangles(ascii_stl)) == 1)
    check("binary not mistaken for ascii", not stlio.looks_ascii(data))
    throws("truncated stl rejected", lambda: stlio.read_triangles(data[:200]), stlio.STLError)
    throws("empty stl has no bbox", lambda: stlio.bbox([]), stlio.STLError)
    huge = bytearray(data)
    struct.pack_into("<I", huge, 80, 9_000_000)
    throws("absurd triangle count rejected",
           lambda: stlio.read_triangles(bytes(huge)), stlio.STLError)


# ---------------------------------------------------------------- static allowlist

def test_static_allowlist():
    ok_cases = ["/", "/index.html", "/js/kernel/mesh.js", "/css/fonts.css"]
    for case in ok_cases:
        target = entry.resolve_static(case)
        exists = os.path.isfile(os.path.join(ROOT, case.strip("/") or "index.html"))
        if exists:
            check(f"serves {case}", target is not None)
        else:
            check(f"absent {case} is not served", target is None)
    # index.html is written by another leaf and may not exist yet, so assert the
    # mapping rather than the file: a bare directory must resolve exactly as its
    # index would, whenever that lands.
    check("root maps to index.html",
          entry.resolve_static("/") == entry.resolve_static("/index.html"))

    bad_cases = [
        "/../../etc/passwd", "/..%2f..%2fetc/passwd", "/%2e%2e/%2e%2e/etc/passwd",
        "/server.py", "/server/slicer.py", "/PLAN.md", "/GATES.md",
        "/gates/S1-server.md", "/.git/config", "/.gitignore", "/js/../server.py",
        "/library/anything.json", "/state/prints.json", "/tests/test_server.py",
        "/assets/../../secrets.md", "/secrets.md", "/config.env", "/my.env",
        "/assets/api-token.txt", "/assets/fonts/../../server.py",
        "/js/kernel/mesh.js%00.png", "/docs/design.md",
    ]
    for case in bad_cases:
        check(f"refuses {case}", entry.resolve_static(case) is None,
              entry.resolve_static(case))

    # A symlink out of the project must not be followed even with a legal name.
    link = os.path.join(ROOT, "assets", "escape.txt")
    try:
        os.symlink("/etc/hostname", link)
        check("refuses symlink escape", entry.resolve_static("/assets/escape.txt") is None)
    except OSError:
        pass
    finally:
        if os.path.islink(link):
            os.unlink(link)


# ---------------------------------------------------------------- slicer settings

def test_slicer_settings():
    s = slicer.normalise({})
    check("default profile is standard", s["process"] == "0.20mm Standard @BBL A1M", s)
    near("default layer height comes from the preset", s["layerH"], 0.2)
    check("default arranges", s["arrange"] is True)

    fine = slicer.normalise({"profile": "fine"})
    near("fine profile resolves its own layer height", fine["layerH"], 0.12)

    clamped = slicer.normalise({"layerH": 5})
    near("absurd layer height clamped", clamped["layerH"], 0.30)
    check("clamping is reported", any("layer height" in w for w in clamped["warnings"]))

    vase = slicer.normalise({"spiral": True, "supports": True})
    check("vase disables supports", vase["supports"] is False)
    check("vase says why", any("vase" in w for w in vase["warnings"]))

    over = slicer._process_overrides(vase, slicer.resolve_preset("process", vase["process"]))
    for key, want in (("spiral_mode", "1"), ("wall_loops", "1"), ("top_shell_layers", "0"),
                      ("sparse_infill_density", "0%")):
        check(f"vase sets {key}", over.get(key) == want, over.get(key))

    draft = slicer.normalise({"profile": "draft"})
    d_over = slicer._process_overrides(draft, slicer.resolve_preset("process", draft["process"]))
    check("thick layers raise the first layer",
          d_over.get("initial_layer_print_height") == "0.28", d_over.get("initial_layer_print_height"))

    throws("unknown profile rejected", lambda: slicer.normalise({"profile": "turbo"}),
           slicer.SliceError)
    throws("unknown filament rejected", lambda: slicer.normalise({"filament": "unobtainium"}),
           slicer.SliceError)
    throws("unknown plate rejected", lambda: slicer.normalise({"plate": "lava"}),
           slicer.SliceError)
    throws("bad override key rejected",
           lambda: slicer.normalise({"overrides": {"rm -rf": "1"}}), slicer.SliceError)

    # Trap 5: the resolved overlay must carry the preset's own speeds, not the
    # printer default process's. This is what makes the time estimate real.
    resolved = slicer.resolve_preset("process", "0.12mm Fine @BBL A1M")
    check("resolved preset has the parent chain's speeds",
          slicer._first(resolved.get("outer_wall_speed")) == "200",
          resolved.get("outer_wall_speed"))
    check("resolved preset keeps its own layer height",
          slicer._first(resolved.get("layer_height")) == "0.12")

    ident = slicer.job_id([{"data": b"abc"}], s)
    same = slicer.job_id([{"data": b"abc"}], s)
    other = slicer.job_id([{"data": b"abd"}], s)
    moved = slicer.job_id([{"data": b"abc", "x": 10}], s)
    check("job id is content addressed", ident == same)
    check("job id follows geometry", ident != other)
    check("job id follows placement", ident != moved)


# ---------------------------------------------------------------- placement

def test_placement():
    """Coordinate frames, bed fit and overlap — all the ways a plate goes wrong.

    Verified against the bytes actually written for the slicer, not just the
    reported boxes: the whole point is that what gets sliced is where the browser
    drew it.
    """
    data = cube_stl()

    def prepare(objects, raw):
        out = tempfile.mkdtemp(prefix="bluesheet-place-")
        try:
            settings = slicer.normalise(raw)
            paths, placed, union, _prov = slicer._prepare(objects, settings, out)
            written = [stlio.bounds_of(open(p, "rb").read()) for p in paths]
            return placed, union, written
        finally:
            shutil.rmtree(out, ignore_errors=True)

    placed, union, written = prepare(
        [{"data": data, "name": "left", "x": -30}, {"data": data, "name": "right", "x": 30}],
        {"arrange": False})
    near("left reported in plate coords", placed[0]["box"]["center"][0], -30.0, 1e-3)
    near("right reported in plate coords", placed[1]["box"]["center"][0], 30.0, 1e-3)
    near("left written in printer coords", written[0]["center"][0], 60.0, 1e-3)
    near("right written in printer coords", written[1]["center"][0], 120.0, 1e-3)
    near("y centred on the bed", written[0]["center"][1], 90.0, 1e-3)
    near("still resting on the plate", written[0]["min"][2], 0.0, 1e-4)
    near("union spans both", union["size"][0], 80.0, 1e-3)

    # An object at exactly 0,0 is still a plate coordinate, not a corner.
    placed, _u, written = prepare(
        [{"data": data, "name": "middle", "x": 0}, {"data": data, "name": "right", "x": 30}],
        {"arrange": False})
    near("x=0 lands at the bed centre", written[0]["center"][0], 90.0, 1e-3)

    # Pre-packed geometry in printer coordinates passes through untouched.
    prepacked = stlio.place(data, 40, 40, 0)
    placed, _u, written = prepare([{"data": prepacked, "name": "packed"}],
                                  {"arrange": False, "frame": "bed"})
    near("bed frame is not shifted again", written[0]["center"][0], 40.0, 1e-3)
    near("bed frame reported back in plate coords", placed[0]["box"]["center"][0], -50.0, 1e-3)

    # Arranging leaves the geometry alone and lets the slicer place it.
    _p, _u, written = prepare([{"data": data, "name": "auto"}], {"arrange": True})
    near("arrange does not move geometry", written[0]["center"][0], 0.0, 1e-4)

    rotated, _u, written = prepare([{"data": data, "name": "spun", "rot": 45}], {"arrange": True})
    near("rotation is applied locally", written[0]["size"][0], 20 * math.sqrt(2), 1e-3)

    throws("overlapping objects refused",
           lambda: prepare([{"data": data, "name": "a", "x": 0},
                            {"data": data, "name": "b", "x": 5}], {"arrange": False}),
           slicer.SliceError)
    throws("object off the plate refused",
           lambda: prepare([{"data": data, "name": "far", "x": 120}], {"arrange": False}),
           slicer.SliceError)
    throws("object larger than the bed refused",
           lambda: prepare([{"data": cube_stl(200), "name": "huge"}], {"arrange": True}),
           slicer.SliceError)
    sunk = stlio.write_binary([tuple(v - (2 if i % 3 == 2 else 0) for i, v in enumerate(t))
                               for t in stlio.read_triangles(cube_stl())])
    throws("mesh dipping below z=0 refused",
           lambda: prepare([{"data": sunk, "name": "sunk"}], {"arrange": True}),
           slicer.SliceError)
    throws("bed frame plus placement refused",
           lambda: prepare([{"data": data, "x": 10}], {"arrange": False, "frame": "bed"}),
           slicer.SliceError)


# ---------------------------------------------------------------- gcode

SAMPLE_GCODE = """
; HEADER_BLOCK_START
; model printing time: 1h 2m 3s
; HEADER_BLOCK_END
G1 X-30 Y185 E5
M83
; CHANGE_LAYER
; Z_HEIGHT: 0.2
; LAYER_HEIGHT: 0.2
; FEATURE: Outer wall
G1 X0 Y0
G1 X10 Y0 E1
G1 X10 Y10 E1
G1 X0 Y10 E1
; FEATURE: Sparse infill
G1 X2 Y2
G1 X8 Y8 E2
; CHANGE_LAYER
; Z_HEIGHT: 0.4
; FEATURE: Outer wall
G1 X0 Y0
G1 X10 Y0 E1
G1 X5 Y5 E1
"""


def test_gcode():
    parsed = gcode.parse(SAMPLE_GCODE)
    check("two layers", parsed["layerCount"] == 2, parsed["layerCount"])
    near("layer z read from Z_HEIGHT", parsed["layers"][0]["z"], 0.2)
    near("layer height read", parsed["layers"][0]["h"], 0.2)
    types = [p.type for p in parsed["layers"][0]["paths"]]
    check("features typed", types == ["outer", "sparse"], types)
    check("prologue excluded",
          parsed["bbox"]["min"][0] >= 0, parsed["bbox"])
    check("travel breaks the path",
          list(parsed["layers"][0]["paths"][0].pts)[:2] == [0.0, 0.0])
    check("travel not drawn by default",
          all(p.type != "travel" for l in parsed["layers"] for p in l["paths"]))
    with_travel = gcode.parse(SAMPLE_GCODE, include_travel=True)
    check("travel drawn on request",
          any(p.type == "travel" for l in with_travel["layers"] for p in l["paths"]))

    # Collinear runs collapse; a straight wall is two points however many moves
    # drew it.
    straight = "; CHANGE_LAYER\n; Z_HEIGHT: 0.2\nM83\n; FEATURE: Outer wall\nG1 X0 Y0\n" + \
        "".join(f"G1 X{i} Y0 E0.1\n" for i in range(1, 40))
    simple = gcode.parse(straight)
    check("collinear points collapse",
          len(simple["layers"][0]["paths"][0]) <= 3,
          len(simple["layers"][0]["paths"][0]))

    # An arc must become a curve, not a chord.
    arc = ("; CHANGE_LAYER\n; Z_HEIGHT: 0.2\nM83\n; FEATURE: Outer wall\n"
           "G1 X10 Y0\nG3 X0 Y10 I-10 J0 E1\n")
    arced = gcode.parse(arc)
    pts = list(arced["layers"][0]["paths"][0].pts)
    radii = [math.hypot(pts[i], pts[i + 1]) for i in range(0, len(pts), 2)]
    check("arc flattened into many points", len(radii) > 8, len(radii))
    check("arc points stay on the circle",
          all(abs(r - 10) < 0.11 for r in radii), max(radii))

    doc = gcode.to_jsonable(parsed)
    check("jsonable round trips", json.loads(json.dumps(doc))["layerCount"] == 2)
    view = gcode.view(doc)
    check("view keeps layer indices", view["layers"][0]["i"] == 0)
    check("view reports the budget", view["downsample"]["budget"] == 250_000)

    # Over budget: infill goes first, then whole layers, and the response says so.
    fat = {"layers": [{"z": i * 0.2, "h": 0.2, "paths": [
        {"type": "sparse", "pts": [0.0] * 2000},
        {"type": "outer", "pts": [0.0] * 200}]} for i in range(50)],
        "layerCount": 50, "points": 55000, "counts": {}, "bbox": None}
    thin = gcode.view(fat, max_points=3000)
    check("sheds infill first", "sparse" in thin["downsample"]["droppedTypes"])
    check("meets the budget", thin["downsample"]["points"] <= 3000,
          thin["downsample"]["points"])
    check("keeps walls", any(p["type"] == "outer" for l in thin["layers"] for p in l["paths"]))
    ranged = gcode.view(doc, layer_from=1, layer_to=2)
    check("layer range honoured", len(ranged["layers"]) == 1)


def test_verify():
    """The settings verifier, on its own: it must report a mismatch as a
    mismatch, and must not paper over the shapes Orca writes."""
    from server import threemf
    got = {"layer_height": "0.2", "sparse_infill_density": "15%", "spiral_mode": "0"}
    rows = threemf.verify(got, {"layer_height": ("num", "0.20"),
                                "sparse_infill_density": ("pct", "15"),
                                "spiral_mode": ("str", "1")})
    by_key = {r["key"]: r for r in rows}
    check("0.20 equals 0.2", by_key["layer_height"]["ok"])
    check("15 equals 15%", by_key["sparse_infill_density"]["ok"])
    check("a dropped spiral_mode is a failure", by_key["spiral_mode"]["ok"] is False)
    check("passing rows are reported too", len(rows) == 3)
    missing = threemf.verify({}, {"layer_height": ("num", "0.2")})
    check("an absent setting is a failure", missing[0]["ok"] is False)


# ---------------------------------------------------------------- library

def test_library():
    original = util.LIBRARY_DIR
    tmp = tempfile.mkdtemp(prefix="bluesheet-lib-")
    util.LIBRARY_DIR = tmp
    try:
        entry_a = library.save({"gen": "gridfinity", "name": "  Bin 2x1  ",
                                "params": {"w": 2, "d": 1}})
        check("saved id is safe", util.is_safe_id(entry_a["id"]), entry_a["id"])
        check("name trimmed", entry_a["name"] == "Bin 2x1", entry_a["name"])
        time.sleep(0.01)
        library.save({"gen": "vase", "name": "Twist", "params": {}})
        rows = library.listing()
        check("newest first", rows[0]["gen"] == "vase", [r["gen"] for r in rows])
        check("thumbnails omitted by default", "thumbnail" not in rows[0])
        check("filter by generator", len(library.listing(gen="vase")) == 1)

        updated = library.save({"id": entry_a["id"], "gen": "gridfinity",
                                "name": "Renamed", "params": {"w": 3}})
        check("update keeps id", updated["id"] == entry_a["id"])
        check("update keeps created", updated["createdAt"] == entry_a["createdAt"])
        check("update count", library.count() == 2)

        thumb = "data:image/png;base64," + base64.b64encode(b"x" * 64).decode()
        withthumb = library.save({"gen": "x", "name": "t", "params": {}, "thumbnail": thumb})
        check("thumbnail stored", library.get(withthumb["id"])["thumbnail"] == thumb)
        check("thumbnail listed on request",
              any(r.get("thumbnail") for r in library.listing(include_thumbs=True)))

        throws("bad gen rejected", lambda: library.save({"gen": "Not An Id"}),
               library.LibraryError)
        throws("script thumbnail rejected",
               lambda: library.save({"gen": "x", "thumbnail": "javascript:alert(1)"}),
               library.LibraryError)
        throws("svg thumbnail rejected",
               lambda: library.save({"gen": "x", "thumbnail": "data:image/svg+xml;base64,PHN2Zz4="}),
               library.LibraryError)
        throws("huge params rejected",
               lambda: library.save({"gen": "x", "params": {"a": "y" * 300000}}),
               library.LibraryError)
        throws("traversal id rejected", lambda: library.delete("../../etc/passwd"),
               library.LibraryError)
        check("delete works", library.delete(entry_a["id"]))
        check("delete of a ghost is false", library.delete("20200101-000000-aaaaaa") is False)
    finally:
        util.LIBRARY_DIR = original
        shutil.rmtree(tmp, ignore_errors=True)


# ---------------------------------------------------------------- print tokens

def test_tokens():
    issued = printer.issue_token("job1", "job1.gcode.3mf")
    check("token issued", len(issued["token"]) > 10)
    check("wrong job rejected", printer.redeem(issued["token"], "other", "job1.gcode.3mf")
          is False)
    fresh = printer.issue_token("job1", "job1.gcode.3mf")
    check("wrong name rejected", printer.redeem(fresh["token"], "job1", "elsewhere.3mf")
          is False)
    good = printer.issue_token("job1", "job1.gcode.3mf")
    check("right token accepted", printer.redeem(good["token"], "job1", "job1.gcode.3mf"))
    check("token is single use",
          printer.redeem(good["token"], "job1", "job1.gcode.3mf") is False)
    whole = printer.issue_token("job1", "job1.gcode.3mf")
    check("the object the server issued is itself a valid confirmation "
          "(what the browser actually sends back)",
          printer.redeem(whole, "job1", "job1.gcode.3mf"))
    check("a dict without a token is rejected",
          printer.redeem({"expiresIn": 180}, "job1", "job1.gcode.3mf") is False)
    check("empty token rejected", printer.redeem("", "job1", "job1.gcode.3mf") is False)
    check("none token rejected", printer.redeem(None, "job1", "job1.gcode.3mf") is False)

    stale = printer.issue_token("job2", "job2.gcode.3mf")
    printer._tokens[stale["token"]]["expires"] = time.time() - 1
    check("expired token rejected", printer.redeem(stale["token"], "job2", "job2.gcode.3mf")
          is False)
    # The ack is a proxy; the printer state is the fact (2026-09-03).
    saved = printer.status
    try:
        printer.status = lambda timeout=1.5: {"reachable": True, "state": "RUNNING",
                                              "job": "gauge-abc123"}
        check("a running printer confirms a start gladys could not ack",
              printer.started_by_state("gauge-abc123.gcode.3mf", wait=0))
        printer.status = lambda timeout=1.5: {"reachable": True, "state": "RUNNING",
                                              "job": "something-else"}
        check("a different running file does not",
              printer.started_by_state("gauge-abc123.gcode.3mf", wait=0) is False)
        printer.status = lambda timeout=1.5: {"reachable": False}
        check("an unreachable gladys does not",
              printer.started_by_state("gauge-abc123.gcode.3mf", wait=0) is False)
    finally:
        printer.status = saved
    check("names are made safe",
          printer.sd_name("abc123", "../../etc/passwd") == "etc-passwd-abc123.gcode.3mf",
          printer.sd_name("abc123", "../../etc/passwd"))


# ---------------------------------------------------------------- live handler

class Live:
    """A real ThreadingHTTPServer on an ephemeral loopback port."""

    def __enter__(self):
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), entry.BluesheetHandler)
        self.server.daemon_threads = True
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        return self

    def __exit__(self, *exc):
        self.server.shutdown()
        self.server.server_close()

    def request(self, method, path, body=None, ctype="application/json", headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=30)
        head = dict(headers or {})
        payload = None
        if body is not None:
            payload = json.dumps(body).encode()
            head.setdefault("Content-Type", ctype)
        conn.request(method, path, payload, head)
        response = conn.getresponse()
        raw = response.read()
        conn.close()
        try:
            return response.status, json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            return response.status, raw


def _fake_job(job_id="testjob00000001"):
    """A slice directory complete enough for /api/print to accept it."""
    d = os.path.join(util.SLICE_DIR, job_id)
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, "job.3mf"), "wb") as f:
        f.write(b"PK\x03\x04 not a real 3mf, never sent anywhere in this test")
    util.atomic_write_json(os.path.join(d, "meta.json"), {
        "id": job_id, "layers": 100, "timeText": "17m 23s", "grams": 3.68,
        "objects": [{"name": "cube20"}], "settings": {}, "cached": False})
    return job_id


def test_http():
    calls = {"upload": [], "start": [], "status": 0}
    real = (printer.upload, printer.start, printer.status)

    def fake_upload(path, name, skip_if_present=True):
        calls["upload"].append(name)
        return name, os.path.getsize(path), False

    def fake_start(name, **kwargs):
        calls["start"].append(name)
        return {"ok": True, "name": name}

    def fake_status(timeout=1.5):
        calls["status"] += 1
        return {"reachable": True, "via": "gladys", "state": "IDLE"}

    printer.upload, printer.start, printer.status = fake_upload, fake_start, fake_status
    entry.printer.upload, entry.printer.start, entry.printer.status = \
        fake_upload, fake_start, fake_status
    job = _fake_job()
    try:
        with Live() as live:
            status, health = live.request("GET", "/api/health")
            check("health 200", status == 200, status)
            check("health ok", health.get("ok") is True)
            check("health names the slicer", health["slicer"]["machine"].startswith("Bambu"))

            status, fonts_body = live.request("GET", "/api/fonts")
            check("fonts listed", status == 200 and len(fonts_body["fonts"]) >= 1)

            # --- G7: the default must not start a print ---------------------
            status, body = live.request("POST", "/api/print", {"id": job})
            check("upload-only returns 200", status == 200, (status, body))
            check("upload happened", calls["upload"] == [body.get("name")], calls)
            check("DEFAULT DID NOT START", calls["start"] == [], calls["start"])
            check("response says not started", body.get("started") is False, body)
            check("response reports whether the card already had it",
                  body.get("alreadyOnCard") is False, body)

            for sneaky in ({"id": job, "start": "true"}, {"id": job, "start": 1},
                           {"id": job, "start": ["yes"]}, {"id": job, "start": {"x": 1}}):
                status, body = live.request("POST", "/api/print", sneaky)
                check(f"truthy-not-true start {sneaky['start']!r} does not start",
                      calls["start"] == [] and body.get("started") is False, body)

            # Bed not confirmed clear: refused before a token is even issued, and
            # the spy never moves (2026-09-03 — a start onto a part left on the plate).
            status, body = live.request("POST", "/api/print", {"id": job, "start": True})
            check("start without bedClear is refused with 428", status == 428, (status, body.get("error")))
            check("and no token is offered for it", not body.get("confirm"), body.get("confirm"))
            check("and nothing started", calls["start"] == [], calls["start"])

            status, body = live.request("POST", "/api/print", {"id": job, "start": True, "bedClear": True})
            check("start without a token is refused", status == 409, status)
            check("refusal offers a token", bool(body.get("confirm", {}).get("token")))
            check("still not started", calls["start"] == [], calls["start"])
            token = body["confirm"]["token"]
            name = body["name"]

            status, body = live.request("POST", "/api/print",
                                        {"id": job, "start": True, "confirm": "wrong-token", "bedClear": True})
            check("wrong token refused", status == 409 and calls["start"] == [])

            # A valid token without the bed confirmation is refused too — and the
            # token survives, because the refusal happens before it is redeemed.
            status, body = live.request("POST", "/api/print",
                                        {"id": job, "start": True, "confirm": token})
            check("valid token but no bedClear is refused", status == 428 and calls["start"] == [], status)

            # ...and the test can detect a start, so the assertions above mean
            # something: with the real token it goes through.
            status, body = live.request("POST", "/api/print",
                                        {"id": job, "start": True, "confirm": token, "bedClear": True})
            check("valid token + bedClear starts the print", status == 200 and body.get("started") is True,
                  (status, body))
            check("the spy saw exactly one start", calls["start"] == [name], calls["start"])

            status, body = live.request("POST", "/api/print",
                                        {"id": job, "start": True, "confirm": token, "bedClear": True})
            check("token cannot be replayed", status == 409 and len(calls["start"]) == 1)

            # --- CSRF ------------------------------------------------------
            status, _ = live.request("POST", "/api/print", {"id": job},
                                     ctype="text/plain")
            check("non-json content type refused", status == 415, status)
            status, _ = live.request("POST", "/api/print", {"id": job},
                                     headers={"Origin": "http://evil.example"})
            check("cross-origin POST refused", status == 403, status)
            status, _ = live.request("POST", "/api/print", {"id": job},
                                     headers={"Referer": "http://evil.example/x"})
            check("cross-origin referer refused", status == 403, status)
            status, _ = live.request("DELETE", "/api/library/whatever",
                                     headers={"Origin": "http://evil.example"})
            check("cross-origin DELETE refused", status == 403, status)

            conn = http.client.HTTPConnection("127.0.0.1", live.port, timeout=10)
            conn.request("OPTIONS", "/api/print")
            check("no preflight is answered", conn.getresponse().status in (400, 501))
            conn.close()

            conn = http.client.HTTPConnection("127.0.0.1", live.port, timeout=10)
            conn.putrequest("POST", "/api/library")
            conn.putheader("Content-Type", "application/json")
            conn.endheaders()
            check("missing content-length refused", conn.getresponse().status == 411)
            conn.close()

            # --- library over HTTP -----------------------------------------
            status, body = live.request("POST", "/api/library",
                                        {"gen": "testgen", "name": "http entry",
                                         "params": {"a": 1}})
            check("library POST creates", status == 201 and body["entry"]["gen"] == "testgen",
                  (status, body))
            created = body["entry"]["id"]
            status, body = live.request("GET", "/api/library")
            check("library GET lists", any(e["id"] == created for e in body["entries"]))
            status, body = live.request("DELETE", "/api/library/" + created)
            check("library DELETE removes", status == 200 and body["deleted"] is True)
            status, body = live.request("DELETE", "/api/library/" + created)
            check("second delete is 404", status == 404)
            status, body = live.request("DELETE", "/api/library/..%2f..%2fetc%2fpasswd")
            check("traversal delete refused", status in (400, 404), status)

            status, body = live.request("GET", "/api/slice/not-a-real-slice")
            check("unknown slice is 404", status == 404)
            status, body = live.request("GET", "/api/slice/..%2f..%2fetc")
            check("slice id traversal refused", status in (400, 404), status)
            status, body = live.request("POST", "/api/slice", {"stl": "!!!not base64"})
            check("bad base64 refused", status == 400, status)
            status, body = live.request("POST", "/api/slice", {})
            check("missing stl refused", status == 400, status)
            status, body = live.request("POST", "/api/slice",
                                        {"stl": base64.b64encode(cube_stl()).decode(),
                                         "settings": {"profile": "nope"}})
            check("bad settings refused", status == 422, status)

            # A blocked slicer must refuse extra work rather than parking an
            # unbounded number of HTTP threads on the lock.
            slicer._slice_lock.acquire()
            codes = []
            lock_guard = threading.Lock()

            def hammer():
                # force, or a cache hit would return before the queue is
                # reached — cache hits are deliberately never rate-limited.
                code, _ = live.request("POST", "/api/slice",
                                       {"stl": base64.b64encode(cube_stl()).decode(),
                                        "force": True,
                                        "settings": {"profile": "standard"}})
                with lock_guard:
                    codes.append(code)

            threads = [threading.Thread(target=hammer) for _ in range(8)]
            for t in threads:
                t.start()
            time.sleep(1.0)
            slicer._slice_lock.release()
            for t in threads:
                t.join(timeout=120)
            check("a busy slicer sheds load with 503", 503 in codes, codes)
            check("queued requests still get served",
                  any(c in (200, 422) for c in codes), codes)

            status, body = live.request("GET", "/api/elevation?lat=999&lon=0")
            check("bad coordinates refused", status == 400, status)
            status, body = live.request("GET", "/nope.html")
            check("missing static is 404", status == 404)
    finally:
        printer.upload, printer.start, printer.status = real
        entry.printer.upload, entry.printer.start, entry.printer.status = real
        shutil.rmtree(os.path.join(util.SLICE_DIR, job), ignore_errors=True)


# ---------------------------------------------------------------- elevation & fonts

def test_elevation_and_fonts():
    near("web mercator centre x", elevation.lonlat_to_tile(0, 0, 1)[0], 1.0, 1e-9)
    near("web mercator centre y", elevation.lonlat_to_tile(0, 0, 1)[1], 1.0, 1e-9)
    near("zoom 0 pixel at equator", elevation.metres_per_pixel(0, 0), 156543.03392, 1e-3)
    near("zoom 12 pixel at Bristol", elevation.metres_per_pixel(51.45, 12), 23.8, 0.2)
    check("zoom chosen for the sample spacing",
          elevation.choose_zoom(51.45, 3000, 64) == 12, elevation.choose_zoom(51.45, 3000, 64))
    throws("bad latitude refused", lambda: elevation.heightfield(999, 0),
           elevation.ElevationError)
    throws("missing longitude refused", lambda: elevation.heightfield(51, None),
           elevation.ElevationError)

    # A 3x3 PNG through the decoder, exercising a real filter type.
    import zlib
    raw = b""
    for row in range(3):
        raw += bytes([2]) + bytes([row * 10, row * 10, row * 10] * 3)  # filter Up
    png = b"\x89PNG\r\n\x1a\n"

    def chunk(tag, body):
        return (struct.pack(">I", len(body)) + tag + body
                + struct.pack(">I", zlib.crc32(tag + body) & 0xFFFFFFFF))
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", 3, 3, 8, 2, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw))
    png += chunk(b"IEND", b"")
    w, h, channels, pixels = elevation.decode_png(png)
    check("png size", (w, h, channels) == (3, 3, 3), (w, h, channels))
    check("up filter accumulates", pixels[0] == 0 and pixels[9] == 10 and pixels[18] == 30,
          list(pixels[::9]))
    throws("non-png refused", lambda: elevation.decode_png(b"GIF89a"),
           elevation.ElevationError)

    # Geocoding: a coordinate pair never touches the network, and the rest is
    # shaped for the panel. The network path is exercised by hand, not here.
    hit = elevation.geocode("51.4545, -2.6247")
    check("a bare coordinate pair geocodes to itself", len(hit) == 1 and hit[0]["type"] == "coordinates"
          and abs(hit[0]["lat"] - 51.4545) < 1e-9 and abs(hit[0]["lon"] + 2.6247) < 1e-9, hit)
    check("a coordinate pair with a space also parses", elevation.geocode("53.07 -4.08")[0]["lat"] == 53.07)
    throws("a coordinate off the planet is refused", lambda: elevation.geocode("95, 0"), elevation.ElevationError)
    throws("an empty query is refused", lambda: elevation.geocode(" "), elevation.ElevationError)
    near("a coordinate with no box suggests a 3 km square", elevation.suggested_span_km(hit[0]), 3.0, 1e-9)
    near("a town's box suggests its own size",
         elevation.suggested_span_km({"bounds": {"south": 51.40, "north": 51.50, "west": -2.70, "east": -2.50}}),
         max(0.10 * 111.32, 0.20 * 111.32 * math.cos(math.radians(51.45))) * 1.15, 0.01)

    listed = fonts.listing()
    check("fonts found", len(listed) >= 1, len(listed))
    for font in listed:
        check(f"{font['id']} has a family", bool(font.get("family")), font)
        check(f"{font['id']} has unitsPerEm", font.get("unitsPerEm", 0) > 0, font)
        check(f"{font['id']} url is under assets", font["url"].startswith("/assets/fonts/"))


def main():
    for test in (test_util, test_stl, test_static_allowlist, test_slicer_settings,
                 test_placement, test_gcode, test_verify, test_library, test_tokens, test_http,
                 test_elevation_and_fonts):
        try:
            test()
        except Exception:
            FAILED.append(test.__name__)
            print(f"FAIL  {test.__name__} raised:")
            import traceback
            traceback.print_exc()
    total = len(PASSED) + len(FAILED)
    print(f"\n{len(PASSED)}/{total} checks passed")
    if FAILED:
        print("failed: " + ", ".join(FAILED[:12]))
        print(f"RESULT: FAIL ({len(FAILED)})")
        return 1
    print("RESULT: PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
