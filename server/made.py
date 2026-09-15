"""The Made log — what Bluesheet actually printed, and how wrong the estimate was.

A design is a promise; a job is what happened. This module keeps one record per
job through four moments:

    sliced     the slicer answered, so we have an estimate and a render
    uploaded   the 3mf is on the SD card, under a name that carries the slice id
    printing   the printer is running that file
    made       it finished — and a photograph of the real object was taken

The render beside the photograph is the point of the whole thing. Everything
else here exists to make sure that pair is honest about which object it is.

**The link between Bluesheet and the printer is the filename.** `printer.sd_name`
writes `<label>-<sliceid>.gcode.3mf`, and gladys reports the running file's name
in its telemetry. So a print can be matched to the job that produced it with no
shared state, no handshake and nothing to keep in sync — which also means a file
uploaded by some other route still lands in this log the moment it starts.

**Nothing here polls from a request handler.** One background thread reads
gladys every `BLUESHEET_MADE_POLL` seconds (default 15, 5 while a job is live) and
is the only thing that moves a job through the state machine. A request handler
reads records and writes the ones a person can change.

**It has to survive being wrong.** Three failures are designed for rather than
hoped against, because each of them has a version where the job silently sticks
on "printing" forever:

  * gladys unreachable — the job is marked stale immediately and closed as
    `unknown` after `lost_after` seconds of continuous silence, keeping the last
    percentage actually observed. If gladys comes back and the printer is still
    running that file, the job reopens.
  * the camera down — the print still completes. `photo` is null, `photoError`
    says why, and the card offers to try again. A missing photograph must never
    cost the timing record.
  * the printer jumping from RUNNING to IDLE (a stop, a power cycle, a file
    swapped on the card) — the job is closed as `unknown` with the last layer
    and percentage seen. Two consecutive observations are required so a single
    odd frame of telemetry cannot end a print that is still going.

**Scoring.** Predicted minutes against measured minutes, per job and as a
running median ratio, because one abandoned print should not move the number the
way a mean would. Grams are scored too but honestly: the A1 mini does not weigh
anything, so `grams_from_telemetry` returns a figure only when the AMS reports
both a usable remaining percentage and a spool weight, and otherwise the number
comes from a human putting the part on a scale — recorded with its source either
way, because an estimate scored against another estimate is not a measurement.

Wiring (server.py, the driver's file — this module never edits it):

    from server import made                      # with the other imports
    if made.route(self, path): return            # first line of _api_get,
                                                 #   of do_POST after the CSRF
                                                 #   check, and of do_DELETE
    made.start()                                 # in main(), before serve_forever

`route` returns True when it has answered the request. It uses the handler's own
`_json`/`_send`/`_fail`/`_read_json`, so every reply here gets the same headers,
gzip and body limits as the rest of the surface rather than a second convention.
"""
import base64
import binascii
import io
import json
import os
import re
import secrets
import threading
import time
import urllib.error
import urllib.request

from . import slicer, util

PREFIX = "/api/made"

GLADYS_API = os.environ.get("BLUESHEET_GLADYS_API", "http://127.0.0.1:8128")
STATUS_URL = GLADYS_API.rstrip("/") + "/api/status"
CAMERA_URL = os.environ.get("BLUESHEET_CAMERA_URL",
                            "http://127.0.0.1:8131/snapshot.jpg?hd=1")

POLL_IDLE = float(os.environ.get("BLUESHEET_MADE_POLL", "15"))
POLL_LIVE = max(1.0, min(POLL_IDLE, 5.0))
LOST_AFTER = float(os.environ.get("BLUESHEET_MADE_LOST_AFTER", "900"))

MAX_JOBS = 300
MAX_NAME = 80
MAX_NOTES = 2000
MAX_EVENTS = 40
MAX_PARAMS_BYTES = 256 * 1024
MAX_RENDER_BYTES = 512 * 1024
MAX_PHOTO_BYTES = 12 * 1024 * 1024
MIN_PHOTO_BYTES = 1024
LIST_PARAMS_INLINE = 4 * 1024      # bigger param sets are fetched per job

# A listing carrying every parameter set would be a multi-megabyte response as
# soon as one lithophane is in it, so anything over LIST_PARAMS_INLINE is left
# out of the list and fetched from /api/made/<id> when a card needs it.

LIVE_STATES = ("sliced", "uploaded", "printing")
DONE_STATES = ("made", "failed", "unknown")

# gladys passes the printer's own gcode_state through untouched.
PRINTER_ACTIVE = {"RUNNING", "PREPARE", "SLICING", "PAUSE"}
PRINTER_DONE_OK = {"FINISH"}
PRINTER_DONE_BAD = {"FAILED"}

GEN_ID = re.compile(r"\A[a-z0-9][a-z0-9-]{0,63}\Z")
DATA_URL = re.compile(r"\Adata:image/(png|jpeg|webp);base64,([A-Za-z0-9+/=\s]{16,})\Z")
CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
# `printer.sd_name` builds "<label>-<sliceid>.gcode.3mf" and the slice id is a
# 16-character content hash, so the filename on the card names the slice.
# gladys reports the running job as the printer's *subtask name* — the file
# name with its extensions stripped — so the extension has to be optional here
# or a print is never matched to its job (found live, 2026-09-03).
SD_SLICE_ID = re.compile(r"-([0-9a-f]{16})(?:\.gcode\.3mf|\.3mf|\.gcode)?\Z", re.I)

RENDER_EXT = {"png": ".png", "jpeg": ".jpg", "webp": ".webp"}
RENDER_MIME = {".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp"}


class MadeError(ValueError):
    """A request that is wrong in a way the caller can fix."""


# ---------------------------------------------------------------- the store


