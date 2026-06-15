import { describe, expect, it } from 'vitest'

import {
  accessHeadersFromEnv,
  parseViewportMatrix,
  resolveSceneFilter,
  selectScenes,
} from './report'
import type { Scene } from './scenes'

const fakeScene = (name: string): Scene => ({
  name,
  description: name,
  setup: async () => {},
})

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

describe('resolveSceneFilter', () => {
  it('reads --scene <value> from argv', () => {
    expect(resolveSceneFilter(['--scene', 'tools-menu'], undefined)).toBe('tools-menu')
  })

  it('reads the --scene=<value> and --only forms', () => {
    expect(resolveSceneFilter(['--scene=a,b'], undefined)).toBe('a,b')
    expect(resolveSceneFilter(['--only', 'x'], undefined)).toBe('x')
    expect(resolveSceneFilter(['--only=y'], undefined)).toBe('y')
  })

  it('falls back to the VISUAL_ONLY env when no flag is present', () => {
    expect(resolveSceneFilter([], 'env-scene')).toBe('env-scene')
  })

  it('prefers an argv flag over the env var', () => {
    expect(resolveSceneFilter(['--scene', 'cli'], 'env')).toBe('cli')
  })

  it('returns undefined with neither flag nor env', () => {
    expect(resolveSceneFilter([], undefined)).toBeUndefined()
  })
})

describe('selectScenes', () => {
  const all = [fakeScene('a'), fakeScene('b'), fakeScene('c')]

  it('returns every scene for a blank or undefined filter', () => {
    expect(selectScenes(all, undefined)).toEqual(all)
    expect(selectScenes(all, '')).toEqual(all)
    expect(selectScenes(all, '  ,  ')).toEqual(all)
  })

  it('narrows to the requested names in requested order', () => {
    expect(selectScenes(all, 'c,a').map((s) => s.name)).toEqual(['c', 'a'])
  })

  it('tolerates whitespace and de-dupes repeats', () => {
    expect(selectScenes(all, ' a , a , b ').map((s) => s.name)).toEqual(['a', 'b'])
  })

  it('throws on an unknown name, listing what is available', () => {
    expect(() => selectScenes(all, 'a,nope')).toThrow(/Unknown scene\(s\): nope/)
    expect(() => selectScenes(all, 'a,nope')).toThrow(/Available: a, b, c/)
  })
})
