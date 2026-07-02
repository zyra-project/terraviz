/**
 * Unit tests for the slice-C AI date/location enrichment.
 *
 * The Workers AI binding is stubbed with canned JSON replies, so these
 * exercise the module's real job: only filling missing fields, gating
 * on confidence, constraining places to the regions.ts vocabulary,
 * validating extracted dates against the publish anchor, and never
 * throwing on garbage model output.
 */

import { describe, expect, it, vi } from 'vitest'
import {
  buildEnrichPrompt,
  enrichEventFields,
  extractJsonObject,
  extractModelText,
  isPlausibleDate,
  MIN_CONFIDENCE,
} from './events-enrich'

function aiStub(reply: unknown) {
  const run = vi.fn(async () => (typeof reply === 'string' ? { response: reply } : reply))
  return { env: { AI: { run } }, run }
}

const PLAIN_NEWS = {
  title: 'Flooding displaces thousands across the river basin',
  summary: 'Days of heavy rain pushed rivers past record levels on Tuesday, officials said.',
  publishedAt: '2026-06-25T09:00:00.000Z',
  occurredStart: null,
  geometry: {},
}

describe('enrichEventFields', () => {
  it('fills a missing date + place, records provenance, resolves the region bbox', async () => {
    const { env, run } = aiStub(
      JSON.stringify({ date: '2026-06-23', place: 'Southeast Asia', confidence: 0.9 }),
    )
    const out = await enrichEventFields(env, PLAIN_NEWS)
    expect(out).not.toBeNull()
    expect(out!.inferred.sort()).toEqual(['geometry', 'occurredStart'])
    expect(out!.occurredStart).toBe('2026-06-23T00:00:00.000Z')
    // The place resolves through regions.ts into a real bounding box the
    // matcher's geo signal can score against.
    expect(out!.geometry?.regionName).toBe('Southeast Asia')
    expect(out!.geometry?.boundingBox).toBeDefined()
    expect(run).toHaveBeenCalledOnce()
  })

  it('returns null and skips the model when nothing is missing or AI is unbound', async () => {
    const { env, run } = aiStub('{}')
    const complete = {
      ...PLAIN_NEWS,
      occurredStart: '2026-06-20T00:00:00.000Z',
      geometry: { point: { lat: 1, lon: 2 } },
    }
    expect(await enrichEventFields(env, complete)).toBeNull()
    expect(run).not.toHaveBeenCalled()
    expect(await enrichEventFields({}, PLAIN_NEWS)).toBeNull()
  })

  it('drops a low-confidence extraction entirely', async () => {
    const { env } = aiStub(
      JSON.stringify({ date: '2026-06-23', place: 'Europe', confidence: MIN_CONFIDENCE - 0.1 }),
    )
    expect(await enrichEventFields(env, PLAIN_NEWS)).toBeNull()
  })

  it('drops an unresolvable place but keeps a valid date', async () => {
    const { env } = aiStub(
      JSON.stringify({ date: '2026-06-23', place: 'Middle Earth', confidence: 0.95 }),
    )
    const out = await enrichEventFields(env, PLAIN_NEWS)
    expect(out!.inferred).toEqual(['occurredStart'])
    expect(out!.geometry).toBeUndefined()
  })

  it('never fills a field the source provided', async () => {
    const { env } = aiStub(
      JSON.stringify({ date: '2026-06-23', place: 'Europe', confidence: 0.95 }),
    )
    const withDate = { ...PLAIN_NEWS, occurredStart: '2026-06-01T00:00:00.000Z' }
    const out = await enrichEventFields(env, withDate)
    expect(out!.inferred).toEqual(['geometry'])
    expect(out!.occurredStart).toBeUndefined()
  })

  it('returns null on garbage output, model errors, and post-publish dates', async () => {
    expect(await enrichEventFields(aiStub('not json at all').env, PLAIN_NEWS)).toBeNull()
    expect(await enrichEventFields(aiStub({ response: '' }).env, PLAIN_NEWS)).toBeNull()
    const throwing = { AI: { run: vi.fn(async () => { throw new Error('model exploded') }) } }
    expect(await enrichEventFields(throwing, PLAIN_NEWS)).toBeNull()
    // An extracted "occurred" date more than a day after publication is
    // implausible for a news report and is discarded.
    const future = aiStub(JSON.stringify({ date: '2026-07-15', place: null, confidence: 0.9 }))
    expect(await enrichEventFields(future.env, PLAIN_NEWS)).toBeNull()
  })
})

