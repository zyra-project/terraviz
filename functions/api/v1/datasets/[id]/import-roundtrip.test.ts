/**
 * Phase 1d/C — verifies the SOS importer's data_ref pass-through.
 *
 * The importer (1d/A's pure mapper + 1d/B's CLI subcommand) never
 * touches the manifest endpoint directly. It only POSTs draft +
 * publish via the publisher API; the manifest is resolved at read
 * time when the frontend follows `dataLink`. Phase 1d's brief calls
 * out the importer's contract with the manifest layer:
 *
 *   - vimeo: data_refs pass through unchanged. Phase 1b's manifest
 *     endpoint already resolves them via the existing video proxy.
 *   - url: data_refs pass through verbatim too. The manifest
 *     endpoint synthesises a single-file shape for video URLs and
 *     the progressive-resolution variant ladder for image URLs.
 *   - No asset re-hosting happens here — that's Phase 2's video
 *     re-encoding work.
 *
 * This file is the contract test that pins those guarantees:
 * synthesise SOS-shaped rows, run them through the mapper, persist
 * via the real mutation layer, then call resolveManifest on the
 * resulting row and assert on the shape the frontend sees. It
 * doubles as documentation — a contributor reading this file sees
 * the entire importer-to-manifest data flow on one page.
 */

import { describe, expect, it, vi } from 'vitest'
import { resolveManifest } from './manifest'
import {
  asD1,
  makeKV,
  seedFixtures,
} from '../../_lib/test-helpers'
import {
  createDataset,
  publishDataset,
} from '../../_lib/dataset-mutations'
import { getPublicDataset } from '../../_lib/catalog-store'
import type { PublisherRow } from '../../_lib/publisher-store'
import {
  mapSnapshotEntry,
  type RawSosEntry,
} from '../../../../../cli/lib/snapshot-import'

const STAFF: PublisherRow = {
  id: 'PUB-IMPORTER',
  email: 'importer@example.com',
  display_name: 'SOS Importer',
  affiliation: null,
  org_id: null,
  role: 'staff',
  is_admin: 1,
  status: 'active',
  created_at: '2026-04-30T00:00:00.000Z',
}

