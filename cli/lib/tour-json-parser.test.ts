// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Tests for `cli/lib/tour-json-parser.ts` (Phase 3c commit A).
 *
 * The parser is pure / deterministic / no-I/O, so it gets fed
 * raw tour-file objects and asserted on the classification +
 * source-position output it produces.
 */

import { describe, expect, it } from 'vitest'
import {
  classifyAssetUrl,
  parseTourFile,
  siblingKeyForRelativeAsset,
} from './tour-json-parser'

describe('classifyAssetUrl', () => {
  it('treats bare filenames as relative', () => {
    expect(classifyAssetUrl('audio.mp3')).toBe('relative')
    expect(classifyAssetUrl('overlays/title.png')).toBe('relative')
    expect(classifyAssetUrl('../sibling/x.jpg')).toBe('relative')
  })

  it('treats empty / whitespace as relative (caller filters before fetching)', () => {
    expect(classifyAssetUrl('')).toBe('relative')
    expect(classifyAssetUrl('   ')).toBe('relative')
  })

  it('classifies absolute URLs on SOS CDN hosts', () => {
    expect(classifyAssetUrl('https://d3sik7mbbzunjo.cloudfront.net/extras/foo/audio.mp3'))
      .toBe('absolute_sos_cdn')
    expect(classifyAssetUrl('https://s3.amazonaws.com/metadata.sosexplorer.gov/x.png'))
      .toBe('absolute_sos_cdn')
  })

  it('classifies non-SOS absolute URLs as external', () => {
    expect(classifyAssetUrl('https://www.youtube.com/embed/abc123')).toBe('absolute_external')
    expect(classifyAssetUrl('https://en.wikipedia.org/wiki/El_Niño')).toBe('absolute_external')
    expect(classifyAssetUrl('https://sos.noaa.gov/Datasets/dataset.html?id=42')).toBe(
      'absolute_external',
    )
  })

  it('classifies mailto: / data: URIs as external (not relative)', () => {
    // These parse as standalone URLs (no base needed), so per the
    // policy they're external rather than relative.
    expect(classifyAssetUrl('mailto:contact@example.org')).toBe('absolute_external')
    expect(classifyAssetUrl('data:image/png;base64,iVBOR=')).toBe('absolute_external')
  })
})

