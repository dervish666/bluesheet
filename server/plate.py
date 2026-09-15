"""The plate, and the provenance index behind it.

Two jobs, both of them memory:

*The plate itself.* A plate is a list of objects with quantities and a gap, and
it lives on the server so that closing the tab does not throw away the layout you
were halfway through arranging. It stores what an object *is* — the generator and
its parameters — never a mesh: geometry is a pure function of those numbers, so
storing the mesh would be storing a derived megabyte that can go stale against its
own generator. The footprint is stored alongside as a cache so the panel can draw
the list and the packing immediately on load, before a single mesh is rebuilt.

*The provenance index.* Every STL Bluesheet exports carries `Bluesheet <gen> v<n> #<hash>`
in the 80 bytes of dead space at the front of a binary STL. That is only half a
trace: the hash identifies a parameter set without containing it. So the hash is
recorded here against the parameters that produced it, and an STL found six months
later can be turned back into the object that made it. Saved library entries carry
the same string, so the lookup falls through to the library and a design saved
through the Save button is findable without being registered twice.

The hash is never computed here. It arrives from the browser, which owns the one
implementation of it (js/kernel/provenance.js) — a second implementation in Python
would be a second opinion about what "the same object" means, and the first time
the two disagreed, a file would silently resolve to the wrong parameters.

Wiring: server.py routes to `route(handler, method, path)`. See the note at the
bottom of this file for the three lines that does, and for the `--serve` entry
point that applies them to a throwaway instance for the tests.
"""
import base64
import binascii
import json
import os
import re
import threading
import time
from urllib.parse import parse_qs, unquote, urlparse

from . import library, util

PLATE_PATH = os.path.join(util.STATE_DIR, "plate.json")
PROV_PATH = os.path.join(util.STATE_DIR, "provenance.json")

MAX_ITEMS = 32
"""Distinct entries on a plate. The slicer endpoint accepts 32 objects, and one
copy is one object, so a plate can never usefully carry more than this many
different things."""
MAX_COPIES = 64
MAX_QTY = 64
MAX_NAME = 80
MAX_ITEM_PARAM_BYTES = 256 * 1024      # matches library.MAX_PARAMS_BYTES
MAX_PLATE_PARAM_BYTES = 768 * 1024
MAX_GAP = 25.0
MAX_DIM = 500.0
MAX_PROV_ENTRIES = 400
MAX_PROV_BODY = 24 * 1024 * 1024
"""A whole STL may be posted to read its header. Only the first 81 bytes are ever
decoded — see `_header_of` — but a caller holding a file should not have to know
that to ask the question."""

QUALITIES = ("draft", "normal", "fine")
GEN_ID = re.compile(r"\A[a-z0-9][a-z0-9-]{0,63}\Z")
HASH = re.compile(r"\A[0-9a-f]{8}\Z")
CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")

# The header format written by js/kernel/provenance.js. Mirrored, not
# reimplemented: this reads the string, it does not recompute the hash.
PROVENANCE = re.compile(
    r"\A(?:Bluesheet\s+)?([a-z0-9][a-z0-9-]*)\s+v(\d+)\s+#([0-9a-f]{8})", re.I)

STL_HEADER_LEN = 80
_B64_FOR_HEADER = 108                  # 108 base64 chars decode to 81 bytes

_lock = threading.RLock()
"""One lock for both files. They are small, the writes are atomic, and a plate
save registers provenance in the same breath — a second lock would only create an
order to get wrong."""


class PlateError(ValueError):
    pass


# --- the plate -------------------------------------------------------------

EMPTY = {"items": [], "gap": 3.0, "rotate": True, "updated": None, "updatedAt": 0}


def load():
    """The stored plate, or an empty one. Never raises: a plate that will not
    parse is a plate you have lost, not an endpoint that should stop answering."""
    stored = util.read_json(PLATE_PATH)
    if not isinstance(stored, dict) or not isinstance(stored.get("items"), list):
        return dict(EMPTY)
    return stored