describe('extractJsonObject', () => {
  it('unwraps prose / code-fence around the JSON', () => {
    expect(extractJsonObject('Sure! ```json\n{"date": null}\n```')).toEqual({ date: null })
    expect(extractJsonObject('nope')).toBeNull()
    expect(extractJsonObject('[1,2]')).toBeNull()
  })
})

describe('isPlausibleDate', () => {
  it('accepts a day at or just after the anchor, rejects far-future and garbage', () => {
    expect(isPlausibleDate('2026-06-25', '2026-06-25T09:00:00.000Z')).toBe(true)
    expect(isPlausibleDate('2026-06-27', '2026-06-25T09:00:00.000Z')).toBe(false)
    expect(isPlausibleDate('1815-06-18', null)).toBe(false)
    expect(isPlausibleDate('not a date', null)).toBe(false)
  })

  it('anchors to now when there is no publish date — far-future rejected, recent past kept', () => {
    expect(isPlausibleDate('2100-01-01', null)).toBe(false)
    expect(isPlausibleDate('2100-01-01', 'not a date either')).toBe(false)
    const lastWeek = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
    expect(isPlausibleDate(lastWeek, null)).toBe(true)
  })
})

describe('buildEnrichPrompt', () => {
  it('anchors relative dates to the publish date and lists the region vocabulary', () => {
    const { system, user } = buildEnrichPrompt(PLAIN_NEWS)
    expect(user).toContain('Published: 2026-06-25T09:00:00.000Z')
    expect(user).toContain(PLAIN_NEWS.title)
    expect(system).toContain('Southeast Asia')
    expect(system).toContain('null')
  })
})

describe('model selection', () => {
  it('uses the env override when set, the known-alive default otherwise', async () => {
    const calls: string[] = []
    const run = async (model: string) => {
      calls.push(model)
      return { response: JSON.stringify({ date: '2026-06-23', place: null, confidence: 0.9 }) }
    }
    await enrichEventFields({ AI: { run } }, PLAIN_NEWS)
    await enrichEventFields({ AI: { run }, EVENTS_ENRICH_MODEL: '@cf/example/newer-model' }, PLAIN_NEWS)
    expect(calls).toEqual(['@cf/meta/llama-4-scout-17b-16e-instruct', '@cf/example/newer-model'])
  })
})

describe('extractModelText', () => {
  const EXTRACT = JSON.stringify({ date: '2026-06-23', place: 'Europe', confidence: 0.9 })

  it('accepts every known Workers AI reply envelope', async () => {
    // Classic { response: string }, JSON-mode { response: object },
    // OpenAI-compatible choices (llama-4-scout, observed live), and
    // bare output_text — all must enrich identically.
    const shapes: unknown[] = [
      { response: EXTRACT },
      { response: { date: '2026-06-23', place: 'Europe', confidence: 0.9 } },
      { choices: [{ message: { role: 'assistant', content: EXTRACT } }] },
      { output_text: EXTRACT },
    ]
    for (const shape of shapes) {
      const out = await enrichEventFields({ AI: { run: async () => shape } }, PLAIN_NEWS)
      expect(out?.occurredStart, JSON.stringify(shape).slice(0, 60)).toBe('2026-06-23T00:00:00.000Z')
      expect(out?.geometry?.regionName).toBe('Europe')
    }
  })

  it('returns null for unrecognised shapes', () => {
    expect(extractModelText(undefined)).toBeNull()
    expect(extractModelText({ something: 'else' })).toBeNull()
    expect(extractModelText({ choices: [] })).toBeNull()
    expect(extractModelText({ response: '' })).toBeNull()
  })
})