class Store:
    """One JSON file per job under `root`, with the images beside them.

    A file each, as the design library does: concurrent writes stay independent,
    a record is readable with `cat`, and a corrupted one costs a single job
    rather than the log. The in-memory index is authoritative while the process
    lives — the watcher reads it every few seconds and re-scanning 300 files on
    a timer to learn nothing would be wasteful — and every mutation writes
    through to disk before the lock is released.
    """

    def __init__(self, root):
        self.root = os.path.abspath(root)
        self.photo_dir = os.path.join(self.root, "photos")
        self.render_dir = os.path.join(self.root, "renders")
        self._lock = threading.RLock()
        self._jobs = None

    # --- paths ---------------------------------------------------------

    def _ensure(self):
        for d in (self.root, self.photo_dir, self.render_dir):
            os.makedirs(d, exist_ok=True)

    def path(self, job_id):
        if not util.is_safe_id(job_id):
            raise MadeError("bad job id")
        return os.path.join(self.root, job_id + ".json")

    def photo_path(self, job):
        f = (job.get("photo") or {}).get("file")
        return os.path.join(self.photo_dir, f) if f else None

    def render_path(self, job):
        f = (job.get("render") or {}).get("file")
        return os.path.join(self.render_dir, f) if f else None

    # --- loading -------------------------------------------------------

    def _index(self):
        """The in-memory index, loaded from disk once."""
        if self._jobs is not None:
            return self._jobs
        jobs = {}
        try:
            entries = list(os.scandir(self.root))
        except OSError:
            entries = []
        for e in entries:
            if not (e.is_file() and e.name.endswith(".json") and not e.name.startswith(".")):
                continue
            job = util.read_json(e.path)
            if isinstance(job, dict) and util.is_safe_id(job.get("id") or ""):
                jobs[job["id"]] = job
        self._jobs = jobs
        return jobs

    def all(self):
        """Every job, newest first."""
        with self._lock:
            jobs = list(self._index().values())
        jobs.sort(key=lambda j: j.get("createdAt") or 0, reverse=True)
        return [json.loads(json.dumps(j)) for j in jobs]

    def get(self, job_id):
        with self._lock:
            job = self._index().get(job_id)
            return json.loads(json.dumps(job)) if job else None

    def live(self):
        with self._lock:
            jobs = [j for j in self._index().values() if j.get("state") in LIVE_STATES]
        jobs.sort(key=lambda j: j.get("updatedAt") or 0, reverse=True)
        return jobs

    def count(self):
        with self._lock:
            return len(self._index())

    # --- writing -------------------------------------------------------

    def _put(self, job):
        """Write one record through to disk. Caller holds the lock."""
        job["updatedAt"] = time.time()
        job["updated"] = util.iso(job["updatedAt"])
        self._ensure()
        util.atomic_write_json(self.path(job["id"]), job, indent=1)
        self._index()[job["id"]] = job
        return job

    def update(self, job_id, fn):
        """Read-modify-write one job under the lock. `fn(job)` mutates in place;
        returning False abandons the write."""
        with self._lock:
            job = self._index().get(job_id)
            if not job:
                return None
            if fn(job) is False:
                return json.loads(json.dumps(job))
            self._put(job)
            return json.loads(json.dumps(job))

    def create(self, job):
        with self._lock:
            self._put(job)
            self._prune()
            return json.loads(json.dumps(job))

    def delete(self, job_id):
        with self._lock:
            job = self._index().pop(job_id, None)
            if not job:
                return False
            self._unlink_assets(job)
            try:
                os.unlink(self.path(job_id))
            except OSError:
                pass
            return True

    def _unlink_assets(self, job):
        for path in (self.photo_path(job), self.render_path(job)):
            if not path:
                continue
            try:
                os.unlink(path)
            except OSError:
                pass

    def _prune(self):
        """Stay under MAX_JOBS, dropping finished jobs before live ones and the
        oldest first. Caller holds the lock."""
        jobs = self._index()
        if len(jobs) <= MAX_JOBS:
            return []
        ordered = sorted(jobs.values(),
                         key=lambda j: (j.get("state") in LIVE_STATES,
                                        j.get("createdAt") or 0))
        removed = []
        for job in ordered[:len(jobs) - MAX_JOBS]:
            jobs.pop(job["id"], None)
            self._unlink_assets(job)
            try:
                os.unlink(self.path(job["id"]))
            except OSError:
                pass
            removed.append(job["id"])
        return removed

    # --- assets --------------------------------------------------------

    def write_render(self, job_id, data, ext):
        self._ensure()
        name = job_id + ext
        util.atomic_write_bytes(os.path.join(self.render_dir, name), data)
        return {"file": name, "bytes": len(data),
                "type": RENDER_MIME.get(ext, "application/octet-stream")}

    def write_photo(self, job_id, data):
        self._ensure()
        name = job_id + ".jpg"
        util.atomic_write_bytes(os.path.join(self.photo_dir, name), data)
        return name


_store = None
_store_lock = threading.Lock()


def store():
    """The process-wide store, rooted at BLUESHEET_MADE_DIR or state/made."""
    global _store
    with _store_lock:
        if _store is None:
            root = os.environ.get("BLUESHEET_MADE_DIR") or os.path.join(util.STATE_DIR, "made")
            _store = Store(root)
        return _store


# ---------------------------------------------------------------- records


def _clean_text(value, limit, field):
    if value is None:
        return ""
    if not isinstance(value, str):
        raise MadeError(f"{field} must be a string")
    value = CONTROL.sub("", value).strip()
    if len(value) > limit:
        value = value[:limit]
    return value


def _check_params(params):
    if params is None:
        return {}
    if not isinstance(params, dict):
        raise MadeError("params must be an object")
    try:
        text = util.canonical(params)
    except (TypeError, ValueError) as e:
        raise MadeError(f"params are not JSON-serialisable: {e}")
    if len(text.encode("utf-8")) > MAX_PARAMS_BYTES:
        raise MadeError(f"params exceed {MAX_PARAMS_BYTES} bytes")
    return params


