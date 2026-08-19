import { describe, expect, it } from 'vitest'
import type { SosCatalog } from './sos-catalog'
import { buildSosConversionPlans } from './sos-conversion'
import type { CrawledSosPlaylist } from './sos-crawler'
import { parseSosPlaylist } from './sos-playlist'

const catalog: SosCatalog = {
  path: 'catalog.db',
  datasets: [{
    dataId: 42,
    name: 'Catalog title',
    description: 'Description',
    notableFeatures: null,
    directory: 'ftp://public.sos.noaa.gov/demo/',
    setSource: 'NOAA source office',
    dateAdded: '2020-01-01',
    startDate: '2020-01-01',
    endDate: '2020-01-02',
    liveProgramsPlaylist: null,
    flags: {
      narratedMovie: false, movie: false, realtime: false, audio: true,
      pip: true, webgl: false, sosx: false, sos: true,
    },
    categories: [{ major: 'Atmosphere', subcategory: 'Weather' }],
    keywords: ['storm'],
    contacts: [],
    variations: [],
  }],
}

describe('buildSosConversionPlans', () => {
  it('keeps unknown licenses private and routes synchronized features explicitly', () => {
    const source = 'ftp://public.sos.noaa.gov/demo/playlist.sos'
    const playlist = parseSosPlaylist(
      `name=Demo
datadir=frames
layer=Clouds
layerdata=clouds
audio=narration.mp3
caption=en.srt
firstdwell=1500
pip=card.png
pipstyle=globe
pippath=track.csv
futureThing=yes
`,
      source,
    )
    const crawled: CrawledSosPlaylist = {
      source,
      depth: 0,
      sha256: 'abc',
      playlist,
      references: [
        { property: 'datadir', raw: 'frames', resolved: `${source}/../frames`, line: 2, role: 'media' },
        { property: 'audio', raw: 'narration.mp3', resolved: `${source}/../narration.mp3`, line: 5, role: 'media' },
      ],
    }

    const [plan] = buildSosConversionPlans([crawled], catalog, { version: 1 })
    expect(plan.legacyId).toBe('sos:42:primary')
    expect(plan.draft.visibility).toBe('private')
    expect(plan.draft.attribution_text).toBe('NOAA source office')
    expect(plan.draft).not.toHaveProperty('license_statement')
    expect(plan.features.composition?.layers).toHaveLength(2)
    expect(plan.features.mediaTracks[0].sync).toBe('dataset-clock')
    expect(plan.features.textTracks[0].conversion).toBe('srt-to-vtt')
    expect(plan.features.playbackPolicy?.firstDwellMs).toBe(1500)
    expect(plan.features.overlays[0].proposedTarget).toBe('composition-overlay')
    expect(plan.experience.audioTracks?.[0].sync).toBe('dataset-clock')
    expect(plan.draft.experience_manifest).toEqual(expect.any(String))
    expect(plan.draft.source_import_state).toEqual(expect.any(String))
    expect(plan.unknownProperties[0].name).toBe('futurething')
    expect(plan.readiness).toBe('needs_review')
  })

  it('marks scripts and live PIPs unsupported and never executes them', () => {
    const source = 'ftp://public.sos.noaa.gov/demo/live.sos'
    const playlist = parseSosPlaylist(
      'name=Live\ndatadir=frames\npip=webcam\nscript=do-not-run.sh\n',
      source,
    )
    const [plan] = buildSosConversionPlans([{
      source, depth: 0, sha256: 'def', playlist, references: [],
    }], catalog, { version: 1 })
    expect(plan.readiness).toBe('unsupported')
    expect(plan.issues.map(issue => issue.code)).toEqual(
      expect.arrayContaining(['live_pip', 'script_blocked']),
    )
  })

  it('generates a companion Tour skeleton for presentation PIPs', () => {
    const source = 'ftp://public.sos.noaa.gov/demo/presentation.sos'
    const playlist = parseSosPlaylist(
      'name=Presentation\ndatadir=frames\npip=card.png\npipstyle=room\npiptimer=2000\n',
      source,
    )
    const [plan] = buildSosConversionPlans([{
      source, depth: 0, sha256: 'ghi', playlist, references: [],
    }], catalog, {
      version: 1,
      datasets: {
        'sos:42:primary': { license_statement: 'Reviewed internal example' },
      },
    })
    expect(plan.companionTour?.tourTasks).toEqual(expect.arrayContaining([
      expect.objectContaining({ loadDataset: expect.objectContaining({ id: 'sos:42:primary' }) }),
      expect.objectContaining({ showImage: expect.objectContaining({ filename: expect.stringContaining('card.png') }) }),
      { pauseSeconds: 2 },
      { hideImage: 'sos-pip-1' },
    ]))
  })
})
