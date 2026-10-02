// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * What an operator picked, turned into a warp set one output can carry
 * (`docs/MULTI_MONITOR_PLAN.md` §"Rung 16", "Where the meshes live" and
 * "Prerequisites"): a sphere-sim bundle, or the `.data` files extracted
 * from one, in; each mesh with the viewport it was placed in, and a
 * content id for the lot, out.
 *
 * Two steps, because the panel asks a question between them. **Reading**
 * (`readWarpSources`) takes the files as picked and returns every mesh
 * that arrived, parsed — or one refusal naming the file to blame — so the
 * operator sees what came in before being asked where it goes.
 * **Placing** (`assembleWarpSet`) takes their answer and returns the set.
 *
 * **Only `warp/<id>.data` at the archive's root is a mesh.** sphere-sim's
 * bundle can also carry `restore/warp/<id>.data`: the file an install
 * would overwrite, kept byte for byte so the operator can go back. That
 * is the *previous* calibration, in the same format under the same file
 * name one directory down, so a reader that matched on the file name —
 * or on any path ending `.data` — would import the old calibration as the
 * new one, or refuse the pair as duplicates, depending on entry order.
 * Nothing else in the archive is read either: the alignment files restate
 * the same correction, lossily, for SOS's own renderer, and the config is
 * the site's.
 *
 * **A layout is never inferred.** There are two, and neither is a guess.
 * A bundle from sphere-sim#52 on carries `layout.json`, which says where
 * each mesh goes and what its `u` addresses; the meshes are paired with it
 * by each entry's `mesh` path, never by projector id, because a placed
 * rig's `P1`…`P4` are not SOS's quadrants. Anything else — loose `.data`
 * files, or a bundle from before that — can be placed in SOS's quadrants,
 * but only as the operator's explicit answer. A `layout.json` this build
 * cannot read is a refusal, never a reason to fall back to asking: the
 * bundle said where its meshes go, and a guess where it said so is the
 * silent misplacement the file exists to end.
 *
 * **What `(u, v)` address is a declaration or nothing.** A Bourke file
 * cannot say: its texture coordinates refer to "the original input image",
 * and a dome's fisheye mesh parses, places and draws exactly as an equirect
 * one does — a smooth picture that is wrong, with nothing dropped to show
 * it. So a layout that states the frame is believed only when it states
 * equirectangular, and refused for anything else. One that states nothing
 * reads as it did. Loose files can state nothing, so for them the
 * operator's answer to the panel's question is the declaration, and the
 * question asks for the frame as well as the place.
 *
 * The parser and the set check are imported from `projectorWarp` rather
 * than restated: a set is re-read by the same functions on restore and by
 * the output on receipt, and one parser is one set of refusals.
 *
 * Pure: bytes in, values out. No DOM, no storage, no Tauri.
 */

import {
  isWarpId,
  MAX_WARP_MESHES,
  parseWarpMesh,
  placeWarpSet,
  sosQuadrantLayout,
  type PlacedWarpMesh,
  type WarpMesh,
  type WarpRefusal,
  type WarpSetEntry,
  type WarpSetRefusal,
  type WarpViewport,
} from '../../output/projectorWarp'
import type { WarpTexture } from './protocol'
import { crc32, readStoredEntry, readZipDirectory, type StoredZipRefusal } from './storedZip'

/** A file as the panel hands it over: its own name, and its bytes. */
export interface WarpImportFile {
  readonly name: string
  readonly bytes: Uint8Array
}

/** One mesh as it arrived, before any layout. */
export interface WarpSource {
  /** The projector id: `<id>` from `warp/<id>.data`, or from a picked `<id>.data`. */
  readonly id: string
  /** Where it came from, as the operator would recognise it. */
  readonly sourceName: string
  /** The file as imported — what is kept, and what a restore re-parses. */
  readonly text: string
  readonly mesh: WarpMesh
}

/** Where a set's viewports came from. Never an inference from ids. */
export type WarpLayoutSource = 'sos-quadrants' | 'bundle'

export interface WarpSetMesh extends WarpSetEntry {
  readonly sourceName: string
}

