/**
 * Unit tests for the pure event→tour generator (`event-tour.ts`).
 *
 * Coverage: fly-target derivation (point, bbox, antimeridian-wrapping
 * bbox, no geometry), the deterministic template captions, the task
 * sequence `buildEventTourTasks` emits (intro overlay, per-stop
 * load/setTime/animation/caption, the setTime-only-when-dated rule,
 * the stop cap), and `generateTourCaptions`' AI path + its
 * fall-back-to-templates failure modes.
 */

import { describe, expect, it, vi } from 'vitest'
import {
  buildEventTourTasks,
  buildTemplateCaptions,
  eventFlyTarget,
  generateTourCaptions,
  MAX_CAPTION_CHARS,
  MAX_TOUR_STOPS,
  type EventTourDataset,
  type EventTourEvent,
} from './event-tour'
import type { EnrichEnv } from './events-enrich'

function makeEvent(overrides: Partial<EventTourEvent> = {}): EventTourEvent {
  return {
    title: 'Hurricane Delta strengthens',
    summary: 'Delta reached category 3 overnight.',
    source_name: 'NOAA',
    occurred_start: '2026-06-25T12:00:00.000Z',
    image_url: null,
    bbox_n: null,
    bbox_s: null,
    bbox_w: null,
    bbox_e: null,
    point_lat: null,
    point_lon: null,
    region_name: null,
    ...overrides,
  }
}

function makeDataset(id: string, title = `Dataset ${id}`): EventTourDataset {
  return { id, title, startTime: '2026-06-01T00:00:00Z', endTime: null, format: 'video/mp4', thumbnailUrl: null }
}

describe('eventFlyTarget', () => {
  it('prefers the point with a regional close-up altitude', () => {
    const target = eventFlyTarget(
      makeEvent({ point_lat: 25.5, point_lon: -80.2, bbox_n: 30, bbox_s: 20, bbox_w: -85, bbox_e: -75 }),
    )
    expect(target).toEqual({ lat: 25.5, lon: -80.2, altmi: 1200 })
  })

  it('frames a bbox at its midpoint with span-scaled altitude', () => {
    const target = eventFlyTarget(makeEvent({ bbox_n: 30, bbox_s: 20, bbox_w: -90, bbox_e: -70 }))
    expect(target?.lat).toBe(25)
    expect(target?.lon).toBe(-80)
    // 20° span × 69 mi × 1.4 headroom = 1932.
    expect(target?.altmi).toBe(1932)
  })

  it('clamps tiny and huge bboxes into the regional-to-continental band', () => {
    const tiny = eventFlyTarget(makeEvent({ bbox_n: 10.1, bbox_s: 10, bbox_w: 20, bbox_e: 20.1 }))
    expect(tiny?.altmi).toBe(600)
    const huge = eventFlyTarget(makeEvent({ bbox_n: 80, bbox_s: -80, bbox_w: -179, bbox_e: 179 }))
    expect(huge?.altmi).toBe(6000)
  })

  it('handles an antimeridian-wrapping bbox (w > e)', () => {
    const target = eventFlyTarget(makeEvent({ bbox_n: 10, bbox_s: -10, bbox_w: 170, bbox_e: -170 }))
    // 20° of longitude centred on the dateline (±180 are the same meridian).
    expect(Math.abs(target?.lon ?? 0)).toBe(180)
    expect(target?.lat).toBe(0)
  })

  it('returns null when the event carries no usable geometry', () => {
    expect(eventFlyTarget(makeEvent({ region_name: 'Caribbean Sea' }))).toBeNull()
  })
})

describe('buildTemplateCaptions', () => {
  it('composes the intro from title, region, date, and source', () => {
    const captions = buildTemplateCaptions(makeEvent({ region_name: 'Gulf of Mexico' }), [makeDataset('DS1')])
    expect(captions.intro).toContain('Hurricane Delta strengthens')
    expect(captions.intro).toContain('Gulf of Mexico')
    expect(captions.intro).toContain('2026-06-25')
    expect(captions.intro).toContain('NOAA')
    expect(captions.stops.DS1).toContain('Dataset DS1')
  })

  it('omits the date clause when occurred_start is unset', () => {
    const captions = buildTemplateCaptions(makeEvent({ occurred_start: null }), [])
    expect(captions.intro).not.toContain('Reported')
    expect(captions.intro).toContain('Source: NOAA')
  })

  it('caps the intro at the overlay budget', () => {
    const captions = buildTemplateCaptions(makeEvent({ title: 'x'.repeat(400) }), [])
    expect(captions.intro.length).toBeLessThanOrEqual(MAX_CAPTION_CHARS)
  })
})

