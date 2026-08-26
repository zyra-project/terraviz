// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Heuristic to detect "real-time" SOS rows by title — the rows
 * whose Vimeo source is re-uploaded on a recurring (typically
 * daily) cadence by NOAA's automation.
 *
 * Shared by `cli/migrate-r2-hls.ts` (which uses it to skip
 * real-time rows at plan time, default-on via `--skip-realtime`)
 * and `cli/list-realtime-r2.ts` (the read-only triage helper).
 * Lives in `cli/lib/` rather than in either command so the
 * triage helper doesn't transitively drag in ffmpeg-hls /
 * r2-upload / vimeo-source just to ask "is this title real-time?"
 *
 * The SOS catalog has no explicit `update_cadence` field — the
 * row title is the only reliable signal (e.g. `Sea Surface
 * Temperature - Real-time`, `Precipitation - Real-time`, etc.).
 * The pattern catches hyphenated, space-separated, and joined
 * variants case-insensitively because publisher-side editors
 * aren't strictly consistent.
 */

export const REALTIME_TITLE_PATTERN = /real[-\s]?time/i

export function isRealtimeTitle(title: string): boolean {
  return REALTIME_TITLE_PATTERN.test(title)
}
