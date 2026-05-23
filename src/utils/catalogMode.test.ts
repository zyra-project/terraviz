import { describe, it, expect, beforeEach } from 'vitest'
import { getCatalogMode, setCatalogMode } from './catalogMode'

function setUrl(search: string): void {
  window.history.replaceState({}, '', `/${search}`)
}

describe('catalogMode · getCatalogMode', () => {
  beforeEach(() => {
    setUrl('')
  })

  it('returns false when the catalog param is absent', () => {
    expect(getCatalogMode()).toBe(false)
  })

  it('returns true when ?catalog=true', () => {
    setUrl('?catalog=true')
    expect(getCatalogMode()).toBe(true)
  })

  it('returns true when ?catalog (empty value)', () => {
    setUrl('?catalog')
    expect(getCatalogMode()).toBe(true)
  })

  it('returns false when ?catalog=false', () => {
    setUrl('?catalog=false')
    expect(getCatalogMode()).toBe(false)
  })

  it('returns false when ?catalog=0', () => {
    setUrl('?catalog=0')
    expect(getCatalogMode()).toBe(false)
  })

  it('is case-insensitive for false/0 opt-outs', () => {
    setUrl('?catalog=False')
    expect(getCatalogMode()).toBe(false)
  })

  it('preserves the flag alongside other params', () => {
    setUrl('?dataset=INTERNAL_SOS_123&catalog=true')
    expect(getCatalogMode()).toBe(true)
  })
})

describe('catalogMode · setCatalogMode', () => {
  beforeEach(() => {
    setUrl('')
  })

  it('adds the catalog param when toggled on', () => {
    setCatalogMode(true)
    expect(window.location.search).toBe('?catalog=true')
  })

  it('removes the catalog param when toggled off', () => {
    setUrl('?catalog=true')
    setCatalogMode(false)
    expect(window.location.search).toBe('')
  })

  it('preserves other params on toggle', () => {
    setUrl('?dataset=INTERNAL_SOS_123')
    setCatalogMode(true)
    expect(window.location.search).toBe('?dataset=INTERNAL_SOS_123&catalog=true')
  })

  it('round-trips cleanly with getCatalogMode', () => {
    setCatalogMode(true)
    expect(getCatalogMode()).toBe(true)
    setCatalogMode(false)
    expect(getCatalogMode()).toBe(false)
  })

  it('does not create a history entry when the state is unchanged', () => {
    setUrl('?catalog=true')
    const beforeLength = window.history.length
    setCatalogMode(true)
    expect(window.history.length).toBe(beforeLength)
  })
})
