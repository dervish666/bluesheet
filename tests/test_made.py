#!/usr/bin/env python3
"""The Made log's state machine, driven without a printer, a camera or a clock.

    python3 tests/test_made.py [-v]

Gate M1 G1–G4. `Watcher.tick()` takes a snapshot argument, so every path — the
happy one and the three failure modes the module was designed for — is fed
telemetry by hand and asserted on. Where a test could pass vacuously (a photo
"landed", a job "was not lost") the suite also drives the opposite case so the
check has a way to fail.

Written 2026-09-03, the day the first real print went through this log — and
the day it turned out the watcher had never been started, matched jobs on a
filename the printer never reports, and had no POST route. None of those could
have survived this file existing.
"""
import json
import os
import shutil
import struct
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)

from server import made  # noqa: E402

PASSED, FAILED = [], []
VERBOSE = any(a in ("-v", "--verbose") for a in sys.argv[1:])


def check(name, condition, detail=""):
    (PASSED if condition else FAILED).append(name)
    if not condition:
        print(f"FAIL  {name}  {detail}")
    elif VERBOSE:
        print(f"ok    {name}{('  ' + str(detail)) if detail else ''}")
    return bool(condition)


# ---------------------------------------------------------------- fixtures

SLICE = "48ce32bc391eb2a3"
SD = f"skadis-fit-gauge-{SLICE}.gcode.3mf"
SUBTASK = f"skadis-fit-gauge-{SLICE}"          # what gladys reports as `job`

META = {"id": SLICE, "timeSec": 5912, "timeText": "1h 38m 32s", "grams": 11.15,
        "layers": 541, "settings": {"profile": "fine", "filament": "pla"},
        "objects": [{"name": "skadis-fit-gauge"}], "provenance": "skadis v1 #91a2af78"}


def tiny_jpeg():
    """The smallest thing `fetch_photo`'s checks accept: SOI, an SOF0 with a
    real size, and EOI, padded past MIN_PHOTO_BYTES."""
    sof = b"\xff\xc0" + struct.pack(">HBHHB", 17, 8, 480, 640, 3) + b"\x01\x11\x00\x02\x11\x01\x03\x11\x01"
    body = b"\xff\xd8" + sof + b"\xff\xfe" + struct.pack(">H", 1200) + b"\0" * 1198 + b"\xff\xd9"
    return body


def summary(state, percent, layer, job=SUBTASK, **extra):
    s = {"state": state, "percent": percent, "layer": layer, "total_layers": 541,
         "remaining_min": 90, "job": job, "gcode_file": SD if state == "RUNNING" else "",
         "filament": {"ams_slots": [{"id": "3", "remain": 80, "tray_weight": 1000}]}}
    s.update(extra)
    return {"connected": True, "summary": s}


class World:
    """A store in a temp dir, a fake clock, a fake camera and a patched slicer."""

    def __init__(self, camera_ok=True):
        self.dir = tempfile.mkdtemp(prefix="made-test-")
        self.store = made.Store(self.dir)
        self.t = 1_000_000.0
        self.photos = 0
        self.camera_ok = camera_ok
        self._cached = made.slicer.cached
        made.slicer.cached = lambda jid: dict(META) if jid == SLICE else None

        def photo(url=None, timeout=12.0):
            self.photos += 1
            if not self.camera_ok:
                raise ValueError("the camera returned no content type, not a JPEG")
            return tiny_jpeg(), (640, 480)

        self.w = made.Watcher(st=self.store, status=lambda url=None, timeout=4.0: {},
                              photo=photo, clock=lambda: self.t, lost_after=900,
                              misses_to_close=2, photo_attempts=2,
                              photo_retry_delay=0, sleep=lambda s: None)

    def advance(self, seconds):
        self.t += seconds

    def close(self):
        made.slicer.cached = self._cached
        shutil.rmtree(self.dir, ignore_errors=True)

    def only(self):
        jobs = self.store.all()
        assert len(jobs) == 1, jobs
        return jobs[0]


# ---------------------------------------------------------------- G1: end to end

