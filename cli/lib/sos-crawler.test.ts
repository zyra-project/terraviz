import { describe, expect, it } from 'vitest'
import { crawlSosPlaylists } from './sos-crawler'

describe('crawlSosPlaylists', () => {
  it('follows includes once, records assets, and detects cycles', async () => {
    const files = new Map([
      [
        'ftp://public.sos.noaa.gov/root.sos',
        'include=child.sos\nname=Root\ndatadir=frames\n',
      ],
      [
        'ftp://public.sos.noaa.gov/child.sos',
        'include=root.sos\nname=Child\naudio=audio.mp3\n',
      ],
    ])
    const result = await crawlSosPlaylists(
      ['ftp://public.sos.noaa.gov/root.sos'],
      async source => {
        const value = files.get(source)
        if (value === undefined) throw new Error('missing fixture')
        return value
      },
    )

    expect(result.playlists).toHaveLength(2)
    expect(result.playlists[1].references).toContainEqual(expect.objectContaining({
      property: 'audio',
      resolved: 'ftp://public.sos.noaa.gov/audio.mp3',
    }))
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'cycle' }))
  })

  it('records a root fetch failure instead of throwing away the report', async () => {
    const result = await crawlSosPlaylists(['missing.sos'], async () => {
      throw new Error('offline')
    })
    expect(result.issues[0]).toMatchObject({ code: 'fetch_failed', message: 'offline' })
  })
})
