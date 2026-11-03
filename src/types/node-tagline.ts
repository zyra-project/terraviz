// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The node's loading-screen tagline (`node_profile.tagline`): one rule
 * for what one may contain, shared by the profile API that stores it
 * (`functions/api/v1/_lib/node-profile-store.ts`) and the portal form
 * that writes it (`src/ui/publisher/pages/node-profile.ts`), so the
 * form can never send what the API refuses.
 *
 * A tagline is a single short line of **visible** text shown on every
 * load of the public app, and in every embed of it. Refused, besides
 * length:
 *
 * - every control character (`\p{Cc}`: C0 including tab and line
 *   breaks, DEL, C1), and the Unicode line and paragraph separators;
 * - every format character (`\p{Cf}`) but the five below: bidi
 *   embeddings, overrides and isolates, the zero-width space, word
 *   joiner and invisible operators, the BOM, the soft hyphen, the tag
 *   block, interlinear annotation marks and the rest. Each draws
 *   nothing, or reorders what it sits beside, so it makes the portal
 *   field show different text from what is stored and a second
 *   reviewer cannot see what they approve; the value is also public
 *   JSON, and a later consumer that inlines it would inherit a bidi
 *   override's reordering. (The tag block also builds the England,
 *   Scotland and Wales flag emoji, which are refused with it.)
 * - letters that draw as blanks (the Hangul fillers, blank braille,
 *   the combining grapheme joiner), so a tagline cannot be a blank
 *   line that passes the "not empty" check in place of the default;
 * - lone surrogates (`\p{Cs}`), which a JSON body can carry and which
 *   are stored as U+FFFD, so what was validated would not be what is
 *   stored.
 *
 * Deliberately **not** refused: ZWNJ and ZWJ (U+200C, U+200D), which
 * Persian, Indic scripts and emoji need, and the directional marks
 * (LRM, RLM, ALM: U+200E, U+200F, U+061C), which right-to-left text
 * uses legitimately.
 *
 * **Widen only.** `storedTagline` holds a stored tagline to these
 * rules on every read, the portal's included, and the portal sends the
 * field back on every save. Tightening either constant below would
 * therefore hide a tagline stored under the old rules from the portal
 * and let the next save of any field clear it, with no message. Its
 * previous value is in the audit row, but nobody would know to look.
 * To tighten them, migrate the stored value in the same change.
 */

/** Short enough to sit on one line under the title on a desktop splash. */
export const TAGLINE_MAX_LEN = 80

/** Characters a tagline may not contain (see the module comment). */
export const TAGLINE_FORBIDDEN_CHARS =
  /[\p{Cc}\p{Cs}\p{Zl}\p{Zp}\u034F\u115F\u1160\u2800\u3164\uFFA0]|(?![\u061C\u200C-\u200F])\p{Cf}/u

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