def test_happy_path():
    w = World()
    try:
        job = made.record_slice({"sliceId": SLICE, "gen": "skadis", "genName": "Skådis",
                                 "name": "Fit gauge", "params": {"type": "gauge"},
                                 "provenance": "skadis v1 #91a2af78"}, w.store)
        check("slice creates a job in state sliced", job["state"] == "sliced", job["state"])
        check("the estimate comes from the slicer, not the request",
              job["estimate"]["seconds"] == 5912 and job["estimate"]["grams"] == 11.15,
              job["estimate"])
        again = made.record_slice({"sliceId": SLICE, "gen": "skadis", "params": {}}, w.store)
        check("re-slicing the same content hash updates rather than duplicates",
              again["id"] == job["id"] and w.store.count() == 1)

        up = made.record_upload(SLICE, SD, 513494, w.store)
        check("upload moves it to uploaded with the SD name", up["state"] == "uploaded"
              and up["sd"]["name"] == SD and up["sd"]["bytes"] == 513494, up.get("sd"))

        # The printer reports the SUBTASK name (no extension). This is the case
        # that was broken in production.
        r = w.w.tick(summary("RUNNING", 6, 1))
        check("the running print is matched by the printer's extension-less job name",
              r["matched"] == job["id"], r)
        j = w.only()
        check("it is now printing", j["state"] == "printing", j["state"])
        check("6% on layer 1 is the START (the A1 counts warm-up in its percentage), so observed",
              j["print"]["startedAtSource"] == "observed", j["print"])
        w.advance(300)
        w.w.tick(summary("RUNNING", 50, 270))
        j = w.only()
        check("progress is carried on the job", j["print"]["percent"] == 50
              and j["print"]["layer"] == 270, j["print"])
        w.advance(5600)
        r = w.w.tick(summary("FINISH", 100, 541))
        j = w.only()
        check("FINISH completes the job as made", j["state"] == "made", j["state"])
        check("the real elapsed time is stored beside the estimate",
              j["actual"]["seconds"] == 5900 and j["estimate"]["seconds"] == 5912,
              (j["actual"], j["estimate"]["seconds"]))
        check("timing is marked observed", j["actual"]["timing"] == "observed")
        sc = made.score(j)
        check("the estimate is scored against reality",
              sc and abs(sc["timeRatio"] - 5900 / 5912) < 1e-3, sc)
        check("grams are NOT invented when the AMS reports no usable weight change",
              j["actual"]["grams"] is None, j["actual"])
        check("a photograph was taken automatically", j["photo"] is not None
              and w.photos == 1, (j.get("photo"), w.photos))
        path = w.store.photo_path(j)
        data = open(path, "rb").read() if path and os.path.isfile(path) else b""
        check("a real JPEG landed on disk", data.startswith(b"\xff\xd8")
              and data.endswith(b"\xff\xd9") and len(data) > made.MIN_PHOTO_BYTES, len(data))
        check("events tell the story in order",
              [e["what"] for e in j["events"]][:5] == ["sliced", "resliced", "uploaded",
                                                        "printing", "made"],
              [e["what"] for e in j["events"]])

        # A FINISH seen again must not re-complete a finished job.
        before = json.dumps(j, sort_keys=True)
        w.w.tick(summary("FINISH", 100, 541))
        check("a repeated FINISH changes nothing", json.dumps(w.only(), sort_keys=True) == before)
    finally:
        w.close()


def test_adopted_and_inferred():
    """A print that started with no record: an upload from curl, then a printer
    already well into the job when the log first sees it."""
    w = World()
    try:
        up = made.record_upload(SLICE, SD, 1, w.store)
        check("an upload with no slice record opens a job from slicer metadata",
              up["state"] == "uploaded" and up["gen"] == "unknown"
              and up["estimate"]["seconds"] == 5912, up)
        check("and says it was adopted", up["events"][0]["what"] == "adopted")
        w.w.tick(summary("RUNNING", 40, 216))
        j = w.only()
        check("joined mid-print, the start is reconstructed and marked inferred",
              j["print"]["startedAtSource"] == "inferred"
              and abs((w.t - j["print"]["startedAt"]) - 0.4 * 5912) < 1, j["print"])
        w.advance(3600)
        w.w.tick(summary("FINISH", 100, 541))
        j = w.only()
        check("an inferred timing is stored", j["actual"]["timing"] == "inferred")
        acc = made.accuracy(w.store.all())
        check("but the accuracy series refuses inferred timings",
              not acc or not (acc.get("time") or {}).get("n"), acc)
    finally:
        w.close()


