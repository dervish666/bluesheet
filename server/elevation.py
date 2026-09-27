"""Real terrain, for the terrain-tile generator: lat/lon in, heightfield out.

Source is the Terrarium tile set on AWS Open Data — 256×256 PNGs where elevation
is encoded in the pixel as `(R*256 + G + B/256) - 32768` metres. Tiles rather
than a point-query API on purpose: a 128×128 heightfield is 16384 samples, which
is 164 requests to a 100-points-per-call elevation API and about four to this one.
No key, no account, and the tiles cache to disk so a place you have already
printed costs nothing to re-open.

The PNG is decoded here in pure Python because there is no image library in this
project's dependency budget (there is no dependency budget). That is fine — the
tiles are 8-bit non-interlaced RGB, which is the simple corner of the format —
and decoded tiles are held in memory so panning around one area does not re-do it.

Grid convention: row 0 is the SOUTH edge and x increases east, so `data[y*w+x]`
maps straight onto a Z-up millimetre heightfield with +Y north.
"""
import math
import os
import struct
import threading
import time
import json
import re
import urllib.error
import urllib.parse
import urllib.request
import zlib

from . import util

TILE_URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"
TILE_PX = 256
MAX_ZOOM = 14
MIN_ZOOM = 2
MAX_TILES = 16          # one request may not fetch more than this
MAX_GRID = 512          # samples per side
USER_AGENT = "Bluesheet/1.0 (claudespace; parametric printable-object foundry)"

_tile_cache = util.Lru(24)
_fetch_lock = threading.Lock()
_last_fetch = [0.0]
MIN_FETCH_GAP = 0.05    # be a polite client of a free service
_COORD_RE = re.compile(r"^\s*(-?\d{1,2}(?:\.\d+)?)\s*[, ]\s*(-?\d{1,3}(?:\.\d+)?)\s*$")


class ElevationError(RuntimeError):
    pass


# ------------------------------------------------------------------ PNG

def decode_png(data):
    """-> (width, height, channels, bytes). 8-bit, non-interlaced only."""
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ElevationError("not a PNG")
    pos = 8
    width = height = depth = colour = interlace = None
    idat = bytearray()
    palette = None
    while pos + 8 <= len(data):
        (length,) = struct.unpack_from(">I", data, pos)
        ctype = data[pos + 4:pos + 8]
        body = data[pos + 8:pos + 8 + length]
        pos += 12 + length          # 4 length + 4 type + body + 4 crc
        if ctype == b"IHDR":
            width, height, depth, colour, _comp, _filt, interlace = \
                struct.unpack(">IIBBBBB", body)
        elif ctype == b"PLTE":
            palette = body
        elif ctype == b"IDAT":
            idat += body
        elif ctype == b"IEND":
            break
    if width is None:
        raise ElevationError("PNG has no header chunk")
    if depth != 8 or interlace != 0:
        raise ElevationError(f"unsupported PNG: depth {depth}, interlace {interlace}")
    channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}.get(colour)
    if channels is None:
        raise ElevationError(f"unsupported PNG colour type {colour}")
    raw = zlib.decompress(bytes(idat))
    out = _unfilter(raw, width, height, channels)
    if colour == 3:
        if not palette:
            raise ElevationError("indexed PNG without a palette")
        out = bytearray(b"".join(palette[i * 3:i * 3 + 3] for i in out))
        channels = 3
    return width, height, channels, bytes(out)


def _unfilter(raw, width, height, channels):
    """Undo the per-scanline PNG filters.

    Written against bytearrays with the previous row kept as a slice: the naive
    version that indexes `out` with absolute offsets is twice as slow, and this
    runs on every cold tile.
    """
    stride = width * channels
    if len(raw) < height * (stride + 1):
        raise ElevationError("PNG data is truncated")
    out = bytearray(height * stride)
    prev = bytearray(stride)
    pos = 0
    for row in range(height):
        ftype = raw[pos]
        pos += 1
        line = bytearray(raw[pos:pos + stride])
        pos += stride
        if ftype == 0:
            pass
        elif ftype == 1:
            for i in range(channels, stride):
                line[i] = (line[i] + line[i - channels]) & 0xFF
        elif ftype == 2:
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 0xFF
        elif ftype == 3:
            for i in range(stride):
                left = line[i - channels] if i >= channels else 0
                line[i] = (line[i] + ((left + prev[i]) >> 1)) & 0xFF
        elif ftype == 4:
            for i in range(stride):
                a = line[i - channels] if i >= channels else 0
                b = prev[i]
                c = prev[i - channels] if i >= channels else 0
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                pred = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (line[i] + pred) & 0xFF
        else:
            raise ElevationError(f"unknown PNG filter {ftype}")
        out[row * stride:(row + 1) * stride] = line
        prev = line
    return out