export interface WarpSet {
  readonly layoutFrom: WarpLayoutSource
  /** What the meshes' `u` addresses, as the bundle stated it; `null` when nothing did. */
  readonly texture: WarpTexture | null
  readonly meshes: readonly WarpSetMesh[]
}

/**
 * A bundle's `layout.json` (sphere-sim#52), read and paired with the
 * meshes beside it. Only what the import needs: the viewport of every
 * mesh, the display they divide, and what their `u` addresses.
 */
export interface BundleLayout {
  /** The display every viewport divides, in pixels, as the calibration holds it. */
  readonly framebuffer: { readonly width: number; readonly height: number }
  readonly texture: WarpTexture
  /** One per mesh, by the mesh's own id — paired through its `mesh` path, never matched by id. */
  readonly projectors: readonly { readonly id: string; readonly viewport: WarpViewport }[]
}

/** How a set is placed: by its bundle's own layout, or in SOS's quadrants on the operator's answer. */
export type WarpPlacement = 'sos-quadrants' | BundleLayout

/**
 * Why a `layout.json` could not be used. `format` and `uv` carry what the
 * file said, since each has a remedy of its own — a newer build for a
 * newer sphere-sim, a different file for a different projection; the
 * others name the entry to blame where there is one.
 */
export type BundleLayoutProblem =
  | { readonly code: 'not-json' }
  | { readonly code: 'format'; readonly format: string }
  | { readonly code: 'origin' }
  | { readonly code: 'framebuffer' }
  /**
   * The layout says the meshes address something other than an
   * equirectangular frame — a fisheye, a model's own UV set — which this
   * build would draw as though it were one.
   */
  | { readonly code: 'uv'; readonly uv: string }
  | { readonly code: 'texture' }
  | { readonly code: 'projectors' }
  /** An entry names a mesh the archive does not hold at `warp/<id>.data`. */
  | { readonly code: 'unknown-mesh'; readonly mesh: string }
  | { readonly code: 'listed-twice'; readonly mesh: string }
  /** A mesh in the archive that the layout does not place. */
  | { readonly code: 'unlisted-mesh'; readonly mesh: string }
  /** An entry whose `id` is not the id its own mesh file carries. */
  | { readonly code: 'id-mismatch'; readonly mesh: string; readonly id: string }

/**
 * The most bytes one import reads. A sphere-sim bundle is a few hundred
 * kilobytes — about 80 KB per projector at its default 41×41 — and even a
 * fine export of a large rig is a few megabytes. The bound exists so a
 * wrong file is refused before it is read into memory, not to size rigs;
 * what a set may actually occupy is the storage write's to decide.
 */
export const MAX_WARP_IMPORT_BYTES = 16 * 1024 * 1024

/** Why an import was refused. The panel words its own message from `code`. */
export type WarpImportRefusal =
  | { readonly code: 'nothing-picked' }
  | { readonly code: 'too-large'; readonly bytes: number }
  /** An archive together with anything else — two archives, or one and some meshes. */
  | { readonly code: 'mixed-selection' }
  /** Neither `.zip` nor `.data`. */
  | { readonly code: 'unsupported-file'; readonly file: string }
  | { readonly code: 'archive'; readonly file: string; readonly zip: StoredZipRefusal }
  /** An archive with no `warp/<id>.data` at its root. */
  | { readonly code: 'no-meshes'; readonly file: string }
  | { readonly code: 'too-many'; readonly count: number }
  /** A file name that cannot yield a projector id. */
  | { readonly code: 'bad-name'; readonly file: string }
  | { readonly code: 'duplicate-id'; readonly ids: readonly string[] }
  /** Not UTF-8 text, so not a mesh. */
  | { readonly code: 'not-text'; readonly file: string }
  | { readonly code: 'mesh'; readonly file: string; readonly mesh: WarpRefusal }
  /** The bundle's own `layout.json`, which this build cannot use. */
  | { readonly code: 'bundle-layout'; readonly file: string; readonly problem: BundleLayoutProblem }
  /** The chosen layout cannot place these ids: one it has no place for, or two for one place. */
  | { readonly code: 'layout'; readonly reason: 'unplaceable' | 'duplicate'; readonly ids: readonly string[] }
  | { readonly code: 'set'; readonly set: WarpSetRefusal }

