# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 The Zyra Project

import json
import sys
import tempfile
from pathlib import Path

import geopandas
import requests
import stac_geoparquet
from pystac_client import Client

root, collection = sys.argv[1:3]
client = Client.open(root)
assert collection in [entry.id for entry in client.get_collections()]
get_items = list(client.search(method="GET", collections=[collection], limit=17).items())
post_items = list(client.search(method="POST", collections=[collection], limit=17).items())
assert len(get_items) == 120
assert {item.id for item in get_items} == {item.id for item in post_items}
dated = list(client.search(collections=[collection], datetime="2026-01-02T00:00:00Z").items())
assert len(dated) == 1
assert dated[0].datetime.isoformat().startswith("2026-01-02")

indexed = []
url = root + "/search?limit=19&collections=" + collection
while url:
    response = requests.get(url, timeout=30)
    response.raise_for_status()
    page = response.json()
    indexed.extend(page["features"])
    url = next((link["href"] for link in page["links"] if link["rel"] == "next"), None)
assert len(indexed) == 120
assert len({item["id"] for item in indexed}) == 120
frame = stac_geoparquet.to_geodataframe(indexed)
with tempfile.TemporaryDirectory() as directory:
    path = Path(directory) / "stac-index.parquet"
    frame.to_parquet(path)
    restored = geopandas.read_parquet(path)
    assert len(restored) == 120
    assert set(restored["id"]) == {item.id for item in get_items}
    assert restored.geometry.notna().all()
print(json.dumps({"pystac_client": "0.9.0", "stac_geoparquet": stac_geoparquet.__version__, "indexed_items": 120, "get_post_equal": True}))