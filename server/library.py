"""Saved designs: one JSON file per entry under library/.

A design is small — a generator id, a handful of numbers and a thumbnail — so a
file each is the right storage. It keeps concurrent writes independent (no index
file to lose), makes an entry inspectable with `cat`, and means a corrupt entry
costs one design rather than the library.

Everything in here arrives from a browser on the LAN, so every field is bounded:
a name that is 4 MB of text or a thumbnail that is a 30 MB PNG would otherwise be
accepted, stored forever and re-sent on every listing.
"""
import os
import re
import secrets
import time

from . import util

MAX_NAME = 80
MAX_NOTES = 2000
MAX_PARAMS_BYTES = 256 * 1024
MAX_THUMB_BYTES = 400 * 1024
MAX_ENTRIES = 500

GEN_ID = re.compile(r"\A[a-z0-9][a-z0-9-]{0,63}\Z")
THUMB = re.compile(r"\Adata:image/(png|jpeg|webp);base64,[A-Za-z0-9+/=\s]{16,}\Z")
CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


class LibraryError(ValueError):
    pass


def _path(entry_id):
    if not util.is_safe_id(entry_id):
        raise LibraryError("bad library id")
    return os.path.join(util.LIBRARY_DIR, entry_id + ".json")


def _clean_text(value, limit, field):
    if not isinstance(value, str):
        raise LibraryError(f"{field} must be a string")
    value = CONTROL.sub("", value).strip()
    if len(value) > limit:
        raise LibraryError(f"{field} is longer than {limit} characters")
    return value


def _check_params(params):
    """Params are whatever a generator declares, so the shape is open — but the
    size is not, and a value that cannot be JSON is a bug we should not store."""
    if not isinstance(params, dict):
        raise LibraryError("params must be an object")
    try:
        text = util.canonical(params)
    except (TypeError, ValueError) as e:
        raise LibraryError(f"params are not JSON-serialisable: {e}")
    if len(text.encode("utf-8")) > MAX_PARAMS_BYTES:
        raise LibraryError(f"params exceed {MAX_PARAMS_BYTES} bytes")
    return params


def save(body):
    """Create or replace an entry. Returns the stored record."""
    if not isinstance(body, dict):
        raise LibraryError("expected a JSON object")
    gen = body.get("gen")
    if not isinstance(gen, str) or not GEN_ID.match(gen):
        raise LibraryError("gen must be a generator id like 'gridfinity'")
    name = _clean_text(body.get("name") or gen, MAX_NAME, "name") or gen
    params = _check_params(body.get("params") or {})

    thumb = body.get("thumbnail")
    if thumb:
        if not isinstance(thumb, str) or not THUMB.match(thumb):
            raise LibraryError("thumbnail must be a data: URL for a png, jpeg or webp")
        if len(thumb) > MAX_THUMB_BYTES:
            raise LibraryError(f"thumbnail exceeds {MAX_THUMB_BYTES} bytes")

    entry_id = body.get("id")
    created = time.time()
    if entry_id:
        if not util.is_safe_id(entry_id):
            raise LibraryError("bad library id")
        existing = util.read_json(_path(entry_id))
        if existing:
            created = existing.get("createdAt", created)
            if thumb is None:
                thumb = existing.get("thumbnail")
    else:
        entry_id = time.strftime("%Y%m%d-%H%M%S") + "-" + secrets.token_hex(3)

    entry = {
        "id": entry_id,
        "gen": gen,
        "name": name,
        "params": params,
        "notes": _clean_text(body.get("notes") or "", MAX_NOTES, "notes"),
        "provenance": _clean_text(body.get("provenance") or "", 200, "provenance"),
        "sliceId": body.get("sliceId") if util.is_safe_id(body.get("sliceId") or "") else None,
        "thumbnail": thumb or None,
        "createdAt": created,
        "created": util.iso(created),
        "updatedAt": time.time(),
        "updated": util.iso(),
        "version": int(util.as_number(body.get("version"), 1)),
    }
    util.atomic_write_json(_path(entry_id), entry, indent=1)
    _enforce_cap()
    return entry


def _enforce_cap():
    entries = _files()
    if len(entries) <= MAX_ENTRIES:
        return
    for path, _mtime in entries[MAX_ENTRIES:]:
        try:
            os.unlink(path)
        except OSError:
            pass


def _files():
    out = []
    try:
        for e in os.scandir(util.LIBRARY_DIR):
            if e.is_file() and e.name.endswith(".json") and not e.name.startswith("."):
                out.append((e.path, e.stat().st_mtime))
    except OSError:
        return []
    out.sort(key=lambda row: row[1], reverse=True)
    return out


def listing(include_thumbs=False, gen=None):
    """Newest first. Thumbnails are omitted by default — fifty base64 PNGs is a
    multi-megabyte response for a list the UI only needs names from."""
    out = []
    for path, _mtime in _files():
        entry = util.read_json(path)
        if not entry or "id" not in entry:
            continue
        if gen and entry.get("gen") != gen:
            continue
        entry["hasThumb"] = bool(entry.get("thumbnail"))
        if not include_thumbs:
            entry.pop("thumbnail", None)
        out.append(entry)
    return out


def get(entry_id):
    return util.read_json(_path(entry_id))


def delete(entry_id):
    path = _path(entry_id)
    if not os.path.isfile(path):
        return False
    os.unlink(path)
    return True


def count():
    return len(_files())
