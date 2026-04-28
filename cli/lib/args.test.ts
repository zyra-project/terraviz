import { describe, expect, it } from 'vitest'
import { getBool, getNumber, getString, parseArgs } from './args'

describe('parseArgs', () => {
  it('separates positionals from options', () => {
    const r = parseArgs(['publish', 'foo.json', '--server', 'http://x'])
    expect(r.positional).toEqual(['publish', 'foo.json'])
    expect(r.options).toEqual({ server: 'http://x' })
  })

  it('supports --key=value', () => {
    const r = parseArgs(['--server=https://example.com'])
    expect(r.options.server).toBe('https://example.com')
  })

  it('treats a bare --flag as boolean true', () => {
    const r = parseArgs(['--insecure-local', 'arg1'])
    expect(r.options['insecure-local']).toBe(true)
    expect(r.positional).toEqual(['arg1'])
  })

  it('treats --no-flag as boolean false', () => {
    const r = parseArgs(['--no-color'])
    expect(r.options.color).toBe(false)
  })

  it('stops parsing options after `--`', () => {
    const r = parseArgs(['cmd', '--', '--not-a-flag'])
    expect(r.positional).toEqual(['cmd', '--not-a-flag'])
    expect(r.options).toEqual({})
  })
})

describe('helpers', () => {
  it('getString returns string values, undefined for booleans', () => {
    expect(getString({ a: 'x', b: true }, 'a')).toBe('x')
    expect(getString({ b: true }, 'b')).toBeUndefined()
    expect(getString({}, 'missing')).toBeUndefined()
  })

  it('getNumber parses numeric strings, returns undefined otherwise', () => {
    expect(getNumber({ ttl: '900' }, 'ttl')).toBe(900)
    expect(getNumber({ ttl: 'abc' }, 'ttl')).toBeUndefined()
    expect(getNumber({}, 'ttl')).toBeUndefined()
  })

  it('getBool returns true only for the boolean-true case', () => {
    expect(getBool({ flag: true }, 'flag')).toBe(true)
    expect(getBool({ flag: 'true' }, 'flag')).toBe(false)
    expect(getBool({}, 'flag')).toBe(false)
  })
})