export type WarpSourcesResult =
  | {
      readonly ok: true
      readonly sources: readonly WarpSource[]
      /** The bundle's own layout, paired and checked; `null` when there is none to read. */
      readonly layout: BundleLayout | null
    }
  | { readonly ok: false; readonly refusal: WarpImportRefusal }

export type WarpSetAssembly =
  | {
      readonly ok: true
      readonly set: WarpSet
      /** `warpSetId(set.meshes)`, born with it. */
      readonly id: string
      /** Aligned with `set.meshes`, parsed and checked — what the geometry build takes. */
      readonly placed: readonly PlacedWarpMesh[]
    }
  | { readonly ok: false; readonly refusal: WarpImportRefusal }

/** Exactly what sphere-sim writes: one level under `warp/`, at the archive's root. */
const ARCHIVE_MESH = /^warp\/([^/]+)\.data$/
/** Where sphere-sim writes the layout: the archive's root, under this name and no other. */
const LAYOUT_ENTRY = 'layout.json'
/**
 * The only format this build reads. sphere-sim bumps it when a reader of
 * `@1` would misread the file, so any other value is a different contract.
 */
const LAYOUT_FORMAT = 'sphere-sim/projector-layout@1'
/** The one frame a layout may say its meshes address: the only one this build draws. */
const UV_EQUIRECT = 'equirectangular'
/** A picked file: any case, since a renamed file is still the file. */
const PICKED_MESH = /\.data$/i
const ARCHIVE = /\.zip$/i

type Refused = { readonly ok: false; readonly refusal: WarpImportRefusal }
const refuse = (refusal: WarpImportRefusal): Refused => ({ ok: false, refusal })

/** Ids that fold to one another — `P1` and `p1` are one file on the disks they are extracted to. */
function duplicateIds(ids: readonly string[]): string[] {
  const folded = ids.map((id) => id.toLowerCase())
  return [...new Set(ids.filter((_, i) => folded.indexOf(folded[i]) !== i))]
}

type SourceResult = { readonly ok: true; readonly source: WarpSource } | Refused

/** Decode and parse one mesh file, or name it in the refusal. */
function readSource(id: string, sourceName: string, bytes: Uint8Array): SourceResult {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return refuse({ code: 'not-text', file: sourceName })
  }
  const parsed = parseWarpMesh(text)
  if (!parsed.ok) return refuse({ code: 'mesh', file: sourceName, mesh: parsed.refusal })
  return { ok: true, source: { id, sourceName, text, mesh: parsed.mesh } }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

type LayoutParse =
  | { readonly ok: true; readonly layout: BundleLayout }
  | { readonly ok: false; readonly problem: BundleLayoutProblem }

/**
 * `layout.json`'s text, read against the meshes the archive holds — each
 * given as its entry name and the id that name carries. Fail-closed, field
 * by field, to sphere-sim's own statement of what a reader must do: the
 * format exactly, the origin stated, a framebuffer in whole pixels, the
 * surface and its rotation as a pair, and **one entry per mesh, paired by
 * its `mesh` path** — an entry naming a mesh the archive lacks, a mesh
 * listed twice or not at all, or an `id` that is not its own mesh's, is
 * the layout and the meshes disagreeing about which projectors exist, and
 * a reader that picked one would be the misplacement the file ends.
 * Fields this build does not know are ignored: sphere-sim adds fields
 * within a format and bumps it only for ones a reader would misread. `uv`
 * is the one added field read ahead of its writer (sphere-sim#57), because
 * ignoring it is the misreading: where present it must say
 * `equirectangular`.
 * Whether the viewports fit the framebuffer and share no pixels is
 * `placeWarpSet`'s, run on the paired set after this.
 */
