#!/usr/bin/env python3
"""End-to-end: a 20 mm cube goes in over HTTP and a verified 3mf comes out.

    python3 tests/slice_smoke.py [port]

Everything asserted here is read back out of the produced file, never taken from
the slicer's exit code or from the numbers the API happened to return. The vase
run exists because vase mode is the setting that fails *silently*: if
`spiral_mode` were dropped, the cube would come back as a solid brick with a
clean exit and a plausible-looking response, and only the filament volume and the
config block inside the 3mf would give it away.

Prints SLICE OK with the measured time, weight and layer count.
"""
import base64
import http.client
import importlib.util
import json
import os
import struct
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)

from server import threemf  # noqa: E402

_spec = importlib.util.spec_from_file_location("bluesheet_entry", os.path.join(ROOT, "server.py"))
entry = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(entry)

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else int(os.environ.get("BLUESHEET_PORT", 8132))
FAILURES = []
CHECKS = [0]


def check(name, ok, detail=""):
    CHECKS[0] += 1
    mark = "ok  " if ok else "FAIL"
    if not ok:
        FAILURES.append(name)
    print(f"  {mark} {name}{('  ' + str(detail)) if detail else ''}")
    return ok


def between(name, value, low, high):
    return check(f"{name} = {value}", value is not None and low <= value <= high,
                 f"expected {low}..{high}")


def request(method, path, body=None, timeout=600):
    conn = http.client.HTTPConnection("127.0.0.1", PORT, timeout=timeout)
    try:
        payload = json.dumps(body).encode() if body is not None else None
        headers = {"Content-Type": "application/json"} if payload else {}
        conn.request(method, path, payload, headers)
        response = conn.getresponse()
        data = response.read()
        ctype = response.getheader("Content-Type", "")
        if "json" in ctype:
            return response.status, json.loads(data.decode("utf-8"))
        return response.status, data
    finally:
        conn.close()


def cube_stl(size=20.0, header="Bluesheet smoke cube"):
    """A 20 mm cube, built here rather than imported, so this test depends on the
    server and the slicer and nothing else."""
    s = size
    v = [(x * s - s / 2, y * s - s / 2, z * s) for x, y, z in
         [(0, 0, 0), (1, 0, 0), (1, 1, 0), (0, 1, 0),
          (0, 0, 1), (1, 0, 1), (1, 1, 1), (0, 1, 1)]]
    faces = [(0, 3, 2), (0, 2, 1), (4, 5, 6), (4, 6, 7), (0, 1, 5), (0, 5, 4),
             (1, 2, 6), (1, 6, 5), (2, 3, 7), (2, 7, 6), (3, 0, 4), (3, 4, 7)]
    out = bytearray(header.encode()[:80].ljust(80, b"\x00")) + struct.pack("<I", len(faces))
    for a, b, c in faces:
        u = [v[b][i] - v[a][i] for i in range(3)]
        w = [v[c][i] - v[a][i] for i in range(3)]
        n = (u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0])
        length = sum(k * k for k in n) ** 0.5 or 1.0
        out += struct.pack("<3f", *[k / length for k in n])
        for i in (a, b, c):
            out += struct.pack("<3f", *v[i])
        out += b"\x00\x00"
    return bytes(out)


def ensure_server():
    from http.server import ThreadingHTTPServer
    global PORT
    try:
        request("GET", "/api/health", timeout=5)
        print(f"using the running service on :{PORT}")
        return None
    except OSError:
        server = ThreadingHTTPServer(("127.0.0.1", 0), entry.BluesheetHandler)
        server.daemon_threads = True
        PORT = server.server_address[1]
        threading.Thread(target=server.serve_forever, daemon=True).start()
        print(f"nothing on :8132 — started a private instance on :{PORT}")
        return server


