#!/usr/bin/env python3
"""Prove the static handler cannot be talked out of a file it should not serve.

    python3 tests/security_probe.py [port]

This port is open to the whole LAN and the bug it is guarding against — serving a
config file with a key in it — has shipped from this machine twice. So the probe
does not merely ask for files that do not exist (a 404 for an absent file proves
nothing at all). It *creates* decoy files inside the project first: a .env at the
root, a secret-shaped text file in a published directory, and a token-shaped .js
in a published directory with an allowed extension. Those must all be refused.

It also creates one perfectly ordinary file that must be *served*, because a probe
that cannot see any file would pass every other assertion by accident.

Runs against the live service if it is up, otherwise starts its own on a
loopback-only ephemeral port.
"""
import http.client
import importlib.util
import json
import os
import socket
import sys
import threading
from http.server import ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)

_spec = importlib.util.spec_from_file_location("bluesheet_entry", os.path.join(ROOT, "server.py"))
entry = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(entry)

FAILURES = []
CHECKS = [0]

DECOYS = {
    "bluesheet-probe-decoy.env": "PRINTER_CODE=hunter2\n",
    "assets/bluesheet-probe-secret.txt": "SECRET=hunter2\n",
    "js/bluesheet-probe-token.js": "export const TOKEN = 'hunter2';\n",
    "assets/bluesheet-probe-control.txt": "ordinary public file\n",
}
CONTROL = "assets/bluesheet-probe-control.txt"


def report(name, ok, detail=""):
    CHECKS[0] += 1
    if not ok:
        FAILURES.append(name)
        print(f"  LEAK   {name}  {detail}")
    return ok


def get(port, path, method="GET", headers=None, body=None):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    try:
        conn.request(method, path, body, headers or {})
        response = conn.getresponse()
        data = response.read()
        return response.status, data
    finally:
        conn.close()


def raw_get(port, path, method="GET"):
    """Send a request line verbatim over a socket.

    http.client refuses to transmit control characters in a path, which is
    exactly why the raw-socket version is worth having: an attacker is not using
    http.client, and a NUL byte in a filename is a classic way past a suffix
    check in a language that hands the string to C.
    """
    sock = socket.create_connection(("127.0.0.1", port), timeout=10)
    try:
        sock.sendall(f"{method} {path} HTTP/1.1\r\nHost: 127.0.0.1\r\n"
                     f"Connection: close\r\n\r\n".encode("latin-1"))
        chunks = []
        while True:
            chunk = sock.recv(65536)
            if not chunk:
                break
            chunks.append(chunk)
    finally:
        sock.close()
    data = b"".join(chunks)
    head, _, body = data.partition(b"\r\n\r\n")
    try:
        status = int(head.split(b" ")[1])
    except (IndexError, ValueError):
        status = 0
    return status, body


def refused(port, path, why, method="GET"):
    status, data = get(port, path, method)
    ok = status not in (200, 206, 301, 302) and b"hunter2" not in data
    return report(f"{why}: {method} {path}", ok, f"status {status}, {len(data)} bytes")