# ------------------------------------------------------------------ tiles

def tile_path(z, x, y):
    return os.path.join(util.ELEV_DIR, "terrarium", str(z), str(x), f"{y}.png")


def fetch_tile(z, x, y, timeout=10):
    """PNG bytes for one tile, from disk if we have ever asked for it before."""
    path = tile_path(z, x, y)
    if os.path.isfile(path):
        try:
            with open(path, "rb") as f:
                return f.read(), True
        except OSError:
            pass
    url = TILE_URL.format(z=z, x=x, y=y)
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with _fetch_lock:
        gap = MIN_FETCH_GAP - (time.time() - _last_fetch[0])
        if gap > 0:
            time.sleep(gap)
        _last_fetch[0] = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            data = r.read()
    except urllib.error.HTTPError as e:
        if e.code == 404:
            raise ElevationError(f"no elevation tile at zoom {z} for this location")
        raise ElevationError(f"elevation source returned HTTP {e.code}")
    except (urllib.error.URLError, OSError, TimeoutError) as e:
        raise ElevationError(f"could not reach the elevation source: {e}")
    util.atomic_write_bytes(path, data)
    return data, False


def tile_heights(z, x, y):
    """Decoded metres for one tile as a flat list of TILE_PX*TILE_PX floats,
    row 0 north (tile order), plus whether it came from cache."""
    key = (z, x, y)
    hit = _tile_cache.get(key)
    if hit is not None:
        return hit, True
    data, from_disk = fetch_tile(z, x, y)
    w, h, channels, pixels = decode_png(data)
    if w != TILE_PX or h != TILE_PX:
        raise ElevationError(f"unexpected tile size {w}×{h}")
    heights = [0.0] * (w * h)
    for i in range(w * h):
        p = i * channels
        heights[i] = (pixels[p] * 256.0 + pixels[p + 1] + pixels[p + 2] / 256.0) - 32768.0
    _tile_cache.put(key, heights)
    return heights, from_disk


# ------------------------------------------------------------------ geo

def lonlat_to_tile(lon, lat, z):
    n = 2.0 ** z
    lat = util.clamp(lat, -85.05112878, 85.05112878)
    rad = math.radians(lat)
    return ((lon + 180.0) / 360.0 * n,
            (1.0 - math.asinh(math.tan(rad)) / math.pi) / 2.0 * n)


def metres_per_pixel(lat, z):
    """156543.034 m is the size of one zoom-0 pixel at the equator — a 256 px tile
    spanning the whole 40075 km world. Dividing by TILE_PX as well (the obvious
    slip) understates the pixel size 256-fold and picks a zoom with no detail in
    it: Bristol came back as an 11 m-relief pancake before this was measured."""
    return 156543.03392 * math.cos(math.radians(lat)) / (2.0 ** z)


def choose_zoom(lat, span_m, samples):
    """The smallest zoom whose pixels are no coarser than the sample spacing —
    asking for more detail than the sample grid can hold just costs tiles."""
    spacing = max(span_m / max(1, samples - 1), 1.0)
    for z in range(MIN_ZOOM, MAX_ZOOM + 1):
        if metres_per_pixel(lat, z) <= spacing:
            return z
    return MAX_ZOOM


