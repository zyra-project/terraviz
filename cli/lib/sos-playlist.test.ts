import { describe, expect, it } from 'vitest'
import { parseSosPlaylist, propertyValue } from './sos-playlist'

describe('parseSosPlaylist', () => {
  it('matches SOS name/value, layer, PIP, and preservation behavior', () => {
    const parsed = parseSosPlaylist(
      `# comment
include = /shared/sos/media/a/playlist.sos
not a property
name = Example
data = frames
firstdwell = 1200
layer = Clouds
layerdata = cloud-frames
pip = cards/info.png
pipstyle = globe
pipcoords = 10,  20,,
caption = captions/en.srt
unknownFuture = keep=this
`,
      'ftp://public.sos.noaa.gov/demo/playlist.sos',
    )

    expect(parsed.includes[0].value).toBe('/shared/sos/media/a/playlist.sos')
    expect(parsed.ignoredLines).toEqual([3])
    expect(parsed.clips).toHaveLength(1)
    const clip = parsed.clips[0]
    expect(propertyValue(clip.properties, 'datadir')).toBe('frames')
    expect(clip.layers).toHaveLength(2)
    expect(propertyValue(clip.layers[0].properties, 'layer')).toBe('Example')
    expect(propertyValue(clip.layers[1].properties, 'datadir')).toBe('cloud-frames')
    expect(clip.pips).toHaveLength(1)
    expect(propertyValue(clip.pips[0].properties, 'pipcoords')).toBe('10,20')
    expect(propertyValue(clip.properties, 'unknownfuture')).toBe('keep=this')
  })

  it('warns but retains an orphan PIP property on the clip', () => {
    const parsed = parseSosPlaylist('name=x\npipalpha=.5\n')
    expect(parsed.warnings[0]).toContain('appears before a pip declaration')
    expect(propertyValue(parsed.clips[0].properties, 'pipalpha')).toBe('.5')
  })
})

