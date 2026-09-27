"""Getting a sliced job onto the A1 mini — and deliberately not starting it.

Two separate channels reach the printer and this module uses both, for reasons
that are not obvious:

*Upload* goes over implicit FTPS to the SD card, using gladys's `sdcard.py`
rather than a copy of it. That module already knows the trap: the printer hangs
the TLS shutdown on the data socket after a *successful* STOR, so ftplib raises
TimeoutError for a transfer that completed fine. It verifies by re-listing and
comparing byte counts, which is the only trustworthy signal.

*Starting* is an MQTT `project_file` command, and the A1 mini accepts exactly one
MQTT client at a time. The gladys daemon holds that slot permanently — it is what
feeds the dashboard and the print-watch alerts. So Bluesheet must not open its own
connection: it asks gladys to send the command over the link it already has.
Bluesheet starting a print behind gladys's back would also mean starting one nothing
was watching.

Starting is gated twice over. `start: true` alone does nothing: the caller must
first ask for a confirmation token, then send it back within a couple of minutes
along with the same job id. Tokens are single-use and live only in this process,
so a replayed request, a stale browser tab or a curl loop cannot start a print.
"""
import importlib.util
import json
import os
import secrets
import threading
import time
import urllib.error
import urllib.request

GLADYS_DIR = os.path.expanduser("~/explorer/projects/gladys")
GLADYS_API = os.environ.get("BLUESHEET_GLADYS_API", "http://127.0.0.1:8128")
TOKEN_TTL = 180.0

_sdcard = None
_sdcard_lock = threading.Lock()
_tokens = {}
_tokens_lock = threading.Lock()


class PrinterError(RuntimeError):
    pass


