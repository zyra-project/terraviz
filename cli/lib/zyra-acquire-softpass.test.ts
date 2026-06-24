/**
 * Tests for `cli/lib/zyra-acquire-softpass.ts` — the soft-pass
 * decision for a transient NOAA-FTP `acquire` failure.
 *
 * Coverage:
 *   - `classifyZyraFailure`: matches FTP/network transients, rejects
 *     compose/code failures (the conservative default).
 *   - `assessBundleFreshness`: published vs never-published, fresh vs
 *     stale, unparseable end_time → treated fresh.
 *   - `decideAcquireSoftPass`: soft-pass requires BOTH a transient
 *     acquire failure AND a fresh published bundle; everything else
 *     escalates.
 */

import { describe, expect, it } from 'vitest'
import {
  assessBundleFreshness,
  classifyZyraFailure,
  decideAcquireSoftPass,
  hasPublishedBundle,
} from './zyra-acquire-softpass'

describe('classifyZyraFailure', () => {
  it('matches FTP-connector specifics', () => {
    const log = [
      'INFO acquire ftp ...',
      'Traceback (most recent call last):',
      '  File "/usr/lib/python/zyra/connectors/backends/ftp.py", line 88, in sync_directory',
      '    resp = self.ftp.sendcmd(f"MDTM {name}")',
      'ftplib.error_temp: 421 Too many connections',
    ].join('\n')
    const result = classifyZyraFailure(log)
    expect(result.acquireFailure).toBe(true)
    expect(result.signal).toBe('ftplib')
  })

  it('matches a generic network transient WHEN the acquire stage is in context', () => {
    const ctx = (err: string) => `Running stage acquire (ftp)\n${err}`
    expect(classifyZyraFailure(ctx('socket.timeout: timed out')).acquireFailure).toBe(true)
    expect(classifyZyraFailure(ctx('ConnectionResetError: [Errno 104] Connection reset by peer')).acquireFailure).toBe(
      true,
    )
    expect(classifyZyraFailure(ctx('OSError: [Errno 101] Network is unreachable')).acquireFailure).toBe(true)
    expect(
      classifyZyraFailure(ctx('socket.gaierror: [Errno -3] Temporary failure in name resolution')).acquireFailure,
    ).toBe(true)
  })

  it('does NOT soft-pass a generic network error with NO acquire context (e.g. pip install)', () => {
    // The in-container `pip install pillow` step runs BEFORE `zyra run`
    // and logs the pad-missing stage, not acquire — a network blip there
    // must escalate, not soft-pass.
    const pip = 'Installing Pillow for the pad-missing stage...\nTimeoutError: timed out fetching pillow==12.2.0'
    expect(classifyZyraFailure(pip).acquireFailure).toBe(false)
  })

  it('does NOT match a compose-video / code failure (escalates)', () => {
    const ffmpeg = [
      'Running stage visualize (compose-video)',
      'ffmpeg version 4.4.2',
      '[libx264 @ 0x...] error: could not open encoder',
      'Stage compose-video failed with exit code 1',
    ].join('\n')
    const result = classifyZyraFailure(ffmpeg)
    expect(result.acquireFailure).toBe(false)
    expect(result.signal).toBeNull()
  })

  it('does NOT match an empty / unreadable log', () => {
    expect(classifyZyraFailure('').acquireFailure).toBe(false)
  })
})

describe('hasPublishedBundle', () => {
  it('is true for any non-empty data_ref, false for null/empty', () => {
    expect(hasPublishedBundle('r2:videos/DS/UP/master.m3u8')).toBe(true)
    expect(hasPublishedBundle('vimeo:123')).toBe(true)
    expect(hasPublishedBundle(null)).toBe(false)
    expect(hasPublishedBundle(undefined)).toBe(false)
    expect(hasPublishedBundle('   ')).toBe(false)
  })
})

