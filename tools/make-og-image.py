#!/usr/bin/env python3
"""Generate the 1200x630 Open Graph preview card using the project's icon colors.

Needs Pillow (the same dependency as tools/make-icons.py).
"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "og-image.png"
SIZE = (1200, 630)
BG = (15, 42, 36)
GREEN = (16, 185, 129)
WHITE = (255, 255, 255)
MUTED = (209, 224, 219)


def font(size):
    candidates = [
        Path("C:/Windows/Fonts/arial.ttf"),
        Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"),
        Path("/Library/Fonts/Arial.ttf"),
    ]
    for path in candidates:
        if path.is_file():
            return ImageFont.truetype(str(path), size)
    return ImageFont.load_default()


def main():
    image = Image.new("RGB", SIZE, BG)
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((74, 72, 164, 162), radius=22, fill=(7, 65, 52))
    draw.ellipse((98, 96, 140, 138), outline=GREEN, width=4)
    draw.line(((107, 118), (117, 128), (134, 107)), fill=GREEN, width=8, joint="curve")
    draw.text((194, 88), "INDEPENDENT PUBLIC-DATA TRACKER", font=font(21), fill=GREEN)
    draw.text((74, 235), "Irish Visa Decisions", font=font(64), fill=WHITE)
    draw.text((74, 321), "& Processing Time Tracker", font=font(54), fill=WHITE)
    draw.text((78, 424), "New Delhi decisions · Stamp 1G · Employment permits", font=font(27), fill=MUTED)
    draw.line((78, 502, 1122, 502), fill=(57, 91, 80), width=2)
    draw.text((78, 528), "Historical public data  ·  Outcomes are not guaranteed", font=font(22), fill=MUTED)
    image.save(OUT, "PNG", optimize=True)
    print(f"wrote {OUT} ({SIZE[0]}x{SIZE[1]})")


if __name__ == "__main__":
    main()
