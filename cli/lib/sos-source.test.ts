import { describe, expect, it } from 'vitest'
import { resolveSosReference, sosPathToFtpUrl } from './sos-source'

describe('SOS reference resolution', () => {
  it('maps native shared media and realtime paths to the public FTP tree', () => {
    expect(sosPathToFtpUrl('/shared/sos/media/atmosphere/a/playlist.sos')).toBe(
      'ftp://public.sos.noaa.gov/atmosphere/a/playlist.sos',
    )
    expect(sosPathToFtpUrl('/shared/sos/rt/noaa/goes/playlist/playlist.sos')).toBe(
      'ftp://public.sos.noaa.gov/rt/goes/playlist/playlist.sos',
    )
  })

  it('resolves relative values against the containing remote playlist', () => {
    expect(
      resolveSosReference('ftp://public.sos.noaa.gov/ocean/a/playlist.sos', '../shared/cap.srt'),
    ).toBe('ftp://public.sos.noaa.gov/ocean/shared/cap.srt')
  })

  it('does not confuse a Windows drive letter with a URL protocol', () => {
    expect(resolveSosReference('D:\\SOS\\playlist.sos', 'media\\frames')).toMatch(
      /D:[\\/]SOS[\\/]media[\\/]frames$/,
    )
  })
})