export function parseBundleLayout(
  text: string,
  meshes: readonly { readonly entryName: string; readonly id: string }[],
): LayoutParse {
  const fail = (problem: BundleLayoutProblem): LayoutParse => ({ ok: false, problem })
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return fail({ code: 'not-json' })
  }
  if (!isRecord(raw)) return fail({ code: 'not-json' })
  if (raw.format !== LAYOUT_FORMAT) return fail({ code: 'format', format: String(raw.format) })
  if (raw.origin !== 'bottom-left') return fail({ code: 'origin' })
  const fb = raw.framebuffer
  const pixels = (n: unknown): n is number => Number.isInteger(n) && (n as number) > 0
  if (!isRecord(fb) || !pixels(fb.width) || !pixels(fb.height)) return fail({ code: 'framebuffer' })
  // A layout that says nothing about (u, v), as every one written before
  // the field does, reads as it did: a sphere's are equirect by
  // construction, and a model's never were checkable here.
  if (Object.prototype.hasOwnProperty.call(raw, 'uv') && raw.uv !== UV_EQUIRECT) {
    return fail({ code: 'uv', uv: typeof raw.uv === 'string' ? raw.uv : JSON.stringify(raw.uv) })
  }

  let texture: WarpTexture
  if (raw.surface === 'sphere' && isFiniteNumber(raw.rotationOffsetDeg)) {
    texture = { surface: 'sphere', rotationOffsetDeg: raw.rotationOffsetDeg }
  } else if (raw.surface === 'mesh' && raw.rotationOffsetDeg === null) {
    texture = { surface: 'mesh', rotationOffsetDeg: null }
  } else {
    return fail({ code: 'texture' })
  }

  if (!Array.isArray(raw.projectors)) return fail({ code: 'projectors' })
  const idOf = new Map(meshes.map((m) => [m.entryName, m.id]))
  const listed = new Set<string>()
  const projectors: { id: string; viewport: WarpViewport }[] = []
  for (const entry of raw.projectors as unknown[]) {
    if (!isRecord(entry) || typeof entry.id !== 'string' || typeof entry.mesh !== 'string') {
      return fail({ code: 'projectors' })
    }
    const vp = entry.viewport
    if (!isRecord(vp) || ![vp.x, vp.y, vp.w, vp.h].every(isFiniteNumber)) return fail({ code: 'projectors' })
    const id = idOf.get(entry.mesh)
    if (id === undefined) return fail({ code: 'unknown-mesh', mesh: entry.mesh })
    if (listed.has(entry.mesh)) return fail({ code: 'listed-twice', mesh: entry.mesh })
    listed.add(entry.mesh)
    if (entry.id !== id) return fail({ code: 'id-mismatch', mesh: entry.mesh, id: entry.id })
    projectors.push({ id, viewport: { x: vp.x as number, y: vp.y as number, w: vp.w as number, h: vp.h as number } })
  }
  const unlisted = meshes.find((m) => !listed.has(m.entryName))
  if (unlisted !== undefined) return fail({ code: 'unlisted-mesh', mesh: unlisted.entryName })
  return { ok: true, layout: { framebuffer: { width: fb.width, height: fb.height }, texture, projectors } }
}

