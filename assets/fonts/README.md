# Bundled fonts

Three TrueType (`glyf`) faces, copied verbatim from Debian trixie packages. All
three licences explicitly permit redistribution and bundling with software; the
full licence text sits next to each font as `<Font>.LICENSE.txt` (the upstream
Debian `copyright` file, unedited).

| File | Face | Licence | Why it is here |
|---|---|---|---|
| `Quicksand-Bold.ttf` | geometric rounded sans, bold | SIL OFL 1.1 | Default nameplate face — thick even strokes with no hairlines, which is what survives a 0.4 mm nozzle. Kerning lives in **GPOS**. |
| `DejaVuSansMono.ttf` | monospace | Bitstream Vera (permissive) | Fixed pitch for labels and part numbers. Carries a **cmap format 12** subtable and a large stock of **composite** glyphs, so it exercises the parser paths a Latin-only font never touches. |
| `LiberationSansNarrow-Regular.ttf` | condensed sans | SIL OFL 1.1 | Fits long words on a short plate. Carries a legacy **`kern` table** (932 pairs) as well as GPOS, so both kerning back-ends get real data. |

Each is under 400 kB so the whole set ships with the page.

Sources:
- Quicksand — https://fonts.google.com/specimen/Quicksand (`fonts-quicksand`)
- DejaVu — https://dejavu-fonts.github.io/ (`fonts-dejavu-core`)
- Liberation — https://github.com/liberationfonts (`fonts-liberation-sans-narrow`)

The OFL forbids selling the fonts *by themselves* and reserves the family names
for unmodified copies — both satisfied here: the files are byte-identical to
upstream and are shipped as part of Forge, not sold on their own.