def decode_data_url(text, limit=MAX_RENDER_BYTES):
    """A data: URL for an image we are willing to store -> (bytes, extension).

    Checked before the decode as well as after: base64 inflates by a third, so a
    caller sending 40 MB of text would otherwise be decoded in full before being
    refused.
    """
    if not isinstance(text, str):
        raise MadeError("the render must be a data: URL")
    if len(text) > limit * 2:
        raise MadeError(f"the render exceeds {limit} bytes")
    m = DATA_URL.match(text)
    if not m:
        raise MadeError("the render must be a data: URL for a png, jpeg or webp")
    try:
        data = base64.b64decode(m.group(2), validate=False)
    except (binascii.Error, ValueError):
        raise MadeError("the render is not valid base64")
    if len(data) > limit:
        raise MadeError(f"the render exceeds {limit} bytes")
    if not data:
        raise MadeError("the render is empty")
    return data, RENDER_EXT[m.group(1)]


def new_id(now=None):
    """Sortable, filesystem-safe and collision-proof within a second."""
    return time.strftime("%Y%m%d-%H%M%S", time.localtime(now or time.time())) \
        + "-" + secrets.token_hex(3)


def _estimate_from_meta(meta):
    """What the slicer promised, in the units the log scores in."""
    seconds = int(util.as_number((meta or {}).get("timeSec"), 0) or 0)
    return {
        "seconds": seconds,
        "minutes": round(seconds / 60.0, 2) if seconds else None,
        "timeText": (meta or {}).get("timeText"),
        "totalSeconds": int(util.as_number((meta or {}).get("totalTimeSec"), 0) or 0),
        "grams": util.as_number((meta or {}).get("grams"), None),
        "gramsEstimated": bool((meta or {}).get("gramsEstimated")),
        "layers": int(util.as_number((meta or {}).get("layers"), 0) or 0),
        "filamentMm": util.as_number((meta or {}).get("filamentMm"), None),
    }


def _blank_actual():
    return {"seconds": None, "minutes": None, "grams": None,
            "gramsSource": None, "layers": None, "timing": None}


def _event(job, what, detail=""):
    now = time.time()
    job.setdefault("events", []).append({"t": now, "at": util.iso(now),
                                         "what": what, "detail": detail})
    job["events"] = job["events"][-MAX_EVENTS:]
    return job


def _stem(name):
    """A print file's name as the printer reports it: without its extensions."""
    name = (name or "").lower()
    for ext in (".gcode.3mf", ".3mf", ".gcode"):
        if name.endswith(ext):
            return name[:-len(ext)]
    return name


def record_slice(body, st=None):
    """A slice happened. Create the job, or update the one this slice already has.

    Pressing Slice twice on an unchanged object produces the same slice id — the
    id is a content hash — so a second press updates the existing record instead
    of filling the log with duplicates of one intent.

    The estimate is read from the slicer's own stored metadata rather than from
    the request: the browser is where the render comes from, but it is not the
    authority on what the slicer said, and a log that scores its own estimates
    must not let the thing being scored supply the numbers.
    """
    st = st or store()
    if not isinstance(body, dict):
        raise MadeError("expected a JSON object")
    slice_id = body.get("sliceId") or body.get("id")
    if not util.is_safe_id(slice_id or ""):
        raise MadeError("sliceId must be a slice id")
    gen = body.get("gen")
    if not isinstance(gen, str) or not GEN_ID.match(gen):
        raise MadeError("gen must be a generator id like 'gridfinity'")

    meta = slicer.cached(slice_id)
    if not meta:
        raise MadeError("no such slice (it may have been pruned)")

    params = _check_params(body.get("params"))
    name = _clean_text(body.get("name"), MAX_NAME, "name") or gen
    render = None
    if body.get("render"):
        data, ext = decode_data_url(body["render"])
        render = (data, ext)

    with st._lock:
        existing = None
        for job in st.live():
            if job.get("sliceId") == slice_id:
                existing = job
                break
        job = existing or {
            "id": new_id(),
            "sliceId": slice_id,
            "state": "sliced",
            "createdAt": time.time(),
            "sd": None, "photo": None, "photoError": None, "render": None,
            "print": {}, "actual": _blank_actual(), "error": None,
            "notes": "", "events": [],
        }
        job["created"] = util.iso(job["createdAt"])
        job["gen"] = gen
        job["genName"] = _clean_text(body.get("genName"), MAX_NAME, "genName") or gen
        job["name"] = name
        job["params"] = params
        job["provenance"] = _clean_text(body.get("provenance"), 200, "provenance")
        job["version"] = int(util.as_number(body.get("version"), 1) or 1)
        job["settings"] = meta.get("settings") or {}
        job["profileLabel"] = _clean_text(body.get("profileLabel"), 60, "profileLabel")
        job["estimate"] = _estimate_from_meta(meta)
        job["objects"] = [o.get("name") for o in (meta.get("objects") or [])]
        if render:
            job["render"] = st.write_render(job["id"], render[0], render[1])
        _event(job, "sliced" if not existing else "resliced",
               f"{job['estimate']['timeText'] or '?'} · "
               f"{job['estimate']['grams'] or 0:.2f} g · {job['estimate']['layers']} layers")
        st._put(job)
        if not existing:
            st._prune()
        return json.loads(json.dumps(job))


