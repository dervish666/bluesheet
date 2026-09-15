"""Just enough STL for the server side: bounds, provenance header, placement.

The browser writes STLs (js/kernel/stl.js); Python only ever needs to read a few
facts back out of one and, for a multi-object plate, move it. Binary STL is the
only format we emit, but uploads are parsed either way — a user can paste an
ASCII STL from anywhere.

The 80-byte header is dead space in every other tool, so Bluesheet stamps its
provenance there ("Bluesheet <gen> v<n> #<hash>"). That is the one string that lets a
file found six months later be traced back to the generator and parameters that
made it, so it is read out here and carried into the slice metadata.
"""
import math
import re
import struct

TRI = struct.Struct("<12fH")
HEADER_LEN = 80
MAX_TRIS = 1_500_000
"""~75 MB of binary STL. The cap is about memory, not disk: read_triangles boxes
every triangle into a tuple of nine Python floats, which costs roughly 300 bytes
each, so an unbounded file is an out-of-memory event on a laptop that is also
running fifty other services. Anything that needs more than this is not going to
fit on a 180 mm bed anyway."""


class STLError(ValueError):
    pass


def looks_ascii(data):
    """ASCII STLs start with 'solid', but so do some binary ones written by bad
    exporters — the reliable discriminator is whether the binary triangle count
    matches the file length."""
    if len(data) < HEADER_LEN + 4:
        return data[:5].lower() == b"solid"
    (count,) = struct.unpack_from("<I", data, HEADER_LEN)
    if len(data) == HEADER_LEN + 4 + count * TRI.size:
        return False
    return data[:5].lower() == b"solid"


def header_text(data):
    """The provenance string stamped into a binary STL, or '' for ASCII input."""
    if len(data) < HEADER_LEN or looks_ascii(data):
        return ""
    return data[:HEADER_LEN].split(b"\x00", 1)[0].decode("utf-8", "replace").strip()


def read_triangles(data):
    """-> list of 9-float tuples (three vertices). Normals are dropped: they are
    recomputed on write, and a mesh whose stored normals disagree with its winding
    is a file we should not propagate."""
    if looks_ascii(data):
        return _read_ascii(data)
    if len(data) < HEADER_LEN + 4:
        raise STLError("truncated STL: shorter than a binary header")
    (count,) = struct.unpack_from("<I", data, HEADER_LEN)
    if count > MAX_TRIS:
        raise STLError(f"STL claims {count} triangles, refusing (limit {MAX_TRIS})")
    need = HEADER_LEN + 4 + count * TRI.size
    if len(data) < need:
        raise STLError(f"truncated STL: {len(data)} bytes, header says {need}")
    out = []
    off = HEADER_LEN + 4
    for _ in range(count):
        v = TRI.unpack_from(data, off)
        out.append(v[3:12])
        off += TRI.size
    return out


_FLOAT = re.compile(rb"vertex\s+(\S+)\s+(\S+)\s+(\S+)", re.I)


def _read_ascii(data):
    verts = []
    for m in _FLOAT.finditer(data):
        try:
            verts.append(tuple(float(x) for x in m.groups()))
        except ValueError:
            raise STLError("ASCII STL contains a non-numeric vertex")
    if not verts or len(verts) % 3:
        raise STLError(f"ASCII STL has {len(verts)} vertices, not a multiple of 3")
    return [(*verts[i], *verts[i + 1], *verts[i + 2])
            for i in range(0, len(verts), 3)]


def bounds_of(data):
    """Bounding box straight from the bytes, without building a triangle list.

    The validation path only needs the extents, and materialising a million
    triangles to learn them is the difference between 40 MB of transient memory
    and 1.5 GB of it.
    """
    if looks_ascii(data):
        return bbox(_read_ascii(data))
    if len(data) < HEADER_LEN + 4:
        raise STLError("truncated STL: shorter than a binary header")
    (count,) = struct.unpack_from("<I", data, HEADER_LEN)
    if count > MAX_TRIS:
        raise STLError(f"STL claims {count} triangles, refusing (limit {MAX_TRIS})")
    if len(data) < HEADER_LEN + 4 + count * TRI.size:
        raise STLError(f"truncated STL: {len(data)} bytes, header says "
                       f"{HEADER_LEN + 4 + count * TRI.size}")
    if count == 0:
        raise STLError("STL contains no triangles")
    lo = [math.inf] * 3
    hi = [-math.inf] * 3
    off = HEADER_LEN + 4
    unpack = struct.Struct("<9f").unpack_from
    for _ in range(count):
        v = unpack(data, off + 12)
        off += TRI.size
        for k in range(0, 9, 3):
            for a in range(3):
                c = v[k + a]
                if c != c:
                    raise STLError("STL contains NaN coordinates")
                if c < lo[a]:
                    lo[a] = c
                if c > hi[a]:
                    hi[a] = c
    return {"min": lo, "max": hi,
            "size": [hi[i] - lo[i] for i in range(3)],
            "center": [(hi[i] + lo[i]) / 2 for i in range(3)]}


def bbox(tris):
    if not tris:
        raise STLError("STL contains no triangles")
    lo = [math.inf] * 3
    hi = [-math.inf] * 3
    for t in tris:
        for k in range(0, 9, 3):
            for a in range(3):
                v = t[k + a]
                if v != v:
                    raise STLError("STL contains NaN coordinates")
                if v < lo[a]:
                    lo[a] = v
                if v > hi[a]:
                    hi[a] = v
    return {"min": lo, "max": hi,
            "size": [hi[i] - lo[i] for i in range(3)],
            "center": [(hi[i] + lo[i]) / 2 for i in range(3)]}


def _normal(t):
    ux, uy, uz = t[3] - t[0], t[4] - t[1], t[5] - t[2]
    vx, vy, vz = t[6] - t[0], t[7] - t[1], t[8] - t[2]
    nx, ny, nz = uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx
    length = math.sqrt(nx * nx + ny * ny + nz * nz)
    if length < 1e-20:
        return (0.0, 0.0, 0.0)  # degenerate: a zero normal is legal and honest
    return (nx / length, ny / length, nz / length)


def write_binary(tris, header=""):
    out = bytearray(header.encode("utf-8", "replace")[:HEADER_LEN].ljust(HEADER_LEN, b"\x00"))
    out += struct.pack("<I", len(tris))
    for t in tris:
        out += TRI.pack(*_normal(t), *t, 0)
    return bytes(out)


def place(data, dx=0.0, dy=0.0, rot_deg=0.0, header=None):
    """Rotate about Z then translate, returning a new binary STL.

    Used for plate layout. Doing it here rather than asking the slicer to arrange
    means the position the browser drew is exactly the position that gets printed;
    OrcaSlicer's CLI can only auto-arrange, it cannot be told where to put things.
    """
    tris = read_triangles(data)
    if rot_deg:
        c, s = math.cos(math.radians(rot_deg)), math.sin(math.radians(rot_deg))
        moved = []
        for t in tris:
            v = []
            for k in range(0, 9, 3):
                x, y, z = t[k], t[k + 1], t[k + 2]
                v += [x * c - y * s + dx, x * s + y * c + dy, z]
            moved.append(tuple(v))
        tris = moved
    elif dx or dy:
        tris = [tuple(t[k] + (dx if k % 3 == 0 else dy if k % 3 == 1 else 0.0)
                      for k in range(9)) for t in tris]
    return write_binary(tris, header if header is not None else header_text(data))
