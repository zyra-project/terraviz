import { describe, expect, it } from 'vitest'

import { accessHeadersFromEnv, parseViewportMatrix } from './report'

describe('parseViewportMatrix', () => {
  it('parses the default desktop + mobile matrix', () => {
    expect(parseViewportMatrix('desktop=1440x900,mobile=390x844')).toEqual([
      { label: 'desktop', viewport: { width: 1440, height: 900 } },
      { label: 'mobile', viewport: { width: 390, height: 844 } },
    ])
  })

  it('tolerates surrounding whitespace and trailing commas', () => {
    expect(parseViewportMatrix(' wide = 1920x1080 , ,')).toEqual([
      { label: 'wide', viewport: { width: 1920, height: 1080 } },
    ])
  })

  it('rejects an entry without a label=WxH shape', () => {
    expect(() => parseViewportMatrix('1440x900')).toThrow(/label=WIDTHxHEIGHT/)
  })

  it('rejects an empty label', () => {
    expect(() => parseViewportMatrix('=1440x900')).toThrow(/empty label/)
  })

  it('rejects labels with path separators or dots (traversal guard)', () => {
    expect(() => parseViewportMatrix('../evil=1440x900')).toThrow(/filename/)
    expect(() => parseViewportMatrix('a/b=1440x900')).toThrow(/filename/)
    expect(() => parseViewportMatrix('mobile.1=390x844')).toThrow(/filename/)
  })

  it('rejects a malformed dimension', () => {
    expect(() => parseViewportMatrix('desktop=wide')).toThrow(/viewport must look like/)
  })
})

describe('accessHeadersFromEnv', () => {
  it('returns CF Access headers when both halves are present', () => {
    expect(accessHeadersFromEnv('id-123', 'secret-456')).toEqual({
      'CF-Access-Client-Id': 'id-123',
      'CF-Access-Client-Secret': 'secret-456',
    })
  })

  it('returns undefined when either half is missing or empty', () => {
    expect(accessHeadersFromEnv(undefined, undefined)).toBeUndefined()
    expect(accessHeadersFromEnv('id', undefined)).toBeUndefined()
    expect(accessHeadersFromEnv(undefined, 'secret')).toBeUndefined()
    expect(accessHeadersFromEnv('', '')).toBeUndefined()
  })
})