describe('buildEventTourTasks', () => {
  const captions = { intro: 'Intro caption', stops: { DS1: 'Stop one', DS2: 'Stop two' } }

  it('emits flyTo → intro overlay → per-dataset stops with setTime', () => {
    const tasks = buildEventTourTasks(
      makeEvent({ point_lat: 25, point_lon: -80 }),
      [makeDataset('DS1'), makeDataset('DS2')],
      captions,
    )
    const keys = tasks.map(t => Object.keys(t)[0])
    expect(keys).toEqual([
      'flyTo',
      'showRect', 'pauseSeconds', 'hideRect',
      'loadDataset', 'setTime', 'datasetAnimation', 'showRect', 'pauseSeconds', 'hideRect',
      'loadDataset', 'setTime', 'datasetAnimation', 'showRect', 'pauseSeconds', 'hideRect',
    ])
    const flyTo = (tasks[0] as { flyTo: { lat: number; lon: number } }).flyTo
    expect(flyTo.lat).toBe(25)
    const intro = (tasks[1] as { showRect: { caption: string; rectID: string } }).showRect
    expect(intro.caption).toBe('Intro caption')
    expect(intro.rectID).toBe('event-intro')
    const setTime = (tasks[5] as { setTime: { time: string } }).setTime
    expect(setTime.time).toBe('2026-06-25T12:00:00.000Z')
    const stopCaption = (tasks[7] as { showRect: { caption: string } }).showRect
    expect(stopCaption.caption).toBe('Stop one')
  })

  it('skips flyTo and setTime when the event has no geometry or date', () => {
    const tasks = buildEventTourTasks(makeEvent({ occurred_start: null }), [makeDataset('DS1')], captions)
    const keys = tasks.map(t => Object.keys(t)[0])
    expect(keys).not.toContain('flyTo')
    expect(keys).not.toContain('setTime')
    expect(keys).toContain('loadDataset')
  })

  it('shows the first available dataset thumbnail as a positionless intro media card', () => {
    const withThumb = { ...makeDataset('DS2'), thumbnailUrl: 'https://assets.example.org/ds2-thumb.png' }
    const tasks = buildEventTourTasks(
      makeEvent({ point_lat: 25, point_lon: -80 }),
      [makeDataset('DS1'), withThumb],
      captions,
    )
    const keys = tasks.map(t => Object.keys(t)[0])
    // The media card rides with the intro caption and is hidden
    // before the first dataset takes the globe.
    expect(keys.slice(0, 6)).toEqual(['flyTo', 'showRect', 'showImage', 'pauseSeconds', 'hideRect', 'hideImage'])
    const show = tasks.find(t => 'showImage' in t) as unknown as { showImage: Record<string, unknown> }
    expect(show.showImage).toEqual({
      imageID: 'event-intro-media',
      filename: 'https://assets.example.org/ds2-thumb.png',
      caption: withThumb.title,
    })
    // Positionless → the player's media rail, never a coordinate box.
    expect(JSON.stringify(show)).not.toMatch(/xPct|yPct|widthPct|heightPct/)
    expect(tasks.find(t => 'hideImage' in t)).toEqual({ hideImage: 'event-intro-media' })
  })

  it("prefers the event's own story image over a dataset thumbnail, cited", () => {
    const withThumb = { ...makeDataset('DS2'), thumbnailUrl: 'https://assets.example.org/ds2-thumb.png' }
    const tasks = buildEventTourTasks(
      makeEvent({ image_url: 'https://img.ex/story.jpg' }),
      [withThumb],
      captions,
    )
    const show = tasks.find(t => 'showImage' in t) as unknown as { showImage: Record<string, unknown> }
    expect(show.showImage).toEqual({
      imageID: 'event-intro-media',
      filename: 'https://img.ex/story.jpg',
      // The story image carries the citation, not the dataset title.
      caption: 'Hurricane Delta strengthens — NOAA',
    })
    // A non-http(s) stored value must fall back to the thumbnail.
    const fallback = buildEventTourTasks(
      makeEvent({ image_url: 'javascript:alert(1)' }),
      [withThumb],
      captions,
    ).find(t => 'showImage' in t) as unknown as { showImage: Record<string, unknown> }
    expect(fallback.showImage.filename).toBe('https://assets.example.org/ds2-thumb.png')
  })

  it('emits no media tasks when no stop has a thumbnail', () => {
    const tasks = buildEventTourTasks(makeEvent(), [makeDataset('DS1')], captions)
    const keys = tasks.map(t => Object.keys(t)[0])
    expect(keys).not.toContain('showImage')
    expect(keys).not.toContain('hideImage')
  })

  it('caps the stops at MAX_TOUR_STOPS and falls back per-stop for missing captions', () => {
    const datasets = Array.from({ length: MAX_TOUR_STOPS + 2 }, (_, i) => makeDataset(`DS${i}`))
    const tasks = buildEventTourTasks(makeEvent(), datasets, { intro: 'i', stops: {} })
    const loads = tasks.filter(t => 'loadDataset' in t)
    expect(loads).toHaveLength(MAX_TOUR_STOPS)
    const firstStop = tasks.find(t => 'showRect' in t && (t as { showRect: { rectID: string } }).showRect.rectID === 'event-stop-1')
    expect((firstStop as { showRect: { caption: string } }).showRect.caption).toContain('Dataset DS0')
  })
})