def record_upload(slice_id, sd_name, size=None, st=None):
    """The 3mf reached the SD card. Attach it to the job, or make one.

    A job can appear here without ever having been through `record_slice` — an
    upload driven from the command line, or a browser that closed between the
    two — and a log that dropped those would be quietly incomplete, so the slice
    metadata is enough to open a record on its own.
    """
    st = st or store()
    if not util.is_safe_id(slice_id or ""):
        raise MadeError("sliceId must be a slice id")
    sd_name = _clean_text(sd_name, 120, "sdName")
    if not sd_name:
        raise MadeError("sdName is required")
    with st._lock:
        target = None
        for job in st.live():
            if job.get("sliceId") == slice_id:
                target = job
                break
        if target is None:
            meta = slicer.cached(slice_id)
            if not meta:
                raise MadeError("no such slice (it may have been pruned)")
            target = {
                "id": new_id(), "sliceId": slice_id, "state": "sliced",
                "createdAt": time.time(), "created": util.iso(),
                "gen": "unknown", "genName": "Unknown", "name":
                    (meta.get("objects") or [{}])[0].get("name") or "Unnamed",
                "params": {}, "provenance": meta.get("provenance") or "",
                "version": 1, "settings": meta.get("settings") or {},
                "estimate": _estimate_from_meta(meta), "actual": _blank_actual(),
                "sd": None, "photo": None, "photoError": None, "render": None,
                "print": {}, "error": None, "notes": "", "events": [],
                "objects": [o.get("name") for o in (meta.get("objects") or [])],
            }
            _event(target, "adopted", "an upload arrived for a slice with no record")
        target["sd"] = {"name": sd_name,
                        "bytes": int(util.as_number(size, 0) or 0),
                        "at": time.time()}
        if target["state"] == "sliced":
            target["state"] = "uploaded"
        _event(target, "uploaded", sd_name)
        st._put(target)
        return json.loads(json.dumps(target))


def set_actual_grams(job_id, grams, source="weighed", st=None):
    """The measured weight of the real object.

    This exists because the A1 mini cannot weigh anything. Scoring an estimate
    against a second estimate would produce a number that looks like a
    measurement and is not one, so the source travels with the value.
    """
    st = st or store()
    value = util.as_number(grams, None, 0, 100000)
    if value is None:
        raise MadeError("grams must be a number")
    source = _clean_text(source, 24, "source") or "weighed"

    def apply(job):
        job["actual"]["grams"] = round(value, 3)
        job["actual"]["gramsSource"] = source
        _event(job, "weighed", f"{value:.2f} g ({source})")

    job = st.update(job_id, apply)
    if not job:
        raise MadeError("no such job")
    return job


def set_notes(job_id, notes, st=None):
    st = st or store()
    text = _clean_text(notes, MAX_NOTES, "notes")

    def apply(job):
        job["notes"] = text

    job = st.update(job_id, apply)
    if not job:
        raise MadeError("no such job")
    return job


# ---------------------------------------------------------------- scoring


def score(job):
    """One job's estimate against its reality, or None if it cannot be scored."""
    est = job.get("estimate") or {}
    act = job.get("actual") or {}
    out = {}
    e_sec, a_sec = est.get("seconds"), act.get("seconds")
    if e_sec and a_sec:
        out["timeRatio"] = round(a_sec / e_sec, 4)
        out["timePct"] = round((a_sec - e_sec) / e_sec * 100.0, 2)
        out["timing"] = act.get("timing")
    e_g, a_g = est.get("grams"), act.get("grams")
    if e_g and a_g:
        out["gramsRatio"] = round(a_g / e_g, 4)
        out["gramsPct"] = round((a_g - e_g) / e_g * 100.0, 2)
        out["gramsSource"] = act.get("gramsSource")
    return out or None