function fromArchive(file: WarpImportFile): WarpSourcesResult {
  const directory = readZipDirectory(file.bytes)
  if (!directory.ok) return refuse({ code: 'archive', file: file.name, zip: directory.refusal })
  const meshes = directory.entries.flatMap((entry) => {
    const match = ARCHIVE_MESH.exec(entry.name)
    return match === null ? [] : [{ entry, id: match[1] }]
  })
  if (meshes.length === 0) return refuse({ code: 'no-meshes', file: file.name })
  if (meshes.length > MAX_WARP_MESHES) return refuse({ code: 'too-many', count: meshes.length })
  const named = (name: string): string => `${file.name}/${name}`
  const badName = meshes.find((m) => !isWarpId(m.id))
  if (badName !== undefined) return refuse({ code: 'bad-name', file: named(badName.entry.name) })
  const duplicates = duplicateIds(meshes.map((m) => m.id))
  if (duplicates.length > 0) return refuse({ code: 'duplicate-id', ids: duplicates })

  const sources: WarpSource[] = []
  for (const { entry, id } of meshes) {
    const read = readStoredEntry(file.bytes, entry)
    if (!read.ok) return refuse({ code: 'archive', file: file.name, zip: read.refusal })
    const one = readSource(id, named(entry.name), read.bytes)
    if (!one.ok) return one
    sources.push(one.source)
  }

  // The layout, when the bundle carries one: read through the same
  // checksum as the meshes, then checked as a set here — so a layout whose
  // viewports overlap or leave the framebuffer is refused before the panel
  // draws it, not after the operator has agreed to it.
  const layoutEntry = directory.entries.find((entry) => entry.name === LAYOUT_ENTRY)
  if (layoutEntry === undefined) return { ok: true, sources, layout: null }
  const layoutFile = named(LAYOUT_ENTRY)
  const read = readStoredEntry(file.bytes, layoutEntry)
  if (!read.ok) return refuse({ code: 'archive', file: file.name, zip: read.refusal })
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(read.bytes)
  } catch {
    return refuse({ code: 'bundle-layout', file: layoutFile, problem: { code: 'not-json' } })
  }
  const parsed = parseBundleLayout(
    text,
    meshes.map(({ entry, id }) => ({ entryName: entry.name, id })),
  )
  if (!parsed.ok) return refuse({ code: 'bundle-layout', file: layoutFile, problem: parsed.problem })
  const placed = placeWarpSet(placedEntries(sources, parsed.layout))
  if (!placed.ok) return refuse({ code: 'set', set: placed.refusal })
  return { ok: true, sources, layout: parsed.layout }
}

/** Each source with the viewport its bundle gives it — `parseBundleLayout` has already paired every one. */
function placedEntries(sources: readonly WarpSource[], layout: BundleLayout): WarpSetMesh[] {
  const viewportOf = new Map(layout.projectors.map((p) => [p.id, p.viewport]))
  return sources.map((s) => ({
    id: s.id,
    viewport: viewportOf.get(s.id) as WarpViewport,
    text: s.text,
    sourceName: s.sourceName,
  }))
}

function fromMeshFiles(files: readonly WarpImportFile[]): WarpSourcesResult {
  const unsupported = files.find((f) => !PICKED_MESH.test(f.name))
  if (unsupported !== undefined) return refuse({ code: 'unsupported-file', file: unsupported.name })
  if (files.length > MAX_WARP_MESHES) return refuse({ code: 'too-many', count: files.length })
  const ids = files.map((f) => f.name.slice(0, -'.data'.length))
  const badName = files.find((_, i) => !isWarpId(ids[i]))
  if (badName !== undefined) return refuse({ code: 'bad-name', file: badName.name })
  const duplicates = duplicateIds(ids)
  if (duplicates.length > 0) return refuse({ code: 'duplicate-id', ids: duplicates })

  const sources: WarpSource[] = []
  for (let i = 0; i < files.length; i++) {
    const one = readSource(ids[i], files[i].name, files[i].bytes)
    if (!one.ok) return one
    sources.push(one.source)
  }
  // Loose files carry no layout: `layout.json` sits at the bundle's root,
  // beside `warp/` rather than in it, so no one pick of a folder holds both.
  return { ok: true, sources, layout: null }
}

/**
 * Every mesh in what the operator picked: one sphere-sim bundle, or any
 * number of `.data` files, never a mix — an archive beside loose meshes
 * would make two sources for one projector a question of which the reader
 * happened to see first. In file order, which for a bundle is sphere-sim's
 * rig order.
 */
export function readWarpSources(files: readonly WarpImportFile[]): WarpSourcesResult {
  if (files.length === 0) return refuse({ code: 'nothing-picked' })
  const bytes = files.reduce((sum, f) => sum + f.bytes.length, 0)
  if (bytes > MAX_WARP_IMPORT_BYTES) return refuse({ code: 'too-large', bytes })
  const archives = files.filter((f) => ARCHIVE.test(f.name))
  if (archives.length > 0) {
    return files.length === 1 ? fromArchive(files[0]) : refuse({ code: 'mixed-selection' })
  }
  return fromMeshFiles(files)
}

