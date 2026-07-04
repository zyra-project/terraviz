/**
 * Tests for the agency-YouTube channel allowlist + embed-URL guard
 * (task: media suggestion engine — YouTube source).
 */

import { describe, expect, it } from 'vitest'
import {
  AGENCY_YOUTUBE_CHANNELS,
  channelName,
  isAllowlistedChannel,
  isNocookieEmbedUrl,
  nocookieEmbedUrl,
} from './youtube-channels'

describe('agency channel allowlist', () => {
  it('recognises vetted channels by id and rejects everything else', () => {
    expect(isAllowlistedChannel('UCLA_DiR1FfKNvjuUpBHmylQ')).toBe(true) // NASA
    expect(isAllowlistedChannel('UCeXH8GZyV3sVqAr45AvupOA')).toBe(true) // USGS
    expect(isAllowlistedChannel('UC-pHprdRFZMZNegDaZKFB9g')).toBe(true) // hyphenated id
    expect(isAllowlistedChannel('UCsomeRandomSpoofChannel')).toBe(false)
    expect(isAllowlistedChannel(null)).toBe(false)
    expect(isAllowlistedChannel(undefined)).toBe(false)
  })

  it('maps an allowlisted id to its display name', () => {
    expect(channelName('UCLA_DiR1FfKNvjuUpBHmylQ')).toBe('NASA')
    expect(channelName('UCeXH8GZyV3sVqAr45AvupOA')).toBe('USGS')
    expect(channelName('nope')).toBeNull()
    // Every allowlisted id must have a non-empty name.
    for (const [id, name] of Object.entries(AGENCY_YOUTUBE_CHANNELS)) {
      expect(id).toMatch(/^UC[\w-]{20,24}$/)
      expect(name.length).toBeGreaterThan(0)
    }
  })
})

describe('isNocookieEmbedUrl', () => {
  it('accepts only the privacy-enhanced embed shape', () => {
    expect(isNocookieEmbedUrl('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ')).toBe(true)
    // Frame-refusing watch page, non-embed path, wrong host, http, and
    // a random URL all fail.
    expect(isNocookieEmbedUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(false)
    expect(isNocookieEmbedUrl('https://www.youtube-nocookie.com/dQw4w9WgXcQ')).toBe(false)
    expect(isNocookieEmbedUrl('https://evil.example.org/embed/dQw4w9WgXcQ')).toBe(false)
    expect(isNocookieEmbedUrl('http://www.youtube-nocookie.com/embed/dQw4w9WgXcQ')).toBe(false)
    expect(isNocookieEmbedUrl('not a url')).toBe(false)
  })

  it('round-trips a video id through nocookieEmbedUrl', () => {
    const url = nocookieEmbedUrl('dQw4w9WgXcQ')
    expect(url).toBe('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ')
    expect(isNocookieEmbedUrl(url)).toBe(true)
  })
})
