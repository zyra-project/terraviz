// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * SOS tour.json parser — discovers every URL-bearing field in a
 * tour file and classifies it for migration.
 *
 * Phase 3c commit A. The companion to 3b's `asset-fetch.ts` /
 * `srt-to-vtt.ts` libraries: pure, deterministic, no I/O. The
 * 3c/B pump (`migrate-r2-tours.ts`) feeds tour.json bytes in and
 * gets back a structured catalog of every asset URL that needs
 * fetching, plus a classification per URL so external links
 * (YouTube embeds, popup links) and absolute SOS-CDN URLs are
 * surfaced separately from relative siblings.
 *
 * Classification policy (Phase 3c policy 1 — "strict relative-only"):
 *
 *   relative           → migrate (sibling of tour.json on NOAA's CDN)
 *   absolute_external  → leave untouched (YouTube, external popups,
 *                        third-party content the operator cannot
 *                        and shouldn't make local)
 *   absolute_sos_cdn   → leave untouched for now; surfaced as a
 *                        diagnostic count so the operator can
 *                        gauge residual noaa.gov dependency. A
 *                        future "policy 2" pass could migrate
 *                        these too, but that needs path rewriting
 *                        inside the tour.json and isn't in 3c/A.
 *
 * URL-bearing task fields (per `TourTaskDef` in src/types/index.ts
 * plus six additional task types surfaced by the 3c/A sweep of
 * production tours — `addBubble`, `showInfoBtn`, `hideInfoBtn`,
 * `loadTour`, `showLegend`, `worldBorders`):
 *
 *   - playAudio.filename
 *   - playVideo.filename, showVideo.filename
 *   - hideVideo / hidePlayVideo / stopVideo (bare string)
 *   - showImage.filename, showImg.filename
 *   - hideImage / hideImg (bare string)
 *   - question.imgQuestionFilename, question.imgAnswerFilename
 *   - showPopupHtml.url (often external — popup web links)
 *   - addPlacemark.iconFilename
 *   - addBubble.media360 (mixed: external Vimeo URL or relative
 *     360-pano image; classified per-value)
 *   - showInfoBtn.content (typically external — YouTube embed)
 *   - showInfoBtn.iconFilename (relative button icon)
 *   - hideInfoBtn (bare string — info-button id)
 *
 * Non-URL-bearing known task types we silently skip:
 *
 *   - loadTour (bare-string dataset id, looked up by the SPA via
 *     the catalog — not a URL the migration needs to touch)
 *   - showLegend (boolean toggle)
 *   - worldBorders (string enum: "off"/"on"/…)
 *
 * Tour task types this parser doesn't know about are listed in
 * `unknownTasks` for diagnostics but otherwise ignored. The
 * tour engine in `src/services/tourEngine.ts` also ignores
 * unknown tasks (`switch` default), so this conservative
 * behaviour matches the runtime contract.
 */

/** Hosts the SOS catalog imports from. Matches the audit from
 * `public/assets/sos-dataset-list.json`'s `runTourOnLoad` field.
 * Absolute URLs on these hosts are classified as
 * `absolute_sos_cdn` (residual noaa.gov dependency); anything else
 * absolute is `absolute_external`. */
const SOS_CDN_HOSTS: ReadonlySet<string> = new Set([
  'd3sik7mbbzunjo.cloudfront.net',
  's3.amazonaws.com',
])

/** Tour task names whose taskValue is `{ filename: string, ... }`. */
const FILENAME_TASKS: ReadonlySet<string> = new Set([
  'playAudio',
  'playVideo',
  'showVideo',
  'showImage',
  'showImg',
])

/** Tour task names whose taskValue is a bare string referencing
 * a previously-shown asset. The migration uses these to validate
 * that hide-* tasks reference assets the parser already captured
 * via the corresponding show-* task. */
const BARE_STRING_TASKS: ReadonlySet<string> = new Set([
  'hideVideo',
  'hidePlayVideo',
  'stopVideo',
  'hideImage',
  'hideImg',
  'hideInfoBtn',
])

export type AssetKind = 'relative' | 'absolute_external' | 'absolute_sos_cdn'

export interface DiscoveredAsset {
  /** The URL/filename verbatim from the tour.json field. */
  rawValue: string
  /** Where in the tour the value was found — used by the
   * migration CLI's dry-run output and operator triage. */
  source: {
    taskIndex: number
    taskName: string
    field: string
  }
  kind: AssetKind
}

export interface TourParseResult {
  /** Every URL-bearing field encountered, classified. The
   * migration pump iterates only the `relative` entries when
   * deciding what to fetch + upload to R2. */
  assets: DiscoveredAsset[]
  /** Task entries whose taskName isn't in the known set. Surfaced
   * for diagnostics; the parser doesn't try to extract URLs from
   * them. */
  unknownTasks: Array<{ taskIndex: number; taskName: string }>
}

/**
 * Classify a URL/filename value. Pure — no I/O.
 *
 * Returns `relative` when the value can't be parsed as a standalone
 * URL (i.e. resolution requires a base — which is how the tour
 * engine's `resolveMediaUrl` produces the absolute URL at runtime).
 * Returns `absolute_external` / `absolute_sos_cdn` based on the
 * hostname.
 */
export function classifyAssetUrl(value: string): AssetKind {
  // Empty / whitespace-only → treat as relative (the migration
  // pump filters empties before fetching anyway, but this is the
  // honest classification: there's no parseable absolute URL here).
  if (!value || !value.trim()) return 'relative'
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return 'relative'
  }
  // Browsers parse `mailto:` and `data:` URIs successfully. Treat
  // those as external — they're not migratable assets, and they're
  // not relative-to-base either.
  if (SOS_CDN_HOSTS.has(url.hostname)) return 'absolute_sos_cdn'
  return 'absolute_external'
}

/**
 * Walk the parsed tour-file object and produce the discovery list.
 * Accepts an `unknown` so the caller can hand in `JSON.parse(text)`
 * output directly; the parser is defensive against any shape that
 * doesn't match the documented contract.
 */
export function parseTourFile(parsed: unknown): TourParseResult {
  const result: TourParseResult = { assets: [], unknownTasks: [] }
  if (!parsed || typeof parsed !== 'object') return result
  const root = parsed as Record<string, unknown>
  const tasks = root.tourTasks
  if (!Array.isArray(tasks)) return result

  for (let i = 0; i < tasks.length; i++) {
    const entry = tasks[i]
    if (!entry || typeof entry !== 'object') continue
    const keys = Object.keys(entry as Record<string, unknown>)
    if (keys.length !== 1) {
      // SOS spec is "each task has exactly one key." Anything else
      // is malformed; surface as unknown for diagnostics.
      result.unknownTasks.push({ taskIndex: i, taskName: keys.join('|') || '(empty)' })
      continue
    }
    const taskName = keys[0]
    const taskValue = (entry as Record<string, unknown>)[taskName]

    if (FILENAME_TASKS.has(taskName)) {
      // taskValue is `{ filename: string, ... }`.
      const filename =
        taskValue && typeof taskValue === 'object'
          ? ((taskValue as Record<string, unknown>).filename as string | undefined)
          : undefined
      if (typeof filename === 'string' && filename.length > 0) {
        result.assets.push({
          rawValue: filename,
          source: { taskIndex: i, taskName, field: 'filename' },
          kind: classifyAssetUrl(filename),
        })
      }
      continue
    }

    if (taskName === 'question' && taskValue && typeof taskValue === 'object') {
      const v = taskValue as Record<string, unknown>
      for (const field of ['imgQuestionFilename', 'imgAnswerFilename']) {
        const candidate = v[field]
        if (typeof candidate === 'string' && candidate.length > 0) {
          result.assets.push({
            rawValue: candidate,
            source: { taskIndex: i, taskName, field },
            kind: classifyAssetUrl(candidate),
          })
        }
      }
      continue
    }

    if (taskName === 'showPopupHtml' && taskValue && typeof taskValue === 'object') {
      const v = taskValue as Record<string, unknown>
      const url = v.url
      if (typeof url === 'string' && url.length > 0) {
        result.assets.push({
          rawValue: url,
          source: { taskIndex: i, taskName, field: 'url' },
          kind: classifyAssetUrl(url),
        })
      }
      // `html` inline content isn't a URL — no migration needed.
      continue
    }

    if (taskName === 'addPlacemark' && taskValue && typeof taskValue === 'object') {
      const v = taskValue as Record<string, unknown>
      const iconFilename = v.iconFilename
      if (typeof iconFilename === 'string' && iconFilename.length > 0) {
        result.assets.push({
          rawValue: iconFilename,
          source: { taskIndex: i, taskName, field: 'iconFilename' },
          kind: classifyAssetUrl(iconFilename),
        })
      }
      continue
    }

    if (taskName === 'addBubble' && taskValue && typeof taskValue === 'object') {
      // 360-pano "bubble" task. `media360` is the only URL field —
      // can be either a Vimeo embed URL (absolute_external) or a
      // sibling .jpg pano (relative); classifyAssetUrl handles both.
      const v = taskValue as Record<string, unknown>
      const media360 = v.media360
      if (typeof media360 === 'string' && media360.length > 0) {
        result.assets.push({
          rawValue: media360,
          source: { taskIndex: i, taskName, field: 'media360' },
          kind: classifyAssetUrl(media360),
        })
      }
      continue
    }

    if (taskName === 'showInfoBtn' && taskValue && typeof taskValue === 'object') {
      // Info-button overlay. Two URL fields:
      //   - `content` is the body the button opens (usually a
      //     YouTube embed URL — absolute_external). The SOS spec
      //     also allows image / html types but the sweep only
      //     surfaced YouTube embeds; we classify per-value either
      //     way.
      //   - `iconFilename` is the button icon (typically a sibling
      //     image like `logo.jpg`).
      const v = taskValue as Record<string, unknown>
      for (const field of ['content', 'iconFilename']) {
        const candidate = v[field]
        if (typeof candidate === 'string' && candidate.length > 0) {
          result.assets.push({
            rawValue: candidate,
            source: { taskIndex: i, taskName, field },
            kind: classifyAssetUrl(candidate),
          })
        }
      }
      continue
    }

    if (BARE_STRING_TASKS.has(taskName)) {
      // hide-* tasks reference a previously-shown asset. We don't
      // emit a separate migration entry for them — the show-* task
      // already produced one for the same filename — but we don't
      // count them as unknown either; they're correctly-typed
      // tasks that simply don't add new assets to migrate.
      continue
    }

    // Task types we know about but have no URL-bearing field
    // (flyTo, pauseSeconds, setEnvView, etc.) — silently skip.
    if (isKnownTaskName(taskName)) continue

    result.unknownTasks.push({ taskIndex: i, taskName })
  }

  return result
}

/** Closed list of task names from `TourTaskDef` in src/types/index.ts.
 * Anything not in this set is surfaced as `unknownTasks` so a future
 * tour-format extension shows up at migration time rather than
 * silently dropping URLs. */
const KNOWN_TASK_NAMES: ReadonlySet<string> = new Set([
  // Asset-bearing
  'playAudio', 'playVideo', 'showVideo', 'showImage', 'showImg',
  'question', 'showPopupHtml', 'addPlacemark', 'addBubble', 'showInfoBtn',
  // Bare-string asset-reference (hide-*)
  'hideVideo', 'hidePlayVideo', 'stopVideo', 'hideImage', 'hideImg',
  'hidePopupHtml', 'hidePlacemark', 'hideRect', 'hideInfoBtn',
  // Non-asset
  'flyTo', 'tiltRotateCamera', 'resetCameraZoomOut', 'resetCameraAndZoomOut',
  'showRect', 'pauseForInput', 'pauseSeconds', 'pauseSec', 'stopAudio',
  'loadDataset', 'unloadAllDatasets', 'unloadDataset', 'datasetAnimation',
  'envShowDayNightLighting', 'envShowClouds', 'envShowEarth',
  'envShowWorldBorder', 'envShowStars', 'worldBorder', 'worldBorders',
  'setGlobeRotationRate', 'loopToBeginning', 'enableTourPlayer',
  'tourPlayerWindow', 'setEnvView', 'showLegend',
  // loadTour's value is a bare-string SOS dataset id, NOT a URL —
  // the SPA looks it up in the catalog at execution time. So it's
  // a known non-asset task: we don't capture anything to migrate.
  'loadTour',
])

function isKnownTaskName(name: string): boolean {
  return KNOWN_TASK_NAMES.has(name)
}

/**
 * Sibling-key generator: from a relative tour.json reference, what
 * key suffix should we PUT the migrated bytes at under the tour's
 * R2 prefix? The tour engine resolves filenames against the
 * tour.json's URL with the standard `new URL(s, base)` algorithm,
 * which means a sibling-relative path like `audio.mp3` becomes
 * `<tourBaseUrl>/audio.mp3` at runtime. We preserve that path
 * verbatim under the new R2 prefix so the unchanged tour.json
 * still resolves correctly.
 *
 * Returns null for inputs that can't be safely turned into a key —
 * empty strings, absolute URLs, or paths with `..` traversal
 * (defensive; SOS tours don't author these but a future
 * publisher-side bug could).
 */
export function siblingKeyForRelativeAsset(rawValue: string): string | null {
  if (!rawValue || !rawValue.trim()) return null
  // Anything that parses as a URL standalone is absolute — caller
  // shouldn't be asking for a sibling key.
  try {
    new URL(rawValue)
    return null
  } catch {
    /* expected for relative paths */
  }
  // Reject path traversal. `foo/../bar.png` resolves outside the
  // tour's prefix and we won't migrate it.
  const segments = rawValue.split('/').filter(s => s.length > 0)
  if (segments.some(s => s === '..' || s === '.')) return null
  return segments.join('/')
}