describe('parseTourFile — happy path', () => {
  it('returns an empty result for an empty tour', () => {
    expect(parseTourFile({ tourTasks: [] })).toEqual({ assets: [], unknownTasks: [] })
  })

  it('captures playAudio filename', () => {
    const tour = {
      tourTasks: [
        { playAudio: { filename: 'audio/intro.mp3', asynchronous: false } },
      ],
    }
    const r = parseTourFile(tour)
    expect(r.assets).toEqual([
      {
        rawValue: 'audio/intro.mp3',
        source: { taskIndex: 0, taskName: 'playAudio', field: 'filename' },
        kind: 'relative',
      },
    ])
    expect(r.unknownTasks).toEqual([])
  })

  it('captures both question images', () => {
    const tour = {
      tourTasks: [
        {
          question: {
            id: 'q1',
            imgQuestionFilename: 'q.png',
            numberOfAnswers: 4,
            correctAnswerIndex: 1,
            imgAnswerFilename: 'a.png',
          },
        },
      ],
    }
    const r = parseTourFile(tour)
    expect(r.assets).toHaveLength(2)
    expect(r.assets.map(a => a.rawValue).sort()).toEqual(['a.png', 'q.png'])
    expect(r.assets.map(a => a.source.field).sort()).toEqual([
      'imgAnswerFilename',
      'imgQuestionFilename',
    ])
  })

  it('captures showPopupHtml.url and classifies external links', () => {
    const tour = {
      tourTasks: [
        { showPopupHtml: { popupID: 'p1', url: 'https://en.wikipedia.org/wiki/El_Niño' } },
      ],
    }
    const r = parseTourFile(tour)
    expect(r.assets).toHaveLength(1)
    expect(r.assets[0]).toMatchObject({
      rawValue: 'https://en.wikipedia.org/wiki/El_Niño',
      kind: 'absolute_external',
    })
  })

  it('captures addPlacemark.iconFilename when present', () => {
    const tour = {
      tourTasks: [
        { addPlacemark: { placemarkID: 'm1', lat: 0, lon: 0, iconFilename: 'pin.png' } },
        { addPlacemark: { placemarkID: 'm2', lat: 1, lon: 1 } }, // no iconFilename
      ],
    }
    const r = parseTourFile(tour)
    expect(r.assets).toHaveLength(1)
    expect(r.assets[0].rawValue).toBe('pin.png')
  })

  it('captures playVideo URL and distinguishes YouTube from sibling', () => {
    const tour = {
      tourTasks: [
        { playVideo: { filename: 'https://www.youtube.com/embed/dQw4w9WgXcQ' } },
        { showVideo: { filename: 'b-roll.mp4' } },
      ],
    }
    const r = parseTourFile(tour)
    expect(r.assets).toHaveLength(2)
    expect(r.assets[0].kind).toBe('absolute_external')
    expect(r.assets[1].kind).toBe('relative')
  })

  it('captures addBubble.media360 (external Vimeo URL)', () => {
    const tour = {
      tourTasks: [
        {
          addBubble: {
            bubbleID: 'bubble1',
            title: 'Hurricane Maria',
            lat: 25.2, lon: -62.1, alt: 500,
            media360: 'https://vimeo.com/296736862',
            autoFlyTo: true,
          },
        },
      ],
    }
    const r = parseTourFile(tour)
    expect(r.unknownTasks).toEqual([])
    expect(r.assets).toEqual([
      {
        rawValue: 'https://vimeo.com/296736862',
        source: { taskIndex: 0, taskName: 'addBubble', field: 'media360' },
        kind: 'absolute_external',
      },
    ])
  })

  it('captures addBubble.media360 (relative 360-pano image)', () => {
    const tour = {
      tourTasks: [
        {
          addBubble: {
            bubbleID: 'bubble1',
            title: 'Christ of the Abyss',
            lat: 25.124, lon: -80.297,
            media360: 'pano_floridakeys.jpg',
          },
        },
      ],
    }
    const r = parseTourFile(tour)
    expect(r.assets).toHaveLength(1)
    expect(r.assets[0]).toMatchObject({
      rawValue: 'pano_floridakeys.jpg',
      kind: 'relative',
    })
  })

  it('captures both showInfoBtn URL fields with per-value classification', () => {
    const tour = {
      tourTasks: [
        {
          showInfoBtn: {
            infoBtnID: 'infoBtn1',
            type: 'video',
            content: 'https://www.youtube.com/embed/_87Rss34-fU',
            iconFilename: 'logo.jpg',
            caption: 'Elephant Seals',
          },
        },
      ],
    }
    const r = parseTourFile(tour)
    expect(r.unknownTasks).toEqual([])
    expect(r.assets).toHaveLength(2)
    // Content URL is external, icon is a sibling file.
    const byField = Object.fromEntries(r.assets.map(a => [a.source.field, a]))
    expect(byField.content).toMatchObject({
      rawValue: 'https://www.youtube.com/embed/_87Rss34-fU',
      kind: 'absolute_external',
    })
    expect(byField.iconFilename).toMatchObject({
      rawValue: 'logo.jpg',
      kind: 'relative',
    })
  })

  it('hideInfoBtn bare-string task does not produce an asset', () => {
    const r = parseTourFile({
      tourTasks: [{ hideInfoBtn: 'info2' }],
    })
    expect(r.assets).toEqual([])
    expect(r.unknownTasks).toEqual([])
  })

  it('loadTour / showLegend / worldBorders are known non-asset tasks', () => {
    // These were surfaced as unknown by the 3c/A sweep and audited
    // as non-URL-bearing — loadTour's value is a SOS dataset id
    // (catalog lookup), showLegend is a boolean, worldBorders is
    // a setting enum. None of them produce an asset to migrate,
    // and none should be flagged as unknown.
    const r = parseTourFile({
      tourTasks: [
        { loadTour: 'ID_TB_SOSX_WELCOME' },
        { showLegend: true },
        { worldBorders: 'off' },
      ],
    })
    expect(r.assets).toEqual([])
    expect(r.unknownTasks).toEqual([])
  })

  it('handles a full multi-task tour and preserves taskIndex ordering', () => {
    // Realistic SOS shape — narrated audio, overlay image, question,
    // YouTube clip, then a hide-* task that doesn't add an asset.
    const tour = {
      tourTasks: [
        { setEnvView: '1globe' },
        { loadDataset: { id: 'DS_X', datasetID: 'dataset1' } },
        { playAudio: { filename: 'audio.mp3' } },
        { showImage: { imageID: 'i1', filename: 'overlays/title.png' } },
        {
          question: {
            id: 'q1',
            imgQuestionFilename: 'q.png',
            numberOfAnswers: 2,
            correctAnswerIndex: 0,
            imgAnswerFilename: 'a.png',
          },
        },
        { playVideo: { filename: 'https://www.youtube.com/embed/abc' } },
        { hideImage: 'i1' },
        { showPopupHtml: { popupID: 'p1', url: 'https://noaa.gov/article' } },
      ],
    }
    const r = parseTourFile(tour)
    expect(r.unknownTasks).toEqual([])
    // 6 URL-bearing fields total: audio, overlay, q, a, video, popup
    expect(r.assets).toHaveLength(6)
    // Ordering follows tasks in source order.
    expect(r.assets.map(a => a.source.taskIndex)).toEqual([2, 3, 4, 4, 5, 7])
    // Classification mix.
    const kinds = r.assets.map(a => a.kind)
    expect(kinds.filter(k => k === 'relative')).toHaveLength(4)
    expect(kinds.filter(k => k === 'absolute_external')).toHaveLength(2)
  })
})

