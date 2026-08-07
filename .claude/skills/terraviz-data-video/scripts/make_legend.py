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


def _nice_ticks(vmin, vmax, target=5):
    """Ticks on round numbers, ~`target` of them, inclusive of both ends.

    linspace puts ticks wherever the range divides, which reads fine at
    vmax=3e-4 (0/1/2/3 after scaling) and badly at vmax=10 (0/3.33/6.67/10).
    """
    span = float(vmax) - float(vmin)
    if span <= 0:
        return np.array([vmin])
    raw = span / (target - 1)
    mag = 10.0 ** np.floor(np.log10(raw))
    # On a tie take the larger step (fewer, cleaner ticks) — that is what keeps
    # vmax=3e-4 on 0/1/2/3 rather than half-steps. The tolerance matters: the
    # two candidates are exactly equidistant there, and float error alone would
    # otherwise decide it.
    cands = [m * mag for m in (1, 2, 2.5, 5, 10)]
    diffs = [abs(c - raw) for c in cands]
    best = min(diffs)
    step = max(c for c, d in zip(cands, diffs) if d <= best * (1 + 1e-9) + 1e-15)
    ticks = np.arange(np.ceil(vmin / step) * step, vmax + step * 0.5, step)
    return ticks[(ticks >= vmin - step * 1e-6) & (ticks <= vmax + step * 1e-6)]


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

    # Tick labels: share a x10^-n exponent so the numbers stay short.
    # Only worth it when the exponent is actually large — a human-scale range
    # (vmax=10, say) would otherwise be labelled "0 0 1 1" against "x10^1".
    exp = int(np.floor(np.log10(a.vmax))) if a.vmax > 0 else 0
    if -3 < exp < 3:
        exp = 0
    scale = 10.0 ** exp
    ticks = _nice_ticks(a.vmin, a.vmax)
    # Enough decimals for the step to survive, no more.
    sstep = (ticks[1] - ticks[0]) / scale if len(ticks) > 1 else 1.0
    decimals = 0 if sstep == int(sstep) else (1 if round(sstep, 1) == sstep else 2)

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