describe('generateTourCaptions', () => {
  const event = makeEvent()
  const datasets = [makeDataset('DS1'), makeDataset('DS2')]

  it('returns templates when no AI binding exists', async () => {
    const out = await generateTourCaptions({} as EnrichEnv, event, datasets)
    expect(out).toEqual(buildTemplateCaptions(event, datasets))
  })

  it('uses the model output, honouring the scout choices[] envelope', async () => {
    const run = vi.fn(async () => ({
      choices: [
        {
          message: {
            content: JSON.stringify({
              intro: 'AI intro about Delta.',
              stops: [{ id: 'DS1', caption: 'AI stop one.' }],
            }),
          },
        },
      ],
    }))
    const env = { AI: { run } } as unknown as EnrichEnv
    const out = await generateTourCaptions(env, event, datasets)
    expect(out.intro).toBe('AI intro about Delta.')
    expect(out.stops.DS1).toBe('AI stop one.')
    // DS2 omitted by the model → per-stop template fallback.
    expect(out.stops.DS2).toContain('Dataset DS2')
    expect(run).toHaveBeenCalledOnce()
  })

  it('ignores model captions for ids it was never given', async () => {
    const run = vi.fn(async () => ({
      response: JSON.stringify({ intro: 'ok', stops: [{ id: 'HALLUCINATED', caption: 'nope' }] }),
    }))
    const env = { AI: { run } } as unknown as EnrichEnv
    const out = await generateTourCaptions(env, event, datasets)
    expect(out.stops).not.toHaveProperty('HALLUCINATED')
  })

  it('truncates overlong model captions to the overlay budget', async () => {
    const run = vi.fn(async () => ({
      response: JSON.stringify({ intro: 'y'.repeat(500), stops: [{ id: 'DS1', caption: 'z'.repeat(500) }] }),
    }))
    const env = { AI: { run } } as unknown as EnrichEnv
    const out = await generateTourCaptions(env, event, datasets)
    expect(out.intro.length).toBe(MAX_CAPTION_CHARS)
    expect(out.stops.DS1.length).toBe(MAX_CAPTION_CHARS)
  })

  it('falls back to templates on unparseable output and on a thrown model error', async () => {
    const fallback = buildTemplateCaptions(event, datasets)
    const garbled = { AI: { run: vi.fn(async () => ({ response: 'not json at all' })) } } as unknown as EnrichEnv
    expect(await generateTourCaptions(garbled, event, datasets)).toEqual(fallback)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const throwing = { AI: { run: vi.fn(async () => { throw new Error('model down') }) } } as unknown as EnrichEnv
    expect(await generateTourCaptions(throwing, event, datasets)).toEqual(fallback)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('passes the configured model override through to AI.run', async () => {
    const run = vi.fn(async (_model: string, _opts?: unknown) => ({ response: '{}' }))
    const env = { AI: { run }, EVENTS_ENRICH_MODEL: '@cf/custom/model' } as unknown as EnrichEnv
    await generateTourCaptions(env, event, datasets)
    expect(run.mock.calls[0]?.[0]).toBe('@cf/custom/model')
  })
})
