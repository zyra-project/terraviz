/**
 * Wire-level tests for POST /api/v1/publish/events/:id — the curator
 * review-submit.
 *
 * Coverage: privileged gate (403), 404 unknown event, 400 empty body,
 * 400 unknown link, event approve, per-link approve/reject, and the
 * `event.reviewed` audit row.
 */

import { describe, expect, it } from 'vitest'
import { onRequestPost as reviewPost } from './[id]'
import { asD1, seedFixtures } from '../../_lib/test-helpers'
import {
  insertCurrentEvent,
  upsertEventDatasetLink,
  getCurrentEvent,
  listLinksForEvent,
} from '../../_lib/events-store'
import type { PublisherRow } from '../../_lib/publisher-store'

const ADMIN: PublisherRow = {
  id: 'PUB-ADMIN',
  email: 'admin@example.com',
  display_name: 'Admin',
  affiliation: null,
  org_id: null,
  role: 'admin',
  is_admin: 1,
  status: 'active',
  created_at: '2026-01-01T00:00:00.000Z',
}
const PUBLISHER: PublisherRow = { ...ADMIN, id: 'PUB-PUBLISHER', email: 'c@e', role: 'publisher', is_admin: 0 }

const DS_0 = 'DS000' + 'A'.repeat(21)
const DS_1 = 'DS001' + 'A'.repeat(21)

function setupEnv() {
  const sqlite = seedFixtures({ count: 2 })
  sqlite
    .prepare(
      `INSERT INTO publishers (id, email, display_name, role, is_admin, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(ADMIN.id, ADMIN.email, ADMIN.display_name, ADMIN.role, ADMIN.is_admin, ADMIN.status, ADMIN.created_at)
  return { sqlite, env: { CATALOG_DB: asD1(sqlite) } }
}

function ctx(opts: { env: Record<string, unknown>; id: string; publisher?: PublisherRow; body?: unknown; bodyText?: string }) {
  const init: RequestInit = { method: 'POST', headers: new Headers({ 'Content-Type': 'application/json' }) }
  if (opts.bodyText !== undefined) init.body = opts.bodyText
  else if (opts.body !== undefined) init.body = JSON.stringify(opts.body)
  return {
    request: new Request(`https://localhost/api/v1/publish/events/${opts.id}`, init),
    env: opts.env,
    params: { id: opts.id },
    data: { publisher: opts.publisher ?? ADMIN },
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: `/api/v1/publish/events/${opts.id}`,
  } as unknown as Parameters<typeof reviewPost>[0]
}

function auditCount(sqlite: ReturnType<typeof seedFixtures>, action: string): number {
  const row = sqlite.prepare(`SELECT COUNT(*) AS n FROM audit_events WHERE action = ?`).get(action) as { n: number }
  return row.n
}

const SAMPLE = {
  originNode: 'NODE000',
  title: 'Storm now',
  sourceName: 'NOAA',
  sourceUrl: 'https://example.gov/storm',
  occurredStart: '2026-06-25T12:00:00Z',
}

async function seedEventWithLink(env: { CATALOG_DB: D1Database }) {
  const id = (await insertCurrentEvent(env.CATALOG_DB, SAMPLE)).id
  await upsertEventDatasetLink(env.CATALOG_DB, { eventId: id, datasetId: DS_0, matchScore: 0.9 })
  return id
}

