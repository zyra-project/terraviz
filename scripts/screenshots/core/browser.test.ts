import { describe, expect, it } from 'vitest'

import { isSameOrigin } from './browser'

describe('isSameOrigin', () => {
  const base = 'https://terraviz.zyra-project.org'

  it('is true for same-origin URLs (any path/query)', () => {
    expect(isSameOrigin('https://terraviz.zyra-project.org/', base)).toBe(true)
    expect(isSameOrigin('https://terraviz.zyra-project.org/publish/datasets', base)).toBe(true)
    expect(isSameOrigin('https://terraviz.zyra-project.org/api/v1/publish/me?x=1', base)).toBe(true)
  })

  it('is false for third-party origins (so the token never leaks)', () => {
    expect(isSameOrigin('https://tiles.openfreemap.org/planet', base)).toBe(false)
    expect(isSameOrigin('https://gibs.earthdata.nasa.gov/x.png', base)).toBe(false)
    // A look-alike host must not match (exact origin, not prefix).
    expect(isSameOrigin('https://terraviz.zyra-project.org.evil.com/', base)).toBe(false)
  })

  it('distinguishes scheme and port', () => {
    expect(isSameOrigin('http://terraviz.zyra-project.org/', base)).toBe(false)
    expect(isSameOrigin('https://terraviz.zyra-project.org:8443/', base)).toBe(false)
  })

  it('is false for a malformed URL rather than throwing', () => {
    expect(isSameOrigin('not a url', base)).toBe(false)
  })
})
