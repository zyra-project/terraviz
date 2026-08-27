#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 The Zyra Project

"""Inspect a live TerraViz node's public catalog — no auth required.

Three jobs, all of which beat guessing:

  duplicates  Before building a new dataset, check whether the node already
              has one. Uses the node's semantic search plus a title/keyword
              scan, because "Global Smoke Forecast" and "Wildfire Smoke
              Overhead" are the same idea under different names.

  reference   List the node's existing data-encoded datasets with their
              actual vmin/vmax/units/palette. This is the best available
              answer to "what vmax should I use?" — a sibling dataset that
              already renders correctly is worth more than a guess, and it
              shows the house conventions for units and naming.

  check       Verify a published dataset really is data-encoded: does the
              row carry renderEncoding + a parseable colorScale? This is the
              fastest way to split "the color scale never attached" from
              "attached but the palette/range is wrong" — the two failure
              modes that look identical on the globe.

Usage:
    python3 node_inspect.py --node https://your-node.example duplicates "global dust forecast"
    python3 node_inspect.py --node https://your-node.example reference
    python3 node_inspect.py --node https://your-node.example check <dataset-id-or-slug>

Only the public read API is used (GET /api/v1/catalog, GET /api/v1/search), so
this works against any node without credentials. Workflows are publisher-only
(/api/v1/publish/*, behind auth) — use the `terraviz` CLI for those.
"""
import argparse
import json
import sys
import urllib.parse
import urllib.request

TIMEOUT = 60
# A node fronted by Cloudflare rejects the default "Python-urllib/3.x" agent
# with a 403, so identify ourselves like an ordinary client.
UA = "terraviz-data-video-skill/1.0 (+node_inspect.py)"


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        return json.load(r)


def catalog(node):
    return fetch(f"{node.rstrip('/')}/api/v1/catalog").get("datasets", [])


def scale_of(ds):
    """The colorScale, tolerating either an object or a JSON string."""
    cs = ds.get("colorScale")
    if isinstance(cs, str):
        try:
            cs = json.loads(cs)
        except Exception:
            return None
    return cs if isinstance(cs, dict) else None


def cmd_duplicates(node, query):
    hits = []
    try:
        q = urllib.parse.quote(query)
        res = fetch(f"{node.rstrip('/')}/api/v1/search?q={q}&limit=8")
        hits = res.get("datasets", []) or []
    except Exception as e:
        print(f"(semantic search unavailable: {e})\n")

    if hits:
        print(f"Semantic matches for {query!r}:")
        for d in hits:
            print(f"  • {d.get('title')}   [{d.get('id')}]")
        print()

    # Substring pass — catches near-identical titles semantic search may rank low.
    terms = [t for t in query.lower().split() if len(t) > 2]
    subs = []
    for d in catalog(node):
        hay = " ".join(str(d.get(k, "")) for k in ("title", "slug")).lower()
        hay += " " + " ".join(map(str, d.get("keywords") or []))
        if sum(t in hay for t in terms) >= max(1, len(terms) // 2):
            subs.append(d)
    if subs:
        print(f"Title/keyword matches ({len(subs)}):")
        for d in subs[:12]:
            enc = " [data-encoded]" if d.get("renderEncoding") else ""
            print(f"  • {d.get('title')}{enc}   [{d.get('id')}]")
    if not hits and not subs:
        print("No similar dataset found — looks like a genuinely new one.")


def cmd_reference(node):
    ds = [d for d in catalog(node) if d.get("renderEncoding")]
    if not ds:
        print("No data-encoded datasets on this node yet.")
        return
    print(f"{len(ds)} data-encoded dataset(s) — use these as calibration references:\n")
    for d in ds:
        cs = scale_of(d) or {}
        print(f"  {d.get('title')}")
        print(f"      id       {d.get('id')}")
        print(f"      encoding {d.get('renderEncoding')}")
        print(f"      range    vmin={cs.get('vmin')}  vmax={cs.get('vmax')}  units={cs.get('units')!r}")
        tr = cs.get("transparentRange")
        print(f"      palette  {len(cs.get('stops') or [])} stops"
              + (f", transparentRange={tr}" if tr is not None else ""))
        if d.get("startTime"):
            print(f"      time     {d.get('startTime')} → {d.get('endTime')}  period={d.get('period')}")
        print()
    print("Match units and order-of-magnitude to the closest sibling; a column field "
          "(kg m-2) and a near-surface field (kg m-3) have very different ranges.")


def cmd_check(node, ident):
    ident_l = ident.lower()
    match = None
    for d in catalog(node):
        if ident_l in (str(d.get("id", "")).lower(), str(d.get("slug", "")).lower()) \
           or ident_l == str(d.get("title", "")).lower():
            match = d
            break
    if not match:
        print(f"No public dataset matching {ident!r}. "
              "(A draft/unpublished dataset is not in the public catalog.)")
        return 1
    enc = match.get("renderEncoding")
    cs = scale_of(match)
    print(f"{match.get('title')}  [{match.get('id')}]")
    print(f"  renderEncoding : {enc!r}")
    print(f"  colorScale     : {'present' if cs else 'MISSING'}")
    if not enc or not cs:
        print("\n  → This is a plain picture dataset (no value encoding). That is correct")
        print("    for ordinary imagery. If you expected data-encoded, the pair never")
        print("    attached: check that the heatmap stage has BOTH data_encoded:true and")
        print("    color_scale_file, and that publishing went through the Zyra dispatch")
        print("    path (the publish log says 'publishing as a picture' when it didn't).")
        return 1
    stops = cs.get("stops") or []
    grayish = sum(1 for s in stops if isinstance(s.get("rgba"), list)
                  and len(set(s["rgba"][:3])) == 1)
    print(f"  vmin/vmax      : {cs.get('vmin')} .. {cs.get('vmax')}  units={cs.get('units')!r}")
    print(f"  stops          : {len(stops)}  ({grayish} are pure gray)")
    print("\n  → Data-encoded wiring is correct (hover values will work).")
    if stops and grayish >= len(stops) * 0.9:
        print("  ⚠ The palette is (nearly) all gray — a bare --cmap was probably used, which")
        print("    is ignored on the data-encoded path. Supply cmap_inline/cmap_file instead.")
    return 0


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--node", required=True, help="Node base URL, e.g. https://your-node.example")
    sub = ap.add_subparsers(dest="cmd", required=True)
    d = sub.add_parser("duplicates"); d.add_argument("query")
    sub.add_parser("reference")
    c = sub.add_parser("check"); c.add_argument("dataset")
    a = ap.parse_args()
    try:
        if a.cmd == "duplicates":
            return cmd_duplicates(a.node, a.query) or 0
        if a.cmd == "reference":
            return cmd_reference(a.node) or 0
        return cmd_check(a.node, a.dataset)
    except urllib.error.URLError as e:
        print(f"Could not reach {a.node}: {e}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