def main():
    for rel, text in DECOYS.items():
        full = os.path.join(ROOT, rel)
        os.makedirs(os.path.dirname(full), exist_ok=True)
        with open(full, "w") as f:
            f.write(text)

    port = int(sys.argv[1]) if len(sys.argv) > 1 else int(os.environ.get("BLUESHEET_PORT", 8132))
    server = None
    try:
        try:
            status, _ = get(port, "/api/health")
            print(f"probing the running service on :{port}")
        except OSError:
            server = ThreadingHTTPServer(("127.0.0.1", 0), entry.BluesheetHandler)
            server.daemon_threads = True
            port = server.server_address[1]
            threading.Thread(target=server.serve_forever, daemon=True).start()
            print(f"nothing on :8132 — probing a private instance on :{port}")

        # The control: if this is not served, every refusal below is meaningless.
        status, data = get(port, "/" + CONTROL)
        report("control file is served (the probe can see files at all)",
               status == 200 and b"ordinary public file" in data, f"status {status}")

        print("decoy files inside the project")
        refused(port, "/bluesheet-probe-decoy.env", "dotenv at the root")
        refused(port, "/assets/bluesheet-probe-secret.txt", "secret-shaped name")
        refused(port, "/js/bluesheet-probe-token.js", "token-shaped name with a legal extension")

        print("source and configuration")
        for path in ("/server.py", "/server/slicer.py", "/server/util.py",
                     "/tests/security_probe.py", "/PLAN.md", "/GATES.md",
                     "/README.md", "/gates/S1-server.md", "/docs/design.md",
                     "/library/", "/state/prints.json"):
            refused(port, path, "project file that is not a web asset")

        print("dotfiles")
        for path in ("/.git/config", "/.gitignore", "/.env", "/.git/HEAD",
                     "/js/.hidden.js", "/assets/./../.gitignore"):
            refused(port, path, "dotfile")

        print("traversal")
        for path in ("/../server.py", "/../../etc/passwd", "/../../../etc/passwd",
                     "/..%2f..%2fetc%2fpasswd", "/%2e%2e%2f%2e%2e%2fetc%2fpasswd",
                     "/js/../server.py", "/js/%2e%2e/server.py",
                     "/assets/fonts/../../../etc/hostname",
                     "//etc/passwd", "/./../../etc/passwd",
                     "/js/kernel/mesh.js%00.png",
                     "/%2e%2e%5c%2e%2e%5cwindows", "/....//....//etc/passwd",
                     "/js/%252e%252e/server.py", "/~/secrets.md",
                     "/home/user/secrets.md"):
            refused(port, path, "traversal")

        for path in ("/js/kernel/mesh.js\x00.png", "/server.py\x00.js",
                     "/assets/bluesheet-probe-secret.txt\x00.png"):
            status, data = raw_get(port, path)
            report(f"NUL-byte suffix trick: {path!r}",
                   status not in (200, 206) and b"hunter2" not in data
                   and b"import " not in data, f"status {status}")

        # Absolute-form request URI: a proxy-style request line that some handlers
        # translate differently from an origin-form path.
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
        conn.putrequest("GET", "http://127.0.0.1/../server.py", skip_host=True)
        conn.putheader("Host", "127.0.0.1")
        conn.endheaders()
        response = conn.getresponse()
        body = response.read()
        report("absolute-form URI traversal", response.status != 200 and b"import" not in body,
               f"status {response.status}")
        conn.close()

        print("directory listing")
        for path in ("/js/", "/assets/", "/js", "/state/", "/gates/"):
            status, data = get(port, path)
            report(f"no listing for {path}",
                   status != 200 or b"<li>" not in data.lower(), f"status {status}")

        print("symlink escape")
        link = os.path.join(ROOT, "assets", "bluesheet-probe-link.txt")
        try:
            if os.path.islink(link):
                os.unlink(link)
            os.symlink("/etc/hostname", link)
            refused(port, "/assets/bluesheet-probe-link.txt", "symlink out of the project")
        except OSError as e:
            print(f"  (symlink probe skipped: {e})")
        finally:
            if os.path.islink(link):
                os.unlink(link)

        print("methods and mutation")
        status, _ = get(port, "/api/health", "OPTIONS")
        report("no CORS preflight is answered", status not in (200, 204), f"status {status}")
        status, _ = get(port, "/api/health", "TRACE")
        report("no TRACE", status not in (200, 204), f"status {status}")
        status, _ = get(port, "/api/library", "PUT",
                        {"Content-Type": "application/json"}, b"{}")
        report("no unrouted PUT", status not in (200, 201), f"status {status}")

        payload = json.dumps({"gen": "probe", "name": "x", "params": {}}).encode()
        status, _ = get(port, "/api/library", "POST",
                        {"Content-Type": "application/json",
                         "Origin": "http://evil.example"}, payload)
        report("cross-origin POST refused", status == 403, f"status {status}")
        status, _ = get(port, "/api/library", "POST",
                        {"Content-Type": "text/plain"}, payload)
        report("non-json POST refused", status == 415, f"status {status}")
        status, _ = get(port, "/api/print", "POST",
                        {"Content-Type": "application/json",
                         "Referer": "http://evil.example/page"},
                        json.dumps({"id": "whatever", "start": True}).encode())
        report("cross-origin print refused", status == 403, f"status {status}")

        status, data = get(port, "/api/slice/..%2f..%2f..%2fetc%2fpasswd/3mf")
        report("slice id traversal refused", status in (400, 404), f"status {status}")
        status, data = get(port, "/api/library/..%2f..%2fetc%2fpasswd")
        report("library id traversal refused", status in (400, 404), f"status {status}")

    finally:
        for rel in DECOYS:
            full = os.path.join(ROOT, rel)
            if os.path.isfile(full):
                os.unlink(full)
        if server:
            server.shutdown()
            server.server_close()

    print(f"\n{CHECKS[0] - len(FAILURES)}/{CHECKS[0]} probes refused as they should be")
    if FAILURES:
        print("leaks: " + ", ".join(FAILURES))
        print(f"SECURITY FAIL ({len(FAILURES)})")
        return 1
    print("SECURITY OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