describe('assessBundleFreshness', () => {
  const NOW = Date.parse('2026-06-24T00:00:00Z')
  const STALE_AFTER = 172_800 // 2 days

  it('reports not-published when data_ref is missing', () => {
    const r = assessBundleFreshness({ dataRef: null, endTime: null, nowMs: NOW, staleAfterSeconds: STALE_AFTER })
    expect(r.published).toBe(false)
    expect(r.stale).toBe(true)
  })

  it('is fresh when the trailing edge is within the threshold', () => {
    const endTime = '2026-06-23T23:30:00Z' // 30 min old
    const r = assessBundleFreshness({
      dataRef: 'r2:videos/DS/UP/master.m3u8',
      endTime,
      nowMs: NOW,
      staleAfterSeconds: STALE_AFTER,
    })
    expect(r.published).toBe(true)
    expect(r.stale).toBe(false)
    expect(r.ageSeconds).toBe(1800)
  })

  it('is stale when the trailing edge is older than the threshold', () => {
    const endTime = '2026-06-21T00:00:00Z' // 3 days old
    const r = assessBundleFreshness({
      dataRef: 'r2:videos/DS/UP/master.m3u8',
      endTime,
      nowMs: NOW,
      staleAfterSeconds: STALE_AFTER,
    })
    expect(r.published).toBe(true)
    expect(r.stale).toBe(true)
    expect(r.ageSeconds).toBe(3 * 86_400)
  })

  it('falls back to updated_at when end_time is null — fresh', () => {
    const r = assessBundleFreshness({
      dataRef: 'r2:videos/DS/UP/master.m3u8',
      endTime: null,
      updatedAt: '2026-06-23T23:30:00Z', // 30 min old
      nowMs: NOW,
      staleAfterSeconds: STALE_AFTER,
    })
    expect(r.published).toBe(true)
    expect(r.stale).toBe(false)
    expect(r.ageSeconds).toBe(1800)
    expect(r.detail).toMatch(/updated_at/)
  })

  it('falls back to updated_at when end_time is null — stale escalates (sustained outage)', () => {
    const r = assessBundleFreshness({
      dataRef: 'r2:videos/DS/UP/master.m3u8',
      endTime: null,
      updatedAt: '2026-06-21T00:00:00Z', // 3 days old
      nowMs: NOW,
      staleAfterSeconds: STALE_AFTER,
    })
    expect(r.published).toBe(true)
    expect(r.stale).toBe(true)
    expect(r.ageSeconds).toBe(3 * 86_400)
  })

  it('prefers end_time over updated_at when both are present', () => {
    const r = assessBundleFreshness({
      dataRef: 'r2:videos/DS/UP/master.m3u8',
      endTime: '2026-06-23T23:00:00Z', // 1h old — the trailing edge
      updatedAt: '2026-06-20T00:00:00Z', // 4 days old — ignored
      nowMs: NOW,
      staleAfterSeconds: STALE_AFTER,
    })
    expect(r.stale).toBe(false)
    expect(r.ageSeconds).toBe(3600)
    expect(r.detail).toMatch(/end_time/)
  })

  it('treats both timestamps unparseable as fresh (no escalation on a pure unknown)', () => {
    const r = assessBundleFreshness({
      dataRef: 'r2:videos/DS/UP/master.m3u8',
      endTime: 'not-a-date',
      updatedAt: null,
      nowMs: NOW,
      staleAfterSeconds: STALE_AFTER,
    })
    expect(r.published).toBe(true)
    expect(r.stale).toBe(false)
    expect(r.ageSeconds).toBeNull()
  })
})

describe('decideAcquireSoftPass', () => {
  const fresh = { published: true, stale: false, ageSeconds: 1800, detail: 'fresh' }
  const stale = { published: true, stale: true, ageSeconds: 300_000, detail: 'stale' }
  const unpublished = { published: false, stale: true, ageSeconds: null, detail: 'no bundle' }
  const acquire = { acquireFailure: true, signal: 'ftplib' }
  const other = { acquireFailure: false, signal: null }

  it('soft-passes a transient acquire failure with a fresh published bundle', () => {
    const d = decideAcquireSoftPass({ classification: acquire, freshness: fresh })
    expect(d.softPass).toBe(true)
    expect(d.reason).toMatch(/soft-passing/)
  })

  it('escalates when the failure is not an acquire transient', () => {
    expect(decideAcquireSoftPass({ classification: other, freshness: fresh }).softPass).toBe(false)
  })

  it('escalates a transient acquire failure when the bundle was never published', () => {
    const d = decideAcquireSoftPass({ classification: acquire, freshness: unpublished })
    expect(d.softPass).toBe(false)
    expect(d.reason).toMatch(/nothing to fall back to/)
  })

  it('escalates a transient acquire failure when the bundle is stale (sustained outage)', () => {
    const d = decideAcquireSoftPass({ classification: acquire, freshness: stale })
    expect(d.softPass).toBe(false)
    expect(d.reason).toMatch(/sustained outage/)
  })
})
