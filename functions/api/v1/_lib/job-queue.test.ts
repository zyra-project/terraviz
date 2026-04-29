/**
 * Tests for the job-queue interface implementations.
 *
 * Coverage:
 *   - SyncJobQueue runs handlers inline and records the call.
 *   - CapturingJobQueue records but does NOT run.
 *   - WaitUntilJobQueue forwards the handler promise to the
 *     supplied `waitUntil` and swallows errors via console.error
 *     so a failing background job does not surface to the
 *     originating request.
 */

import { describe, expect, it, vi } from 'vitest'
import {
  CapturingJobQueue,
  SyncJobQueue,
  WaitUntilJobQueue,
} from './job-queue'

describe('SyncJobQueue', () => {
  it('runs the handler with the provided env + payload and records the call', async () => {
    const env = { tag: 'env' }
    const queue = new SyncJobQueue(env)
    const seen: Array<{ env: unknown; payload: unknown }> = []
    await queue.enqueue('test', async (envIn, payload) => {
      seen.push({ env: envIn, payload })
    }, { tag: 'payload' })
    expect(seen).toEqual([{ env: { tag: 'env' }, payload: { tag: 'payload' } }])
    expect(queue.records).toEqual([{ name: 'test', payload: { tag: 'payload' } }])
  })

  it('propagates handler errors so test assertions can catch them', async () => {
    const queue = new SyncJobQueue({})
    await expect(
      queue.enqueue('boom', async () => {
        throw new Error('handler failed')
      }, {}),
    ).rejects.toThrow('handler failed')
  })
})

describe('CapturingJobQueue', () => {
  it('records but does not run the handler', async () => {
    const queue = new CapturingJobQueue()
    let ran = false
    await queue.enqueue('test', async () => {
      ran = true
    }, { x: 1 })
    expect(ran).toBe(false)
    expect(queue.records).toEqual([{ name: 'test', payload: { x: 1 } }])
  })
})

describe('WaitUntilJobQueue', () => {
  it('forwards the handler promise to waitUntil', async () => {
    const seen: Array<unknown> = []
    const waitUntil = vi.fn((p: Promise<unknown>) => {
      seen.push(p)
    })
    const queue = new WaitUntilJobQueue({ env: 'x' }, waitUntil)
    const handler = vi.fn(async (_env: unknown, _p: unknown) => {})
    await queue.enqueue('ok', handler, { foo: 'bar' })
    expect(waitUntil).toHaveBeenCalledOnce()
    expect(seen[0]).toBeInstanceOf(Promise)
    // Drain the promise so the handler resolves.
    await seen[0]
    expect(handler).toHaveBeenCalledWith({ env: 'x' }, { foo: 'bar' })
  })

  it('swallows handler errors via console.error so the request is not affected', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const seen: Promise<unknown>[] = []
    const waitUntil = vi.fn((p: Promise<unknown>) => seen.push(p))
    const queue = new WaitUntilJobQueue({}, waitUntil)
    await queue.enqueue('explode', async () => {
      throw new Error('background failure')
    }, {})
    // Awaiting the inner promise must not reject — the queue caught
    // the error and logged it.
    await expect(seen[0]).resolves.not.toThrow()
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('explode'),
      expect.any(Error),
    )
    errSpy.mockRestore()
  })
})
