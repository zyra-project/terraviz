import { describe, expect, it, vi } from 'vitest'

import type { WeblateUnit } from './weblate-client'
import {
  diffUnits,
  resolveUnitIds,
  screenshotIdFromUrl,
  unitIdFromUrl,
} from './sync-weblate-screenshots'

describe('sync-weblate-screenshots helpers', () => {
  describe('unitIdFromUrl', () => {
    it('extracts the trailing unit id', () => {
      expect(unitIdFromUrl('https://hosted.weblate.org/api/units/123/')).toBe(123)
      expect(unitIdFromUrl('/api/units/45')).toBe(45)
    })

    it('returns null for non-unit URLs', () => {
      expect(unitIdFromUrl('https://hosted.weblate.org/api/screenshots/9/')).toBeNull()
      expect(unitIdFromUrl('nonsense')).toBeNull()
    })
  })

  describe('screenshotIdFromUrl', () => {
    it('extracts the trailing screenshot id from a hyperlinked url', () => {
      expect(
        screenshotIdFromUrl('https://hosted.weblate.org/api/screenshots/42/'),
      ).toBe(42)
      expect(screenshotIdFromUrl('/api/screenshots/7')).toBe(7)
    })

    it('returns null for undefined or non-screenshot URLs', () => {
      expect(screenshotIdFromUrl(undefined)).toBeNull()
      expect(screenshotIdFromUrl('https://hosted.weblate.org/api/units/9/')).toBeNull()
    })
  })

  describe('diffUnits', () => {
    it('adds desired-not-current and removes current-not-desired', () => {
      const { add, remove } = diffUnits(new Set([1, 2, 3]), new Set([2, 3, 4]))
      expect(add).toEqual([4])
      expect(remove).toEqual([1])
    })

    it('is a no-op when sets match', () => {
      const { add, remove } = diffUnits(new Set([1, 2]), new Set([1, 2]))
      expect(add).toEqual([])
      expect(remove).toEqual([])
    })

    it('handles empty current (first association)', () => {
      const { add, remove } = diffUnits(new Set(), new Set([7, 8]))
      expect(add).toEqual([7, 8])
      expect(remove).toEqual([])
    })
  })

  describe('resolveUnitIds', () => {
    const unit = (id: number, context: string): WeblateUnit => ({
      id,
      context,
      explanation: '',
    })
    const byKey = new Map([
      ['browse.card.load', unit(10, 'browse.card.load')],
      ['app.title', unit(20, 'app.title')],
    ])

    it('maps known keys to unit ids', () => {
      const scene = { name: 's', description: '', file: 's.png', sha256: '', keys: ['app.title', 'browse.card.load'] }
      const { ids, missing } = resolveUnitIds(scene, byKey)
      expect([...ids].sort()).toEqual([10, 20])
      expect(missing).toBe(0)
    })

    it('counts and warns on keys with no unit', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const scene = { name: 's', description: '', file: 's.png', sha256: '', keys: ['app.title', 'ghost.key'] }
      const { ids, missing } = resolveUnitIds(scene, byKey)
      expect([...ids]).toEqual([20])
      expect(missing).toBe(1)
      expect(warn).toHaveBeenCalledOnce()
      warn.mockRestore()
    })
  })
})
