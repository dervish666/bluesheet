"""Paths, atomic state files, hashing and small caches.

State is JSON on disk — no database, per the house pattern. Every write goes
through atomic_write_*: a slice can take a minute and a laptop can lose power,
and a truncated meta.json that still *parses* would be worse than none at all.
"""
import gzip
import hashlib
import json
import os
import re
import shutil
import tempfile
import threading
import time

PROJECT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATE_DIR = os.path.join(PROJECT_DIR, "state")
SLICE_DIR = os.path.join(STATE_DIR, "slices")
LIBRARY_DIR = os.path.join(PROJECT_DIR, "library")
ELEV_DIR = os.path.join(PROJECT_DIR, "assets", "elev")
FONT_DIR = os.path.join(PROJECT_DIR, "assets", "fonts")


def ensure_dirs():
    for d in (STATE_DIR, SLICE_DIR, LIBRARY_DIR, ELEV_DIR):
        os.makedirs(d, exist_ok=True)


def canonical(obj):
    """Stable JSON text for hashing: sorted keys, no incidental whitespace."""
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def digest(*parts, length=16):
    """sha256 over the parts, hex-truncated. Parts are separated by a byte that
    cannot appear in JSON text, so digest('ab','c') != digest('a','bc') — cache
    keys are built from concatenated user input and collisions there would serve
    one design's gcode for another's."""
    h = hashlib.sha256()
    for p in parts:
        if isinstance(p, str):
            p = p.encode("utf-8")
        h.update(p)
        h.update(b"\x1e")
    return h.hexdigest()[:length]


def atomic_write_bytes(path, data):
    d = os.path.dirname(path) or "."
    os.makedirs(d, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=d, prefix=".tmp-")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def atomic_write_json(path, obj, indent=None):
    atomic_write_bytes(path, (json.dumps(obj, indent=indent, ensure_ascii=False) + "\n")
                       .encode("utf-8"))


def read_json(path, default=None):
    """Read JSON, or `default` if the file is missing OR unparseable. Corruption
    is treated as absence deliberately: every caller here can rebuild what it
    reads (a slice can be re-run, a parse re-derived), and a hard failure on one
    bad file would take the whole endpoint down."""
    try:
        with open(path, "rb") as f:
            return json.loads(f.read().decode("utf-8"))
    except (OSError, ValueError):
        return default


def write_gz_json(path, obj):
    atomic_write_bytes(path, gzip.compress(
        json.dumps(obj, separators=(",", ":"), ensure_ascii=False).encode("utf-8"), 6))


def read_gz_json(path, default=None):
    try:
        with gzip.open(path, "rb") as f:
            return json.loads(f.read().decode("utf-8"))
    except (OSError, ValueError, EOFError):
        return default


_SAFE_ID = re.compile(r"\A[A-Za-z0-9][A-Za-z0-9_-]{0,63}\Z")


def is_safe_id(s):
    """True for ids we are willing to put in a filesystem path. Anchored with \\A/\\Z
    rather than ^/$ — `$` also matches before a trailing newline, so '../x\\n' would
    pass a `^...$` check and then walk out of the state directory."""
    return isinstance(s, str) and bool(_SAFE_ID.match(s))


_DUR = re.compile(r"(\d+(?:\.\d+)?)\s*([dhms])", re.I)
_DUR_UNITS = {"d": 86400, "h": 3600, "m": 60, "s": 1}


def parse_time_text(text):
    """'1h 25m 11s' -> 5111. OrcaSlicer prints estimates as prose in the header
    block; there is no machine-readable seconds field anywhere in the file."""
    if not text:
        return 0
    total = 0.0
    for value, unit in _DUR.findall(str(text)):
        total += float(value) * _DUR_UNITS[unit.lower()]
    return int(round(total))


def fmt_duration(seconds):
    seconds = int(max(0, seconds))
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    if h:
        return f"{h}h {m}m {s}s"
    if m:
        return f"{m}m {s}s"
    return f"{s}s"


def dir_size(path):
    total = 0
    for root, _dirs, files in os.walk(path):
        for name in files:
            try:
                total += os.lstat(os.path.join(root, name)).st_size
            except OSError:
                pass
    return total


def prune_dirs(root, keep=40, max_bytes=2 * 1024 ** 3, protect=()):
    """Keep the newest `keep` subdirectories and stay under `max_bytes`.

    Sliced 3mfs plus their parsed toolpath caches run to tens of megabytes each
    and this laptop shares its disk with ~50 other services, so the cache is
    bounded by both count and size. `protect` holds ids of in-flight jobs, which
    must survive a prune triggered by a concurrent slice.
    """
    try:
        entries = [e for e in os.scandir(root) if e.is_dir(follow_symlinks=False)]
    except OSError:
        return []
    entries.sort(key=lambda e: e.stat().st_mtime, reverse=True)
    removed = []
    total = 0
    for i, e in enumerate(entries):
        size = dir_size(e.path)
        total += size
        if e.name in protect:
            continue
        if i >= keep or total > max_bytes:
            try:
                shutil.rmtree(e.path)
                removed.append(e.name)
                total -= size
            except OSError:
                pass
    return removed


class Lru:
    """Bounded thread-safe cache. Small by design — the values are parsed
    toolpath sets of tens of MB, so this holds two, not two hundred."""

    def __init__(self, capacity=2):
        self.capacity = max(1, capacity)
        self._d = {}
        self._order = []
        self._lock = threading.Lock()

    def get(self, key, default=None):
        with self._lock:
            if key not in self._d:
                return default
            self._order.remove(key)
            self._order.append(key)
            return self._d[key]

    def put(self, key, value):
        with self._lock:
            if key in self._d:
                self._order.remove(key)
            self._d[key] = value
            self._order.append(key)
            while len(self._order) > self.capacity:
                del self._d[self._order.pop(0)]

    def drop(self, key):
        with self._lock:
            if key in self._d:
                del self._d[key]
                self._order.remove(key)


def iso(ts=None):
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(ts if ts else time.time()))


def clamp(value, lo, hi):
    return lo if value < lo else hi if value > hi else value


def as_number(value, default=None, lo=None, hi=None):
    """Coerce untrusted JSON to a finite float. Rejects bool (True would otherwise
    become 1.0 and slice at a 1 mm layer height), NaN and inf."""
    if isinstance(value, bool) or value is None:
        return default
    try:
        f = float(value)
    except (TypeError, ValueError):
        return default
    if f != f or f in (float("inf"), float("-inf")):
        return default
    if lo is not None and f < lo:
        f = lo
    if hi is not None and f > hi:
        f = hi
    return f
