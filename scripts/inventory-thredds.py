#!/usr/bin/env python3
"""Inventory a THREDDS catalog without downloading the data.

Written for the NOAA GSL UFS-Chem surface-ozone retro catalog, but the
mechanics are generic to any TDS instance.

Why this exists as a *local* script rather than something the workflow
runs: ``gsl.noaa.gov`` sits behind a Cloudflare policy that 403s
datacenter egress (cloud IPs, CI runners). Run this from a machine on a
NOAA-allowed network and commit / paste the JSON it prints; that output
is what the pipeline design is calibrated against.

The inventory is deliberately cheap. It reads:

  * ``catalog.xml``          — file names, sizes, modified dates
  * ``<file>.dds`` / ``.das`` — OPeNDAP structure + attributes (variables,
                                dimensions, shapes, units) in ~kilobytes,
                                instead of pulling a multi-GB NetCDF
  * ``dataset.xml``          — the NCSS grid description, when NCSS is on
  * ``HEAD`` on fileServer   — Content-Length and Accept-Ranges, i.e.
                                whether byte-range transfer is available

Usage:
    python3 scripts/inventory-thredds.py \\
        https://gsl.noaa.gov/thredds/catalog/retro/ufs_chem_sfc_ozone/catalog.xml \\
        > sfc-ozone-inventory.json

    # inspect more than the first file
    python3 scripts/inventory-thredds.py <catalog.xml> --probe 3

Stdlib only — no install step, so it runs on a bare NOAA workstation.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from typing import Any
from urllib.parse import urljoin

# Cloudflare's bot rule rejects the stock python-urllib/python-requests
# User-Agent outright (NOAA GSL IT, confirmed: a *custom* UA returns 200
# where the default returns 403). Any non-default string works; this one
# self-identifies so server logs stay useful.
USER_AGENT = "terraviz-inventory/1.0 (+https://github.com/zyra-project/terraviz)"

TIMEOUT = 60
CATALOG_NS = "{http://www.unidata.ucar.edu/namespaces/thredds/InvCatalog/v1.0}"


def get(url: str, method: str = "GET") -> tuple[int, dict[str, str], bytes]:
    """Fetch a URL, returning (status, headers, body). Never raises on HTTP error."""
    req = urllib.request.Request(url, method=method, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            return resp.status, dict(resp.headers), resp.read()
    except urllib.error.HTTPError as exc:
        return exc.code, dict(exc.headers or {}), exc.read()[:2048]
    except Exception as exc:  # noqa: BLE001 - a probe reports failures, never dies on them
        return 0, {}, str(exc).encode()


def parse_catalog(xml_bytes: bytes) -> dict[str, Any]:
    """Pull services, sub-catalogs and dataset entries out of a TDS catalog.xml."""
    root = ET.fromstring(xml_bytes)

    services = [
        {"name": s.get("name"), "type": s.get("serviceType"), "base": s.get("base")}
        for s in root.iter(f"{CATALOG_NS}service")
        if s.get("serviceType")
    ]

    catalog_refs = [
        {
            "title": c.get("{http://www.w3.org/1999/xlink}title"),
            "href": c.get("{http://www.w3.org/1999/xlink}href"),
        }
        for c in root.iter(f"{CATALOG_NS}catalogRef")
    ]

    files = []
    for ds in root.iter(f"{CATALOG_NS}dataset"):
        url_path = ds.get("urlPath")
        if not url_path:
            continue  # a container node, not a file
        size_el = ds.find(f"{CATALOG_NS}dataSize")
        date_el = ds.find(f"{CATALOG_NS}date")
        files.append(
            {
                "name": ds.get("name"),
                "urlPath": url_path,
                "id": ds.get("ID"),
                "size": (size_el.text if size_el is not None else None),
                "sizeUnits": (size_el.get("units") if size_el is not None else None),
                "modified": (date_el.text if date_el is not None else None),
            }
        )

    return {"services": services, "catalogRefs": catalog_refs, "files": files}


def service_base(services: list[dict[str, Any]], want: str) -> str | None:
    for s in services:
        if (s.get("type") or "").lower() == want.lower():
            return s.get("base")
    return None


def probe_opendap(base_url: str) -> dict[str, Any]:
    """Read the OPeNDAP DDS + DAS — the whole variable inventory, in kilobytes."""
    out: dict[str, Any] = {}

    status, _, body = get(base_url + ".dds")
    out["dds_status"] = status
    if status == 200:
        text = body.decode("utf-8", "replace")
        out["dds"] = text[:8000]
        # "Float32 o3_sfc[time = 120][lat = 768][lon = 1536];"
        out["variables"] = [
            {"type": m.group(1), "name": m.group(2), "dims": m.group(3).strip()}
            for m in re.finditer(r"(\w+)\s+(\w+)\[([^;]*)\];", text)
        ]

    status, _, body = get(base_url + ".das")
    out["das_status"] = status
    if status == 200:
        text = body.decode("utf-8", "replace")
        out["das"] = text[:8000]
        out["units_seen"] = sorted(set(re.findall(r'units\s+"([^"]+)"', text)))
        out["long_names_seen"] = sorted(set(re.findall(r'long_name\s+"([^"]+)"', text)))

    return out


def probe_transfer(file_url: str) -> dict[str, Any]:
    """Does the file server support HEAD + byte ranges? That decides the transfer story."""
    status, headers, _ = get(file_url, method="HEAD")
    norm = {k.lower(): v for k, v in headers.items()}
    result = {
        "head_status": status,
        "content_length": norm.get("content-length"),
        "content_type": norm.get("content-type"),
        "accept_ranges": norm.get("accept-ranges"),
        "last_modified": norm.get("last-modified"),
        "server": norm.get("server"),
    }

    # An actual range request is the only trustworthy test; some servers
    # advertise nothing but honour ranges anyway.
    req = urllib.request.Request(
        file_url, headers={"User-Agent": USER_AGENT, "Range": "bytes=0-1023"}
    )
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            result["range_status"] = resp.status  # 206 => range transfer works
            result["range_bytes"] = len(resp.read())
    except urllib.error.HTTPError as exc:
        result["range_status"] = exc.code
    except Exception as exc:  # noqa: BLE001
        result["range_error"] = str(exc)

    # First bytes identify the container: CDF/HDF5 (NetCDF) vs GRIB.
    req = urllib.request.Request(
        file_url, headers={"User-Agent": USER_AGENT, "Range": "bytes=0-7"}
    )
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            head_bytes = resp.read(8)
        if head_bytes.startswith(b"CDF"):
            result["format_magic"] = "NetCDF classic (CDF)"
        elif head_bytes.startswith(b"\x89HDF"):
            result["format_magic"] = "HDF5 / NetCDF-4"
        elif head_bytes.startswith(b"GRIB"):
            result["format_magic"] = "GRIB"
        else:
            result["format_magic"] = head_bytes.hex()
    except Exception:  # noqa: BLE001
        pass

    return result


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("catalog", help="URL of the THREDDS catalog.xml")
    ap.add_argument("--probe", type=int, default=1, help="how many files to inspect in depth (default 1)")
    args = ap.parse_args()

    catalog_url = args.catalog.replace("catalog.html", "catalog.xml")
    report: dict[str, Any] = {"catalog": catalog_url, "userAgent": USER_AGENT}

    status, _, body = get(catalog_url)
    report["catalog_status"] = status
    if status != 200:
        report["error"] = (
            f"catalog fetch returned HTTP {status}. A 403 with a Cloudflare body means "
            "this host is blocking your network; run from a NOAA-allowed IP."
        )
        report["body_head"] = body[:400].decode("utf-8", "replace")
        json.dump(report, sys.stdout, indent=2)
        print()
        return 1

    parsed = parse_catalog(body)
    report.update(parsed)
    report["file_count"] = len(parsed["files"])

    dap = service_base(parsed["services"], "OPENDAP") or "/thredds/dodsC/"
    http = service_base(parsed["services"], "HTTPServer") or "/thredds/fileServer/"
    ncss = service_base(parsed["services"], "NetcdfSubset")

    root = re.match(r"(https?://[^/]+)", catalog_url)
    origin = root.group(1) if root else ""

    report["probes"] = []
    for entry in parsed["files"][: max(0, args.probe)]:
        url_path = entry["urlPath"]
        probe: dict[str, Any] = {"name": entry["name"], "urlPath": url_path}
        probe["opendap_url"] = urljoin(origin, dap.rstrip("/") + "/" + url_path)
        probe["file_url"] = urljoin(origin, http.rstrip("/") + "/" + url_path)
        probe["opendap"] = probe_opendap(probe["opendap_url"])
        probe["transfer"] = probe_transfer(probe["file_url"])
        if ncss:
            ncss_url = urljoin(origin, ncss.rstrip("/") + "/" + url_path)
            st, _, nb = get(ncss_url + "/dataset.xml")
            probe["ncss"] = {
                "url": ncss_url,
                "status": st,
                "dataset_xml": nb[:6000].decode("utf-8", "replace") if st == 200 else None,
            }
        report["probes"].append(probe)

    json.dump(report, sys.stdout, indent=2)
    print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