def save(body):
    """Replace the stored plate. Returns the record as stored.

    The whole plate is sent every time rather than patched item by item. It is at
    most a few hundred kilobytes, it makes a reorder or a bulk clear one request,
    and it means the file on disk is always a complete plate rather than the
    result of a sequence of edits that may have been interrupted.
    """
    if not isinstance(body, dict):
        raise PlateError("expected a JSON object")
    raw_items = body.get("items")
    if not isinstance(raw_items, list):
        raise PlateError("items must be a list")
    if len(raw_items) > MAX_ITEMS:
        raise PlateError(f"a plate holds at most {MAX_ITEMS} different objects")

    items, copies, param_bytes, keys = [], 0, 0, set()
    for i, raw in enumerate(raw_items):
        item = _clean_item(raw, i)
        if item["key"] in keys:
            raise PlateError(f"two items share the key {item['key']!r}")
        keys.add(item["key"])
        copies += item["qty"]
        param_bytes += item["_bytes"]
        del item["_bytes"]
        items.append(item)
    if copies > MAX_COPIES:
        raise PlateError(f"{copies} copies is more than the {MAX_COPIES} a plate holds")
    if param_bytes > MAX_PLATE_PARAM_BYTES:
        raise PlateError(f"the plate's parameters total {param_bytes} bytes, "
                         f"over the {MAX_PLATE_PARAM_BYTES} byte limit")

    gap = util.as_number(body.get("gap"), 3.0)
    if gap is None or not (0.0 <= gap <= MAX_GAP):
        raise PlateError(f"gap must be between 0 and {MAX_GAP:g} mm")

    now = time.time()
    record = {
        "items": items,
        "gap": round(gap, 3),
        "rotate": bool(body.get("rotate", True)),
        "copies": copies,
        "updated": util.iso(now),
        "updatedAt": now,
    }
    with _lock:
        util.atomic_write_json(PLATE_PATH, record, indent=1)
        # Putting an object on the plate is the strongest signal we get that its
        # parameters are worth remembering — it is about to be printed. Register
        # every item that carries a hash, so the STL that comes off this plate can
        # be traced back without anyone having pressed Save.
        for item in items:
            if item["hash"]:
                _register_locked(item["gen"], item["version"], item["hash"],
                                 item["params"], item["name"], source="plate")
    return record


def clear():
    with _lock:
        try:
            os.unlink(PLATE_PATH)
        except OSError:
            pass
    return dict(EMPTY)


def _clean_item(raw, index):
    if not isinstance(raw, dict):
        raise PlateError(f"item {index} is not an object")
    gen = raw.get("gen")
    if not isinstance(gen, str) or not GEN_ID.match(gen):
        raise PlateError(f"item {index}: gen must be a generator id like 'gridfinity'")

    key = raw.get("key")
    if not util.is_safe_id(key or ""):
        raise PlateError(f"item {index}: key must be a short identifier")

    qty = util.as_number(raw.get("qty"), 1)
    if qty is None or qty < 1 or qty > MAX_QTY or abs(qty - round(qty)) > 1e-9:
        raise PlateError(f"item {index}: qty must be a whole number from 1 to {MAX_QTY}")

    params = raw.get("params")
    if not isinstance(params, dict):
        raise PlateError(f"item {index}: params must be an object")
    try:
        text = util.canonical(params)
    except (TypeError, ValueError) as e:
        raise PlateError(f"item {index}: params are not JSON-serialisable: {e}")
    size = len(text.encode("utf-8"))
    if size > MAX_ITEM_PARAM_BYTES:
        raise PlateError(f"item {index}: params are {size} bytes, over the "
                         f"{MAX_ITEM_PARAM_BYTES} byte limit")

    name = CONTROL.sub("", str(raw.get("name") or gen)).strip()[:MAX_NAME] or gen
    quality = raw.get("quality") if raw.get("quality") in QUALITIES else "normal"

    prov_hash = str(raw.get("hash") or "").lower()
    if prov_hash and not HASH.match(prov_hash):
        raise PlateError(f"item {index}: hash must be eight hex digits")

    size3 = []
    for axis, field in enumerate(("w", "d", "h")):
        v = util.as_number(raw.get(field))
        if v is None or not (0 < v <= MAX_DIM):
            raise PlateError(f"item {index}: {field} must be a size in mm "
                             f"(0 to {MAX_DIM:g}), got {raw.get(field)!r}")
        size3.append(round(v, 4))

    return {
        "key": key, "gen": gen, "name": name, "qty": int(round(qty)),
        "params": params, "quality": quality, "hash": prov_hash,
        "version": int(util.as_number(raw.get("version"), 1) or 1),
        "w": size3[0], "d": size3[1], "h": size3[2],
        "tris": int(util.as_number(raw.get("tris"), 0, 0, 1e9) or 0),
        "rotatable": bool(raw.get("rotatable", True)),
        "_bytes": size,
    }