def _median(values):
    if not values:
        return None
    s = sorted(values)
    n = len(s)
    return s[n // 2] if n % 2 else (s[n // 2 - 1] + s[n // 2]) / 2.0


def _series(ratios):
    if not ratios:
        return None
    errs = [(r - 1.0) * 100.0 for r in ratios]
    return {
        "n": len(ratios),
        "medianRatio": round(_median(ratios), 4),
        "meanRatio": round(sum(ratios) / len(ratios), 4),
        "medianErrorPct": round(_median(errs), 2),
        "meanErrorPct": round(sum(errs) / len(errs), 2),
        "meanAbsErrorPct": round(sum(abs(e) for e in errs) / len(errs), 2),
        "worstErrorPct": round(max(errs, key=abs), 2),
    }


def accuracy(jobs):
    """The running score of the slicer's estimates against measured reality.

    The headline is a **median** ratio, not a mean: one print stopped at 4% would
    drag a mean towards zero and quietly rewrite the number a person is meant to
    trust. Jobs whose start time was inferred rather than observed are counted
    separately for the same reason — a print already at 40% when Bluesheet first saw
    it has an elapsed time reconstructed from the estimate being scored, and
    scoring an estimate against itself is circular.
    """
    time_ratios, grams_ratios = [], []
    excluded = 0
    made = 0
    sources = {}
    for job in jobs:
        if job.get("state") == "made":
            made += 1
        s = score(job)
        if not s:
            continue
        if "timeRatio" in s:
            if s.get("timing") == "observed":
                time_ratios.append(s["timeRatio"])
            else:
                excluded += 1
        if "gramsRatio" in s:
            grams_ratios.append(s["gramsRatio"])
            src = s.get("gramsSource") or "unknown"
            sources[src] = sources.get(src, 0) + 1

    t = _series(time_ratios)
    g = _series(grams_ratios)
    if t:
        t["excludedInferredStart"] = excluded
    if g:
        g["sources"] = sources
    return {
        "jobs": len(jobs),
        "made": made,
        "time": t,
        "grams": g,
        "verdict": _verdict(t, g),
    }


def _verdict(t, g):
    """One sentence, in the units a person would say it in."""
    if not t:
        return "No finished print has been timed yet, so there is nothing to score."
    ratio = t["medianRatio"]
    off = abs(ratio - 1.0) * 100.0
    n = t["n"]
    plural = "print" if n == 1 else "prints"
    if off < 3:
        head = f"The slicer's time estimate is within {off:.0f}% over {n} {plural}."
    elif ratio > 1:
        head = (f"Prints take {off:.0f}% longer than the slicer says "
                f"(median ×{ratio:.2f} over {n} {plural}).")
    else:
        head = (f"Prints finish {off:.0f}% sooner than the slicer says "
                f"(median ×{ratio:.2f} over {n} {plural}).")
    if g:
        gr = g["medianRatio"]
        head += (f" Weight is ×{gr:.2f} over {g['n']}"
                 f" weighed {'print' if g['n'] == 1 else 'prints'}.")
    return head


# ---------------------------------------------------------------- telemetry


def grams_from_telemetry(before, after):
    """Filament used, in grams, from two AMS snapshots — or None.

    The A1 mini reports no consumed weight of any kind. The only figure that can
    become one is the AMS tray's `remain` percentage against the spool's stated
    weight, and both are zero for every spool without a Bambu RFID tag, which is
    every spool in this cupboard. So this returns a number when the printer
    genuinely supplies one and None the rest of the time, and the caller says
    which happened rather than inventing a value.
    """
    def trays(snapshot):
        out = {}
        for tray in ((snapshot or {}).get("filament") or {}).get("ams_slots") or []:
            tid = str(tray.get("id"))
            remain = util.as_number(tray.get("remain"), None)
            weight = util.as_number(tray.get("tray_weight"), None)
            if remain is None or weight is None or remain <= 0 or weight <= 0:
                continue
            out[tid] = (remain, weight)
        return out

    a, b = trays(before), trays(after)
    used = 0.0
    seen = False
    for tid, (r0, w0) in a.items():
        if tid not in b:
            continue
        r1, _w1 = b[tid]
        delta = (r0 - r1) / 100.0 * w0
        if delta < 0:
            continue                 # a spool was swapped or refilled; not ours to guess
        used += delta
        seen = True
    if not seen or used <= 0:
        return None
    return round(used, 2)


def jpeg_size(data):
    """(width, height) of a JPEG, or None. Enough of a parse to prove the bytes
    are a decodable image rather than an error page that happened to start FFD8."""
    if len(data) < 4 or data[0] != 0xFF or data[1] != 0xD8:
        return None
    i = 2
    n = len(data)
    while i + 3 < n:
        if data[i] != 0xFF:
            i += 1
            continue
        marker = data[i + 1]
        if marker in (0xD8, 0x01) or 0xD0 <= marker <= 0xD7:
            i += 2
            continue
        if marker == 0xD9:
            return None
        length = (data[i + 2] << 8) | data[i + 3]
        if length < 2:
            return None
        if marker in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7,
                      0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
            if i + 9 > n:
                return None
            height = (data[i + 5] << 8) | data[i + 6]
            width = (data[i + 7] << 8) | data[i + 8]
            return (width, height) if width and height else None
        i += 2 + length
    return None


def _http_get(url, timeout):
    req = urllib.request.Request(url, headers={"User-Agent": "bluesheet-made/1"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read(), (r.headers.get("Content-Type") or "")


def fetch_status(url=None, timeout=4.0):
    """gladys's view of the printer. Raises if it cannot be had."""
    raw, _ctype = _http_get(url or STATUS_URL, timeout)
    data = json.loads(raw.decode("utf-8"))
    if not isinstance(data, dict):
        raise ValueError("gladys returned something that is not an object")
    return data


def fetch_photo(url=None, timeout=12.0):
    """One full-resolution frame from the workshop camera.

    Validated as a JPEG here rather than trusted: the camera service answers a
    request it cannot serve with a JSON error and a 200, and a job holding four
    hundred bytes of `{"error": ...}` in place of a photograph is worse than one
    that admits the camera was down.
    """
    data, ctype = _http_get(url or CAMERA_URL, timeout)
    if len(data) < MIN_PHOTO_BYTES:
        raise ValueError(f"the camera returned {len(data)} bytes, which is not a photograph")
    if len(data) > MAX_PHOTO_BYTES:
        raise ValueError(f"the camera returned {len(data)} bytes, over the {MAX_PHOTO_BYTES} limit")
    if "jpeg" not in ctype.lower() and not data.startswith(b"\xff\xd8\xff"):
        raise ValueError(f"the camera returned {ctype or 'no content type'}, not a JPEG")
    if not data.startswith(b"\xff\xd8") or not data.rstrip(b"\r\n").endswith(b"\xff\xd9"):
        raise ValueError("the camera returned a truncated JPEG")
    size = jpeg_size(data)
    if not size:
        raise ValueError("the camera returned bytes that do not decode as a JPEG")
    return data, size


# ---------------------------------------------------------------- the watcher


class Watcher:
    """The only thing that moves a job from `uploaded` to `made`.

    One thread, one HTTP GET per tick against a service on loopback. The state
    machine is in `tick()` and takes a snapshot as an argument path so the whole
    of it — including all three failure modes — is exercisable without a printer,
    a camera or a clock.
    """

    def __init__(self, st=None, status=None, photo=None, clock=time.time,
                 poll_idle=POLL_IDLE, poll_live=POLL_LIVE, lost_after=LOST_AFTER,
                 misses_to_close=2, photo_attempts=2, photo_retry_delay=3.0,
                 sleep=time.sleep):
        self.store = st or store()
        self.fetch_status = status or fetch_status
        self.fetch_photo = photo or fetch_photo
        self.now = clock
        self.poll_idle = poll_idle
        self.poll_live = poll_live
        self.lost_after = lost_after
        self.misses_to_close = max(1, int(misses_to_close))
        self.photo_attempts = max(1, int(photo_attempts))
        self.photo_retry_delay = photo_retry_delay
        self.sleep = sleep

        self.last_status_at = None
        self.last_error = None
        self.unreachable_since = None
        self.ticks = 0
        self._misses = {}
        self._thread = None
        self._stop = threading.Event()

    # --- the loop ------------------------------------------------------

    def start(self):
        if self._thread and self._thread.is_alive():
            return self
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, name="bluesheet-made-watch",
                                        daemon=True)
        self._thread.start()
        return self

    def stop(self, timeout=2.0):
        self._stop.set()
        if self._thread:
            self._thread.join(timeout)
        return self

    def _loop(self):
        while not self._stop.is_set():
            try:
                self.tick()
            except Exception as e:                  # a watcher that dies is worse
                self.last_error = f"{type(e).__name__}: {e}"
            wait = self.poll_live if self.store.live() else self.poll_idle
            self._stop.wait(wait)

    @property
    def running(self):
        return bool(self._thread and self._thread.is_alive())

    def state(self):
        return {
            "running": self.running,
            "pollSeconds": self.poll_idle,
            "livePollSeconds": self.poll_live,
            "lastStatusAt": self.last_status_at,
            "lastStatus": util.iso(self.last_status_at) if self.last_status_at else None,
            "lastError": self.last_error,
            "unreachableSince": self.unreachable_since,
            "ticks": self.ticks,
            "source": STATUS_URL,
            "camera": CAMERA_URL,
        }

    # --- one observation ------------------------------------------------

    def tick(self, snapshot=None):
        """Read the printer once and move every job it says something about.

        Returns what it did, which is what the tests assert on and what
        /api/made reports as the watcher's own state.
        """
        self.ticks += 1
        now = self.now()
        if snapshot is None:
            try:
                snapshot = self.fetch_status()
            except Exception as e:
                self.last_error = f"{type(e).__name__}: {e}"
                if self.unreachable_since is None:
                    self.unreachable_since = now
                return {"ok": False, "error": self.last_error,
                        "closed": self._on_unreachable(now)}
        self.last_error = None
        self.unreachable_since = None
        self.last_status_at = now

        summary = (snapshot or {}).get("summary") or {}
        connected = bool(snapshot.get("connected", True))
        if not connected:
            # gladys answered but has no MQTT link, so it knows no more than we do.
            self.last_error = snapshot.get("last_error") or "gladys is not connected to the printer"
            if self.unreachable_since is None:
                self.unreachable_since = now
            return {"ok": False, "error": self.last_error,
                    "closed": self._on_unreachable(now)}

        state = (summary.get("state") or "").upper()
        job_file = summary.get("job") or ""
        matched = self._match(job_file)
        moved = []

        if matched and state in PRINTER_ACTIVE:
            self._misses.pop(matched["id"], None)
            moved.append(self._observe_running(matched["id"], summary, now))
        elif matched and state in PRINTER_DONE_OK:
            if matched.get("state") == "printing":
                moved.append(self._complete(matched["id"], summary, now, "made"))
            else:
                self._misses.pop(matched["id"], None)
        elif matched and state in PRINTER_DONE_BAD:
            if matched.get("state") == "printing":
                moved.append(self._complete(matched["id"], summary, now, "failed"))

        # Anything still claiming to print that the printer is not talking about.
        for job in self.store.live():
            if job.get("state") != "printing":
                continue
            if matched and job["id"] == matched["id"] and state in (
                    PRINTER_ACTIVE | PRINTER_DONE_OK | PRINTER_DONE_BAD):
                continue
            moved.append(self._observe_absent(job, state, job_file, now))

        return {"ok": True, "state": state, "job": job_file,
                "matched": matched["id"] if matched else None,
                "moved": [m for m in moved if m]}

    # --- matching -------------------------------------------------------

    def _match(self, job_file):
        """The job whose file the printer is running, by name or by slice id."""
        if not job_file:
            return None
        m = SD_SLICE_ID.search(job_file)
        slice_id = m.group(1).lower() if m else None
        best = None
        for job in self.store.all():
            sd_name = (job.get("sd") or {}).get("name")
            hit = (sd_name and _stem(sd_name) == _stem(job_file)) or \
                  (slice_id and (job.get("sliceId") or "").lower() == slice_id)
            if not hit:
                continue
            # A live job always wins: the same object printed twice leaves an
            # older finished record with the same filename, and completing that
            # one again would overwrite a real timing with this print's.
            live = job.get("state") in LIVE_STATES
            rank = (1 if live else 0, job.get("updatedAt") or 0)
            if best is None or rank > best[0]:
                best = (rank, job)
        return best[1] if best else None

    # --- transitions ----------------------------------------------------

    def _observe_running(self, job_id, summary, now):
        percent = util.as_number(summary.get("percent"), 0, 0, 100) or 0
        layer = int(util.as_number(summary.get("layer"), 0) or 0)
        total = int(util.as_number(summary.get("total_layers"), 0) or 0)
        remaining = util.as_number(summary.get("remaining_min"), None)
        result = {}

        def apply(job):
            p = job.setdefault("print", {})
            first = job.get("state") != "printing"
            if first:
                job["state"] = "printing"
                job["error"] = None
                if not p.get("startedAt"):
                    est = (job.get("estimate") or {}).get("seconds") or 0
                    # The A1 mini's percentage counts the heat-up and the
                    # calibration passes: the real gauge print read 6% while
                    # still on layer 1 (2026-09-03). The layer is the honest
                    # signal for "did we see this begin"; percent is only the
                    # fallback when no layer is reported.
                    joined_late = (layer > 1) if layer else (percent > 10)
                    if joined_late and est:
                        # Joined mid-print: reconstruct the start so the card is
                        # not obviously wrong, and mark the timing as inferred so
                        # the accuracy score refuses to use it.
                        p["startedAt"] = now - (percent / 100.0) * est
                        p["startedAtSource"] = "inferred"
                    else:
                        p["startedAt"] = now
                        p["startedAtSource"] = "observed"
                if not job.get("sd"):
                    job["sd"] = {"name": summary.get("job"), "bytes": 0, "at": now}
                _event(job, "printing",
                       f"{summary.get('job')} at {percent:.0f}%"
                       + (" (start inferred)" if p.get("startedAtSource") == "inferred" else ""))
                result["moved"] = "printing"
            p["percent"] = percent
            p["layer"] = layer
            p["totalLayers"] = total
            p["remainingMin"] = remaining
            p["lastSeenAt"] = now
            p["stale"] = False
            p["filament"] = (summary.get("filament") or {}) if first else p.get("filament")
            p["filamentAt"] = summary.get("filament") or {}

        self.store.update(job_id, apply)
        return {"id": job_id, "to": result.get("moved") or "printing"}

    def _complete(self, job_id, summary, now, outcome):
        """The print ended. Record the timing first, then try for a photograph.

        In that order deliberately: the elapsed time is the thing that cannot be
        recovered later, and the camera is the part most likely to fail.
        """
        percent = util.as_number(summary.get("percent"), 0, 0, 100) or 0
        layer = int(util.as_number(summary.get("layer"), 0) or 0)
        before = {}

        def apply(job):
            p = job.setdefault("print", {})
            before.update(p.get("filament") or {})
            p["endedAt"] = now
            p["percent"] = percent if outcome == "made" else percent
            p["layer"] = layer
            p["stale"] = False
            started = p.get("startedAt")
            act = job.setdefault("actual", _blank_actual())
            if started:
                elapsed = max(0.0, now - started)
                act["seconds"] = int(round(elapsed))
                act["minutes"] = round(elapsed / 60.0, 2)
                act["timing"] = "observed" if p.get("startedAtSource") == "observed" \
                    else "inferred"
            act["layers"] = layer or (job.get("estimate") or {}).get("layers")
            grams = grams_from_telemetry(p.get("filament"), summary.get("filament"))
            if grams is not None and act.get("grams") is None:
                act["grams"] = grams
                act["gramsSource"] = "ams"
            job["state"] = outcome
            if outcome == "failed":
                job["error"] = f"the printer reported the print failed at {percent:.0f}%"
            _event(job, outcome,
                   f"{util.fmt_duration(act['seconds'] or 0)} against an estimate of "
                   f"{util.fmt_duration((job.get('estimate') or {}).get('seconds') or 0)}")

        self.store.update(job_id, apply)
        self.capture(job_id)
        return {"id": job_id, "to": outcome}

    def _observe_absent(self, job, state, job_file, now):
        """The printer is not running this job any more and never said it ended.

        A stop, a power cycle, a file replaced on the card, or simply the printer
        going IDLE — from here they are indistinguishable, so the job is closed
        as `unknown` holding the last percentage actually seen rather than left
        claiming to be printing for the rest of time. Two consecutive
        observations are required: one odd frame of telemetry between layers
        should not end a print that is still going.
        """
        job_id = job["id"]
        misses = self._misses.get(job_id, 0) + 1
        self._misses[job_id] = misses
        if misses < self.misses_to_close:
            self.store.update(job_id, lambda j: j.setdefault("print", {})
                              .update({"stale": True}) or None)
            return {"id": job_id, "to": "printing", "misses": misses}

        self._misses.pop(job_id, None)
        seen = job.get("print") or {}

        def apply(j):
            p = j.setdefault("print", {})
            p["endedAt"] = now
            p["stale"] = False
            started = p.get("startedAt")
            if started:
                elapsed = max(0.0, now - started)
                j["actual"]["seconds"] = int(round(elapsed))
                j["actual"]["minutes"] = round(elapsed / 60.0, 2)
                # Deliberately not scored: the print stopped being observed, so
                # this elapsed time is how long Bluesheet watched, not how long the
                # object took.
                j["actual"]["timing"] = "unobserved"
            j["state"] = "unknown"
            j["error"] = (f"the printer stopped reporting this print at "
                          f"{seen.get('percent') or 0:.0f}%"
                          + (f" and moved on to {job_file}" if job_file else
                             f" (it now reports {state or 'nothing'})"))
            _event(j, "lost", j["error"])

        self.store.update(job_id, apply)
        return {"id": job_id, "to": "unknown"}

    def _on_unreachable(self, now):
        """gladys is not answering. Say so on every live print immediately, and
        close them once the silence has gone on longer than any blip."""
        closed = []
        silent = now - (self.unreachable_since or now)
        for job in self.store.live():
            if job.get("state") != "printing":
                continue
            if silent < self.lost_after:
                self.store.update(job["id"], lambda j: j.setdefault("print", {})
                                  .update({"stale": True}) or None)
                continue
            seen = job.get("print") or {}

            def apply(j, seen=seen):
                j["state"] = "unknown"
                j["print"]["endedAt"] = now
                j["print"]["stale"] = False
                j["actual"]["timing"] = "unobserved"
                j["error"] = (f"the printer telemetry was unreachable for "
                              f"{util.fmt_duration(silent)}; the last thing Bluesheet saw "
                              f"was {seen.get('percent') or 0:.0f}% at layer "
                              f"{seen.get('layer') or 0}")
                _event(j, "lost", j["error"])

            self.store.update(job["id"], apply)
            closed.append(job["id"])
        return closed

    # --- the photograph -------------------------------------------------

    def capture(self, job_id):
        """Grab a frame and store it against the job. Never raises.

        A failure here is recorded on the job and nothing else: the print
        happened whether or not the camera was working, and losing the timing
        record to a dark cupboard would be the wrong trade every time.
        """
        job = self.store.get(job_id)
        if not job:
            return None
        last = None
        for attempt in range(self.photo_attempts):
            try:
                data, (width, height) = self.fetch_photo()
            except Exception as e:
                last = f"{type(e).__name__}: {e}"
                if attempt + 1 < self.photo_attempts:
                    self.sleep(self.photo_retry_delay)
                continue
            name = self.store.write_photo(job_id, data)

            def ok(j):
                j["photo"] = {"file": name, "bytes": len(data), "at": self.now(),
                              "width": width, "height": height, "source": CAMERA_URL}
                j["photoError"] = None
                _event(j, "photographed", f"{width}×{height}, {len(data) // 1024} kB")

            self.store.update(job_id, ok)
            return self.store.get(job_id)

        def bad(j):
            j["photoError"] = last
            _event(j, "photo-failed", last or "unknown")

        self.store.update(job_id, bad)
        return self.store.get(job_id)


_watcher = None
_watcher_lock = threading.Lock()


def watcher():
    global _watcher
    with _watcher_lock:
        if _watcher is None:
            _watcher = Watcher()
        return _watcher


def start():
    """Begin watching the printer. Called once from server.py's main()."""
    return watcher().start()


def stop():
    return watcher().stop()


# ---------------------------------------------------------------- HTTP


def _public(job, st, inline_params=True):
    """A record as the browser sees it: images by URL, score computed, and the
    bulky parameter sets left for a per-job fetch."""
    out = json.loads(json.dumps(job))
    out["score"] = score(job)
    out["photoUrl"] = f"{PREFIX}/{job['id']}/photo.jpg" if job.get("photo") else None
    out["renderUrl"] = f"{PREFIX}/{job['id']}/render" if job.get("render") else None
    if not inline_params:
        try:
            size = len(util.canonical(out.get("params") or {}).encode("utf-8"))
        except (TypeError, ValueError):
            size = MAX_PARAMS_BYTES
        if size > LIST_PARAMS_INLINE:
            out["params"] = {}
            out["paramsTruncated"] = True
    return out


def listing(st=None, limit=None, state=None, gen=None):
    st = st or store()
    jobs = st.all()
    if state:
        jobs = [j for j in jobs if j.get("state") == state]
    if gen:
        jobs = [j for j in jobs if j.get("gen") == gen]
    acc = accuracy(st.all())
    if limit:
        jobs = jobs[:limit]
    return {"jobs": [_public(j, st, inline_params=False) for j in jobs],
            "accuracy": acc}


def route(handler, path):
    """Serve /api/made*. Returns True when it has answered.

    Wired identically in three places (see the module docstring); the method is
    read from the handler so the line the driver pastes is the same each time.
    """
    if path != PREFIX and not path.startswith(PREFIX + "/"):
        return False
    method = handler.command
    rest = path[len(PREFIX):].strip("/")
    parts = [p for p in rest.split("/") if p]
    st = store()

    try:
        if method in ("GET", "HEAD"):
            return _get(handler, parts, st)
        if method == "POST":
            return _post(handler, parts, st)
        if method == "DELETE":
            return _delete(handler, parts, st)
    except MadeError as e:
        handler._fail(400, str(e))
        return True
    handler._fail(405, f"{method} is not allowed here")
    return True


def _get(handler, parts, st):
    if not parts:
        query = handler._query()
        limit = int(util.as_number(handler._q(query, "limit"), 0, 0, MAX_JOBS) or 0)
        body = listing(st, limit=limit or None,
                       state=handler._q(query, "state"),
                       gen=handler._q(query, "gen"))
        body["ok"] = True
        body["watcher"] = watcher().state()
        handler._json(body)
        return True

    job_id = parts[0]
    if not util.is_safe_id(job_id):
        handler._fail(400, "bad job id")
        return True
    job = st.get(job_id)
    if not job:
        handler._fail(404, "no such job")
        return True

    if len(parts) == 1:
        handler._json({"ok": True, "job": _public(job, st)})
        return True
    if parts[1] in ("photo.jpg", "photo"):
        return _send_asset(handler, st.photo_path(job), "image/jpeg",
                           "no photograph was taken for this job")
    if parts[1] == "render":
        return _send_asset(handler, st.render_path(job),
                           (job.get("render") or {}).get("type") or "image/png",
                           "this job has no render")
    handler._fail(404, "no such job resource")
    return True


def _send_asset(handler, path, ctype, missing):
    if not path or not os.path.isfile(path):
        handler._fail(404, missing)
        return True
    try:
        with open(path, "rb") as f:
            data = f.read()
    except OSError:
        handler._fail(404, missing)
        return True
    # Already-compressed pixels: gzip would cost CPU and add bytes. The name of
    # an image here contains the job id, which never points at different bytes,
    # so it is safe to cache hard — a retaken photograph replaces the file, so
    # the URL carries a version too.
    handler._send(data, 200, ctype, gzip_ok=False, headers={
        "Cache-Control": "private, max-age=60",
        "Content-Disposition": "inline",
    })
    return True


def _post(handler, parts, st):
    if not parts:
        body = handler._read_json(2 * 1024 * 1024)
        if body is None:
            return True
        job = record_slice(body, st)
        _note(handler, f"made job {job['id']} created for slice {job['sliceId']} "
                       f"({job['gen']})")
        handler._json({"ok": True, "job": _public(job, st)}, 201)
        return True

    job_id = parts[0]
    if not util.is_safe_id(job_id):
        handler._fail(400, "bad job id")
        return True
    if not st.get(job_id):
        handler._fail(404, "no such job")
        return True
    body = handler._read_json()
    if body is None:
        return True

    event = body.get("event")
    if event == "uploaded":
        job = st.get(job_id)
        record_upload(job["sliceId"], body.get("sdName") or body.get("name"),
                      body.get("bytes"), st)
        handler._json({"ok": True, "job": _public(st.get(job_id), st)})
        return True
    if event == "retake":
        job = watcher().capture(job_id)
        _note(handler, f"made job {job_id} photograph "
                       f"{'retaken' if job.get('photo') else 'failed: ' + str(job.get('photoError'))}")
        handler._json({"ok": bool(job.get("photo")), "job": _public(job, st),
                       "error": job.get("photoError")},
                      200 if job.get("photo") else 502)
        return True

    changed = False
    if body.get("grams") is not None or body.get("actualGrams") is not None:
        set_actual_grams(job_id,
                         body.get("grams") if body.get("grams") is not None
                         else body.get("actualGrams"),
                         body.get("gramsSource") or "weighed", st)
        changed = True
    if body.get("notes") is not None:
        set_notes(job_id, body.get("notes"), st)
        changed = True
    if not changed:
        handler._fail(400, "nothing to change: send grams, notes, "
                           "or event 'uploaded' or 'retake'")
        return True
    handler._json({"ok": True, "job": _public(st.get(job_id), st)})
    return True


def _delete(handler, parts, st):
    if not parts:
        handler._fail(405, "DELETE the whole log is not allowed")
        return True
    job_id = parts[0]
    if not util.is_safe_id(job_id):
        handler._fail(400, "bad job id")
        return True
    if not st.delete(job_id):
        handler._fail(404, "no such job")
        return True
    _note(handler, f"made job {job_id} forgotten")
    handler._json({"ok": True, "id": job_id, "deleted": True})
    return True


def _note(handler, message):
    note = getattr(handler, "note", None)
    if callable(note):
        note(message)