# ---------------------------------------------------------------- G3: surviving being wrong

def test_gladys_unreachable():
    w = World()
    try:
        made.record_upload(SLICE, SD, 1, w.store)
        w.w.tick(summary("RUNNING", 10, 50))
        w.w.fetch_status = None  # force the exception path

        def boom(url=None, timeout=4.0):
            raise OSError("connection refused")
        w.w.fetch_status = boom
        w.advance(30)
        r = w.w.tick()
        j = w.only()
        check("an unreachable gladys marks the print stale at once",
              r["ok"] is False and j["state"] == "printing" and j["print"]["stale"] is True,
              (r, j["print"].get("stale")))
        check("but does not close it inside lost_after", r["closed"] == [])
        w.advance(899)
        w.w.tick()
        check("still open one second short of lost_after", w.only()["state"] == "printing")
        w.advance(2)
        r = w.w.tick()
        j = w.only()
        check("after lost_after of continuous silence the job closes as unknown",
              j["state"] == "unknown" and r["closed"] == [j["id"]], (j["state"], r))
        check("keeping the last percentage actually seen", "10%" in j["error"], j["error"])
        check("with the timing marked unobserved", j["actual"]["timing"] == "unobserved")

        # And the reverse: gladys comes back mid-print.
        w2 = World()
        try:
            made.record_upload(SLICE, SD, 1, w2.store)
            w2.w.tick(summary("RUNNING", 10, 50))
            w2.w.fetch_status = boom
            w2.advance(60)
            w2.w.tick()
            check("(blip) stale while silent", w2.only()["print"]["stale"] is True)
            w2.advance(60)
            w2.w.tick(summary("RUNNING", 15, 80))
            j2 = w2.only()
            check("a blip shorter than lost_after clears when telemetry returns",
                  j2["state"] == "printing" and j2["print"]["stale"] is False
                  and j2["print"]["percent"] == 15, j2["print"])
        finally:
            w2.close()
    finally:
        w.close()


def test_camera_down():
    w = World(camera_ok=False)
    try:
        made.record_upload(SLICE, SD, 1, w.store)
        w.w.tick(summary("RUNNING", 6, 1))
        w.advance(1000)
        w.w.tick(summary("FINISH", 100, 541))
        j = w.only()
        check("the print still completes without a camera", j["state"] == "made")
        check("timing was recorded before the photo was attempted",
              j["actual"]["seconds"] == 1000, j["actual"])
        check("photo is null and photoError says why", j["photo"] is None
              and "JPEG" in (j["photoError"] or ""), j.get("photoError"))
        check("the camera was retried", w.photos == 2, w.photos)
        w.camera_ok = True
        j = w.w.capture(j["id"])
        check("a retake later succeeds and clears the error",
              j["photo"] is not None and j["photoError"] is None, j.get("photoError"))
    finally:
        w.close()


def test_printer_jumps_to_idle():
    w = World()
    try:
        made.record_upload(SLICE, SD, 1, w.store)
        w.w.tick(summary("RUNNING", 30, 160))
        w.advance(5)
        r = w.w.tick(summary("IDLE", 0, 0, job=""))
        j = w.only()
        check("one odd frame does not end a print", j["state"] == "printing"
              and j["print"]["stale"] is True and r["moved"][0].get("misses") == 1, r)
        w.advance(5)
        w.w.tick(summary("RUNNING", 31, 165))
        check("and the print carries on if the next frame is sane",
              w.only()["state"] == "printing" and w.only()["print"]["stale"] is False)
        w.advance(5)
        w.w.tick(summary("IDLE", 0, 0, job=""))
        w.advance(5)
        w.w.tick(summary("IDLE", 0, 0, job=""))
        j = w.only()
        check("two consecutive absences close it as unknown", j["state"] == "unknown", j["state"])
        check("holding the last layer and percentage seen", "31%" in j["error"], j["error"])

        # A different file replacing ours is named in the reason.
        w2 = World()
        try:
            made.record_upload(SLICE, SD, 1, w2.store)
            w2.w.tick(summary("RUNNING", 30, 160))
            for _ in range(2):
                w2.advance(5)
                w2.w.tick(summary("RUNNING", 1, 1, job="something-else"))
            j2 = w2.only()
            check("a swapped file is named in the reason", j2["state"] == "unknown"
                  and "something-else" in j2["error"], j2["error"])
        finally:
            w2.close()
    finally:
        w.close()


