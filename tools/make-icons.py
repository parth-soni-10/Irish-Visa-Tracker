#!/usr/bin/env python3
"""Render apple-touch-icon.png from the same design as icon.svg.

    python tools/make-icons.py

Writes, next to icon.svg:

    apple-touch-icon.png   180x180, full-bleed

Why the raster exists: iOS ignores SVG favicons and would otherwise use a
screenshot of the page for the home-screen icon. It is full-bleed rather than
rounded because iOS applies its own mask - icon.svg's rx=14 is the browser-tab
shape and would show as a rounded square inside iOS's mask.

The design is icon.svg's: a #0f2a24 tile, a #059669 stamp ring, and the granted
tick in #10b981 with round caps and joins. icon.svg is the source of truth;
keep these numbers in step with it if the mark changes.

Every mark here is a shape, not text, so this generator needs no font and is
byte-reproducible on any machine with Pillow - which is what makes the committed
raster checkable rather than merely present.

Needs Pillow (`pip install pillow`).
"""

from __future__ import annotations

import os

from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "apple-touch-icon.png")

TILE = (15, 42, 36)        # #0f2a24
RING = (5, 150, 105)       # #059669
TICK = (16, 185, 129)      # #10b981

# icon.svg is drawn on a 64-unit grid.
VIEWBOX = 64
SIZE = 180
RING_R = 21
RING_W = 2.5
TICK_W = 7
TICK_PATH = [(21, 33), (28, 40), (43, 23)]


def main() -> None:
    unit = SIZE / VIEWBOX
    img = Image.new("RGBA", (SIZE, SIZE), TILE + (255,))
    draw = ImageDraw.Draw(img)
    cx = cy = 32 * unit

    ring_w = max(1, round(RING_W * unit))
    radius = RING_R * unit
    draw.ellipse(
        [cx - radius, cy - radius, cx + radius, cy + radius],
        outline=RING + (255,),
        width=ring_w,
    )

    points = [(x * unit, y * unit) for x, y in TICK_PATH]
    tick_w = max(1, round(TICK_W * unit))
    # joint="curve" is the SVG's stroke-linejoin="round" at the elbow; the two
    # end circles are its stroke-linecap="round", which a PIL polyline does not
    # draw by itself.
    draw.line(points, fill=TICK + (255,), width=tick_w, joint="curve")
    cap_r = tick_w / 2
    for x, y in (points[0], points[-1]):
        draw.ellipse([x - cap_r, y - cap_r, x + cap_r, y + cap_r], fill=TICK + (255,))

    # RGB rather than RGBA: the tile is full-bleed and therefore completely
    # opaque, so an alpha channel would be dead weight. Saved with Pillow's
    # defaults (compress_level=6, no optimize) because that is the encoder
    # path the shipped rasters came from - with optimize=True the pixels are
    # identical but the file bytes are not, which would make every future run
    # of this generator show up as a binary change.
    img.convert("RGB").save(OUT, "PNG")
    print(f"wrote apple-touch-icon.png ({SIZE}x{SIZE}, {os.path.getsize(OUT)} bytes)")


if __name__ == "__main__":
    main()
