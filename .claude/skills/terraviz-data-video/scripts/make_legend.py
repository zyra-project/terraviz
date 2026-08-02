#!/usr/bin/env python3
"""Render a colorbar legend PNG (opaque white background) for a data-encoded dataset.

TerraViz on `main` has no auto gradient legend — the colorbar comes from a
`legend_ref` image you attach via the publisher form → Media. This makes one
that matches your palette's colormap + vmin/vmax + units. Match the `base`
colormap to the workflow's palette so the legend agrees with the globe.

Usage:
    python3 make_legend.py --title "Global Dust Forecast" \
        --subtitle "Column dust (GEFS-Aerosols)" \
        --cmap Oranges --vmax 3e-4 --units "kg m-2" \
        --low clear --high "heavy dust" --out dust-legend.png

Needs: pip install matplotlib pillow numpy

Why flatten to RGB: matplotlib saves RGBA with a transparent bbox, so the
"white" only looks white on a light viewer and goes see-through on the dark
globe UI. We composite onto solid white and drop the alpha channel.
"""
import argparse

import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.colorbar
from matplotlib import colors
from PIL import Image


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--title", required=True)
    ap.add_argument("--subtitle", default="")
    ap.add_argument("--cmap", default="YlOrBr", help="matplotlib colormap = palette base")
    ap.add_argument("--vmin", type=float, default=0.0)
    ap.add_argument("--vmax", type=float, required=True)
    ap.add_argument("--units", default="kg m-2")
    ap.add_argument("--low", default="clear", help="label under the low end")
    ap.add_argument("--high", default="high", help="label under the high end")
    ap.add_argument("--out", default="legend.png")
    a = ap.parse_args()

    # A colorbar over an empty range says nothing, and the tick-decimal maths
    # below divides by the range. Reject it here with a readable message
    # rather than dying on an inf/nan conversion further down.
    if a.vmax <= a.vmin:
        ap.error(
            f"--vmax ({a.vmax:g}) must be greater than --vmin ({a.vmin:g}); "
            "a colorbar needs a non-empty range"
        )

    # Tick labels share one power-of-ten exponent so the numbers stay short.
    # It is usually negative (column mass density lives at 1e-4), but a large
    # enough vmax factors out a positive one instead.
    #
    # Only factor the exponent out when the plain numbers would actually be
    # unwieldy. Applied unconditionally it destroys human-scale ranges: a
    # 0..120 index at x10^2 rounds to "0 0 1 1". Column mass density (3e-4)
    # still needs it, so the rule is on magnitude, not on units.
    exp = int(np.floor(np.log10(a.vmax))) if a.vmax > 0 else 0
    if -2 <= exp <= 3:
        exp = 0
    scale = 10.0 ** exp
    ticks = np.linspace(a.vmin, a.vmax, 4)
    # Enough decimals that adjacent ticks stay distinct after scaling.
    step = (a.vmax - a.vmin) / (len(ticks) - 1) / scale
    decimals = 0 if step >= 1 else int(np.ceil(-np.log10(step)))

    fig = plt.figure(figsize=(9.0, 2.2), dpi=150)
    fig.patch.set_facecolor("white")
    ax = fig.add_axes([0.06, 0.42, 0.88, 0.26])
    cb = matplotlib.colorbar.ColorbarBase(
        ax, cmap=plt.get_cmap(a.cmap),
        norm=colors.Normalize(a.vmin, a.vmax), orientation="horizontal")
    cb.set_ticks(ticks)
    cb.set_ticklabels([f"{t/scale:.{decimals}f}" for t in ticks])
    cb.ax.tick_params(labelsize=12, color="#333", labelcolor="#222", length=5, width=1)
    cb.outline.set_edgecolor("#333"); cb.outline.set_linewidth(1)

    fig.text(0.5, 0.86, a.title, ha="center", va="center",
             fontsize=18, fontweight="bold", color="#1a1a1a")
    if a.subtitle:
        fig.text(0.5, 0.72, a.subtitle, ha="center", va="center",
                 fontsize=11, color="#555")
    unit_lbl = a.units if exp == 0 else rf"$\times10^{{{exp}}}$ {a.units}"
    fig.text(0.5, 0.12, unit_lbl, ha="center", va="center", fontsize=12, color="#222")
    fig.text(0.06, 0.20, a.low, ha="left", va="center", fontsize=10, color="#666")
    fig.text(0.94, 0.20, a.high, ha="right", va="center", fontsize=10, color="#7a3b00")

    fig.canvas.draw()
    rgba = Image.fromarray(np.asarray(fig.canvas.buffer_rgba()), "RGBA")
    bg = Image.new("RGB", rgba.size, (255, 255, 255))
    bg.paste(rgba, mask=rgba.split()[3])   # composite onto opaque white
    bg.save(a.out, "PNG")
    print(f"wrote {a.out} ({bg.size[0]}x{bg.size[1]}, opaque RGB)")


if __name__ == "__main__":
    main()