# --- provenance ------------------------------------------------------------

def parse_header(text):
    """`Bluesheet gridfinity v1 #a3f9c2e1` -> {gen, version, hash}, or None.

    None is the ordinary answer for a file that was made somewhere else, and is
    not an error anywhere in this module.
    """
    if not isinstance(text, str):
        return None
    m = PROVENANCE.match(text.strip())
    if not m:
        return None
    return {"gen": m.group(1).lower(), "version": int(m.group(2)),
            "hash": m.group(3).lower()}


def _header_of(b64_text):
    """The 80-byte header out of base64 STL text, decoding only what it needs.

    A caller with a 30 MB print has no reason to know that the answer is in the
    first 80 bytes, so the whole file is accepted — but base64 is positional, so
    the first 108 characters can be decoded on their own and the other 40 MB
    ignored.
    """
    if not isinstance(b64_text, str):
        raise PlateError("stl must be base64 text")
    compact = "".join(b64_text.split())
    head = compact[:_B64_FOR_HEADER]
    head = head[:len(head) - (len(head) % 4)]
    if len(head) < 4:
        raise PlateError("stl is too short to hold an 80-byte header")
    try:
        raw = base64.b64decode(head, validate=True)
    except (binascii.Error, ValueError):
        raise PlateError("stl is not valid base64")
    if len(raw) < STL_HEADER_LEN:
        raise PlateError(f"stl is {len(raw)} bytes; a binary STL header is "
                         f"{STL_HEADER_LEN}")
    # An ASCII STL has no header to read. Its first bytes are "solid ..." and
    # would otherwise be returned as a provenance string that never matches.
    if raw[:5].lower() == b"solid":
        return ""
    return raw[:STL_HEADER_LEN].split(b"\x00", 1)[0].decode("utf-8", "replace").strip()


def _prov_store():
    stored = util.read_json(PROV_PATH)
    if not isinstance(stored, dict) or not isinstance(stored.get("entries"), dict):
        return {"entries": {}}
    return stored


def _prov_key(gen, prov_hash):
    return f"{gen}:{prov_hash}"


def register(gen, version, prov_hash, params, name="", source="api"):
    with _lock:
        return _register_locked(gen, version, prov_hash, params, name, source)


def _register_locked(gen, version, prov_hash, params, name, source):
    """Record parameters against a hash. First writer wins.

    A hash that already names a *different* parameter set is a collision, and the
    older record is the one that describes the file that has already been
    exported — so it is kept and the caller is told. Overwriting would quietly
    make "regenerate exactly" a lie for every file stamped before today.
    """
    if not GEN_ID.match(gen or ""):
        raise PlateError("gen must be a generator id")
    prov_hash = str(prov_hash or "").lower()
    if not HASH.match(prov_hash):
        raise PlateError("hash must be eight hex digits")
    if not isinstance(params, dict):
        raise PlateError("params must be an object")
    try:
        text = util.canonical(params)
    except (TypeError, ValueError) as e:
        raise PlateError(f"params are not JSON-serialisable: {e}")
    if len(text.encode("utf-8")) > MAX_ITEM_PARAM_BYTES:
        raise PlateError(f"params exceed {MAX_ITEM_PARAM_BYTES} bytes")

    store = _prov_store()
    entries = store["entries"]
    key = _prov_key(gen, prov_hash)
    now = time.time()
    existing = entries.get(key)
    if existing:
        conflict = util.canonical(existing.get("params") or {}) != text
        existing["seen"] = int(existing.get("seen", 1)) + 1
        existing["lastSeen"] = util.iso(now)
        existing["lastSeenAt"] = now
        if conflict:
            existing["conflicts"] = int(existing.get("conflicts", 0)) + 1
        util.atomic_write_json(PROV_PATH, store, indent=1)
        return dict(existing, conflict=conflict, stored=False)

    entries[key] = {
        "gen": gen, "version": int(version or 1), "hash": prov_hash,
        "params": params,
        "name": CONTROL.sub("", str(name or gen)).strip()[:MAX_NAME] or gen,
        "source": source, "at": util.iso(now), "atAt": now,
        "seen": 1, "lastSeen": util.iso(now), "lastSeenAt": now,
    }
    _prune(store)
    util.atomic_write_json(PROV_PATH, store, indent=1)
    return dict(entries[key], conflict=False, stored=True)


