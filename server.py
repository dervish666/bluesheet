#!/usr/bin/env python3
"""Bluesheet — parametric printable-object foundry. HTTP surface, port 8132.

The browser does the geometry. This process does the four things it cannot:
runs OrcaSlicer, reads the result back to check the slicer told the truth, talks
to the printer, and keeps saved designs. Everything else it serves is static.

ThreadingHTTPServer, always. A slice holds its thread for the better part of a
second and an elevation request can hold one for several; on a single-threaded
server every one of those would stall the dashboard, and that is the documented
cause of most past service hangs on this laptop.

Two security notes, because this port is open to the LAN:

*Static files come from an allowlist*, not from a path translation. A request
names an extension we serve, inside a directory we publish, with no leading dots,
and the resolved realpath must still be inside the project. Anything else is a
404 — including this file. The failure mode being avoided (serving a config file
with a key in it) has shipped from this machine twice.

*Mutating requests are same-origin only.* A POST must be application/json, which
is not a CORS "simple" content type, so a hostile page is forced into a preflight
that never gets answered — there is deliberately no do_OPTIONS. If an Origin or
Referer header is present it must match the Host. That stops drive-by CSRF from a
browser; it is not authentication, and is not pretending to be.
"""
import base64
import binascii
import gzip
import json
import os
import socket
import sys
import threading
import time
import traceback
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from urllib.parse import parse_qs, unquote, urlparse

