# Pybrix brand source artwork

The master artwork the product owner supplied for the Pybrix identity. These
files are **never shipped**: nothing imports them, so they never reach `dist/`
or the release artifact. What the application serves is the small set of
derivatives in `apps/web/src/brand/`, which Vite fingerprints into `/assets/`.

| File                         | Pixels      | Mode | SHA-256                                                            |
| ---------------------------- | ----------- | ---- | ------------------------------------------------------------------ |
| `pybrix-icon.png`            | 1254 × 1254 | RGBA | `cdb1f86387d241c19190de02e256a7add09c2fec2fd29196c72b279546688193` |
| `pybrix-logo-horizontal.png` | 2172 × 724  | RGBA | `1df797b84acff9eb6ec82ab5867ef31e4b0d3b0bfb3a5854eae7bfa210aeb3be` |
| `pybrix-logo-vertical.png`   | 1254 × 1254 | RGBA | `52a253e9c1c034563fdba33f9ee8013d287af585cb20a993c21b78e17ced7bc7` |

Byte-identical to the supplied files; only the names changed (the vertical
lockup was supplied as `Logo_verticle.png`). Backgrounds are transparent. The
"P" in the mark is a transparent cut-out, and the wordmark is navy `#011A47`, so
**neither lockup is legible on the dark application chrome** — on dark surfaces
use the mark on its white tile beside HTML text, never a lockup.

## Palette, sampled from the artwork

| Role                               | Colour    | Where it comes from       |
| ---------------------------------- | --------- | ------------------------- |
| Brand blue (fills, white text 6.1) | `#004DF9` | the flat dot over the "i" |
| Fill hover (white text 4.7)        | `#016AFC` | top face, right end       |
| Fill pressed (white text 7.0)      | `#003AFB` | left face, bottom         |
| Accent on dark (≥ 4.6 : 1)         | `#12A0FB` | inner cube, top face      |
| Accent hover on dark               | `#18C1FC` | top face highlight        |
| Navy (light surfaces only)         | `#011A47` | the wordmark              |

## Derivatives in `src/brand/`

| File                          | Size      | Use                                 |
| ----------------------------- | --------- | ----------------------------------- |
| `pybrix-favicon-32.png`       | 32 × 32   | `<link rel="icon">`                 |
| `pybrix-apple-touch-icon.png` | 180 × 180 | `<link rel="apple-touch-icon">`     |
| `pybrix-tile-96.png`          | 96 × 96   | top-bar mark, drawn at 26 CSS px    |
| `pybrix-logo-horizontal.png`  | 600 × 202 | Help → About plate, drawn at 188 px |

Produced on macOS with `sips` (built in) and the two standard-library Python
scripts in `tools/`; no image library is a dependency of this repository.

1. **Mark crop.** `sips -c 960 960 --cropOffset 140 147 pybrix-icon.png --out mark-960.png`
   removes transparent padding only: the mark's opaque bounding box is
   816 × 923 and sits centred in the crop (73 px either side, 20 / 19 px top
   and bottom). No mark pixel moves or changes.
2. **Tile.** `python3 tools/tile.py mark-960.png tile-rounded.png rounded` and
   `... tile-square.png square` place the mark on the white ground it was
   drawn on. Mark pixels are composited over white with their own alpha;
   nothing is recoloured. The rounded tile has transparent anti-aliased
   corners; the square one is fully opaque, because iOS fills a transparent
   touch icon with black.
3. **Sizes.** `sips -Z 32` / `-Z 96` of the rounded tile, `sips -Z 180` of the
   square tile.
4. **Lockup.** `sips -c 682 2018 --cropOffset 27 88 pybrix-logo-horizontal.png`
   (transparent padding only), then `sips -Z 600`.

The vertical lockup has no surface in the editor that would not waste working
space, so it has no derivative and is not shipped.
