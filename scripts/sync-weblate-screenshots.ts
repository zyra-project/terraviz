/**
 * Push translator screenshots to Weblate (phase S4).
 *
 * Consumes the capturer's output (`screenshots-out/screenshots.json`
 * + the PNGs beside it) and reconciles it against the live Weblate
 * screenshots for our source (`en`) translation. Sibling of
 * `sync-weblate-metadata.ts`; both share `./weblate-client.ts` for
 * auth and `key → unit` resolution.
 *
 * Run after a capture:
 *
 *     WEBLATE_TOKEN=<token> npm run screenshots:sync
 *     WEBLATE_TOKEN=<token> npm run screenshots:sync -- --dry-run
 *
 * Reconcile algorithm, per captured scene (matched to Weblate by
 * `name`):
 *   - new scene            → create the screenshot, associate every
 *                            resolved unit
 *   - image changed        → replace the image (sha compared against
 *                            the stored file), then reconcile units
 *   - image unchanged      → reconcile units only
 *   - units reconcile      → add associations for keys now present,
 *                            drop associations for keys gone
 *
 * Idempotent: with an unchanged capture this is all reads + skips.
 * No local state file — change detection derives entirely from the
 * live Weblate objects, matching how the Explanation sync derives
 * everything from the live unit list.
 *
 * Keys with no matching Weblate unit are warned, not fatal (usually
 * means Weblate hasn't pulled latest `main` yet — same posture as
 * the Explanation sync).
 *
 * See `docs/WEBLATE_SCREENSHOT_SYNC_PLAN.md`.
 */

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  authHeaders,
  fetchAllPages,
  fetchSourceUnits,
  hasToken,
  sourceTranslationUrl,
  unitsByContext,
  weblateFetch,
  WeblateError,
  WEBLATE_COMPONENT,
  WEBLATE_PROJECT,
  WEBLATE_URL,
  type WeblateUnit,
} from './weblate-client'

// Source language the screenshots attach to (the `en` units).
const SOURCE_LANGUAGE = 'en'
// Type-only import — erased at runtime, so the uploader does NOT
// pull in the capturer's `playwright` dependency. Keeps the
// manifest shape a single source of truth across the two scripts.
import type { CapturedScene } from './screenshots/capture'

const HERE = resolve(fileURLToPath(import.meta.url), '..')
const REPO_ROOT = resolve(HERE, '..')
const OUT_DIR =
  process.env.SCREENSHOT_OUT_DIR ?? resolve(REPO_ROOT, 'screenshots-out')

const DRY_RUN = process.argv.includes('--dry-run')

/** Weblate screenshot object (fields we use). */
interface WeblateScreenshot {
  id: number
  name: string
  /** URL of the related translation object (used to scope to `en`). */
  translation?: string
  /** Absolute URL to the stored image, when the API provides it. */
  file_url?: string
  /** Associated source-unit URLs, e.g. `.../api/units/123/`. */
  units?: string[]
}

/** Raw screenshot as returned by the API before normalization. Weblate
 *  uses hyperlinked serializers, so objects carry `url`
 *  (`.../api/screenshots/123/`) rather than a bare numeric `id`. */
interface RawScreenshot {
  id?: number
  url?: string
  name: string
  translation?: string
  file_url?: string
  units?: string[]
}

const sha256 = (buf: Buffer | Uint8Array): string =>
  createHash('sha256').update(buf).digest('hex')

/** Trailing integer id from a `.../api/units/123/` URL. */
export function unitIdFromUrl(url: string): number | null {
  const m = /\/units\/(\d+)\/?$/.exec(url)
  return m ? Number(m[1]) : null
}

/** Trailing integer id from a `.../api/screenshots/123/` URL. */
export function screenshotIdFromUrl(url: string | undefined): number | null {
  if (!url) return null
  const m = /\/screenshots\/(\d+)\/?$/.exec(url)
  return m ? Number(m[1]) : null
}

/**
 * Resolve a usable numeric `id` from a raw screenshot. The hyperlinked
 * serializer returns `url`, not `id`, so fall back to parsing the url.
 * Returns null if neither is present (caller decides how to handle).
 */
function normalizeScreenshot(raw: RawScreenshot): WeblateScreenshot | null {
  const id = typeof raw.id === 'number' ? raw.id : screenshotIdFromUrl(raw.url)
  if (id == null) return null
  return {
    id,
    name: raw.name,
    translation: raw.translation,
    file_url: raw.file_url,
    units: raw.units,
  }
}

/**
 * Every screenshot attached to our source (`en`) translation.
 *
 * The Weblate REST API only exposes the global `GET /api/screenshots/`
 * (there is no component-scoped screenshots list), so we page it and
 * filter by the `translation` URL client-side. This is a
 * low-frequency CI job, so the extra pages are acceptable.
 */
