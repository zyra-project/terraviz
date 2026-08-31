// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Tests for the dock's Media capture helpers — positionless task
 * shapes (rail routing), media-ID minting across reopened drafts,
 * and the hide-latest pairing logic.
 */

import { describe, expect, it } from 'vitest'
import type { TourTaskDef } from '../../types'
import {
  buildEmbedTask,
  normalizeEmbedUrl,
  buildHideLatestMediaTask,
  buildShowImageTask,
  buildShowVideoTask,
  isHttpMediaUrl,
  nextMediaId,
} from './mediaCapture'

describe('nextMediaId', () => {
  it('continues the dock sequence found in an existing draft', () => {
    const tasks: TourTaskDef[] = [
      { showImage: { imageID: 'media2', filename: 'https://x/a.png' } },
      { showImage: { imageID: 'hero-shot', filename: 'https://x/b.png' } },
    ]
    expect(nextMediaId(tasks)).toBe('media3')
    expect(nextMediaId([])).toBe('media1')
  })
})

describe('buildShowImageTask / buildShowVideoTask', () => {
  it('emits positionless params so the player routes to the media rail', () => {
    const task = buildShowImageTask('https://x/a.png', '  A caption ', [])
    expect(task).toEqual({
      showImage: { imageID: 'media1', filename: 'https://x/a.png', caption: 'A caption' },
    })
    // No SOS coordinates anywhere — that's the rail contract.
    expect(JSON.stringify(task)).not.toMatch(/xPct|yPct|widthPct|heightPct/)

    expect(buildShowVideoTask('https://x/clip.mp4')).toEqual({
      showVideo: { filename: 'https://x/clip.mp4' },
    })
  })

  it('omits an empty caption', () => {
    expect(buildShowImageTask('https://x/a.png', '   ', [])).toEqual({
      showImage: { imageID: 'media1', filename: 'https://x/a.png' },
    })
  })
})

describe('isHttpMediaUrl', () => {
  it('accepts http(s) and rejects everything else', () => {
    expect(isHttpMediaUrl('https://x/a.png')).toBe(true)
    expect(isHttpMediaUrl('http://x/a.png')).toBe(true)
    expect(isHttpMediaUrl('javascript:alert(1)')).toBe(false)
    expect(isHttpMediaUrl('not a url')).toBe(false)
  })
})

describe('buildHideLatestMediaTask', () => {
  it('hides the newest still-visible media, respecting existing hides', () => {
    const tasks: TourTaskDef[] = [
      { showImage: { imageID: 'media1', filename: 'https://x/1.png' } },
      { showVideo: { filename: 'https://x/clip.mp4' } },
      { hideVideo: 'https://x/clip.mp4' },
    ]
    // The video is already hidden — the image is the newest survivor.
    expect(buildHideLatestMediaTask(tasks)).toEqual({ hideImage: 'media1' })
  })

  it('returns a hideVideo for the newest visible video', () => {
    const tasks: TourTaskDef[] = [
      { showImage: { imageID: 'media1', filename: 'https://x/1.png' } },
      { showVideo: { filename: 'https://x/clip.mp4' } },
    ]
    expect(buildHideLatestMediaTask(tasks)).toEqual({ hideVideo: 'https://x/clip.mp4' })
  })

  it('honours the empty-string hide-all-videos convention', () => {
    const tasks: TourTaskDef[] = [
      { showVideo: { filename: 'https://x/a.mp4' } },
      { showVideo: { filename: 'https://x/b.mp4' } },
      { hideVideo: '' },
    ]
    expect(buildHideLatestMediaTask(tasks)).toBeNull()
  })

  it('returns null when nothing is visible', () => {
    expect(buildHideLatestMediaTask([])).toBeNull()
    expect(
      buildHideLatestMediaTask([
        { showImage: { imageID: 'media1', filename: 'https://x/1.png' } },
        { hideImage: 'media1' },
      ]),
    ).toBeNull()
  })
})

describe('normalizeEmbedUrl', () => {
  it('rewrites the common YouTube paste forms to the nocookie embed player', () => {
    for (const raw of [
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://youtu.be/dQw4w9WgXcQ',
      'https://www.youtube.com/shorts/dQw4w9WgXcQ',
      'https://www.youtube.com/embed/dQw4w9WgXcQ',
      'https://www.youtube.com/live/dQw4w9WgXcQ',
    ]) {
      expect(normalizeEmbedUrl(raw)).toEqual({
        url: 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
        trusted: true,
      })
    }
  })

  it('rewrites Vimeo page URLs to the player and passes player URLs through', () => {
    expect(normalizeEmbedUrl('https://vimeo.com/123456')).toEqual({
      url: 'https://player.vimeo.com/video/123456',
      trusted: true,
    })
    expect(normalizeEmbedUrl('https://player.vimeo.com/video/123456?h=abc')?.trusted).toBe(true)
  })

  it('passes an arbitrary https page through untrusted (fully sandboxed)', () => {
    expect(normalizeEmbedUrl('https://example.org/explainer')).toEqual({
      url: 'https://example.org/explainer',
      trusted: false,
    })
  })

  it('rejects non-http(s) and unmappable YouTube URLs', () => {
    expect(normalizeEmbedUrl('javascript:alert(1)')).toBeNull()
    expect(normalizeEmbedUrl('not a url')).toBeNull()
    // A YouTube URL with no video id would just render the
    // frame-refusing page — reject up front.
    expect(normalizeEmbedUrl('https://www.youtube.com/@somechannel')).toBeNull()
  })
})

describe('buildEmbedTask', () => {
  it('mints embed IDs past existing ones and sets allowScripts only for trusted players', () => {
    const existing = [{ showPopupHtml: { popupID: 'embed2', url: 'https://x' } }] as TourTaskDef[]
    const yt = buildEmbedTask('https://youtu.be/dQw4w9WgXcQ', existing)!
    expect(yt).toEqual({
      showPopupHtml: {
        popupID: 'embed3',
        url: 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
        allowScripts: true,
      },
    })
    const page = buildEmbedTask('https://example.org/page', [])!
    expect((page as { showPopupHtml: { allowScripts?: boolean } }).showPopupHtml.allowScripts).toBeUndefined()
    expect(buildEmbedTask('ftp://nope', [])).toBeNull()
  })
})

describe('buildHideLatestMediaTask — embeds', () => {
  it('pairs the newest visible embed with hidePopupHtml', () => {
    const tasks = [
      { showImage: { imageID: 'media1', filename: 'https://x/a.png' } },
      { showPopupHtml: { popupID: 'embed1', url: 'https://www.youtube-nocookie.com/embed/abc123' } },
    ] as TourTaskDef[]
    expect(buildHideLatestMediaTask(tasks)).toEqual({ hidePopupHtml: 'embed1' })
    // Once hidden, the image is the newest survivor again.
    expect(buildHideLatestMediaTask([...tasks, { hidePopupHtml: 'embed1' } as TourTaskDef])).toEqual({
      hideImage: 'media1',
    })
  })
})
