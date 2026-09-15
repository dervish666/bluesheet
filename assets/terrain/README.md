# Bundled elevation fields

Real SRTM 30 m elevation, fetched once from opentopodata.org's public API by
`tools/fetch-terrain.mjs`, so the terrain generator works with no network at all.

Format: `{name, lat, lon, spanKm, w, h, dataset, minM, maxM, voids, data:[metres]}`
— `data` is a flat row-major array of integer metres, `w * h` long, south-west
corner first.

The grid is square **on the ground**, not in degrees: a degree of longitude at
51°N is only 62% of a degree of latitude, and sampling a square degree box would
squash every British map by nearly half. The fetcher applies the cosine
correction; a generator re-deriving the aspect from lat/lon must apply it too.

Voids (the sentinel real elevation APIs return for no data) are interpolated away
at fetch time and the count is recorded. All three of these came back clean.

To add another:

    node tools/fetch-terrain.mjs "Ben Nevis" 56.7969 -5.0036 8 80

The API allows one call a second and a hundred points a call, so an 80×80 grid
takes a bit over a minute. Be a good guest.