def main():
    server = ensure_server()
    stl = base64.b64encode(cube_stl()).decode()
    settings = {"profile": "standard", "layerH": 0.2, "infill": 15,
                "filament": "pla", "supports": False}

    print("solid slice")
    started = time.time()
    status, job = request("POST", "/api/slice",
                          {"stl": stl, "name": "smoke-cube", "settings": settings,
                           "force": True})
    wall = time.time() - started
    if not check("POST /api/slice returned 200", status == 200, job if status != 200 else ""):
        return finish()
    check(f"slice took {wall:.2f}s of wall clock", wall < 120)

    between("layers", job.get("layers"), 90, 110)
    between("print seconds", job.get("timeSec"), 300, 7200)
    between("grams", job.get("grams"), 1.0, 40.0)
    between("height mm", job.get("heightMm"), 19.9, 20.1)
    check("time is prose from the header block", bool(job.get("timeText")), job.get("timeText"))
    size = (job.get("bbox") or {}).get("size", [0, 0, 0])
    check("bounding box is the cube we sent",
          all(abs(v - 20.0) < 1e-3 for v in size), size)
    check("every asserted setting landed",
          all(row["ok"] for row in job.get("verified", [])), job.get("verified"))
    check("the slicer did not silently add support", job.get("supportUsed") is False)

    # Re-open the produced file independently of anything the API said.
    status, blob = request("GET", f"/api/slice/{job['id']}/3mf")
    check("3mf downloads", status == 200 and blob[:2] == b"PK", status)
    local = os.path.join("/tmp", f"bluesheet-smoke-{job['id']}.3mf")
    with open(local, "wb") as f:
        f.write(blob)
    summary = threemf.summarize(local)
    applied = summary["settings"]
    check("layer_height in the file is 0.2", applied.get("layer_height") == "0.2",
          applied.get("layer_height"))
    check("infill in the file is 15%", applied.get("sparse_infill_density") == "15%",
          applied.get("sparse_infill_density"))
    check("spiral mode is off", applied.get("spiral_mode") == "0")
    check("sliced for the A1 mini", applied.get("printer_model") == "Bambu Lab A1 mini",
          applied.get("printer_model"))
    check("filament density resolved (or grams would be 0)",
          float(applied.get("filament_density", 0)) > 0.5, applied.get("filament_density"))
    check("the plate fits the bed", summary["outsideBed"] is False)
    layers_in_file = summary["estimates"].get("layers")
    check("layer count in the file matches the API",
          layers_in_file == job.get("layers"), f"{layers_in_file} vs {job.get('layers')}")

    print("toolpaths")
    status, paths = request("GET", f"/api/slice/{job['id']}/gcode")
    check("gcode parses", status == 200 and paths.get("ok") is True, status)
    check("all layers present", paths.get("layerCount") == job["layers"],
          paths.get("layerCount"))
    first = paths["layers"][0]
    check("first layer has toolpaths", len(first["paths"]) > 0)
    check("paths are typed", all(p["type"] for p in first["paths"]),
          [p["type"] for p in first["paths"]][:4])
    check("points are flat x,y pairs", len(first["paths"][0]["pts"]) % 2 == 0)
    check("toolpaths are on the bed",
          0 <= min(first["paths"][0]["pts"][0::2]) and max(first["paths"][0]["pts"][0::2]) <= 180)
    payload_kb = len(json.dumps(paths)) / 1024
    check(f"payload is {payload_kb:.0f} kB for {paths['downsample']['points']} points",
          payload_kb < 4096)

    print("cache")
    threemf_path = os.path.join(ROOT, "state", "slices", job["id"], "job.3mf")
    before = os.path.getmtime(threemf_path)
    started = time.time()
    status, again = request("POST", "/api/slice",
                            {"stl": stl, "name": "smoke-cube", "settings": settings})
    cached_wall = time.time() - started
    check("same content gives the same id", again.get("id") == job["id"])
    check("second slice is served from cache", again.get("cached") is True)
    check(f"cache hit took {cached_wall * 1000:.0f} ms", cached_wall < 1.0)
    check("the AppImage did not run again (3mf untouched)",
          os.path.getmtime(threemf_path) == before)

    print("vase mode — the setting that fails silently")
    status, vase = request("POST", "/api/slice",
                           {"stl": stl, "name": "smoke-vase",
                            "settings": {**settings, "spiral": True}})
    check("vase slice returned 200", status == 200, vase if status != 200 else "")
    if status == 200:
        check("vase mode is confirmed in the file",
              vase["applied"].get("spiral_mode") == "1", vase["applied"].get("spiral_mode"))
        check("vase walls collapsed to one", vase["applied"].get("wall_loops") == "1")
        check(f"vase uses far less filament ({vase['grams']}g vs {job['grams']}g)",
              vase["grams"] < job["grams"] * 0.6)

    print("the settings assertion actually fires")
    # Ask for spiral_mode through a raw override while leaving the shell settings
    # contradicting it. OrcaSlicer 2.4.2 does not refuse and does not drop it —
    # it silently rewrites wall_loops to 1 and infill to 0% to make vase mode
    # possible, and exits 0. Whichever way it resolves the contradiction, what
    # came back is not what was asked for, and the slice must fail rather than
    # print. Without this the whole "never trust the exit code" claim is a comment.
    status, refused = request("POST", "/api/slice",
                              {"stl": stl, "name": "silent-drop",
                               "settings": {**settings, "overrides": {"spiral_mode": "1"}}})
    check("a slice whose settings did not land is refused", status == 422, status)
    check("the refusal names the settings that changed",
          isinstance(refused, dict) and "wall_loops" in refused.get("error", ""),
          refused.get("error") if isinstance(refused, dict) else refused)

    print("concurrency — a slow request must not block the rest of the service")
    done = threading.Event()
    result = {}

    def slow():
        try:
            result["status"], result["body"] = request(
                "POST", "/api/slice",
                {"stl": stl, "name": "concurrent", "force": True,
                 "settings": {**settings, "profile": "extrafine"}})
        finally:
            done.set()

    worker = threading.Thread(target=slow)
    worker.start()
    served_during = 0
    slowest = 0.0
    while not done.is_set():
        t0 = time.time()
        try:
            status, _ = request("GET", "/api/health", timeout=10)
        except OSError:
            break
        elapsed = time.time() - t0
        slowest = max(slowest, elapsed)
        if status == 200 and not done.is_set():
            served_during += 1
    worker.join(timeout=300)
    check(f"health answered {served_during} times during the slice", served_during >= 1)
    check(f"slowest health response was {slowest * 1000:.0f} ms while slicing", slowest < 5.0)
    body = result.get("body")
    check("the concurrent slice also succeeded", result.get("status") == 200,
          body.get("error") if isinstance(body, dict) else body)

    if server:
        server.shutdown()
    return finish(job)


def finish(job=None):
    print(f"\n{CHECKS[0] - len(FAILURES)}/{CHECKS[0]} checks passed")
    if FAILURES:
        print("failed: " + ", ".join(FAILURES))
        print("SLICE FAIL")
        return 1
    print(f"20 mm cube · {job['layers']} layers · {job['timeText']} · {job['grams']} g "
          f"· {job['settings']['process']} · verified in the 3mf")
    print("SLICE OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