def test_failed_print():
    w = World()
    try:
        made.record_upload(SLICE, SD, 1, w.store)
        w.w.tick(summary("RUNNING", 30, 160))
        w.advance(100)
        w.w.tick(summary("FAILED", 33, 170))
        j = w.only()
        check("FAILED closes the job as failed", j["state"] == "failed")
        check("saying where", "33%" in j["error"], j["error"])
        check("and still photographs the wreck", j["photo"] is not None)
    finally:
        w.close()


# ---------------------------------------------------------------- G4: scoring

def test_accuracy():
    w = World()
    try:
        for k, ratio in enumerate((1.10, 1.20, 1.15, 3.0)):   # one abandoned outlier
            sid = f"{k:016x}"
            made.slicer.cached = (lambda s: (lambda jid: dict(META, id=s) if jid == s else None))(sid)
            made.record_upload(sid, f"part-{sid}.gcode.3mf", 1, w.store)
            w.w.tick(summary("RUNNING", 1, 1, job=f"part-{sid}"))
            w.advance(5912 * ratio)
            w.w.tick(summary("FINISH", 100, 541, job=f"part-{sid}"))
        acc = made.accuracy(w.store.all())
        t = acc["time"]
        check("four observed prints are scored", t["n"] == 4, t)
        check("the running figure is a median, so one abandoned print does not move it",
              abs(t["medianRatio"] - 1.175) < 1e-3, t["medianRatio"])
        check("the mean would have", t["meanRatio"] > 1.5, t["meanRatio"])
        check("grams are not scored when nothing was weighed", not acc.get("grams"), acc.get("grams"))
        job = w.store.all()[0]
        made.set_actual_grams(job["id"], 12.0, "weighed", w.store)
        acc = made.accuracy(w.store.all())
        check("a weighed part enters the grams series with its source",
              acc.get("grams") and acc["grams"]["n"] == 1
              and w.store.get(job["id"])["actual"]["gramsSource"] == "weighed", acc.get("grams"))
    finally:
        w.close()


def test_telemetry_grams():
    before = {"filament": {"ams_slots": [{"id": "3", "remain": 80, "tray_weight": 1000}]}}
    after = {"filament": {"ams_slots": [{"id": "3", "remain": 79, "tray_weight": 1000}]}}
    check("a real remain drop on a tagged spool becomes grams",
          made.grams_from_telemetry(before, after) == 10.0, made.grams_from_telemetry(before, after))
    check("an untagged spool (remain 0, weight 0) yields None, never a number",
          made.grams_from_telemetry(
              {"filament": {"ams_slots": [{"id": "3", "remain": 0, "tray_weight": 0}]}},
              {"filament": {"ams_slots": [{"id": "3", "remain": 0, "tray_weight": 0}]}}) is None)
    check("a refilled spool is not counted as negative use",
          made.grams_from_telemetry(after, before) is None)


def test_matching():
    w = World()
    try:
        made.record_upload(SLICE, SD, 1, w.store)
        for name in (SD, SUBTASK, SUBTASK.upper(), f"renamed-by-hand-{SLICE}"):
            check(f"matches the running file reported as {name!r}",
                  w.w._match(name) is not None, name)
        check("does not match a different slice id",
              w.w._match("skadis-fit-gauge-0000000000000000") is None)
        check("does not match nothing", w.w._match("") is None)
    finally:
        w.close()


if __name__ == "__main__":
    for fn in (test_happy_path, test_adopted_and_inferred, test_gladys_unreachable,
               test_camera_down, test_printer_jumps_to_idle, test_failed_print,
               test_accuracy, test_telemetry_grams, test_matching):
        try:
            fn()
        except Exception as e:  # noqa: BLE001
            import traceback
            traceback.print_exc()
            FAILED.append(f"{fn.__name__} raised {type(e).__name__}: {e}")
    print(f"{len(PASSED)}/{len(PASSED) + len(FAILED)} checks passed")
    print("RESULT:", "PASS" if not FAILED else "FAIL")
    sys.exit(1 if FAILED else 0)
