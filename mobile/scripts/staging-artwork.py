#!/usr/bin/env python3
"""Regenerates the temporary STAGING artwork in assets/staging/ (internal identifier only; not CourtBook branding).

Design (Paul, 25 Nov): charcoal background, large bold white "STG" centred; no colour, no decoration.
Readable at 40 px and inside Android's adaptive safe zone (the 66/108 circle), so round masks never cut it.

    python3 scripts/staging-artwork.py      (from mobile/; needs Pillow)

Any change to the output changes its sha256, so the store-artwork gate refuses it until
assets/artwork-approvals.json is updated in a reviewed change.
"""
import math
from PIL import Image, ImageDraw, ImageFont

FONT = "assets/fonts/Archivo_800ExtraBold.ttf"
BG = (31, 35, 40)          # #1F2328
WHITE = (255, 255, 255)
N = 1024
OUT = "assets/staging/"


def font_for(text, maxw, maxdiag=None):
    s = 600
    while s > 20:
        f = ImageFont.truetype(FONT, s)
        b = f.getbbox(text)
        w, h = b[2] - b[0], b[3] - b[1]
        if w <= maxw and (maxdiag is None or math.hypot(w, h) <= maxdiag):
            return f
        s -= 2
    raise SystemExit("no font size fits")


def centre(im, f, fill):
    d = ImageDraw.Draw(im)
    b = f.getbbox("STG")
    d.text(((im.width - (b[2] - b[0])) // 2 - b[0], (im.height - (b[3] - b[1])) // 2 - b[1]), "STG", font=f, fill=fill)


ios = Image.new("RGB", (N, N), BG)
centre(ios, font_for("STG", int(N * 0.68)), WHITE)
ios.save(OUT + "icon.png")

Image.new("RGB", (N, N), BG).save(OUT + "android-icon-background.png")
safe = N * 66 / 108                       # the adaptive-icon safe circle's diameter
f = font_for("STG", int(N * 0.50), maxdiag=safe * 0.92)
for name in ("android-icon-foreground.png", "android-icon-monochrome.png"):
    im = Image.new("RGBA", (N, N), (0, 0, 0, 0))
    centre(im, f, WHITE + (255,))
    im.save(OUT + name)

sp = Image.new("RGBA", (N, N), (0, 0, 0, 0))
centre(sp, font_for("STG", int(N * 0.80)), WHITE + (255,))
sp.save(OUT + "splash-icon.png")
