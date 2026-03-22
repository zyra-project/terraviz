import { describe, it, expect, beforeEach } from 'vitest'
import { dataService } from './dataService'
import type { Dataset } from '../types'

// Helper to build a minimal Dataset
function makeDataset(overrides: Partial<Dataset> = {}): Dataset {
  return {
    id: 'test-id',
    title: 'Test Dataset',
    format: 'image/png',
    dataLink: 'https://example.com/image.png',
    ...overrides
  }
}

// ---------------------------------------------------------------------------
// extractVimeoId
// ---------------------------------------------------------------------------
describe('DataService.extractVimeoId', () => {
  it('extracts ID from a full Vimeo URL', () => {
    expect(dataService.extractVimeoId('https://vimeo.com/123456789')).toBe('123456789')
  })

  it('extracts ID from a proxy URL containing vimeo.com', () => {
    expect(dataService.extractVimeoId('https://video-proxy.example.org/video/987654321/vimeo.com/987654321')).toBe('987654321')
  })

  it('returns null for a non-Vimeo URL', () => {
    expect(dataService.extractVimeoId('https://example.com/video.mp4')).toBeNull()
  })

  it('returns null for an empty string', () => {
    expect(dataService.extractVimeoId('')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// isVideoDataset / isImageDataset
// ---------------------------------------------------------------------------
describe('DataService.isVideoDataset', () => {
  it('returns true for video/mp4', () => {
    expect(dataService.isVideoDataset(makeDataset({ format: 'video/mp4' }))).toBe(true)
  })

  it('returns false for image/png', () => {
    expect(dataService.isVideoDataset(makeDataset({ format: 'image/png' }))).toBe(false)
  })
})

describe('DataService.isImageDataset', () => {
  it('returns true for image/png', () => {
    expect(dataService.isImageDataset(makeDataset({ format: 'image/png' }))).toBe(true)
  })

  it('returns true for image/jpg', () => {
    expect(dataService.isImageDataset(makeDataset({ format: 'image/jpg' }))).toBe(true)
  })

  it('returns false for video/mp4', () => {
    expect(dataService.isImageDataset(makeDataset({ format: 'video/mp4' }))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// parseTimeMetadata
// ---------------------------------------------------------------------------
describe('DataService.parseTimeMetadata', () => {
  it('returns static displayMode when no temporal fields', () => {
    const result = dataService.parseTimeMetadata(makeDataset())
    expect(result.displayMode).toBe('static')
    expect(result.hasTemporalData).toBe(false)
  })

  it('returns temporal mode with startTime + endTime + period', () => {
    const dataset = makeDataset({
      startTime: '2020-01-01T00:00:00',
      endTime: '2021-01-01T00:00:00',
      period: 'P1D',
      format: 'video/mp4'
    })
    const result = dataService.parseTimeMetadata(dataset)
    expect(result.displayMode).toBe('temporal')
    expect(result.hasTemporalData).toBe(true)
    expect(result.startTime).toBeInstanceOf(Date)
    expect(result.endTime).toBeInstanceOf(Date)
  })

  it('parses period into typed object', () => {
    const dataset = makeDataset({
      startTime: '2020-01-01T00:00:00',
      endTime: '2021-01-01T00:00:00',
      period: 'P1W',
      format: 'video/mp4'
    })
    const result = dataService.parseTimeMetadata(dataset)
    expect(result.period?.type).toBe('week')
    expect(result.period?.days).toBe(7)
  })

  it('returns temporal for video with only startTime', () => {
    const dataset = makeDataset({
      format: 'video/mp4',
      startTime: '2020-06-01T00:00:00'
    })
    const result = dataService.parseTimeMetadata(dataset)
    expect(result.displayMode).toBe('temporal')
    expect(result.hasTemporalData).toBe(true)
  })

  it('returns unknown on unparseable period', () => {
    const dataset = makeDataset({
      startTime: '2020-01-01T00:00:00',
      endTime: '2021-01-01T00:00:00',
      period: 'NOT_A_DURATION'
    })
    const result = dataService.parseTimeMetadata(dataset)
    expect(result.displayMode).toBe('unknown')
  })
})

// ---------------------------------------------------------------------------
// getDatasetById — requires populated cache (returns undefined before fetch)
// ---------------------------------------------------------------------------
describe('DataService.getDatasetById', () => {
  it('returns undefined when cache is empty', () => {
    dataService.clearCache()
    expect(dataService.getDatasetById('any-id')).toBeUndefined()
  })
})
