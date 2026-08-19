/**
 * Parser for the native SOS `playlist.sos` format.
 *
 * This follows the behavior of SOS's Playlist.tcl, not SOS Explorer:
 * first `=` splits a property, blank/comment/invalid lines are ignored,
 * `name` starts a clip, `data` aliases `datadir`, and layer/PIP properties
 * attach to the most recently declared layer/PIP. Unknown properties are
 * retained so an import never silently loses source meaning.
 */

export interface SosProperty {
  name: string
  value: string
  line: number
}

export interface SosLayer {
  index: number
  properties: SosProperty[]
}

export interface SosPip {
  index: number
  properties: SosProperty[]
}

export interface SosClip {
  index: number
  name: string
  source: string
  properties: SosProperty[]
  layers: SosLayer[]
  pips: SosPip[]
}

export interface SosPlaylist {
  source: string
  properties: SosProperty[]
  includes: SosProperty[]
  clips: SosClip[]
  ignoredLines: number[]
  warnings: string[]
}

const CSV_PROPERTIES = new Set([
  'pipcoords',
  'icons',
  'keywords',
  'labelcolor',
  'labelposition',
])

/** Properties whose values represent files or directories. */
export const SOS_REFERENCE_PROPERTIES = new Set([
  'include',
  'data',
  'datadir',
  'layerdata',
  'background',
  'overlay',
  'pip',
  'pippath',
  'pippathformat',
  'label',
  'labelformat',
  'caption',
  'captionformat',
  'audio',
  'script',
])

function normalizeCsv(value: string): string {
  return value
    .split(',')
    .map(part => part.trim())
    .filter(Boolean)
    .join(',')
}

function parseProperty(line: string, lineNumber: number): SosProperty | null {
  const trimmed = line.trimStart()
  if (!trimmed || trimmed.startsWith('#')) return null
  const equals = trimmed.indexOf('=')
  if (equals < 0) return null
  const name = trimmed.slice(0, equals).trim().toLowerCase()
  if (!name) return null
  let value = trimmed.slice(equals + 1).trim()
  if (CSV_PROPERTIES.has(name)) value = normalizeCsv(value)
  return { name, value, line: lineNumber }
}

function addLayerProperty(clip: SosClip, property: SosProperty): void {
  let name = property.name
  if (name === 'layerdata') name = 'datadir'
  else if (name.startsWith('layer') && name !== 'layer') name = name.slice(5)

  if (name === 'layer') {
    clip.layers.push({ index: clip.layers.length, properties: [{ ...property, name }] })
    return
  }

  // SOS creates an implicit layer zero when a legacy clip uses datadir.
  if (clip.layers.length === 0 && name === 'datadir') {
    clip.layers.push({
      index: 0,
      properties: [
        { name: 'layer', value: clip.name, line: property.line },
        { ...property, name },
      ],
    })
    return
  }

  const layer = clip.layers.at(-1)
  if (layer) layer.properties.push({ ...property, name })
}

function addPipProperty(clip: SosClip, property: SosProperty, warnings: string[]): void {
  if (property.name === 'pip') {
    clip.pips.push({ index: clip.pips.length, properties: [property] })
    return
  }
  const pip = clip.pips.at(-1)
  if (!pip) {
    warnings.push(
      `${clip.source}:${property.line}: ${property.name} appears before a pip declaration`,
    )
    return
  }
  pip.properties.push(property)
}

export function parseSosPlaylist(text: string, source = '<memory>'): SosPlaylist {
  const playlist: SosPlaylist = {
    source,
    properties: [],
    includes: [],
    clips: [],
    ignoredLines: [],
    warnings: [],
  }
  let current: SosClip | undefined

  for (const [zeroBased, raw] of text.split(/\r?\n/).entries()) {
    const line = zeroBased + 1
    const property = parseProperty(raw, line)
    if (!property) {
      if (raw.trim() && !raw.trimStart().startsWith('#')) playlist.ignoredLines.push(line)
      continue
    }

    if (property.name === 'include') {
      playlist.includes.push(property)
      playlist.properties.push(property)
      continue
    }

    if (property.name === 'name') {
      current = {
        index: playlist.clips.length,
        name: property.value,
        source,
        properties: [property],
        layers: [],
        pips: [],
      }
      playlist.clips.push(current)
      continue
    }

    if (!current) {
      playlist.properties.push(property)
      continue
    }

    if (property.name === 'data') {
      const normalized = { ...property, name: 'datadir' }
      current.properties.push(normalized)
      addLayerProperty(current, normalized)
      continue
    }

    current.properties.push(property)
    if (property.name === 'datadir' || property.name.startsWith('layer')) {
      addLayerProperty(current, property)
    } else if (property.name.startsWith('pip')) {
      addPipProperty(current, property, playlist.warnings)
    }
  }

  return playlist
}

export function propertyValue(
  properties: SosProperty[],
  name: string,
): string | undefined {
  for (let index = properties.length - 1; index >= 0; index--) {
    if (properties[index].name === name) return properties[index].value
  }
  return undefined
}

export function propertyValues(properties: SosProperty[], name: string): string[] {
  return properties.filter(property => property.name === name).map(property => property.value)
}