/**
 * The set, placed by its bundle's layout or by the operator's answer, and
 * checked the way a restore and the output will check it — so a set this
 * returns is one both will accept, and a refusal here is the operator's
 * to act on rather than a surprise at the next launch.
 *
 * A bundle layout must place exactly these sources, which a layout and
 * sources from one read always do; anything else is a caller that mixed
 * two reads, refused as `unplaceable` rather than half-placed.
 */
export function assembleWarpSet(sources: readonly WarpSource[], placement: WarpPlacement): WarpSetAssembly {
  if (sources.length === 0) return refuse({ code: 'set', set: { code: 'no-meshes' } })
  let meshes: WarpSetMesh[]
  if (placement === 'sos-quadrants') {
    const quadrants = sosQuadrantLayout(sources.map((s) => s.id))
    if (!quadrants.ok) {
      // `empty` cannot arrive: there is at least one source.
      const reason = quadrants.code === 'duplicate' ? 'duplicate' : 'unplaceable'
      return refuse({ code: 'layout', reason, ids: quadrants.ids })
    }
    meshes = sources.map((s, i) => ({
      id: s.id,
      viewport: quadrants.viewports[i],
      text: s.text,
      sourceName: s.sourceName,
    }))
  } else {
    const placedIds = new Set(placement.projectors.map((p) => p.id))
    const sourceIds = new Set(sources.map((s) => s.id))
    const unplaceable = [
      ...sources.filter((s) => !placedIds.has(s.id)).map((s) => s.id),
      ...placement.projectors.filter((p) => !sourceIds.has(p.id)).map((p) => p.id),
    ]
    if (unplaceable.length > 0 || placement.projectors.length !== sources.length) {
      return refuse({ code: 'layout', reason: 'unplaceable', ids: unplaceable })
    }
    meshes = placedEntries(sources, placement)
  }
  const checked = placeWarpSet(meshes)
  if (!checked.ok) return refuse({ code: 'set', set: checked.refusal })
  const set: WarpSet =
    placement === 'sos-quadrants'
      ? { layoutFrom: 'sos-quadrants', texture: null, meshes }
      : { layoutFrom: 'bundle', texture: { ...placement.texture }, meshes }
  return { ok: true, set, id: warpSetId(meshes), placed: checked.placed }
}

/** Bumped only if the canonical form below changes, which re-keys every set. */
const WARP_SET_ID_FORM = 'terraviz-warp-set/1'

function fnv1a32(bytes: Uint8Array): number {
  let h = 0x811c9dc5
  for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i], 0x01000193)
  return h >>> 0
}

const hex8 = (n: number): string => n.toString(16).padStart(8, '0')

/**
 * A set's content id: what it keys its storage under and what the output
 * compares to decide whether its geometry needs rebuilding. The meshes'
 * own text and their placement, in id order so the order files were picked
 * in does not matter — and nothing else: not the file names, not when it
 * was imported, not which layout source placed it.
 *
 * Sixty-four bits from two unrelated 32-bit functions, FNV-1a and CRC-32.
 * The id keys a stored set, so two sets that collided would overwrite each
 * other — a wrong warp on some other output with nothing to say so — and
 * at 64 bits an accidental collision among the handful of sets one machine
 * holds is out of reach. It is synchronous and needs nothing from the
 * platform, which `crypto.subtle` does: the app's other hash falls back to
 * a placeholder without it, which is right for an analytics bucket and
 * would be exactly that collision for a storage key.
 */
export function warpSetId(meshes: readonly WarpSetEntry[]): string {
  const ordered = [...meshes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const canonical = [
    WARP_SET_ID_FORM,
    ...ordered.map((m) => JSON.stringify([m.id, m.viewport.x, m.viewport.y, m.viewport.w, m.viewport.h, m.text])),
  ].join('\n')
  const bytes = new TextEncoder().encode(canonical)
  return hex8(fnv1a32(bytes)) + hex8(crc32(bytes))
}