def sdcard():
    """Load gladys's sdcard module by path — importing by name would need the
    gladys directory on sys.path, and it has a `server.py` of its own that would
    then shadow ours."""
    global _sdcard
    with _sdcard_lock:
        if _sdcard is not None:
            return _sdcard
        path = os.path.join(GLADYS_DIR, "sdcard.py")
        if not os.path.isfile(path):
            raise PrinterError(f"gladys sdcard.py not found at {path}")
        spec = importlib.util.spec_from_file_location("forge_gladys_sdcard", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        _sdcard = module
        return module


def status(timeout=1.5):
    """Whatever gladys knows about the printer, or why we cannot tell."""
    try:
        with urllib.request.urlopen(GLADYS_API + "/api/status", timeout=timeout) as r:
            data = json.loads(r.read().decode("utf-8"))
    except (urllib.error.URLError, OSError, ValueError, TimeoutError) as e:
        return {"reachable": False, "via": "gladys", "error": str(e)}
    summary = data.get("summary") or {}
    return {
        "reachable": bool(data.get("connected")),
        "via": "gladys",
        "state": summary.get("state"),
        "job": summary.get("job"),
        "percent": summary.get("percent"),
        "remaining": summary.get("remaining_text"),
        "nozzleTemp": summary.get("nozzle_temp"),
        "bedTemp": summary.get("bed_temp"),
        "age": data.get("age"),
    }


def sd_name(job_id, label=None):
    """SD filenames are flat, ASCII and must end .gcode.3mf to be recognised as a
    printable job by both the printer and the gladys dashboard."""
    base = "".join(c if c.isalnum() or c in "-_" else "-" for c in (label or "bluesheet"))
    base = base.strip("-")[:40] or "bluesheet"
    return f"{base}-{job_id}.gcode.3mf"


def upload(local_path, name, skip_if_present=True):
    """Upload and verify. Returns (name, bytes, already_there).

    The filename ends in the slice's content hash, so a file of that name and
    size on the card *is* this job — re-sending sixty megabytes over FTPS to the
    same place would cost a minute and change nothing.
    """
    if not os.path.isfile(local_path):
        raise PrinterError(f"no such file: {local_path}")
    size = os.path.getsize(local_path)
    if skip_if_present:
        try:
            if any(f["name"] == name and f["size"] == size for f in sdcard().list_files("/")):
                return name, size, True
        except Exception:
            pass    # listing is an optimisation; a failure here just means we upload
    try:
        landed, landed_size = sdcard().upload_file(local_path, name)
    except Exception as e:                      # ftplib raises a wide family
        raise PrinterError(f"upload failed: {e}")
    return landed, landed_size, False


def list_sd():
    try:
        return sdcard().list_files("/")
    except Exception as e:
        raise PrinterError(f"could not list the SD card: {e}")


def issue_token(job_id, name):
    """One-shot confirmation for a specific job. Two minutes is long enough for a
    person to read a dialog and short enough that a forgotten tab cannot act."""
    token = secrets.token_urlsafe(12)
    now = time.time()
    with _tokens_lock:
        for key, row in list(_tokens.items()):
            if row["expires"] < now:
                del _tokens[key]
        _tokens[token] = {"job": job_id, "name": name, "expires": now + TOKEN_TTL}
    return {"token": token, "expiresIn": int(TOKEN_TTL), "job": job_id, "name": name}


def redeem(token, job_id, name):
    """True only for a token issued for this exact job, unexpired and unused.

    Accepts the exact object `issue_token` returned as well as its bare `token`
    string: the browser sends the whole object back, and for weeks this compared
    a dict to the string keys and refused every real confirmation. The unit test
    unwrapped `["token"]` itself, so it could not see that. The contract is now
    "send back what you were given", and the test exercises exactly that.
    """
    if isinstance(token, dict):
        token = token.get("token")
    if not isinstance(token, str) or not token:
        return False
    with _tokens_lock:
        row = _tokens.pop(token, None)
    if not row:
        return False
    if row["expires"] < time.time():
        return False
    return row["job"] == job_id and row["name"] == name


def start(name, plate=1, use_ams=False, ams_mapping=None, timeout=15, bed_clear=False):
    """Ask gladys to start a print from a file already on the SD card.

    Returns gladys's own answer. Never called without a redeemed token — see the
    module docstring for why this goes through gladys rather than direct MQTT.
    """
    payload = {"name": name, "confirm": True, "plate": int(plate),
               "use_ams": bool(use_ams), "bed_leveling": True, "timelapse": False,
               # gladys refuses a start without this (2026-09-03); it means a
               # person has looked at the plate. Bluesheet only sets it when the
               # confirm dialog's own tick box was ticked — see _post_print.
               "bed_clear": bed_clear is True}
    if use_ams and ams_mapping:
        payload["ams_mapping"] = [int(i) for i in ams_mapping]
    req = urllib.request.Request(
        GLADYS_API + "/api/sd/print",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:400]
        # gladys answers from the MQTT publish acknowledgement, and on
        # 2026-09-03 that came back unpublished after its 5 s wait while the
        # printer was already heating for the file. The printer's own state is
        # the fact; the ack is a proxy for it. Ask the fact before believing
        # the proxy.
        if e.code == 503 and started_by_state(name):
            return {"ok": True, "name": name, "verifiedBy": "printer state",
                    "gladysSaid": detail}
        raise PrinterError(f"gladys refused the start ({e.code}): {detail}")
    except (urllib.error.URLError, OSError, ValueError, TimeoutError) as e:
        raise PrinterError(f"could not reach gladys at {GLADYS_API}: {e}")


def started_by_state(name, wait=12.0, step=1.5):
    """True once the printer reports it is running `name` (or its subtask, which
    is the file name without its extensions). Polls for up to `wait` seconds."""
    subtask = name
    for ext in (".gcode.3mf", ".3mf", ".gcode"):
        if subtask.endswith(ext):
            subtask = subtask[:-len(ext)]
            break
    deadline = time.time() + wait
    while True:
        s = status()
        if s.get("reachable") and s.get("state") in ("RUNNING", "PREPARE", "SLICING") \
                and s.get("job") in (name, subtask):
            return True
        if time.time() >= deadline:
            return False
        time.sleep(step)