def _prune(store):
    entries = store["entries"]
    if len(entries) <= MAX_PROV_ENTRIES:
        return
    order = sorted(entries.items(), key=lambda kv: kv[1].get("lastSeenAt", 0), reverse=True)
    store["entries"] = dict(order[:MAX_PROV_ENTRIES])


def lookup(prov_hash, gen=None):
    """Parameters for a hash, from the index or from a saved library entry.

    The library is consulted second and is not a fallback of last resort: a
    design the user actually saved is the better answer, but the index is keyed
    and the library has to be scanned, so the cheap exact match goes first.
    """
    prov_hash = str(prov_hash or "").lower()
    if not HASH.match(prov_hash):
        raise PlateError("hash must be eight hex digits")
    entries = _prov_store()["entries"]
    if gen:
        hit = entries.get(_prov_key(gen, prov_hash))
        if hit:
            return dict(hit, found="index")
    else:
        for key, entry in entries.items():
            if key.endswith(":" + prov_hash):
                return dict(entry, found="index")
    for entry in library.listing():
        parsed = parse_header(entry.get("provenance") or "")
        if not parsed or parsed["hash"] != prov_hash:
            continue
        if gen and parsed["gen"] != gen:
            continue
        return {"gen": parsed["gen"], "version": parsed["version"], "hash": prov_hash,
                "params": entry.get("params") or {}, "name": entry.get("name") or "",
                "source": "library", "libraryId": entry.get("id"),
                "at": entry.get("created"), "found": "library"}
    return None


def count():
    return len(_prov_store()["entries"])


# --- HTTP ------------------------------------------------------------------

def route(handler, method, path):
    """Handle a plate or provenance request. True when it answered.

    Takes the handler rather than returning a response so that the plate speaks
    with the same voice as the rest of the server: the same JSON envelope, the
    same error shape, the same gzip and the same headers. Everything it uses is
    part of ForgeHandler's own vocabulary.
    """
    if not (path == "/api/plate" or path.startswith("/api/plate/")
            or path == "/api/provenance" or path.startswith("/api/provenance/")):
        return False
    try:
        if path == "/api/plate":
            return _plate_endpoint(handler, method)
        if path.startswith("/api/provenance"):
            return _provenance_endpoint(handler, method, path)
        handler._fail(404, "no such endpoint")
        return True
    except PlateError as e:
        handler._fail(400, str(e))
        return True
    except BrokenPipeError:
        return True
    except Exception:
        handler._crash(f"{method} {path}")
        return True


def _plate_endpoint(handler, method):
    if method == "GET":
        record = load()
        handler._json({"ok": True, "plate": record,
                       "limits": {"items": MAX_ITEMS, "copies": MAX_COPIES,
                                  "qty": MAX_QTY, "gap": MAX_GAP}})
        return True
    if method in ("POST", "PUT"):
        body = handler._read_json(MAX_PLATE_PARAM_BYTES + 256 * 1024)
        if body is None:
            return True                       # _read_json already answered
        record = save(body)
        handler.note(f"plate saved: {len(record['items'])} items, "
                     f"{record['copies']} copies, gap {record['gap']} mm")
        handler._json({"ok": True, "plate": record})
        return True
    if method == "DELETE":
        handler._json({"ok": True, "plate": clear(), "cleared": True})
        return True
    handler._fail(405, f"{method} is not allowed on /api/plate")
    return True


