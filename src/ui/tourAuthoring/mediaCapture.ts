// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Pure capture helpers for the dock's Media group (task: tour media
 * authoring). Builds positionless `showImage` / `showVideo` tasks —
 * no SOS coordinate fields, so the player routes them into the
 * responsive media rail (`tourUI.usesMediaRail`) — plus the
 * hide-latest capture that pairs them.
 *
 * Kept separate from `dock.ts` so the ID-minting and hide-pairing
 * logic is unit-testable without mounting the dock.
 */

import type { ShowImageTaskParams, ShowPopupHtmlTaskParams, TourTaskDef } from '../../types'

/** Read a task's single key/value without trusting its shape. */
function taskEntry(task: TourTaskDef): [string, unknown] {
  const key = Object.keys(task)[0] ?? ''
  return [key, (task as Record<string, unknown>)[key]]
}

/**
 * Mint the next dock-issued image overlay ID (`media1`, `media2`, …)
 * — scans existing `showImage` tasks so re-opening a draft continues
 * the sequence instead of colliding with earlier captures.
 */
export function nextMediaId(tasks: readonly TourTaskDef[]): string {
  let max = 0
  for (const task of tasks) {
    const [key, value] = taskEntry(task)
    if (key !== 'showImage' && key !== 'showImg') continue
    const id = (value as ShowImageTaskParams | undefined)?.imageID
    const m = typeof id === 'string' ? /^media(\d+)$/.exec(id) : null
    if (m) max = Math.max(max, Number(m[1]))
  }
  return `media${max + 1}`
}