describe('POST /api/v1/publish/events/:id', () => {
  it('403 for a publisher-role account', async () => {
    const { env } = setupEnv()
    const id = await seedEventWithLink(env)
    const res = await reviewPost(ctx({ env, id, publisher: PUBLISHER, body: { event: 'approve' } }))
    expect(res.status).toBe(403)
  })

  it('404 for an unknown event', async () => {
    const { env } = setupEnv()
    const res = await reviewPost(ctx({ env, id: 'NOPE000000000000000000000A', body: { event: 'approve' } }))
    expect(res.status).toBe(404)
  })

  it('400 for an empty review', async () => {
    const { env } = setupEnv()
    const id = await seedEventWithLink(env)
    const res = await reviewPost(ctx({ env, id, body: {} }))
    expect(res.status).toBe(400)
  })

  it('400 for a link that is not proposed on the event', async () => {
    const { env } = setupEnv()
    const id = await seedEventWithLink(env)
    const res = await reviewPost(ctx({ env, id, body: { links: [{ datasetId: DS_1, decision: 'approve' }] } }))
    expect(res.status).toBe(400)
    const body = JSON.parse(await res.text()) as { errors: Array<{ code: string }> }
    expect(body.errors[0].code).toBe('unknown_link')
  })

  it('approves the event and writes an audit row', async () => {
    const { env, sqlite } = setupEnv()
    const id = await seedEventWithLink(env)
    const res = await reviewPost(ctx({ env, id, body: { event: 'approve' } }))
    expect(res.status).toBe(200)

    const row = await getCurrentEvent(env.CATALOG_DB, id)
    expect(row!.status).toBe('approved')
    expect(row!.reviewed_by).toBe('PUB-ADMIN')
    expect(auditCount(sqlite, 'event.reviewed')).toBe(1)
  })

  it('applies per-link decisions in the same submit', async () => {
    const { env } = setupEnv()
    const id = await seedEventWithLink(env)
    await upsertEventDatasetLink(env.CATALOG_DB, { eventId: id, datasetId: DS_1, matchScore: 0.6 })

    const res = await reviewPost(
      ctx({
        env,
        id,
        body: {
          event: 'approve',
          links: [
            { datasetId: DS_0, decision: 'approve' },
            { datasetId: DS_1, decision: 'reject' },
          ],
        },
      }),
    )
    expect(res.status).toBe(200)

    const links = await listLinksForEvent(env.CATALOG_DB, id)
    const byId = Object.fromEntries(links.map(l => [l.dataset_id, l]))
    expect(byId[DS_0].status).toBe('approved')
    expect(byId[DS_0].approved_by).toBe('PUB-ADMIN')
    expect(byId[DS_1].status).toBe('rejected')
    expect(byId[DS_1].approved_at).toBeNull()
  })

  describe('addDatasetIds — pairing a dataset the matcher missed', () => {
    it('seeds a fresh dataset as a proposed link', async () => {
      const { env } = setupEnv()
      const id = await seedEventWithLink(env) // links DS_0 only
      const res = await reviewPost(ctx({ env, id, body: { addDatasetIds: [DS_1] } }))
      expect(res.status).toBe(200)

      const links = await listLinksForEvent(env.CATALOG_DB, id)
      const added = links.find(l => l.dataset_id === DS_1)
      expect(added).toBeTruthy()
      expect(added!.status).toBe('proposed')
      expect(added!.match_score).toBeNull() // manual add carries no auto score
    })

    it('does not clobber an already-linked dataset\'s matcher score', async () => {
      const { env } = setupEnv()
      const id = await seedEventWithLink(env) // DS_0 @ score 0.9
      await reviewPost(ctx({ env, id, body: { addDatasetIds: [DS_0] } }))
      const links = await listLinksForEvent(env.CATALOG_DB, id)
      expect(links.find(l => l.dataset_id === DS_0)!.match_score).toBe(0.9)
    })

    it('drops a hidden dataset (never creates a dangling link)', async () => {
      const { sqlite, env } = setupEnv()
      sqlite.prepare(`UPDATE datasets SET is_hidden = 1 WHERE id = ?`).run(DS_1)
      const id = await seedEventWithLink(env)
      await reviewPost(ctx({ env, id, body: { addDatasetIds: [DS_1] } }))
      const links = await listLinksForEvent(env.CATALOG_DB, id)
      expect(links.some(l => l.dataset_id === DS_1)).toBe(false)
    })

    it('add + approve in one submit', async () => {
      const { env } = setupEnv()
      const id = await seedEventWithLink(env)
      const res = await reviewPost(
        ctx({ env, id, body: { addDatasetIds: [DS_1], links: [{ datasetId: DS_1, decision: 'approve' }] } }),
      )
      expect(res.status).toBe(200)
      const links = await listLinksForEvent(env.CATALOG_DB, id)
      expect(links.find(l => l.dataset_id === DS_1)!.status).toBe('approved')
    })

  describe('edits — curator metadata override (slice C)', () => {
    async function seedInferredEvent(env: { CATALOG_DB: D1Database }) {
      return (
        await insertCurrentEvent(env.CATALOG_DB, {
          ...SAMPLE,
          occurredStart: '2026-06-20T00:00:00.000Z',
          geometry: { boundingBox: { n: 60, s: 30, w: -30, e: 40 }, regionName: 'Europe' },
          inferredFields: ['occurredStart', 'geometry'],
        })
      ).id
    }

    it('applies a date + region override, clears the inferred flags, resolves the bbox', async () => {
      const { env } = setupEnv()
      const id = await seedInferredEvent(env)
      const res = await reviewPost(
        ctx({ env, id, body: { edits: { occurredStart: '2026-06-18', regionName: 'Caribbean' } } }),
      )
      expect(res.status).toBe(200)
      const row = await getCurrentEvent(env.CATALOG_DB, id)
      expect(row!.occurred_start).toBe('2026-06-18T00:00:00.000Z')
      expect(row!.region_name).toBe('Caribbean Sea') // canonical name via regions.ts
      expect(row!.bbox_n).not.toBe(60) // bbox replaced, not kept
      expect(row!.inferred_fields).toBeNull() // human values are not AI provenance
    })

    it('editing only the date keeps the geometry inferred flag', async () => {
      const { env } = setupEnv()
      const id = await seedInferredEvent(env)
      await reviewPost(ctx({ env, id, body: { edits: { occurredStart: '2026-06-18' } } }))
      const row = await getCurrentEvent(env.CATALOG_DB, id)
      expect(JSON.parse(row!.inferred_fields!)).toEqual(['geometry'])
      expect(row!.region_name).toBe('Europe')
    })

    it('a point edit pins the spot; point-only keeps the surrounding region', async () => {
      const { env } = setupEnv()
      const id = await seedInferredEvent(env)
      // Point-only: bbox + region preserved, pin added.
      const res = await reviewPost(
        ctx({ env, id, body: { edits: { point: { lat: 37.2, lon: -76.8 } } } }),
      )
      expect(res.status).toBe(200)
      let row = await getCurrentEvent(env.CATALOG_DB, id)
      expect(row!.point_lat).toBe(37.2)
      expect(row!.region_name).toBe('Europe')
      expect(row!.bbox_n).toBe(60)
      // Region edit without a new point clears the stale pin.
      await reviewPost(ctx({ env, id, body: { edits: { regionName: 'Caribbean' } } }))
      row = await getCurrentEvent(env.CATALOG_DB, id)
      expect(row!.point_lat).toBeNull()
      expect(row!.region_name).toBe('Caribbean Sea')
    })

    it('400 for out-of-range coordinates', async () => {
      const { env } = setupEnv()
      const id = await seedInferredEvent(env)
      const res = await reviewPost(ctx({ env, id, body: { edits: { point: { lat: 118, lon: 0 } } } }))
      expect(res.status).toBe(400)
    })

    it('400 for an unresolvable region or unparseable date', async () => {
      const { env } = setupEnv()
      const id = await seedInferredEvent(env)
      const bad = await reviewPost(ctx({ env, id, body: { edits: { regionName: 'Middle Earth' } } }))
      expect(bad.status).toBe(400)
      const badDate = await reviewPost(ctx({ env, id, body: { edits: { occurredStart: 'not a date' } } }))
      expect(badDate.status).toBe(400)
    })

    it('sets the event image from an imageUrl edit without touching date/geometry provenance', async () => {
      const { env } = setupEnv()
      const id = await seedInferredEvent(env)
      const res = await reviewPost(
        ctx({ env, id, body: { edits: { imageUrl: 'https://img.example.org/storm.jpg' } } }),
      )
      expect(res.status).toBe(200)
      const row = await getCurrentEvent(env.CATALOG_DB, id)
      expect(row!.image_url).toBe('https://img.example.org/storm.jpg')
      // Image-only edit: the AI-provenance flags stay — nothing about
      // the date or place was human-corrected.
      expect(JSON.parse(row!.inferred_fields!)).toEqual(['occurredStart', 'geometry'])
      expect(row!.region_name).toBe('Europe')
    })

    it('stores alt text with an image pick; a pick without one clears stale alt', async () => {
      const { env } = setupEnv()
      const id = await seedInferredEvent(env)
      const res = await reviewPost(
        ctx({
          env,
          id,
          body: { edits: { imageUrl: 'https://img.example.org/a.jpg', imageAlt: 'Satellite view of the storm' } },
        }),
      )
      expect(res.status).toBe(200)
      let row = await getCurrentEvent(env.CATALOG_DB, id)
      expect(row!.image_alt).toBe('Satellite view of the storm')

      // A new image without a fresh description must not keep text
      // that described the old one.
      await reviewPost(ctx({ env, id, body: { edits: { imageUrl: 'https://img.example.org/b.jpg' } } }))
      row = await getCurrentEvent(env.CATALOG_DB, id)
      expect(row!.image_url).toBe('https://img.example.org/b.jpg')
      expect(row!.image_alt).toBeNull()

      // Alt-only edit describes the image already in place.
      const altOnly = await reviewPost(ctx({ env, id, body: { edits: { imageAlt: 'A new description' } } }))
      expect(altOnly.status).toBe(200)
      row = await getCurrentEvent(env.CATALOG_DB, id)
      expect(row!.image_url).toBe('https://img.example.org/b.jpg')
      expect(row!.image_alt).toBe('A new description')
    })

    it('accepts a nocookie video embed, rejects any other host, and clears on empty', async () => {
      const { env } = setupEnv()
      const id = await seedInferredEvent(env)
      const embed = 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ'
      const ok = await reviewPost(ctx({ env, id, body: { edits: { videoEmbedUrl: embed } } }))
      expect(ok.status).toBe(200)
      let row = await getCurrentEvent(env.CATALOG_DB, id)
      expect(row!.video_embed_url).toBe(embed)
      // Image untouched — video is an independent field.
      expect(row!.image_url).toBeNull()

      // A watch-page / third-party URL is refused on field edits.videoEmbedUrl.
      const bad = await reviewPost(
        ctx({ env, id, body: { edits: { videoEmbedUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' } } }),
      )
      expect(bad.status).toBe(400)
      expect((await bad.json() as { errors: Array<{ field: string }> }).errors[0].field).toBe('edits.videoEmbedUrl')

      // Empty string clears it.
      await reviewPost(ctx({ env, id, body: { edits: { videoEmbedUrl: '' } } }))
      row = await getCurrentEvent(env.CATALOG_DB, id)
      expect(row!.video_embed_url).toBeNull()
    })

    it('400 for a non-http(s) or oversized imageUrl', async () => {
      const { env } = setupEnv()
      const id = await seedInferredEvent(env)
      const bad = await reviewPost(
        ctx({ env, id, body: { edits: { imageUrl: 'javascript:alert(1)' } } }),
      )
      expect(bad.status).toBe(400)
      const body = (await bad.json()) as { errors: Array<{ field: string }> }
      expect(body.errors[0].field).toBe('edits.imageUrl')
      // Scheme-only strings pass a naive prefix check but are not URLs.
      const hostless = await reviewPost(ctx({ env, id, body: { edits: { imageUrl: 'https://' } } }))
      expect(hostless.status).toBe(400)
      const huge = await reviewPost(
        ctx({ env, id, body: { edits: { imageUrl: `https://img.example.org/${'x'.repeat(2048)}` } } }),
      )
      expect(huge.status).toBe(400)
      const row = await getCurrentEvent(env.CATALOG_DB, id)
      expect(row!.image_url).toBeNull()
    })

    it('records the edits in the audit row and supports edit + approve in one submit', async () => {
      const { sqlite, env } = setupEnv()
      const id = await seedInferredEvent(env)
      const res = await reviewPost(
        ctx({ env, id, body: { event: 'approve', edits: { occurredStart: '2026-06-18' } } }),
      )
      expect(res.status).toBe(200)
      const row = await getCurrentEvent(env.CATALOG_DB, id)
      expect(row!.status).toBe('approved')
      expect(row!.occurred_start).toBe('2026-06-18T00:00:00.000Z')
      const audit = sqlite
        .prepare(`SELECT metadata_json AS m FROM audit_events WHERE action = 'event.reviewed' ORDER BY rowid DESC LIMIT 1`)
        .get() as { m: string }
      expect(JSON.parse(audit.m).edits.occurredStart).toBe('2026-06-18T00:00:00.000Z')
    })
  })

    it('records the added-link count in the audit row', async () => {
      const { sqlite, env } = setupEnv()
      const id = await seedEventWithLink(env)
      await reviewPost(ctx({ env, id, body: { addDatasetIds: [DS_1] } }))
      const row = sqlite
        .prepare(`SELECT metadata_json AS m FROM audit_events WHERE action = 'event.reviewed' ORDER BY rowid DESC LIMIT 1`)
        .get() as { m: string }
      expect(JSON.parse(row.m).added_links).toBe(1)
    })
  })
})
