// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The node's loading-screen tagline (`node_profile.tagline`): one rule
 * for what one may contain, shared by the profile API that stores it
 * (`functions/api/v1/_lib/node-profile-store.ts`) and the portal form
 * that writes it (`src/ui/publisher/pages/node-profile.ts`), so the
 * form can never send what the API refuses.
 *
 * A tagline is a single short line of display text shown on every load
 * of the public app, and in every embed of it. Refused, besides length:
 *
 * - every control character (`\p{Cc}`: C0 including tab and line
 *   breaks, DEL, C1), and the Unicode line and paragraph separators;
 * - bidi embeddings, overrides and isolates (U+202A–U+202E,
 *   U+2066–U+2069): each renderer today isolates the string, but the
 *   value is public JSON, and a later consumer that inlines it beside
 *   other text would inherit the reordering;
 * - invisible characters (zero-width space, word joiner and the
 *   invisible operators, the BOM, and the tag block U+E0000–U+E007F),
 *   which make the portal field show different text from what is
 *   stored, so a second reviewer cannot see what they approve.
 *
 * Deliberately **not** refused: ZWNJ and ZWJ (U+200C, U+200D), which
 * Persian, Indic scripts and emoji need, and the directional marks
 * (LRM, RLM, ALM), which right-to-left text uses legitimately.
 */

/** Short enough to sit on one line under the title on a desktop splash. */
export const TAGLINE_MAX_LEN = 80

/** Characters a tagline may not contain (see the module comment). */
export const TAGLINE_FORBIDDEN_CHARS =
  /[\p{Cc}\u2028\u2029\u202A-\u202E\u2066-\u2069\u200B\u2060-\u2064\uFEFF\u{E0000}-\u{E007F}]/u

/** Whitespace-like forbidden characters, which become a space. */
const TAGLINE_BREAKS = /[\t\n\v\f\r\u0085\u2028\u2029]/gu

/** Every forbidden character, for removal. */
const TAGLINE_FORBIDDEN_ALL = new RegExp(TAGLINE_FORBIDDEN_CHARS.source, 'gu')

/** True when `value` contains nothing a tagline may not. Length and
 *  emptiness are the caller's to check. */
export function hasOnlyTaglineChars(value: string): boolean {
  return !TAGLINE_FORBIDDEN_CHARS.test(value)
}

/**
 * What the portal form sends for what was typed or pasted: a tab or
 * line break becomes a space, every other forbidden character is
 * removed, runs of spaces collapse, and the ends are trimmed. A field
 * that shows one line therefore always saves as one, rather than
 * drawing an error for a character nobody can see.
 */
export function cleanTaglineInput(raw: string): string {
  return raw
    .replace(TAGLINE_BREAKS, ' ')
    .replace(TAGLINE_FORBIDDEN_ALL, '')
    .replace(/ {2,}/g, ' ')
    .trim()
}