def _provenance_endpoint(handler, method, path):
    rest = unquote(path[len("/api/provenance"):]).strip("/")
    if method == "GET":
        if not rest:
            handler._json({"ok": True, "count": count()})
            return True
        gen = handler._q(parse_qs(urlparse(handler.path).query), "gen")
        hit = lookup(rest, gen)
        if not hit:
            handler._fail(404, f"nothing on record for #{rest[:16]}")
            return True
        handler._json({"ok": True, "entry": hit})
        return True

    if method != "POST":
        handler._fail(405, f"{method} is not allowed on /api/provenance")
        return True

    body = handler._read_json(MAX_PROV_BODY)
    if body is None:
        return True

    # Reading: an STL (or just its header) in, the generator and hash out.
    if "stl" in body or "header" in body:
        text = (body["header"] if isinstance(body.get("header"), str)
                else _header_of(body.get("stl")))
        parsed = parse_header(text)
        if not parsed:
            handler._json({"ok": True, "provenance": None, "header": text[:80],
                           "entry": None,
                           "message": "this file was not made by Bluesheet"})
            return True
        entry = lookup(parsed["hash"], parsed["gen"])
        handler._json({"ok": True, "provenance": parsed, "header": text[:80],
                       "entry": entry})
        return True

    # Writing: parameters recorded against the hash the browser computed.
    parsed = parse_header(body.get("provenance") or "")
    gen = body.get("gen") or (parsed and parsed["gen"])
    prov_hash = body.get("hash") or (parsed and parsed["hash"])
    version = body.get("version", parsed["version"] if parsed else 1)
    if not gen or not prov_hash:
        handler._fail(400, "send stl/header to read provenance, or gen + hash + "
                           "params (or a provenance string) to record it")
        return True
    stored = register(gen, util.as_number(version, 1), prov_hash,
                      body.get("params") or {}, body.get("name") or "",
                      source=str(body.get("source") or "api")[:24])
    handler._json({"ok": True, "entry": stored}, 201 if stored.get("stored") else 200)
    return True


# --- wiring ----------------------------------------------------------------
#
# server.py owns the HTTP surface and three leaves want a route in it at once, so
# this module does not edit it. The driver adds one line to each of the three
# dispatchers in server.py:
#
#     from server import plate                                     # with the others
#
#     _api_get(self, path):   if plate.route(self, "GET", path): return
#     do_POST(self):          if plate.route(self, "POST", path): return
#     do_DELETE(self):        if plate.route(self, "DELETE", path): return
#
# In do_POST and do_DELETE the line goes *after* the existing `_csrf_reject()`
# call, which is why route() does not repeat that check — one refusal, sent once.
#
# `install()` below applies exactly those three lines to a handler class at
# runtime, and `--serve` starts a throwaway instance with them applied. That is
# how tests/plate.test.mjs exercises the real endpoints without touching the live
# service on 8132 or editing a file this leaf does not own.

PREFIXES = ("/api/plate", "/api/provenance")


def install(handler_cls):
    """Route the plate endpoints on an existing ForgeHandler class."""
    for attr, verb in (("do_GET", "GET"), ("do_POST", "POST"), ("do_DELETE", "DELETE")):
        original = getattr(handler_cls, attr)
        if getattr(original, "_forge_plate", False):
            continue
        setattr(handler_cls, attr, _wrap(original, verb))
    return handler_cls


def _wrap(original, verb):
    def dispatch(self):
        path = urlparse(self.path).path
        if any(path == p or path.startswith(p + "/") for p in PREFIXES):
            if verb != "GET" and self._csrf_reject():
                return
            if route(self, verb, path):
                return
        return original(self)
    dispatch._forge_plate = True
    return dispatch


def _serve(port):
    """A second Bluesheet on another port, with the plate wired in."""
    import importlib.util
    from http.server import ThreadingHTTPServer

    entry = os.path.join(util.PROJECT_DIR, "server.py")
    # server.py reads its port from the environment at import time and reports it
    # on /api/health; without this the second instance answers with 8132 and the
    # next person to read that health line believes they are talking to the live
    # service.
    os.environ["BLUESHEET_PORT"] = str(port)
    spec = importlib.util.spec_from_file_location("forge_entry", entry)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    install(module.ForgeHandler)
    util.ensure_dirs()
    threading.Thread(target=module.slicer.probe_version, daemon=True).start()
    httpd = ThreadingHTTPServer(("127.0.0.1", port), module.ForgeHandler)
    httpd.daemon_threads = True
    print(f"[{util.iso()}] Bluesheet+plate on http://127.0.0.1:{port}", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()


if __name__ == "__main__":
    import argparse

    ap = argparse.ArgumentParser(description="Bluesheet plate storage")
    ap.add_argument("--serve", action="store_true",
                    help="run a Bluesheet instance with the plate endpoints wired in")
    ap.add_argument("--port", type=int, default=int(os.environ.get("BLUESHEET_PLATE_PORT", 8232)))
    ap.add_argument("--show", action="store_true", help="print the stored plate")
    args = ap.parse_args()
    if args.serve:
        _serve(args.port)
    elif args.show:
        print(json.dumps(load(), indent=1))
    else:
        ap.print_help()
