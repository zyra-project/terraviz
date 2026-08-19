import { describe, expect, it } from 'vitest'
import { parseDatasetExperience } from './dataset-experience'

describe('parseDatasetExperience', () => {
  it('accepts version 1 manifests and rejects malformed or unbounded structures', () => {
    expect(parseDatasetExperience({
      version: 1,
      composition: {
        layers: [
          { ordinal: 0, name: 'Base', source: 'r2:base' },
          { ordinal: 1, name: 'Clouds', source: 'r2:clouds' },
        ],
      },
    })).not.toBeNull()
    expect(parseDatasetExperience({ version: 2 })).toBeNull()
    expect(parseDatasetExperience({ version: 1, textTracks: {} })).toBeNull()
    expect(parseDatasetExperience({ version: 1, composition: { layers: [{}] } })).toBeNull()
  })
})