def heightfield(lat, lon, span_km=2.0, samples=128, zoom=None):
    """Sample a square of terrain centred on (lat, lon).

    Returns the grid plus everything needed to turn it into millimetres: the real
    span in metres, the relief, and where on Earth it came from.
    """
    lat = util.as_number(lat)
    lon = util.as_number(lon)
    if lat is None or lon is None or not (-85.0 <= lat <= 85.0) or not (-180.0 <= lon <= 180.0):
        raise ElevationError("lat/lon out of range")
    samples = int(util.clamp(util.as_number(samples, 128), 8, MAX_GRID))
    span_km = util.clamp(util.as_number(span_km, 2.0), 0.05, 500.0)
    span_m = span_km * 1000.0

    # Degrees for the requested span at this latitude.
    dlat = span_m / 111320.0
    dlon = span_m / (111320.0 * max(0.05, math.cos(math.radians(lat))))
    south, north = lat - dlat / 2, lat + dlat / 2
    west, east = lon - dlon / 2, lon + dlon / 2

    z = int(util.clamp(util.as_number(zoom, choose_zoom(lat, span_m, samples)),
                       MIN_ZOOM, MAX_ZOOM))
    # Shrink the zoom until the request fits the tile budget; a 500 km square at
    # zoom 14 would be thousands of tiles and a very rude thing to do to a free
    # service.
    while z > MIN_ZOOM:
        x0, y0 = lonlat_to_tile(west, north, z)
        x1, y1 = lonlat_to_tile(east, south, z)
        if (int(x1) - int(x0) + 1) * (int(y1) - int(y0) + 1) <= MAX_TILES:
            break
        z -= 1

    fetched = cached_count = 0
    tiles = {}

    def sample(px, py):
        """Bilinear sample of the global pixel plane at zoom z."""
        nonlocal fetched, cached_count
        x0, y0 = int(math.floor(px)), int(math.floor(py))
        fx, fy = px - x0, py - y0
        total = 0.0
        for dy in (0, 1):
            for dx in (0, 1):
                gx, gy = x0 + dx, y0 + dy
                tx, ty = gx // TILE_PX, gy // TILE_PX
                key = (tx, ty)
                if key not in tiles:
                    heights, was_cached = tile_heights(z, tx, ty)
                    tiles[key] = heights
                    if was_cached:
                        cached_count += 1
                    else:
                        fetched += 1
                h = tiles[key][(gy % TILE_PX) * TILE_PX + (gx % TILE_PX)]
                total += h * (fx if dx else 1 - fx) * (fy if dy else 1 - fy)
        return total

    n = 2.0 ** z * TILE_PX
    data = [0.0] * (samples * samples)
    lo, hi = math.inf, -math.inf
    for row in range(samples):
        # Row 0 is the south edge: +Y north, matching the millimetre convention.
        f = row / (samples - 1) if samples > 1 else 0.5
        py_lat = south + (north - south) * f
        _, ty = lonlat_to_tile(lon, py_lat, z)
        py = util.clamp(ty * TILE_PX, 0, n - 1.0001)
        for col in range(samples):
            g = col / (samples - 1) if samples > 1 else 0.5
            tx, _ = lonlat_to_tile(west + (east - west) * g, py_lat, z)
            px = util.clamp(tx * TILE_PX, 0, n - 1.0001)
            v = sample(px, py)
            data[row * samples + col] = v
            if v < lo:
                lo = v
            if v > hi:
                hi = v

    return {
        "w": samples,
        "h": samples,
        "data": [round(v, 2) for v in data],
        "min": round(lo, 2),
        "max": round(hi, 2),
        "relief": round(hi - lo, 2),
        "bounds": {"west": west, "south": south, "east": east, "north": north},
        "center": {"lat": lat, "lon": lon},
        "spanKm": round(span_km, 4),
        "spanM": round(span_m, 1),
        "metresPerSample": round(span_m / max(1, samples - 1), 2),
        "zoom": z,
        "metresPerPixel": round(metres_per_pixel(lat, z), 2),
        "tiles": {"used": len(tiles), "fetched": fetched, "cached": cached_count},
        "source": "Terrarium (AWS Open Data / Mapzen)",
        "rowOrder": "south-to-north",
    }


# ------------------------------------------------------------------ geocoding
#
# "Anywhere on Earth" is only true if a person can type a place rather than a
# pair of decimals. Nominatim (OpenStreetMap's geocoder) answers free-text with
# no key; its usage policy asks for a real User-Agent, at most one request a
# second, and caching — all three are honoured here. Results are cached to disk
# by query, so a place looked up once costs the service nothing again.

