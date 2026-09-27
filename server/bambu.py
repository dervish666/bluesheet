"""Hand a Bambu Studio project to Bambu Studio by URL, the way MakerWorld does.

The browser builds the project 3mf (js/kernel/bambu.js), POSTs it here, and
navigates to `bambustudioopen://<url>` (macOS) or `bambustudio://open?file=<url>`.
Bambu Studio then downloads that URL itself (Plater::import_model_id) and opens
it with load_project, i.e. as a project with its config, so the filament swap
comes with it. Bambu's downloader sends no cookie and no Origin, so the GET has
to be unauthenticated. What bounds it instead:

* the id is 128 random bits (secrets.token_hex), checked against ^[0-9a-f]{32}$
  before it is used for anything, and only ever a dict key: never a path, so
  there is nothing to traverse;
* entries live in memory, expire after TTL seconds, and at most MAX_ENTRIES /
  MAX_TOTAL bytes are held; the oldest go first;
* only something that opens as a zip holding 3D/3dmodel.model is stored, so the
  route cannot be used to park arbitrary bytes on the LAN under model/3mf;
* the POST side is the server's usual same-origin JSON rule (server.py
  _csrf_reject), so a hostile page cannot fill the store.

The name in the URL path is cosmetic: Bambu takes the file name from the last
path segment and refuses anything not ending .3mf, so the URL ends in one.
"""
import io
import re
import secrets
import threading
import time
import zipfile

MAX_BYTES = 48 * 1024 * 1024        # one project; a comic panel is well under 2 MB
MAX_ENTRIES = 8
MAX_TOTAL = 128 * 1024 * 1024
TTL = 15 * 60                       # seconds; long enough to answer Bambu's trust dialog

_ID = re.compile(r"\A[0-9a-f]{32}\Z")
_NAME_BAD = re.compile(r"[^A-Za-z0-9._-]+")

_lock = threading.Lock()
_store = {}                         # id -> {"data", "name", "at"}


class BambuError(ValueError):
    pass


def clean_name(name):
    """A file stem safe in a URL path and a Content-Disposition header."""
    stem = _NAME_BAD.sub("-", str(name or "")).strip("-.")[:60]
    if stem.lower().endswith(".3mf"):
        stem = stem[:-4]
    return stem or "bluesheet"


def is_id(value):
    return isinstance(value, str) and bool(_ID.match(value))


def _check_3mf(data):
    if len(data) > MAX_BYTES:
        raise BambuError(f"project is {len(data)} bytes; the limit is {MAX_BYTES}")
    if not data.startswith(b"PK\x03\x04"):
        raise BambuError("not a 3mf (no zip header)")
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            names = set(z.namelist())
    except zipfile.BadZipFile as e:
        raise BambuError(f"not a 3mf: {e}") from None
    if "3D/3dmodel.model" not in names:
        raise BambuError("not a 3mf: no 3D/3dmodel.model inside")


def _prune(now):
    for key in [k for k, v in _store.items() if now - v["at"] > TTL]:
        del _store[key]


def put(data, name, now=None):
    """Store a project and return (id, stem). Raises BambuError on a bad one."""
    _check_3mf(data)
    now = time.time() if now is None else now
    stem = clean_name(name)
    with _lock:
        _prune(now)
        while _store and (len(_store) >= MAX_ENTRIES
                          or sum(len(v["data"]) for v in _store.values()) + len(data) > MAX_TOTAL):
            oldest = min(_store, key=lambda k: _store[k]["at"])
            del _store[oldest]
        key = secrets.token_hex(16)
        _store[key] = {"data": data, "name": stem, "at": now}
    return key, stem


def get(key, now=None):
    """The entry for an id, or None if it is malformed, unknown or expired."""
    if not is_id(key):
        return None
    now = time.time() if now is None else now
    with _lock:
        _prune(now)
        return _store.get(key)


def count():
    with _lock:
        return len(_store)


def clear():
    with _lock:
        _store.clear()