os.chdir(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from server import (VERSION, elevation, fonts, gcode, library, printer,  # noqa: E402
                    slicer, stlio, util)
from server import plate as plate_api, made as made_api  # noqa: E402

PORT = int(os.environ.get("BLUESHEET_PORT", "8132"))
ROOT = os.path.realpath(os.path.dirname(os.path.abspath(__file__)))
STARTED = time.time()

# --- static allowlist ------------------------------------------------------
# Extensions the browser genuinely needs. No .py, no .md, no .json: the only
# JSON on this box worth reading is state, and state has its own endpoints.
ALLOWED_EXT = {
    ".html", ".css", ".js", ".mjs", ".map",
    ".svg", ".png", ".jpg", ".jpeg", ".webp", ".gif", ".ico", ".avif",
    ".woff", ".woff2", ".ttf", ".otf",
    ".txt", ".glsl", ".wasm",
}
# Directories published to the browser. A file at the project root is served only
# if it also passes the extension test, which keeps PLAN.md, GATES.md and every
# .py file out without needing to name them.
ALLOWED_TOP = {"js", "css", "assets"}
# Substrings that disqualify a filename whatever else it looks like. Belt and
# braces over the extension list: a secret named `keys.txt` would otherwise pass.
DENY_SUBSTR = ("secret", "token", "password", "passwd", "credential", "private",
               ".env", ".key", ".pem", ".sqlite", "id_rsa", ".ssh")

CACHE_FOREVER = (".woff", ".woff2", ".ttf", ".otf", ".png", ".jpg", ".jpeg",
                 ".webp", ".avif", ".gif", ".ico")

MAX_BODY = 8 * 1024 * 1024
MAX_SLICE_BODY = 96 * 1024 * 1024      # a base64 STL of ~70 MB
MAX_OBJECTS = 32

_health_cache = {"at": 0.0, "printer": None}
_print_log_lock = threading.Lock()
_parse_locks = {}
_parse_locks_guard = threading.Lock()
_parsed = util.Lru(2)


def _client_of(handler):
    return handler.client_address[0] if handler.client_address else "?"


class BluesheetHandler(SimpleHTTPRequestHandler):
    server_version = "Bluesheet/" + VERSION
    protocol_version = "HTTP/1.1"       # keep-alive; every response sets a length

    # --- plumbing ---------------------------------------------------------

    def log_message(self, fmt, *args):
        """Quiet by default. Mutating requests and failures log themselves with
        more context than this hook has."""

    def note(self, message):
        print(f"[{util.iso()}] {message}", flush=True)

    def _send(self, body, status=200, ctype="application/json; charset=utf-8",
              headers=None, gzip_ok=True):
        if isinstance(body, str):
            body = body.encode("utf-8")
        encoding = None
        if (gzip_ok and len(body) > 8192
                and "gzip" in (self.headers.get("Accept-Encoding") or "")):
            body = gzip.compress(body, 5)
            encoding = "gzip"
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "same-origin")
        if encoding:
            self.send_header("Content-Encoding", encoding)
            self.send_header("Vary", "Accept-Encoding")
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        if self.command != "HEAD":
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass   # the tab moved on; nothing to salvage or report

    def _json(self, obj, status=200, headers=None):
        self._send(json.dumps(obj, ensure_ascii=False), status,
                   "application/json; charset=utf-8", headers)

    def _fail(self, status, message, headers=None, **extra):
        payload = {"ok": False, "error": message}
        payload.update(extra)
        # A request we refuse before reading its body leaves unread bytes in the
        # socket, and on a keep-alive connection those bytes become the next
        # request line. Close instead of trying to drain a body we just called
        # too large.
        if self.command in ("POST", "PUT", "PATCH"):
            self.close_connection = True
        self._json(payload, status, headers)

    def _query(self):
        return parse_qs(urlparse(self.path).query)

    def _q(self, query, key, default=None):
        values = query.get(key)
        return values[0] if values else default

    def _read_body(self, limit=MAX_BODY):
        """Read a request body of a declared length, or send the error and
        return None. Chunked bodies are refused rather than half-handled."""
        if (self.headers.get("Transfer-Encoding") or "").lower() == "chunked":
            self._fail(411, "chunked request bodies are not accepted; "
                            "send a Content-Length")
            return None
        raw_length = self.headers.get("Content-Length")
        if raw_length is None:
            self._fail(411, "Content-Length required")
            return None
        try:
            length = int(raw_length)
        except ValueError:
            self._fail(400, "bad Content-Length")
            return None
        if length < 0 or length > limit:
            self._fail(413, f"body too large (limit {limit} bytes)")
            return None
        chunks = []
        remaining = length
        while remaining > 0:
            chunk = self.rfile.read(min(remaining, 1 << 20))
            if not chunk:
                self._fail(400, "request body ended early")
                return None
            chunks.append(chunk)
            remaining -= len(chunk)
        return b"".join(chunks)

    def _read_json(self, limit=MAX_BODY):
        raw = self._read_body(limit)
        if raw is None:
            return None
        try:
            body = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, ValueError) as e:
            self._fail(400, f"body is not valid JSON: {e}")
            return None
        if not isinstance(body, dict):
            self._fail(400, "body must be a JSON object")
            return None
        return body

    def _csrf_reject(self):
        """Refuse a state-changing request that a hostile page could have forged.

        Requiring application/json forces a preflight for any cross-origin fetch,
        and there is no do_OPTIONS to answer it. The Origin/Referer test then
        catches same-content-type forgeries and is written against Host so it
        keeps working across a hostname, localhost and the DHCP address without
        a list of names to maintain. curl and the tests send neither header and
        are allowed through: this blocks browsers, not the LAN.
        """
        if self.command in ("POST", "PUT", "PATCH"):
            ctype = (self.headers.get("Content-Type") or "").split(";", 1)[0].strip().lower()
            if ctype != "application/json":
                self._fail(415, "Content-Type must be application/json")
                return True
        host = (self.headers.get("Host") or "").lower()
        for header in ("Origin", "Referer"):
            value = self.headers.get(header)
            if not value:
                continue
            netloc = urlparse(value).netloc.lower()
            if netloc and netloc != host:
                self._fail(403, f"cross-origin {self.command} refused "
                                f"({header} {netloc} is not {host})")
                return True
        return False

    # --- routing ----------------------------------------------------------

    def do_GET(self):
        self._route(head=False)

    def do_HEAD(self):
        self._route(head=True)

    def _route(self, head=False):
        path = urlparse(self.path).path
        try:
            if path.startswith("/api/"):
                # The plate and the Made log answer through the handler rather
                # than by returning a response, so they inherit this server's
                # JSON envelope, error shape, gzip and headers rather than
                # growing their own dialect.
                if plate_api.route(self, "GET", path):
                    return
                if made_api.route(self, path):
                    return
                return self._api_get(path)
            return self._static(path)
        except BrokenPipeError:
            pass
        except Exception:
            self._crash("GET " + path)

    def do_POST(self):
        path = urlparse(self.path).path
        try:
            if not path.startswith("/api/"):
                return self._fail(404, "no such endpoint")
            if self._csrf_reject():
                return
            if made_api.route(self, path):
                return
            if path == "/api/slice":
                return self._post_slice()
            if path == "/api/print":
                return self._post_print()
            if path == "/api/library":
                return self._post_library()
            if plate_api.route(self, "POST", path):
                return
            return self._fail(404, "no such endpoint")
        except BrokenPipeError:
            pass
        except Exception:
            self._crash("POST " + path)

    def do_DELETE(self):
        path = urlparse(self.path).path
        try:
            if self._csrf_reject():
                return
            if made_api.route(self, path):
                return
            if path.startswith("/api/library/"):
                entry_id = unquote(path[len("/api/library/"):]).strip("/")
                try:
                    gone = library.delete(entry_id)
                except library.LibraryError as e:
                    return self._fail(400, str(e))
                if not gone:
                    return self._fail(404, "no such library entry")
                self.note(f"library delete {entry_id} from {_client_of(self)}")
                return self._json({"ok": True, "id": entry_id, "deleted": True})
            if plate_api.route(self, "DELETE", path):
                return
            return self._fail(404, "no such endpoint")
        except BrokenPipeError:
            pass
        except Exception:
            self._crash("DELETE " + path)

    def _crash(self, what):
        detail = traceback.format_exc()
        self.note(f"ERROR {what} from {_client_of(self)}\n{detail}")
        try:
            self._fail(500, "internal error", where=what)
        except Exception:
            pass

    # --- GET endpoints ----------------------------------------------------

    def _api_get(self, path):
        query = self._query()
        if path == "/api/health":
            return self._health()
        if path == "/api/fonts":
            return self._json({"ok": True, "fonts": fonts.listing()})
        if path == "/api/elevation":
            return self._elevation(query)
        if path == "/api/geocode":
            return self._geocode(query)
        if path == "/api/library":
            return self._json({"ok": True,
                               "entries": library.listing(
                                   include_thumbs=self._q(query, "thumbs") in ("1", "true"),
                                   gen=self._q(query, "gen"))})
        if path.startswith("/api/library/"):
            try:
                entry = library.get(unquote(path[len("/api/library/"):]).strip("/"))
            except library.LibraryError as e:
                return self._fail(400, str(e))
            if not entry:
                return self._fail(404, "no such library entry")
            return self._json({"ok": True, "entry": entry})
        if path == "/api/print":
            return self._printer_state()
        if path.startswith("/api/slice/"):
            return self._slice_get(path, query)
        return self._fail(404, "no such endpoint")

    def _health(self):
        now = time.time()
        if now - _health_cache["at"] > 10 or _health_cache["printer"] is None:
            _health_cache["printer"] = printer.status()
            _health_cache["at"] = now
        try:
            slices = [e for e in os.scandir(util.SLICE_DIR) if e.is_dir()]
        except OSError:
            slices = []
        self._json({
            "ok": True,
            "service": "bluesheet",
            "version": VERSION,
            "port": PORT,
            "host": socket.gethostname(),
            "uptimeSec": round(now - STARTED, 1),
            "python": sys.version.split()[0],
            "slicer": slicer.available(),
            "printer": _health_cache["printer"],
            "slices": {"cached": len(slices), "queued": slicer._queued[0]},
            "library": {"count": library.count()},
            "fonts": len(fonts.listing()),
        })

    def _printer_state(self):
        """GET /api/print — what POSTing here would be talking to."""
        state = {"ok": True, "printer": printer.status()}
        try:
            state["sd"] = printer.list_sd()
        except printer.PrinterError as e:
            state["sd"] = []
            state["sdError"] = str(e)
        self._json(state)

    def _elevation(self, query):
        try:
            grid = elevation.heightfield(
                util.as_number(self._q(query, "lat")),
                util.as_number(self._q(query, "lon")),
                span_km=util.as_number(self._q(query, "km"), 2.0),
                samples=util.as_number(self._q(query, "n"), 128),
                zoom=util.as_number(self._q(query, "zoom")))
        except elevation.ElevationError as e:
            return self._fail(502 if "reach" in str(e) else 400, str(e))
        grid["ok"] = True
        self._json(grid)

    def _geocode(self, query):
        q = self._q(query, "q", "")
        try:
            results = elevation.geocode(q)
        except elevation.ElevationError as e:
            return self._fail(502 if "reach" in str(e) or "refused" in str(e) else 400, str(e))
        for r in results:
            r["spanKm"] = elevation.suggested_span_km(r)
        self._json({"ok": True, "query": q, "results": results})

    def _slice_get(self, path, query):
        rest = path[len("/api/slice/"):].strip("/")
        parts = rest.split("/")
        job = parts[0]
        if not util.is_safe_id(job):
            return self._fail(400, "bad slice id")
        meta = slicer.cached(job)
        if not meta:
            return self._fail(404, "no such slice (it may have been pruned)")
        if len(parts) == 1:
            return self._json({"ok": True, **meta})
        if parts[1] == "3mf":
            return self._send_3mf(job, meta)
        if parts[1] == "gcode":
            return self._send_gcode(job, meta, query)
        return self._fail(404, "no such slice resource")

    def _send_3mf(self, job, meta):
        path = os.path.join(slicer.job_dir(job), "job.3mf")
        try:
            with open(path, "rb") as f:
                data = f.read()
        except OSError:
            return self._fail(404, "the sliced file is gone")
        name = printer.sd_name(job, (meta.get("objects") or [{}])[0].get("name"))
        # Already-compressed zip: gzipping it again would cost CPU for nothing.
        self._send(data, 200, "model/3mf", gzip_ok=False, headers={
            "Content-Disposition": f'attachment; filename="{name}"',
            "Cache-Control": "private, max-age=3600",
        })

    def _send_gcode(self, job, meta, query):
        doc = self._toolpaths(job)
        if doc is None:
            return self._fail(404, "the sliced file is gone")
        payload = gcode.view(
            doc,
            max_points=int(util.clamp(util.as_number(self._q(query, "maxPoints"), 250_000),
                                      1000, 4_000_000)),
            layer_from=int(util.as_number(self._q(query, "from"), 0, 0, 1e6)),
            layer_to=(None if self._q(query, "to") is None
                      else int(util.as_number(self._q(query, "to"), 0, 0, 1e6))),
            stride=int(util.as_number(self._q(query, "stride"), 1, 1, 64)),
            types=[t for t in (self._q(query, "types") or "").split(",") if t] or None)
        payload["ok"] = True
        payload["id"] = job
        payload["bed"] = {"x": slicer.BED[0], "y": slicer.BED[1], "z": slicer.BED[2]}
        payload["settings"] = meta.get("settings")
        self._json(payload)

    def _toolpaths(self, job):
        """Parsed toolpaths for a job, from memory, then disk, then the 3mf.

        The disk copy matters more than the memory one: parsing is seconds for a
        big print and a restart should not make the viewer feel broken.
        """
        hit = _parsed.get(job)
        if hit is not None:
            return hit
        with _parse_locks_guard:
            lock = _parse_locks.setdefault(job, threading.Lock())
        with lock:
            hit = _parsed.get(job)
            if hit is not None:
                return hit
            cache_path = os.path.join(slicer.job_dir(job), "paths.json.gz")
            doc = util.read_gz_json(cache_path)
            if doc is None:
                source = os.path.join(slicer.job_dir(job), "job.3mf")
                if not os.path.isfile(source):
                    return None
                started = time.time()
                doc = gcode.to_jsonable(gcode.parse_3mf(source))
                util.write_gz_json(cache_path, doc)
                self.note(f"parsed {doc['layerCount']} layers / {doc['points']} points "
                          f"for {job} in {time.time() - started:.1f}s")
            _parsed.put(job, doc)
            return doc

    # --- POST endpoints ---------------------------------------------------

    def _post_slice(self):
        body = self._read_json(MAX_SLICE_BODY)
        if body is None:
            return
        raw_objects = body.get("objects")
        if not raw_objects:
            if not body.get("stl"):
                return self._fail(400, "send stl (base64) or objects[]")
            raw_objects = [{"stl": body["stl"], "name": body.get("name")}]
        if not isinstance(raw_objects, list) or len(raw_objects) > MAX_OBJECTS:
            return self._fail(400, f"objects must be a list of at most {MAX_OBJECTS}")

        objects = []
        for i, obj in enumerate(raw_objects):
            if not isinstance(obj, dict) or not isinstance(obj.get("stl"), str):
                return self._fail(400, f"object {i} needs an stl field of base64 text")
            try:
                data = base64.b64decode(obj["stl"], validate=True)
            except (binascii.Error, ValueError):
                return self._fail(400, f"object {i}: stl is not valid base64")
            try:
                box = stlio.bounds_of(data)
            except stlio.STLError as e:
                return self._fail(400, f"object {i}: {e}")
            objects.append({
                "data": data,
                "bbox": box,
                "name": (obj.get("name") or f"object-{i}")[:60],
                "x": util.as_number(obj.get("x"), 0.0, -200, 200),
                "y": util.as_number(obj.get("y"), 0.0, -200, 200),
                "rot": util.as_number(obj.get("rot"), 0.0, -360, 360),
            })

        started = time.time()
        try:
            meta = slicer.slice_objects(objects, body.get("settings") or {},
                                        force=bool(body.get("force")))
        except slicer.SliceBusy as e:
            return self._fail(503, str(e), headers={"Retry-After": "5"})
        except slicer.SliceError as e:
            self.note(f"slice FAILED for {_client_of(self)}: {e}")
            return self._fail(422, str(e), log=e.log_tail[-1200:], detail=e.detail)
        except stlio.STLError as e:
            return self._fail(400, str(e))
        self.note(f"slice {meta['id']} {'(cached)' if meta['cached'] else ''} "
                  f"{meta['layers']} layers {meta['timeText']} {meta['grams']}g "
                  f"in {time.time() - started:.2f}s for {_client_of(self)}")
        self._json({"ok": True, **meta})

    def _post_print(self):
        """Upload a sliced job to the printer's SD card. Starting it is a second,
        explicit act — see the two-step confirmation below."""
        body = self._read_json()
        if body is None:
            return
        job = body.get("id")
        if not util.is_safe_id(job or ""):
            return self._fail(400, "id must be a slice id")
        meta = slicer.cached(job)
        if not meta:
            return self._fail(404, "no such slice")
        local = os.path.join(slicer.job_dir(job), "job.3mf")
        label = body.get("name") or (meta.get("objects") or [{}])[0].get("name")
        name = printer.sd_name(job, label)

        try:
            _uploaded, size, already = printer.upload(local, name)
        except printer.PrinterError as e:
            self.note(f"upload FAILED {name}: {e}")
            return self._fail(502, str(e))

        record = {"ok": True, "id": job, "name": name, "bytes": size,
                  "uploaded": True, "alreadyOnCard": already, "started": False,
                  "timeText": meta.get("timeText"), "grams": meta.get("grams")}
        # The Made log learns of the upload here, so a job driven from curl or
        # a closed tab is still remembered. Its failure must never fail the
        # upload that already happened.
        try:
            made_api.record_upload(job, name, size)
        except Exception as e:  # noqa: BLE001 - logging only
            self.note(f"made log could not record upload {name}: {e}")

        # Default is upload-only, and the default is what an accidental, replayed
        # or forged request gets. `start` alone is not enough: the caller must
        # hold a token this server issued for this exact job, seconds ago, and
        # never used. There is no path through here that starts a print without
        # both.
        if body.get("start") is not True:
            self.note(f"uploaded {name} ({size} bytes) for {_client_of(self)}; not started")
            self._log_print(record)
            return self._json(record)

        # Someone has to have looked at the plate. The token proves a person
        # pressed the button seconds ago; this proves they ticked the box that
        # says the bed is empty. Both, every time. (2026-09-03: a start onto a
        # finished part, a collision, and a stop that drove the head into the bed.)
        if body.get("bedClear") is not True:
            self.note(f"start refused for {name}: bed not confirmed clear ({_client_of(self)})")
            return self._fail(428, "starting needs bedClear:true — look at the plate and "
                                   "confirm it is empty", **record)

        state = printer.status()
        if state.get("state") in ("RUNNING", "PREPARE", "SLICING", "PAUSE"):
            return self._fail(409, f"the printer is busy ({state.get('state')}) — "
                                   f"start this job from the dashboard when it is free",
                              **record)

        if not printer.redeem(body.get("confirm"), job, name):
            confirm = printer.issue_token(job, name)
            self.note(f"start requested for {name} — issued confirmation token")
            return self._json({**record, "needsConfirm": True, "confirm": confirm,
                               "message": "repeat this request with start:true and "
                                          "confirm set to the token below"}, 409)

        try:
            answer = printer.start(name, plate=1,
                                   use_ams=bool(body.get("useAms")),
                                   ams_mapping=body.get("amsMapping"),
                                   bed_clear=True)
        except printer.PrinterError as e:
            self.note(f"START FAILED {name}: {e}")
            return self._fail(502, str(e), **record)
        record["started"] = bool(answer.get("ok"))
        record["printer"] = answer
        self.note(f"START {name} -> {answer} (requested by {_client_of(self)})")
        self._log_print(record)
        self._json(record, 200 if record["started"] else 502)

    def _log_print(self, record):
        path = os.path.join(util.STATE_DIR, "prints.json")
        with _print_log_lock:
            self._append_print_row(path, record)

    def _append_print_row(self, path, record):
        rows = util.read_json(path, []) or []
        rows.insert(0, {"at": util.iso(), "from": _client_of(self),
                        **{k: record.get(k) for k in
                           ("id", "name", "bytes", "started", "timeText", "grams")}})
        util.atomic_write_json(path, rows[:200], indent=1)

    def _post_library(self):
        body = self._read_json()
        if body is None:
            return
        try:
            entry = library.save(body)
        except library.LibraryError as e:
            return self._fail(400, str(e))
        self.note(f"library save {entry['id']} ({entry['gen']}) from {_client_of(self)}")
        self._json({"ok": True, "entry": entry}, 201)

    # --- static -----------------------------------------------------------

    def _static(self, url_path):
        target = resolve_static(url_path)
        if target is None:
            return self._fail(404, "not found")
        try:
            stat = os.stat(target)
            with open(target, "rb") as f:
                data = f.read()
        except OSError:
            return self._fail(404, "not found")

        etag = '"%x-%x"' % (int(stat.st_mtime), stat.st_size)
        if self.headers.get("If-None-Match") == etag:
            self.send_response(304)
            self.send_header("ETag", etag)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        ext = os.path.splitext(target)[1].lower()
        ctype = self.guess_type(target)
        if ext in (".js", ".mjs"):
            ctype = "text/javascript; charset=utf-8"
        elif ext == ".html":
            ctype = "text/html; charset=utf-8"
        elif ext == ".css":
            ctype = "text/css; charset=utf-8"
        cache = ("public, max-age=604800" if ext in CACHE_FOREVER
                 else "no-cache")   # revalidate: cheap with an ETag, always fresh
        self._send(data, 200, ctype, headers={
            "ETag": etag,
            "Cache-Control": cache,
            "Last-Modified": self.date_time_string(int(stat.st_mtime)),
        }, gzip_ok=ext not in CACHE_FOREVER)

    # Inherited file serving is unreachable by design; neuter it anyway so a
    # future edit that calls into the base class cannot reopen the hole.
    def translate_path(self, path):
        return os.path.join(ROOT, "\x00")

    def list_directory(self, path):
        self._fail(404, "not found")
        return None