describe('parseTourFile — defensive', () => {
  it('returns empty for null / non-object input', () => {
    expect(parseTourFile(null)).toEqual({ assets: [], unknownTasks: [] })
    expect(parseTourFile(undefined)).toEqual({ assets: [], unknownTasks: [] })
    expect(parseTourFile('not a tour')).toEqual({ assets: [], unknownTasks: [] })
    expect(parseTourFile(42)).toEqual({ assets: [], unknownTasks: [] })
  })

  it('returns empty when tourTasks is missing or non-array', () => {
    expect(parseTourFile({})).toEqual({ assets: [], unknownTasks: [] })
    expect(parseTourFile({ tourTasks: 'oops' })).toEqual({ assets: [], unknownTasks: [] })
    expect(parseTourFile({ tourTasks: null })).toEqual({ assets: [], unknownTasks: [] })
  })

  it('skips null / non-object task entries silently', () => {
    const r = parseTourFile({
      tourTasks: [null, undefined, 'a string', 42, { playAudio: { filename: 'a.mp3' } }],
    })
    expect(r.assets).toHaveLength(1)
    expect(r.unknownTasks).toEqual([])
  })

  it('surfaces unknown task names', () => {
    const r = parseTourFile({
      tourTasks: [
        { playAudio: { filename: 'a.mp3' } },
        { totallyMadeUpTask: 'value' },
        { anotherUnknown: { foo: 'bar' } },
      ],
    })
    expect(r.assets).toHaveLength(1)
    expect(r.unknownTasks).toEqual([
      { taskIndex: 1, taskName: 'totallyMadeUpTask' },
      { taskIndex: 2, taskName: 'anotherUnknown' },
    ])
  })

  it('surfaces malformed (multi-key) task objects', () => {
    const r = parseTourFile({
      tourTasks: [
        { playAudio: { filename: 'a.mp3' }, showImage: { imageID: 'x', filename: 'x.png' } },
      ],
    })
    // SOS spec says exactly one key per task; multi-key entries
    // get the warning surface.
    expect(r.assets).toEqual([])
    expect(r.unknownTasks).toHaveLength(1)
    expect(r.unknownTasks[0].taskName).toContain('playAudio')
  })

  it('skips tasks whose taskValue is missing required fields', () => {
    const r = parseTourFile({
      tourTasks: [
        { playAudio: { asynchronous: true } }, // no filename
        { showImage: { imageID: 'x' } }, // no filename
        { question: { id: 'q' } }, // neither question/answer image
        { addPlacemark: { placemarkID: 'm', lat: 0, lon: 0 } }, // no iconFilename
        { showPopupHtml: { popupID: 'p', html: '<p>inline</p>' } }, // no url
        { addBubble: { bubbleID: 'b', title: 't', lat: 0, lon: 0 } }, // no media360
        { showInfoBtn: { infoBtnID: 'i', caption: 'c' } }, // no content / iconFilename
      ],
    })
    expect(r.assets).toEqual([])
    expect(r.unknownTasks).toEqual([])
  })

  it('hide-* / stop-* bare-string tasks do not produce new assets', () => {
    const r = parseTourFile({
      tourTasks: [
        { hideImage: 'i1' },
        { hideImg: 'i2' },
        { hideVideo: 'v1' },
        { hidePlayVideo: 'v2' },
        { stopVideo: 'v3' },
        { hideInfoBtn: 'info2' },
      ],
    })
    expect(r.assets).toEqual([])
    expect(r.unknownTasks).toEqual([])
  })
})

describe('siblingKeyForRelativeAsset', () => {
  it('preserves the relative path verbatim', () => {
    expect(siblingKeyForRelativeAsset('audio.mp3')).toBe('audio.mp3')
    expect(siblingKeyForRelativeAsset('overlays/title.png')).toBe('overlays/title.png')
  })

  it('normalizes leading slash + repeated slashes', () => {
    expect(siblingKeyForRelativeAsset('/audio.mp3')).toBe('audio.mp3')
    expect(siblingKeyForRelativeAsset('audio//x.mp3')).toBe('audio/x.mp3')
  })

  it('returns null for absolute URLs', () => {
    expect(siblingKeyForRelativeAsset('https://example.org/x.mp3')).toBeNull()
    expect(siblingKeyForRelativeAsset('https://d3sik7mbbzunjo.cloudfront.net/y/z.mp3')).toBeNull()
  })

  it('returns null for empty / whitespace inputs', () => {
    expect(siblingKeyForRelativeAsset('')).toBeNull()
    expect(siblingKeyForRelativeAsset('   ')).toBeNull()
  })

  it('refuses path traversal (..)', () => {
    expect(siblingKeyForRelativeAsset('../audio.mp3')).toBeNull()
    expect(siblingKeyForRelativeAsset('overlays/../bad.png')).toBeNull()
  })

  it('refuses single-dot segments', () => {
    // `./x.png` and `x/./y.png` are unusual but technically valid
    // paths; reject them so the resulting R2 key never contains
    // a `.` segment that would confuse path-style addressing.
    expect(siblingKeyForRelativeAsset('./x.png')).toBeNull()
    expect(siblingKeyForRelativeAsset('a/./b.png')).toBeNull()
  })
})
