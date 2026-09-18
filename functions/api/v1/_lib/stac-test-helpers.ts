// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { asD1, makeKV, seedFixtures } from './test-helpers'
import { readStacModel } from './stac-read-model'
import type { StacResolvers } from './stac-builders'

export function stacRouteFixture(count = 1) {
  const sqlite = seedFixtures({ count: 0, baseUrl: 'https://node.example' })
  const ids = Array.from({ length: count }, (_, index) => `01ARZ3NDEKTSV4RRFFQ69G${String(index).padStart(4, '0')}`)
  const insert = sqlite.prepare(`INSERT INTO datasets (id, slug, origin_node, title, format, data_ref,
    visibility, is_hidden, published_at, created_at, updated_at, resource_kind,
    bbox_provenance, bbox_evidence, bbox_n, bbox_s, bbox_w, bbox_e,
    temporal_semantics, temporal_evidence, start_time, end_time, license_spdx)
    VALUES (?, ?, 'NODE000', 'Scientific image', 'image/png', 'url:https://data.example/image.png',
    'public', 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 'product',
    'measured', 'Source metadata', 30, -30, -60, 60, 'represented', 'Source metadata',
    '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z', 'CC-BY-4.0')`)
  for (const id of ids) insert.run(id, id.toLowerCase())
  const env = { STAC_ENABLED: 'true', STAC_ASSET_ORIGINS: 'https://data.example', CATALOG_DB: asD1(sqlite), CATALOG_KV: makeKV() }
  return { sqlite, ids, env }
}

export async function stacFixture() {
  const sqlite = seedFixtures({ count: 1 })
  try {
    sqlite.exec(`UPDATE datasets SET origin_node='NODE000',
      data_ref='url:https://data.example/image.png', format='image/png',
      resource_kind='product', bbox_provenance='measured', bbox_evidence='Source metadata',
      bbox_n=30, bbox_s=-30, bbox_w=-60, bbox_e=60,
      temporal_semantics='represented', temporal_evidence='Source metadata',
      start_time='2026-01-01T00:00:00Z', end_time='2026-01-02T00:00:00Z', license_spdx='CC-BY-4.0'`)
    const model = await readStacModel(asD1(sqlite))
    model.datasets[0].row.id = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
    const node = model.node!
    node.identity.node_id = 'NODE000'
    const resolvers: StacResolvers = {
      resource: (kind, id) => `https://node.example/${kind}/${encodeURIComponent(id)}`,
      asset: ref => ref.startsWith('url:https://data.example/') ? { sourceRef: ref, href: ref.slice(4), type: 'image/png', anonymous: true, hostedBy: 'NODE000' } : null,
    }
    return { node, model: model.datasets[0], resolvers }
  } finally { sqlite.close() }
}