def resolve_static(url_path):
    """Map a URL to a file we are willing to serve, or None.

    Deliberately not a translation followed by checks — a filename must pass
    every one of: no dot-prefixed component, no traversal, an allowlisted
    extension, an allowlisted top directory, no secret-shaped substring, and a
    realpath still inside the project. Order matters only for cheapness.
    """
    path = unquote(url_path.split("?", 1)[0].split("#", 1)[0])
    if "\x00" in path:
        return None
    if path.endswith("/"):
        path += "index.html"
    parts = [p for p in path.split("/") if p not in ("", ".")]
    if not parts:
        parts = ["index.html"]
    for part in parts:
        if part.startswith(".") or "/" in part or "\\" in part:
            return None
    lowered = [p.lower() for p in parts]
    if any(bad in p for p in lowered for bad in DENY_SUBSTR):
        return None
    ext = os.path.splitext(lowered[-1])[1]
    # .json is deliberately not in ALLOWED_EXT — configuration and state files are
    # overwhelmingly .json, and a blanket allow is how a service ends up serving
    # its own settings. The bundled elevation fields under assets/ are data the
    # browser genuinely needs, so they get a narrow exception rather than the
    # extension list getting a wide one.
    if ext == ".json":
        if lowered[0] != "assets" or len(parts) < 2:
            return None
    elif ext not in ALLOWED_EXT:
        return None
    if len(parts) > 1 and parts[0] not in ALLOWED_TOP:
        return None
    full = os.path.realpath(os.path.join(ROOT, *parts))
    if full != ROOT and not full.startswith(ROOT + os.sep):
        return None
    if not os.path.isfile(full):
        return None
    return full


def main():
    util.ensure_dirs()
    # The AppImage takes a moment to mount; find out what version it is off the
    # request path so /api/health never blocks on it.
    threading.Thread(target=slicer.probe_version, daemon=True).start()
    made_api.start()  # the printer watcher; the only thing that moves a Made job
    server = ThreadingHTTPServer(("0.0.0.0", PORT), BluesheetHandler)
    server.daemon_threads = True
    print(f"[{util.iso()}] Bluesheet {VERSION} on http://0.0.0.0:{PORT}  (root {ROOT})",
          flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