/** True for the http(s) URLs tour media may reference. */
export function isHttpMediaUrl(value: string): boolean {
  try {
    const u = new URL(value)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

/** Build a positionless `showImage` task (→ the media rail). */
export function buildShowImageTask(
  url: string,
  caption: string,
  tasks: readonly TourTaskDef[],
): TourTaskDef {
  const params: ShowImageTaskParams = {
    imageID: nextMediaId(tasks),
    filename: url,
    ...(caption.trim() ? { caption: caption.trim() } : {}),
  }
  return { showImage: params }
}

/** Build a positionless `showVideo` task (→ the media rail). */
export function buildShowVideoTask(url: string): TourTaskDef {
  return { showVideo: { filename: url } }
}

/**
 * Normalize a pasted embed URL for `showPopupHtml`.
 *
 * YouTube's watch / share / shorts pages refuse framing
 * (X-Frame-Options), so only the `/embed/` form works inside an
 * iframe — the common paste is rewritten to the privacy-enhanced
 * `youtube-nocookie.com/embed/{id}` host. Vimeo page URLs likewise
 * become `player.vimeo.com/video/{id}`. Known embed players need
 * JavaScript to run at all (`trusted: true` → the task opts into the
 * iframe's `allow-scripts`); any other http(s) page embeds fully
 * sandboxed. Non-http(s) → null (reject).
 */
export function normalizeEmbedUrl(raw: string): { url: string; trusted: boolean } | null {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return null
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
  const host = u.hostname.toLowerCase().replace(/^www\./, '')
  const ytId = (id: string | null | undefined): string | null =>
    id && /^[\w-]{6,20}$/.test(id) ? id : null

  if (host === 'youtu.be') {
    const id = ytId(u.pathname.split('/').filter(Boolean)[0])
    return id ? { url: `https://www.youtube-nocookie.com/embed/${id}`, trusted: true } : null
  }
  if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'youtube-nocookie.com') {
    const parts = u.pathname.split('/').filter(Boolean)
    const id =
      parts[0] === 'watch'
        ? ytId(u.searchParams.get('v'))
        : parts[0] === 'shorts' || parts[0] === 'embed' || parts[0] === 'live'
          ? ytId(parts[1])
          : null
    // A YouTube URL we can't map to a video id would just render the
    // frame-refusing page — reject so the author sees the error now.
    return id ? { url: `https://www.youtube-nocookie.com/embed/${id}`, trusted: true } : null
  }
  if (host === 'vimeo.com') {
    const id = u.pathname.split('/').filter(Boolean)[0]
    return id && /^\d+$/.test(id)
      ? { url: `https://player.vimeo.com/video/${id}`, trusted: true }
      : null
  }
  if (host === 'player.vimeo.com') {
    return { url: u.toString(), trusted: true }
  }
  return { url: u.toString(), trusted: false }
}

/** Mint the next dock-issued embed overlay ID (`embed1`, `embed2`, …). */
export function nextEmbedId(tasks: readonly TourTaskDef[]): string {
  let max = 0
  for (const task of tasks) {
    const [key, value] = taskEntry(task)
    if (key !== 'showPopupHtml') continue
    const id = (value as ShowPopupHtmlTaskParams | undefined)?.popupID
    const m = typeof id === 'string' ? /^embed(\d+)$/.exec(id) : null
    if (m) max = Math.max(max, Number(m[1]))
  }
  return `embed${max + 1}`
}

/**
 * Build a positionless `showPopupHtml` task (→ an embed card in the
 * media rail) from a pasted URL, or null when the URL is unusable.
 * The big-video answer: YouTube/Vimeo host and stream the file; the
 * tour just frames the player — no upload cap involved.
 */
export function buildEmbedTask(raw: string, tasks: readonly TourTaskDef[]): TourTaskDef | null {
  const normalized = normalizeEmbedUrl(raw)
  if (!normalized) return null
  const params: ShowPopupHtmlTaskParams = {
    popupID: nextEmbedId(tasks),
    url: normalized.url,
    ...(normalized.trusted ? { allowScripts: true } : {}),
  }
  return { showPopupHtml: params }
}

/**
 * Build the hide task for the most recently shown, still-visible
 * media overlay — the "Hide latest media" chip. Walks the task list
 * replaying show/hide pairs (including the SOS empty-string
 * "hide all videos" convention) and returns `{ hideImage: id }` /
 * `{ hideVideo: filename }` for the newest survivor, or null when
 * every shown media already has its hide.
 */
export function buildHideLatestMediaTask(tasks: readonly TourTaskDef[]): TourTaskDef | null {
  // Visible media in show order: kind + the identifier its hide task uses.
  const visible: Array<{ kind: 'image' | 'video' | 'popup'; ref: string }> = []
  const dropWhere = (pred: (v: { kind: 'image' | 'video' | 'popup'; ref: string }) => boolean): void => {
    for (let i = visible.length - 1; i >= 0; i--) {
      if (pred(visible[i])) visible.splice(i, 1)
    }
  }
  for (const task of tasks) {
    const [key, value] = taskEntry(task)
    switch (key) {
      case 'showImage':
      case 'showImg': {
        const id = (value as ShowImageTaskParams | undefined)?.imageID
        if (typeof id === 'string' && id) {
          dropWhere(v => v.kind === 'image' && v.ref === id)
          visible.push({ kind: 'image', ref: id })
        }
        break
      }
      case 'playVideo':
      case 'showVideo': {
        const filename = (value as { filename?: unknown } | undefined)?.filename
        if (typeof filename === 'string' && filename) {
          dropWhere(v => v.kind === 'video' && v.ref === filename)
          visible.push({ kind: 'video', ref: filename })
        }
        break
      }
      case 'hideImage':
      case 'hideImg':
        if (typeof value === 'string') dropWhere(v => v.kind === 'image' && v.ref === value)
        break
      case 'hideVideo':
      case 'hidePlayVideo':
      case 'stopVideo':
        if (typeof value === 'string') {
          // Empty string = hide ALL videos (SOS convention).
          dropWhere(v => v.kind === 'video' && (value === '' || v.ref === value))
        }
        break
      case 'showPopupHtml': {
        const id = (value as ShowPopupHtmlTaskParams | undefined)?.popupID
        if (typeof id === 'string' && id) {
          dropWhere(v => v.kind === 'popup' && v.ref === id)
          visible.push({ kind: 'popup', ref: id })
        }
        break
      }
      case 'hidePopupHtml':
        if (typeof value === 'string') dropWhere(v => v.kind === 'popup' && v.ref === value)
        break
      default:
        break
    }
  }
  const latest = visible[visible.length - 1]
  if (!latest) return null
  if (latest.kind === 'image') return { hideImage: latest.ref } as TourTaskDef
  if (latest.kind === 'popup') return { hidePopupHtml: latest.ref } as TourTaskDef
  return { hideVideo: latest.ref } as TourTaskDef
}