async function listSourceScreenshots(): Promise<WeblateScreenshot[]> {
  const all = await fetchAllPages<RawScreenshot>(
    `${WEBLATE_URL}/api/screenshots/`,
  )
  const src = sourceTranslationUrl()
  return all
    .filter((s) => s.translation === src)
    .map(normalizeScreenshot)
    .filter((s): s is WeblateScreenshot => s !== null)
}

async function createScreenshot(
  scene: CapturedScene,
  png: Buffer,
): Promise<WeblateScreenshot> {
  // Current Weblate wants the target as project/component/language
  // slugs (not a `translation` URL); the source units live under the
  // `en` language. (Confirmed by the API's validation_error:
  // "project_slug: This field is required.")
  const form = new FormData()
  form.append('name', scene.name)
  form.append('project_slug', WEBLATE_PROJECT)
  form.append('component_slug', WEBLATE_COMPONENT)
  form.append('language_code', SOURCE_LANGUAGE)
  form.append(
    'image',
    new Blob([new Uint8Array(png)], { type: 'image/png' }),
    scene.file,
  )
  const res = await weblateFetch(`${WEBLATE_URL}/api/screenshots/`, {
    method: 'POST',
    headers: authHeaders(),
    body: form,
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new WeblateError(
      `POST /api/screenshots/ (${scene.name}) → ${res.status} ${res.statusText}` +
        (body ? `\n  ${body}` : ''),
    )
  }
  const shot = normalizeScreenshot((await res.json()) as RawScreenshot)
  if (!shot) {
    throw new WeblateError(
      `Created screenshot ${scene.name} but the response had no id/url to associate units with.`,
    )
  }
  return shot
}

async function replaceScreenshotImage(
  shot: WeblateScreenshot,
  scene: CapturedScene,
  png: Buffer,
): Promise<void> {
  const form = new FormData()
  form.append(
    'image',
    new Blob([new Uint8Array(png)], { type: 'image/png' }),
    scene.file,
  )
  const url = `${WEBLATE_URL}/api/screenshots/${shot.id}/file/`
  const res = await weblateFetch(url, {
    method: 'POST',
    headers: authHeaders(),
    body: form,
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new WeblateError(
      `POST ${url} → ${res.status} ${res.statusText}${body ? `\n  ${body}` : ''}`,
    )
  }
}

async function associateUnit(shotId: number, unitId: number): Promise<void> {
  const url = `${WEBLATE_URL}/api/screenshots/${shotId}/units/`
  // `unit_id` is a FORM parameter per the Weblate API (not JSON).
  // Passing URLSearchParams makes fetch send
  // application/x-www-form-urlencoded.
  const res = await weblateFetch(url, {
    method: 'POST',
    headers: authHeaders(),
    body: new URLSearchParams({ unit_id: String(unitId) }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new WeblateError(
      `POST ${url} (unit ${unitId}) → ${res.status} ${res.statusText}` +
        (body ? `\n  ${body}` : ''),
    )
  }
}

async function dissociateUnit(shotId: number, unitId: number): Promise<void> {
  const url = `${WEBLATE_URL}/api/screenshots/${shotId}/units/${unitId}/`
  const res = await weblateFetch(url, { method: 'DELETE', headers: authHeaders() })
  // 404 is fine — already gone.
  if (!res.ok && res.status !== 404) {
    const body = await res.text().catch(() => '')
    throw new WeblateError(
      `DELETE ${url} → ${res.status} ${res.statusText}${body ? `\n  ${body}` : ''}`,
    )
  }
}

/**
 * Hash the image Weblate currently stores so we only re-upload when
 * the pixels changed. Returns null when the file can't be fetched
 * (older API without `file_url`, transient error) — caller then
 * re-uploads to be safe.
 */
async function storedImageSha(shot: WeblateScreenshot): Promise<string | null> {
  if (!shot.file_url) return null
  const url = shot.file_url.startsWith('http')
    ? shot.file_url
    : `${WEBLATE_URL}${shot.file_url}`
  const res = await weblateFetch(url, { headers: authHeaders() })
  if (!res.ok) return null
  return sha256(new Uint8Array(await res.arrayBuffer()))
}

/** Resolve a scene's keys to unit ids, warning on any that miss. */
export function resolveUnitIds(
  scene: Pick<CapturedScene, 'keys'>,
  byKey: Map<string, WeblateUnit>,
): { ids: Set<number>; missing: number } {
  const ids = new Set<number>()
  let missing = 0
  for (const key of scene.keys) {
    const unit = byKey.get(key)
    if (!unit) {
      missing++
      // eslint-disable-next-line no-console
      console.warn(`  ! ${key}: no matching unit in Weblate (skipped)`)
      continue
    }
    ids.add(unit.id)
  }
  return { ids, missing }
}

/** The current unit ids associated with a screenshot. */
function currentUnitIds(shot: WeblateScreenshot): Set<number> {
  const ids = new Set<number>()
  for (const u of shot.units ?? []) {
    const id = unitIdFromUrl(u)
    if (id !== null) ids.add(id)
  }
  return ids
}

/** Pure set diff: which associations to add and which to drop. */
export function diffUnits(
  current: Set<number>,
  desired: Set<number>,
): { add: number[]; remove: number[] } {
  const add = [...desired].filter((id) => !current.has(id))
  const remove = [...current].filter((id) => !desired.has(id))
  return { add, remove }
}

/** Add/remove unit associations to match the desired set. */
async function reconcileUnits(
  shot: WeblateScreenshot,
  desired: Set<number>,
): Promise<{ added: number; removed: number }> {
  const { add, remove } = diffUnits(currentUnitIds(shot), desired)
  for (const id of add) {
    if (!DRY_RUN) await associateUnit(shot.id, id)
  }
  for (const id of remove) {
    if (!DRY_RUN) await dissociateUnit(shot.id, id)
  }
  return { added: add.length, removed: remove.length }
}

async function readManifest(): Promise<CapturedScene[]> {
  const path = resolve(OUT_DIR, 'screenshots.json')
  let raw: string
  try {
    raw = await readFile(path, 'utf-8')
  } catch {
    throw new WeblateError(
      `No capture manifest at ${path}. Run \`npm run screenshots:capture\` first.`,
    )
  }
  return JSON.parse(raw) as CapturedScene[]
}

async function run(): Promise<void> {
  if (!hasToken()) {
    console.error(
      'WEBLATE_TOKEN not set. Create one at ' +
        `${WEBLATE_URL}/accounts/profile/#api and pass via env var:\n` +
        '  WEBLATE_TOKEN=<token> npm run screenshots:sync',
    )
    process.exit(1)
  }

  const manifest = await readManifest()
  if (manifest.length === 0) {
    // eslint-disable-next-line no-console
    console.log('Capture manifest is empty — nothing to sync.')
    return
  }

  // eslint-disable-next-line no-console
  console.log(
    `${DRY_RUN ? '[dry-run] ' : ''}Syncing ${manifest.length} screenshot(s) ` +
      `to ${WEBLATE_URL} (source translation)`,
  )

  const byKey = unitsByContext(await fetchSourceUnits())
  const existing = new Map(
    (await listSourceScreenshots()).map((s) => [s.name, s]),
  )

  let created = 0
  let imagesReplaced = 0
  let imagesSkipped = 0
  let unitsAdded = 0
  let unitsRemoved = 0
  let keysMissing = 0

  for (const scene of manifest) {
    // eslint-disable-next-line no-console
    console.log(`• ${scene.name}`)
    const { ids, missing } = resolveUnitIds(scene, byKey)
    keysMissing += missing

    let shot = existing.get(scene.name)
    const png = await readFile(resolve(OUT_DIR, scene.file))

    if (!shot) {
      if (DRY_RUN) {
        // eslint-disable-next-line no-console
        console.log(`  would create + associate ${ids.size} unit(s)`)
        created++
        unitsAdded += ids.size
        continue
      }
      shot = await createScreenshot(scene, png)
      created++
      for (const id of ids) await associateUnit(shot.id, id)
      unitsAdded += ids.size
      // eslint-disable-next-line no-console
      console.log(`  created, associated ${ids.size} unit(s)`)
      continue
    }

    const stored = await storedImageSha(shot)
    if (stored === null || stored !== scene.sha256) {
      if (!DRY_RUN) await replaceScreenshotImage(shot, scene, png)
      imagesReplaced++
      // eslint-disable-next-line no-console
      console.log(`  image ${DRY_RUN ? 'would be ' : ''}replaced`)
    } else {
      imagesSkipped++
    }

    const { added, removed } = await reconcileUnits(shot, ids)
    unitsAdded += added
    unitsRemoved += removed
    if (added || removed) {
      // eslint-disable-next-line no-console
      console.log(
        `  units ${DRY_RUN ? 'would change' : 'reconciled'}: +${added} -${removed}`,
      )
    }
  }

  // eslint-disable-next-line no-console
  console.log(
    `\nDone${DRY_RUN ? ' (dry-run)' : ''}. ` +
      `${created} created, ${imagesReplaced} image(s) replaced, ` +
      `${imagesSkipped} image(s) current; units +${unitsAdded} -${unitsRemoved}; ` +
      `${keysMissing} key(s) missing in Weblate.`,
  )
  if (keysMissing > 0) {
    // eslint-disable-next-line no-console
    console.warn(
      'Missing units are non-fatal; trigger a Weblate Repository → Update and re-run.',
    )
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  run().catch((err) => {
    if (err instanceof Error) {
      console.error(err.message)
      process.exit(1)
    }
    throw err
  })
}

export { run }