GEOCODE_URL = "https://nominatim.openstreetmap.org/search"
GEOCODE_CONTACT = os.environ.get("BLUESHEET_GEOCODE_CONTACT", "claudespace")
GEOCODE_CACHE = os.path.join(util.STATE_DIR, "geocode.json")
GEOCODE_MAX = 6
GEOCODE_BIAS = os.environ.get("BLUESHEET_GEOCODE_VIEWBOX", "-11.0,61.0,2.0,49.0")   # west,north,east,south
MIN_GEOCODE_GAP = 1.1
_geo_lock = threading.Lock()
_geo_last = [0.0]
_geo_cache = {}
_geo_loaded = [False]


def _geo_key(q):
    return " ".join(str(q).lower().split())[:120]


def _geo_load():
    if not _geo_loaded[0]:
        _geo_cache.update(util.read_json(GEOCODE_CACHE, {}) or {})
        _geo_loaded[0] = True


def geocode(q, limit=GEOCODE_MAX, timeout=8):
    """Free text -> [{name, lat, lon, type, bounds}], best first. Cached by query."""
    key = _geo_key(q)
    if len(key) < 2:
        raise ElevationError("type a place name, a postcode or 'lat, lon'")
    # A bare coordinate pair needs no service at all.
    m = _COORD_RE.match(key)
    if m:
        lat, lon = float(m.group(1)), float(m.group(2))
        if -85 <= lat <= 85 and -180 <= lon <= 180:
            return [{"name": f"{lat:.5f}, {lon:.5f}", "lat": lat, "lon": lon, "type": "coordinates", "bounds": None}]
        raise ElevationError("lat/lon out of range")
    with _geo_lock:
        _geo_load()
        hit = _geo_cache.get(key)
        if hit is not None:
            return hit[:limit]
        wait = MIN_GEOCODE_GAP - (time.time() - _geo_last[0])
        if wait > 0:
            time.sleep(wait)
        # A soft preference for the British Isles: "Snowdon" is a mountain in
        # Wales before it is a metro station in Montréal. bounded=0 keeps the
        # rest of the world reachable — Mont Blanc still resolves.
        url = (GEOCODE_URL + "?" + urllib.parse.urlencode(
            {"q": key, "format": "jsonv2", "limit": str(max(1, min(10, limit))), "addressdetails": "0",
             "viewbox": GEOCODE_BIAS, "bounded": "0"}))
        req = urllib.request.Request(url, headers={
            "User-Agent": f"{USER_AGENT} contact:{GEOCODE_CONTACT}", "Accept": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                raw = json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            raise ElevationError(f"the geocoder refused ({e.code})")
        except (urllib.error.URLError, OSError, TimeoutError, ValueError) as e:
            raise ElevationError(f"could not reach the geocoder: {e}")
        finally:
            _geo_last[0] = time.time()
        out = []
        for row in raw if isinstance(raw, list) else []:
            try:
                lat, lon = float(row["lat"]), float(row["lon"])
            except (KeyError, TypeError, ValueError):
                continue
            bb = row.get("boundingbox")
            bounds = None
            if isinstance(bb, list) and len(bb) == 4:
                try:
                    south, north, west, east = (float(v) for v in bb)
                    bounds = {"south": south, "north": north, "west": west, "east": east}
                except ValueError:
                    bounds = None
            out.append({
                "name": str(row.get("display_name") or row.get("name") or key)[:160],
                "lat": round(lat, 6), "lon": round(lon, 6),
                "type": str(row.get("type") or row.get("category") or "")[:40],
                "bounds": bounds,
            })
        _geo_cache[key] = out
        try:
            util.atomic_write_json(GEOCODE_CACHE, _geo_cache)
        except OSError:
            pass
        return out[:limit]


def suggested_span_km(result):
    """A sensible square to sample for a geocoder hit: its bounding box's longer
    side, held between the scale of a street and the scale of a national park."""
    b = result.get("bounds") if isinstance(result, dict) else None
    if not b:
        return 3.0
    lat = (b["south"] + b["north"]) / 2
    ns = (b["north"] - b["south"]) * 111.32
    ew = (b["east"] - b["west"]) * 111.32 * max(0.05, math.cos(math.radians(lat)))
    # A point of interest has a box the size of its car park; a print of the
    # place around it wants a couple of kilometres.
    return round(util.clamp(max(ns, ew) * 1.15, 2.0, 60.0), 2)