function setupEnv() {
  const sqlite = seedFixtures({ count: 0 })
  sqlite
    .prepare(
      `INSERT INTO publishers (id, email, display_name, role, is_admin, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(STAFF.id, STAFF.email, STAFF.display_name, STAFF.role, STAFF.is_admin, STAFF.status, STAFF.created_at)
  const env = {
    CATALOG_DB: asD1(sqlite),
    CATALOG_KV: makeKV(),
    VIDEO_PROXY_BASE: 'https://video-proxy.test/video',
  }
  return { sqlite, env }
}

async function importAndPublish(
  env: ReturnType<typeof setupEnv>['env'],
  sos: RawSosEntry,
): Promise<string> {
  const outcome = mapSnapshotEntry(sos, undefined)
  if (outcome.kind !== 'ok') {
    throw new Error(
      `mapper rejected fixture: ${outcome.row.reason}` +
        (outcome.row.details ? ` (${outcome.row.details})` : ''),
    )
  }
  const created = await createDataset(env, STAFF, {
    ...outcome.row.draft,
    legacy_id: outcome.row.legacyId,
  })
  if (!created.ok) throw new Error(`createDataset failed: ${JSON.stringify(created.errors)}`)
  const published = await publishDataset(env, created.dataset.id)
  if (!published.ok) {
    throw new Error(`publishDataset failed: ${JSON.stringify(published.errors)}`)
  }
  return created.dataset.id
}

describe('importer → manifest round-trip', () => {
  it('produces a vimeo: data_ref that resolves through the video proxy', async () => {
    const { env } = setupEnv()
    const id = await importAndPublish(env, {
      id: 'INTERNAL_SOS_768',
      title: 'Hurricane Season - 2024',
      organization: 'NOAA',
      format: 'video/mp4',
      dataLink: 'https://vimeo.com/1107911993',
      tags: ['Air'],
      weight: 10,
    })

    const row = await getPublicDataset(env.CATALOG_DB, id)
    expect(row).not.toBeNull()
    expect(row!.data_ref).toBe('vimeo:1107911993')
    expect(row!.legacy_id).toBe('INTERNAL_SOS_768')

    // Stub the upstream proxy so the test stays offline.
    const fetchStub = vi.fn(async (url: string | URL | Request) => {
      const u = typeof url === 'string' ? url : url.toString()
      expect(u).toBe('https://video-proxy.test/video/1107911993')
      return new Response(
        JSON.stringify({
          id: '1107911993',
          title: 'Hurricane Season - 2024',
          duration: 320,
          hls: 'https://video-proxy.test/hls/1107911993.m3u8',
          files: [{ quality: 'hd', type: 'video/mp4', link: 'https://example/x.mp4', size: 100 }],
        }),
        { status: 200 },
      )
    })
    const result = await resolveManifest(row!, env, fetchStub as unknown as typeof fetch)
    if ('error' in result) throw new Error(`unexpected manifest error: ${result.error.message}`)
    expect(result.manifest.kind).toBe('video')
    if (result.manifest.kind !== 'video') return
    expect(result.manifest.hls).toBe('https://video-proxy.test/hls/1107911993.m3u8')
    expect(result.manifest.files).toHaveLength(1)
    expect(fetchStub).toHaveBeenCalledTimes(1)
  })

  it('produces a url: data_ref for image rows that resolves to the variant ladder', async () => {
    const { env } = setupEnv()
    const id = await importAndPublish(env, {
      id: 'INTERNAL_SOS_770',
      title: 'Argo Buoys (by country)',
      organization: '',
      format: 'image/png',
      dataLink: 'https://d3sik7mbbzunjo.cloudfront.net/oceans/argo_country/argo.png',
      tags: ['Water'],
      weight: 5,
    })

    const row = await getPublicDataset(env.CATALOG_DB, id)
    expect(row).not.toBeNull()
    expect(row!.data_ref).toBe(
      'url:https://d3sik7mbbzunjo.cloudfront.net/oceans/argo_country/argo.png',
    )

    const result = await resolveManifest(row!, env)
    if ('error' in result) throw new Error(`unexpected manifest error: ${result.error.message}`)
    expect(result.manifest.kind).toBe('image')
    if (result.manifest.kind !== 'image') return
    expect(result.manifest.variants.map(v => v.width)).toEqual([4096, 2048, 1024])
    expect(result.manifest.variants[0].url).toBe(
      'https://d3sik7mbbzunjo.cloudfront.net/oceans/argo_country/argo_4096.png',
    )
    expect(result.manifest.fallback).toBe(
      'https://d3sik7mbbzunjo.cloudfront.net/oceans/argo_country/argo.png',
    )
  })

  it('produces a url: data_ref for non-vimeo video rows that resolves to a single-file manifest', async () => {
    const { env } = setupEnv()
    // Some legacy SOS rows host MP4s directly. The mapper passes
    // them through as `url:<href>` and the manifest endpoint
    // synthesises the single-file video manifest the frontend
    // already knows how to play via `hlsService.loadDirect`.
    const id = await importAndPublish(env, {
      id: 'INTERNAL_SOS_DIRECT_MP4',
      title: 'Direct MP4 Source',
      organization: 'NOAA',
      format: 'video/mp4',
      dataLink: 'https://example.org/datasets/direct.mp4',
    })

    const row = await getPublicDataset(env.CATALOG_DB, id)
    expect(row).not.toBeNull()
    expect(row!.data_ref).toBe('url:https://example.org/datasets/direct.mp4')

    const result = await resolveManifest(row!, env)
    if ('error' in result) throw new Error(`unexpected manifest error: ${result.error.message}`)
    expect(result.manifest.kind).toBe('video')
    if (result.manifest.kind !== 'video') return
    expect(result.manifest.hls).toBe('')
    expect(result.manifest.files).toHaveLength(1)
    expect(result.manifest.files[0].link).toBe('https://example.org/datasets/direct.mp4')
    expect(result.manifest.files[0].type).toBe('video/mp4')
  })

  it('preserves the legacy_id on the imported row so re-runs are idempotent', async () => {
    const { env } = setupEnv()
    const id = await importAndPublish(env, {
      id: 'INTERNAL_SOS_777',
      title: 'Idempotency Probe',
      organization: 'NOAA',
      format: 'video/mp4',
      dataLink: 'https://vimeo.com/777',
    })

    // A re-run with the same SOS id should fail at create time with
    // a structured 409 — exercising the unique partial index from
    // migration 0008. The CLI subcommand's in-memory legacy_id index
    // would normally prevent this from ever reaching the API, but
    // the database-level guard is the durable safety net.
    const outcome = mapSnapshotEntry(
      {
        id: 'INTERNAL_SOS_777',
        title: 'Idempotency Probe (Repost)',
        format: 'video/mp4',
        dataLink: 'https://vimeo.com/777',
      },
      undefined,
    )
    if (outcome.kind !== 'ok') throw new Error('mapper unexpectedly rejected fixture')
    const second = await createDataset(env, STAFF, {
      ...outcome.row.draft,
      legacy_id: outcome.row.legacyId,
    })
    expect(second.ok).toBe(false)
    if (second.ok) return
    expect(second.status).toBe(409)
    expect(second.errors[0].field).toBe('legacy_id')
    expect(second.errors[0].message).toContain(id)
  })
})
