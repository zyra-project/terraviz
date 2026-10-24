// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The Embedding card on /publish/node-profile: which other sites may
 * show this node's public app in an iframe (`src/types/node-embedding.ts`).
 *
 * Three postures in a radio group, a list editor for `list`, its own
 * Save (`PUT /api/v1/publish/node-settings` with `{ embedding }` only,
 * so it never touches the Features card's toggles), and a readout of
 * what the node is actually sending.
 *
 * **The readout is the part that earns the card.** The setting is one
 * of several things that decide whether a frame loads: an edge rule,
 * Cloudflare's "Add security headers" managed transform (which sends
 * `X-Frame-Options: SAMEORIGIN`), or a line in `public/_headers` can
 * each block an embed this setting allows, and none of them shows up
 * here. So the card asks the node: a same-origin `HEAD /` reads the
 * `Content-Security-Policy` and `X-Frame-Options` a visitor gets, and
 * {@link analyzeLivePolicy} says where they disagree with the saved
 * setting. It runs once on render, quietly, and again on request,
 * when its verdict is announced.
 *
 * **Validation runs here and on the server with the same function.**
 * The client check is for inline errors before a round trip; the API
 * is the boundary, and its field errors (`embedding.origins[<n>]`) are
 * mapped back to the row that sent them. Leading and trailing spaces
 * are trimmed and empty rows skipped before either runs. Anything else
 * the validator refuses is shown, never repaired.
 *
 * **No presets for Facebook or Claude**, and the card says why: social
 * feeds show a preview card and open the link full-page rather than
 * framing it, so `frame-ancestors` never applies there; and AI apps
 * frame embeds through hosts they do not promise to keep. A preset
 * would be wrong on day one or break silently later.
 *
 * Admins edit; any other caller who can open the page sees the policy
 * read-only. The API enforces that (`isAdmin` on the PUT), so the
 * read-only view is a courtesy rather than the control.
 */

import { t, type MessageKey } from '../../../i18n'
import {
  EMBED_MODES,
  FILE_SOURCE,
  MAX_EMBED_ORIGINS,
  defaultEmbedPolicy,
  frameAncestorsHeader,
  validateEmbedOrigin,
  type EmbedMode,
  type EmbedOriginErrorCode,
  type EmbedPolicy,
} from '../../../types/node-embedding'
import { handleSessionError, publisherSend } from '../api'
import type { EmbedPolicyProblem, NodeSettingsResponse } from '../types'

const SETTINGS_ENDPOINT = '/api/v1/publish/node-settings'

export interface EmbeddingCardOptions {
  policy: EmbedPolicy
  /** Set when the enforced policy is not what was saved
   *  (`embeddingProblem` on the node-settings response). */
  problem?: EmbedPolicyProblem
  /** Admins edit; everyone else gets the read-only view. */
  canEdit: boolean
  fetchFn?: typeof fetch
  navigate?: (url: string) => void
}

// ----- The live-policy readout (pure) -----

/** What `HEAD /` came back with. `null` means the header was absent. */
export interface LiveHeaders {
  csp: string | null
  xfo: string | null
}

/** One thing the readout says. `ok` is the all-clear; the rest are
 *  findings, which can stack. `xfo-ignored` is a note, not a problem:
 *  it can sit beside `ok`. */
export type LiveFinding =
  | { kind: 'ok' }
  | { kind: 'pending' }
  | { kind: 'xfo'; value: string }
  | { kind: 'xfo-ignored'; value: string }
  | { kind: 'extra'; value: string }

/** Every `frame-ancestors` directive across the policies in a CSP
 *  value, as written (sources lowercased for comparison). A comma
 *  separates policies; a semicolon separates directives. */
export function frameAncestorsDirectives(csp: string | null): string[] {
  if (!csp) return []
  const out: string[] = []
  for (const policy of csp.split(',')) {
    for (const directive of policy.split(';')) {
      const tokens = directive.trim().split(/\s+/)
      if (tokens[0]?.toLowerCase() === 'frame-ancestors') out.push(tokens.join(' ').toLowerCase())
    }
  }
  return out
}

/**
 * Compare what the node sends with what it was set to send.
 *
 * - `xfo`: an `X-Frame-Options` browsers will follow: the setting is
 *   `any` and no other policy sends `frame-ancestors`, so it blocks
 *   other sites.
 * - `xfo-ignored`: an `X-Frame-Options` beside a `frame-ancestors`, the
 *   setting's own or another policy's. Current browsers ignore it and
 *   only older ones follow it, so it is a note rather than a problem:
 *   the setting still reads as matching. A Cloudflare zone shared with
 *   other sites can add it to every response with no way for the node
 *   to remove it, and a warning on every check there would teach an
 *   admin to stop reading the readout.
 *
 * The two are told apart by where the saved setting is heading, not by
 * this instant. Just after a change to `any`, the old directive is
 * still served and browsers still ignore the header; minutes later
 * they follow it, so that is when the warning belongs. Likewise a new
 * `list` or `self` will send a directive, so its header is a note even
 * before the save arrives (`pending` already says it has not).
 * - `extra`: a `frame-ancestors` directive this setting did not
 *   produce. Every policy is enforced, so it narrows what the setting
 *   allows; it comes from an edge rule or `_headers`.
 * - `pending`: the setting's own directive is missing, or the one the
 *   setting replaced (`previous`) is still being sent. A save takes a
 *   few minutes to reach every server, so this is usually just early.
 * - `ok`: nothing above but `xfo-ignored`, which follows it.
 */
export function analyzeLivePolicy(policy: EmbedPolicy, live: LiveHeaders, previous?: EmbedPolicy): LiveFinding[] {
  const expected = frameAncestorsHeader(policy)?.toLowerCase() ?? null
  const replaced = previous ? (frameAncestorsHeader(previous)?.toLowerCase() ?? null) : null
  const directives = frameAncestorsDirectives(live.csp)
  const findings: LiveFinding[] = []

  const ours = expected !== null && directives.includes(expected)
  const others = directives.filter(directive => directive !== expected)
  // Under `any` the node sends no directive of its own, so any
  // directive at all is someone else's, except the one a save just
  // replaced, which is still on its way out; under `list` or `self`,
  // one that differs from ours is.
  if (expected === null) {
    if (replaced !== null && others.includes(replaced)) findings.push({ kind: 'pending' })
    for (const directive of others) {
      if (directive !== replaced) findings.push({ kind: 'extra', value: directive })
    }
  } else {
    if (!ours) findings.push({ kind: 'pending' })
    // Before a save has propagated, the old setting's directive is
    // still live; that is the same "pending", not a second policy.
    if (ours) for (const directive of others) findings.push({ kind: 'extra', value: directive })
  }

  // Overridden once the save has landed: by the setting's own
  // directive, or by another policy's. The one a save to `any` just
  // replaced is on its way out, so it does not count.
  const notes: LiveFinding[] = []
  if (live.xfo) {
    const overridden = expected !== null || others.some(directive => directive !== replaced)
    if (overridden) notes.push({ kind: 'xfo-ignored', value: live.xfo })
    else findings.push({ kind: 'xfo', value: live.xfo })
  }
  return findings.length > 0 ? [...findings, ...notes] : [{ kind: 'ok' }, ...notes]
}

/** Ask the node what a visitor's browser receives on `/`. Throws on an
 *  error status: an error page's headers are not the app's, and reading
 *  them would report a verdict on a page no visitor is meant to see. */
export async function readLiveHeaders(fetchFn: typeof fetch = fetch): Promise<LiveHeaders> {
  const res = await fetchFn('/', { method: 'HEAD', cache: 'no-store', credentials: 'same-origin' })
  if (!res.ok) throw new Error(`HEAD / answered ${res.status}`)
  return {
    csp: res.headers.get('Content-Security-Policy'),
    xfo: res.headers.get('X-Frame-Options'),
  }
}

// ----- Wording -----

function modeLabel(mode: EmbedMode): string {
  switch (mode) {
    case 'any':
      return t('publisher.nodeProfile.embedding.mode.any')
    case 'list':
      return t('publisher.nodeProfile.embedding.mode.list')
    case 'self':
      return t('publisher.nodeProfile.embedding.mode.self')
  }
}

function modeDescription(mode: EmbedMode): string {
  switch (mode) {
    case 'any':
      return t('publisher.nodeProfile.embedding.mode.any.desc')
    case 'list':
      return t('publisher.nodeProfile.embedding.mode.list.desc')
    case 'self':
      return t('publisher.nodeProfile.embedding.mode.self.desc')
  }
}

/** The portal's wording for each refusal, keyed so a code added to
 *  the validator fails to compile here rather than showing English. */
const ORIGIN_ERROR_KEYS = {
  required: 'publisher.nodeProfile.embedding.error.empty',
  too_long: 'publisher.nodeProfile.embedding.error.tooLong',
  whitespace: 'publisher.nodeProfile.embedding.error.whitespace',
  forbidden_char: 'publisher.nodeProfile.embedding.error.forbiddenChar',
  keyword: 'publisher.nodeProfile.embedding.error.keyword',
  not_ascii: 'publisher.nodeProfile.embedding.error.notAscii',
  not_https: 'publisher.nodeProfile.embedding.error.notHttps',
  file_form: 'publisher.nodeProfile.embedding.error.fileForm',
  has_userinfo: 'publisher.nodeProfile.embedding.error.userinfo',
  has_path: 'publisher.nodeProfile.embedding.error.path',
  bad_port: 'publisher.nodeProfile.embedding.error.port',
  bad_host: 'publisher.nodeProfile.embedding.error.host',
  wildcard_too_broad: 'publisher.nodeProfile.embedding.error.wildcard',
  ip_or_single_label: 'publisher.nodeProfile.embedding.error.ipOrSingleLabel',
  shared_host: 'publisher.nodeProfile.embedding.error.sharedHost',
} as const satisfies Record<EmbedOriginErrorCode, string>

/** The literal tokens the card's strings name. Placeholders rather
 *  than text, so a translation cannot alter them (French spaces a
 *  colon, which breaks `file:`), and set by {@link sentence} in an
 *  element of their own, so an RTL sentence cannot move their edge
 *  punctuation: each ends in `:`, `//` or `--`, which the bidi
 *  algorithm lays out by the Arabic around it rather than the letters
 *  beside it. An example address stays literal while it stays in
 *  Latin letters, which its translator note asks: it starts and ends
 *  with a letter, so it keeps its order unaided. */
const LITERAL_TOKENS = {
  entry: FILE_SOURCE,
  scheme: 'file://', // i18n-exempt: literal token
  https: 'https://', // i18n-exempt: literal token
  prefix: 'xn--', // i18n-exempt: literal token
}

/** What a row error or a finding says: plain text, or a
 *  {@link sentence}. */
type Message = string | Node[]

function originError(code: string, fallback: string): Message {
  if (code in ORIGIN_ERROR_KEYS) return sentence(ORIGIN_ERROR_KEYS[code as EmbedOriginErrorCode], LITERAL_TOKENS)
  return fallback
}

/** Which findings are drawn as warnings: a table rather than a test,
 *  so a kind added to `LiveFinding` has to take a side. */
const IS_WARNING = {
  ok: false,
  'xfo-ignored': false,
  pending: true,
  xfo: true,
  extra: true,
} satisfies Record<LiveFinding['kind'], boolean>

function findingMessage(finding: LiveFinding): Node[] {
  switch (finding.kind) {
    case 'ok':
      return sentence('publisher.nodeProfile.embedding.live.ok')
    case 'pending':
      return sentence('publisher.nodeProfile.embedding.live.pending')
    case 'xfo':
      return sentence('publisher.nodeProfile.embedding.live.xfo', { value: finding.value })
    case 'xfo-ignored':
      return sentence('publisher.nodeProfile.embedding.live.xfoIgnored', { value: finding.value })
    case 'extra':
      return sentence('publisher.nodeProfile.embedding.live.extra', { value: finding.value })
  }
}

/** What a {@link Message} reads as, for a status region. */
function messageText(message: Message): string {
  return typeof message === 'string' ? message : message.map(node => node.textContent ?? '').join('')
}

// ----- DOM -----

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { className?: string } = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  Object.assign(node, props)
  for (const c of children) node.append(c)
  return node
}

let cardCount = 0

/**
 * A translated sentence as nodes, with each value it names (a URL, a
 * header value, a literal token) in a `<span dir="ltr">`. HTML isolates
 * an element that carries `dir`, so the value keeps its own
 * left-to-right order inside a right-to-left sentence. It replaced
 * U+2068/U+2069 isolate characters in the text, which did the same for
 * layout but reached assistive technology and the clipboard: a braille
 * display showed each as an eight-cell escape, character navigation
 * read "symbol 2068", and a token copied from the card carried them
 * into a row, which refused it as non-ASCII. The W3C's advice is the
 * same: use markup where it is available. A placeholder with no value
 * given stays as written, as `interpolate` leaves it.
 */
function sentence(key: MessageKey, values: Readonly<Record<string, string>> = {}): Node[] {
  const template = t(key)
  const nodes: Node[] = []
  let at = 0
  for (const match of template.matchAll(/\{(\w+)\}/g)) {
    const value = values[match[1]]
    const index = match.index ?? 0
    if (value === undefined) continue
    if (index > at) nodes.push(document.createTextNode(template.slice(at, index)))
    nodes.push(el('span', { dir: 'ltr', textContent: value }))
    at = index + match[0].length
  }
  if (at < template.length) nodes.push(document.createTextNode(template.slice(at)))
  return nodes
}

/** A button that stays focusable while its action runs. Setting
 *  `disabled` on the focused button sends focus to `<body>`, which
 *  loses a keyboard or screen-reader user's place; `aria-disabled`
 *  says the same thing and keeps focus where it was. */
function busyButton(button: HTMLButtonElement) {
  let busy = false
  return {
    get busy(): boolean {
      return busy
    },
    set(next: boolean): void {
      busy = next
      if (next) button.setAttribute('aria-disabled', 'true')
      else button.removeAttribute('aria-disabled')
    },
  }
}

/** Build the card. Its state lives in the closure; the saved policy
 *  it compares the live headers against moves only on a good save. */
export function buildEmbeddingCard(options: EmbeddingCardOptions): HTMLElement {
  const id = `nodeprofile-embed-${++cardCount}`
  let saved: EmbedPolicy = options.policy
  // The policy a save in this session replaced, so the readout can
  // tell its lingering directive from someone else's.
  let previous: EmbedPolicy | undefined
  const fetchFn = options.fetchFn

  const card = el('section', { className: 'publisher-card publisher-glass publisher-nodeprofile-embedding' })
  card.append(
    el('h2', { className: 'publisher-card-heading', textContent: t('publisher.nodeProfile.embedding.heading') }),
    el('p', { className: 'publisher-nodeprofile-hint', textContent: t('publisher.nodeProfile.embedding.intro') }),
  )
  // What was saved is not what is enforced: said first, because the
  // controls below show the enforced policy.
  const problem = options.problem
    ? el('p', {
        className: 'publisher-nodeprofile-embed-problem',
        textContent:
          options.problem === 'unreadable'
            ? t('publisher.nodeProfile.embedding.storedUnreadable')
            : t('publisher.nodeProfile.embedding.storedRefused'),
      })
    : null
  if (problem) card.append(problem)
  // Said before the setting, so a caller who cannot change it knows
  // why there is nothing to operate before reaching it.
  if (!options.canEdit) {
    card.append(el('p', { className: 'publisher-nodeprofile-hint', textContent: t('publisher.nodeProfile.embedding.readOnly') }))
  }

  // ----- Posture -----
  // Editable: radios. Each label holds only the name, and the
  // description is tied by `aria-describedby`; inside the label it
  // would be read twice, once in the name and once as the description.
  // Read-only: the posture as text, as the list is below, rather than
  // a group of disabled radios that Tab skips.
  const radios = new Map<EmbedMode, HTMLInputElement>()
  if (options.canEdit) {
    const fieldset = el('fieldset', { className: 'publisher-nodeprofile-embed-modes' })
    fieldset.append(el('legend', { className: 'publisher-field-label', textContent: t('publisher.nodeProfile.embedding.legend') }))
    for (const mode of EMBED_MODES) {
      const radio = el('input', {
        type: 'radio',
        name: `${id}-mode`,
        value: mode,
        id: `${id}-mode-${mode}`,
        className: 'publisher-nodeprofile-embed-radio',
        checked: saved.mode === mode,
      })
      radio.setAttribute('aria-describedby', `${id}-mode-${mode}-desc`)
      radios.set(mode, radio)
      fieldset.append(
        el('div', { className: 'publisher-nodeprofile-feature-row publisher-nodeprofile-embed-mode' }, [
          radio,
          el('span', { className: 'publisher-nodeprofile-feature-text' }, [
            el('label', { className: 'publisher-nodeprofile-feature-name', htmlFor: radio.id, textContent: modeLabel(mode) }),
            el('span', {
              className: 'publisher-nodeprofile-feature-desc',
              id: `${id}-mode-${mode}-desc`,
              textContent: modeDescription(mode),
            }),
          ]),
        ]),
      )
    }
    card.append(fieldset)
  } else {
    card.append(
      el('div', { className: 'publisher-nodeprofile-embed-modes' }, [
        el('span', { className: 'publisher-field-label', textContent: t('publisher.nodeProfile.embedding.legend') }),
        el('span', { className: 'publisher-nodeprofile-feature-text' }, [
          el('span', { className: 'publisher-nodeprofile-feature-name', textContent: modeLabel(saved.mode) }),
          el('span', { className: 'publisher-nodeprofile-feature-desc', textContent: modeDescription(saved.mode) }),
        ]),
      ]),
    )
  }
  const selectedMode = (): EmbedMode =>
    options.canEdit ? (EMBED_MODES.find(mode => radios.get(mode)?.checked) ?? 'any') : saved.mode

  // ----- Origins -----
  const originsBlock = el('div', { className: 'publisher-nodeprofile-embed-origins' })
  const originsLabelId = `${id}-origins-label`
  const originsHintId = `${id}-origins-hint`
  originsBlock.append(
    el('span', { className: 'publisher-field-label', id: originsLabelId, textContent: t('publisher.nodeProfile.embedding.origins.label') }),
  )
  if (options.canEdit) {
    originsBlock.append(
      el('p', { className: 'publisher-nodeprofile-hint', id: originsHintId }, sentence('publisher.nodeProfile.embedding.origins.hint', LITERAL_TOKENS)),
    )
  }

  interface OriginRow {
    row: HTMLElement
    number: HTMLElement
    input: HTMLInputElement
    error: HTMLElement
  }
  const rows: OriginRow[] = []
  // The hint is tied to the group once, not repeated on every field.
  const list = el('div', { className: 'publisher-nodeprofile-embed-list' })
  list.setAttribute('role', 'group')
  list.setAttribute('aria-labelledby', originsLabelId)
  list.setAttribute('aria-describedby', originsHintId)

  const addButton = el('button', {
    type: 'button',
    className: 'publisher-button publisher-button-small',
    textContent: t('publisher.nodeProfile.embedding.origins.add'),
  })
  const atMax = el('p', {
    className: 'publisher-nodeprofile-hint',
    id: `${id}-origins-max`,
    textContent: t('publisher.nodeProfile.embedding.origins.max', { max: MAX_EMBED_ORIGINS }),
  })
  atMax.hidden = true
  addButton.setAttribute('aria-describedby', atMax.id)

  /** Number every row as it reads, visibly and in its name, so "Site
   *  3" in a name or a voice command is the row marked 3. */
  const relabel = (): void => {
    rows.forEach(({ input, number, row }, index) => {
      number.textContent = `${index + 1}.`
      input.setAttribute('aria-label', t('publisher.nodeProfile.embedding.origins.inputAria', { n: index + 1 }))
      row
        .querySelector('.publisher-nodeprofile-embed-remove')
        ?.setAttribute('aria-label', t('publisher.nodeProfile.embedding.origins.removeAria', { n: index + 1 }))
    })
    const full = rows.length >= MAX_EMBED_ORIGINS
    addButton.disabled = full
    atMax.hidden = !full
  }

  const setRowError = (entry: OriginRow, message: Message | null): void => {
    entry.error.replaceChildren(...(typeof message === 'string' ? [message] : (message ?? [])))
    entry.error.hidden = message === null
    if (message === null) entry.input.removeAttribute('aria-invalid')
    else entry.input.setAttribute('aria-invalid', 'true')
  }

  const addRow = (value = ''): OriginRow => {
    const errorId = `${id}-origin-${Math.random().toString(36).slice(2, 10)}-error`
    const number = el('span', { className: 'publisher-nodeprofile-embed-num' })
    number.setAttribute('aria-hidden', 'true')
    const input = el('input', {
      type: 'text',
      className: 'publisher-nodeprofile-input publisher-nodeprofile-embed-input',
      value,
      placeholder: 'https://www.example.org', // i18n-exempt: an origin, not prose
      spellcheck: false,
      autocomplete: 'off',
      dir: 'ltr',
    })
    input.setAttribute('inputmode', 'url')
    input.setAttribute('aria-describedby', errorId)
    const error = el('p', { className: 'publisher-nodeprofile-status-error publisher-nodeprofile-embed-error', id: errorId })
    error.hidden = true
    const remove = el('button', {
      type: 'button',
      className: 'publisher-events-icon-btn publisher-events-icon-btn-reject publisher-nodeprofile-embed-remove',
      textContent: '✕', // i18n-exempt: glyph; the aria-label carries the meaning
    })
    const row = el('div', { className: 'publisher-nodeprofile-embed-row' }, [number, input, remove, error])
    const entry: OriginRow = { row, number, input, error }
    remove.addEventListener('click', () => {
      const index = rows.indexOf(entry)
      rows.splice(index, 1)
      row.remove()
      relabel()
      // Keep focus in the list rather than dropping it on the body.
      ;(rows[index]?.input ?? rows[index - 1]?.input ?? addButton).focus()
    })
    input.addEventListener('input', () => setRowError(entry, null))
    rows.push(entry)
    list.append(row)
    relabel()
    return entry
  }

  for (const origin of saved.origins) if (options.canEdit) addRow(origin)
  addButton.addEventListener('click', () => {
    if (rows.length >= MAX_EMBED_ORIGINS) return
    addRow().input.focus()
  })

  if (options.canEdit) {
    // How to allow a page opened from a file, in a disclosure of its
    // own rather than in the group's description: a screen reader
    // reads that on entering the group and again after every failed
    // Save, and most admins never need `file:`.
    const fileHelp = el('details', { className: 'publisher-nodeprofile-embed-file' }, [
      el('summary', { textContent: t('publisher.nodeProfile.embedding.origins.file.summary') }),
      el('p', { className: 'publisher-nodeprofile-hint' }, sentence('publisher.nodeProfile.embedding.origins.file.how', LITERAL_TOKENS)),
      el('p', { className: 'publisher-nodeprofile-hint', textContent: t('publisher.nodeProfile.embedding.origins.file.risk') }),
    ])
    originsBlock.append(list, addButton, atMax, fileHelp)
  } else {
    // Read-only: the list as text, so it reads as a list rather than a
    // run of disabled inputs.
    const readOnly = el('ul', { className: 'publisher-nodeprofile-embed-readonly' })
    readOnly.setAttribute('aria-labelledby', originsLabelId)
    for (const origin of saved.origins) readOnly.append(el('li', { textContent: origin, dir: 'ltr' }))
    originsBlock.append(readOnly)
    // `file:` is not a site, so say what it admits.
    if (saved.origins.includes(FILE_SOURCE)) {
      originsBlock.append(
        el('p', { className: 'publisher-nodeprofile-hint' }, sentence('publisher.nodeProfile.embedding.origins.file.readOnly', LITERAL_TOKENS)),
      )
    }
  }
  card.append(originsBlock)

  const syncOriginsVisibility = (): void => {
    const listing = selectedMode() === 'list'
    originsBlock.hidden = !listing
    if (listing && options.canEdit && rows.length === 0) addRow()
  }
  for (const radio of radios.values()) radio.addEventListener('change', syncOriginsVisibility)
  syncOriginsVisibility()

  // ----- Live policy (declared before Save, which refreshes it) -----
  const live = el('div', { className: 'publisher-nodeprofile-embed-live' })
  live.append(el('h3', { className: 'publisher-nodeprofile-embed-subheading', textContent: t('publisher.nodeProfile.embedding.live.heading') }))
  const liveValues = el('dl', { className: 'publisher-nodeprofile-embed-live-values' })
  const liveFindings = el('ul', { className: 'publisher-nodeprofile-embed-findings' })
  // Visually hidden: the verdict is already on screen in the findings
  // list, and this region only speaks it when a check was asked for.
  const liveStatus = el('div', { className: 'sr-only', role: 'status' })
  const checkBtn = el('button', {
    type: 'button',
    className: 'publisher-button publisher-button-small',
    textContent: t('publisher.nodeProfile.embedding.live.check'),
  })
  const checking = busyButton(checkBtn)
  live.append(liveValues, liveFindings, el('div', { className: 'publisher-nodeprofile-actions' }, [checkBtn, liveStatus]))

  const showValue = (name: string, value: string | null): HTMLElement[] => [
    el('dt', { textContent: name }),
    el('dd', {}, [
      value === null
        ? el('span', { textContent: t('publisher.nodeProfile.embedding.live.notSent') })
        : el('code', { textContent: value, dir: 'ltr' }),
    ]),
  ]

  /** Fill the readout. `announce` puts the verdict in the status region
   *  too, for a check the user asked for; the one on render is quiet. */
  const runCheck = async (announce: boolean): Promise<void> => {
    if (checking.busy) return
    checking.set(true)
    if (announce) liveStatus.textContent = t('publisher.nodeProfile.embedding.live.checking')
    try {
      const headers = await readLiveHeaders(fetchFn)
      const findings = analyzeLivePolicy(saved, headers, previous)
      liveValues.replaceChildren(
        ...showValue('Content-Security-Policy', headers.csp), // i18n-exempt: an HTTP header name
        ...showValue('X-Frame-Options', headers.xfo), // i18n-exempt: an HTTP header name
      )
      liveFindings.replaceChildren(
        ...findings.map(finding =>
          el(
            'li',
            {
              className: IS_WARNING[finding.kind] ? 'publisher-nodeprofile-embed-finding publisher-nodeprofile-embed-finding-warn' : 'publisher-nodeprofile-embed-finding',
            },
            findingMessage(finding),
          ),
        ),
      )
      if (announce) liveStatus.textContent = findings.map(finding => messageText(findingMessage(finding))).join(' ')
    } catch {
      liveValues.replaceChildren()
      liveFindings.replaceChildren(
        el('li', { className: 'publisher-nodeprofile-embed-finding publisher-nodeprofile-embed-finding-warn', textContent: t('publisher.nodeProfile.embedding.live.error') }),
      )
      if (announce) liveStatus.textContent = t('publisher.nodeProfile.embedding.live.error')
    } finally {
      checking.set(false)
    }
  }
  checkBtn.addEventListener('click', () => void runCheck(true))

  // ----- Save -----
  const status = el('div', { className: 'publisher-nodeprofile-status', role: 'status' })
  if (options.canEdit) {
    const saveBtn = el('button', {
      type: 'button',
      className: 'publisher-button publisher-button-primary',
      textContent: t('publisher.nodeProfile.embedding.save'),
    })
    const saving = busyButton(saveBtn)
    const fail = (message: string): void => {
      status.textContent = message
      status.classList.add('publisher-nodeprofile-status-error')
    }
    saveBtn.addEventListener('click', () => {
      if (saving.busy) return
      status.textContent = ''
      status.classList.remove('publisher-nodeprofile-status-error')
      const mode = selectedMode()

      // The rows that will be sent, in order, so a server error naming
      // `embedding.origins[<n>]` lands on the row that sent entry n.
      const sent: Array<{ entry: OriginRow; value: string }> = []
      let firstInvalid: OriginRow | null = null
      if (mode === 'list') {
        const seen = new Set<string>()
        for (const entry of rows) {
          const value = entry.input.value.trim()
          if (value === '') {
            setRowError(entry, null)
            continue
          }
          const result = validateEmbedOrigin(value)
          let message: Message | null = null
          // A duplicate quotes the site it repeats rather than a row
          // number, which a removal above would make wrong.
          if (!result.ok) message = originError(result.code, result.message)
          else if (seen.has(result.value)) {
            message = sentence('publisher.nodeProfile.embedding.error.duplicate', { site: result.value })
          } else seen.add(result.value)
          setRowError(entry, message)
          if (message !== null) firstInvalid ??= entry
          sent.push({ entry, value })
        }
        if (!firstInvalid && sent.length === 0) {
          // Tied to the first field as well, so moving focus there reads
          // it, every time Save is pressed.
          const required = t('publisher.nodeProfile.embedding.error.required')
          const first = rows[0] ?? addRow()
          setRowError(first, required)
          fail(required)
          first.input.focus()
          return
        }
        if (firstInvalid) {
          fail(t('publisher.nodeProfile.embedding.error.summary'))
          firstInvalid.input.focus()
          return
        }
      }

      const body = { embedding: { mode, origins: mode === 'list' ? sent.map(s => s.value) : [] } }
      saving.set(true)
      void publisherSend<NodeSettingsResponse>(SETTINGS_ENDPOINT, body, { method: 'PUT', fetchFn })
        .then(res => {
          if (res.ok) {
            // The server's canonical form (lowercased) is what it stored
            // and what the live check compares against.
            previous = saved
            problem?.remove()
            saved = embedPolicyFromSettings(res.data) ?? {
              mode,
              origins: body.embedding.origins.map(origin => origin.toLowerCase()),
            }
            sent.forEach(({ entry }, index) => {
              entry.input.value = saved.origins[index] ?? entry.input.value
            })
            status.textContent = t('publisher.nodeProfile.embedding.saved')
            // Compare the readout against the new setting, quietly; it
            // will usually say the change is still on its way.
            void runCheck(false)
            return
          }
          if (res.kind === 'session') {
            if (handleSessionError({ navigate: options.navigate }) === 'navigating') return
            fail(t('publisher.nodeProfile.error.session'))
          } else if (res.kind === 'validation' && res.errors.length > 0) {
            let placed = false
            for (const error of res.errors) {
              const match = /^embedding\.origins\[(\d+)\]$/.exec(error.field)
              const target = match ? sent[Number(match[1])]?.entry : undefined
              if (!target) continue
              setRowError(target, originError(error.code, error.message))
              if (!placed) target.input.focus()
              placed = true
            }
            fail(placed ? t('publisher.nodeProfile.embedding.error.summary') : listErrorText(res.errors[0]))
          } else {
            fail(t('publisher.nodeProfile.error.generic'))
          }
        })
        .finally(() => {
          saving.set(false)
        })
    })
    card.append(el('div', { className: 'publisher-nodeprofile-actions' }, [saveBtn, status]))
  }

  card.append(live)
  void runCheck(false)

  // ----- What this cannot do -----
  card.append(
    el('p', { className: 'publisher-nodeprofile-hint', textContent: t('publisher.nodeProfile.embedding.access') }),
    el('details', { className: 'publisher-nodeprofile-embed-presets' }, [
      el('summary', { textContent: t('publisher.nodeProfile.embedding.presets.summary') }),
      el('p', { className: 'publisher-nodeprofile-hint', textContent: t('publisher.nodeProfile.embedding.presets.social') }),
      el('p', { className: 'publisher-nodeprofile-hint', textContent: t('publisher.nodeProfile.embedding.presets.ai') }),
      el('p', { className: 'publisher-nodeprofile-hint', textContent: t('publisher.nodeProfile.embedding.presets.test') }),
    ]),
  )
  return card
}

/** A server error that names no row, in the portal's words. Only the
 *  list-level refusals have their own; anything else is the generic
 *  failure rather than the API's English. */
function listErrorText(error: { field: string; code: string }): string {
  if (error.field === 'embedding.origins' && error.code === 'required') {
    return t('publisher.nodeProfile.embedding.error.required')
  }
  if (error.field === 'embedding.origins' && error.code === 'too_many') {
    return t('publisher.nodeProfile.embedding.error.tooMany', { max: MAX_EMBED_ORIGINS })
  }
  return t('publisher.nodeProfile.error.generic')
}

/** The problem a node-settings response reports with its policy, if
 *  any. Anything but the two known values is ignored. */
export function embedProblemFromSettings(raw: unknown): EmbedPolicyProblem | undefined {
  if (raw == null || typeof raw !== 'object') return undefined
  const problem = (raw as { embeddingProblem?: unknown }).embeddingProblem
  return problem === 'unreadable' || problem === 'refused' ? problem : undefined
}

/** The card's policy from a node-settings response, or `null` when the
 *  response carries none (a deploy from before the setting existed),
 *  which hides the card rather than showing a setting it cannot save. */
export function embedPolicyFromSettings(raw: unknown): EmbedPolicy | null {
  if (raw == null || typeof raw !== 'object' || !('embedding' in raw)) return null
  const embedding = (raw as { embedding: unknown }).embedding
  if (embedding == null || typeof embedding !== 'object') return defaultEmbedPolicy()
  const rec = embedding as { mode?: unknown; origins?: unknown }
  const mode = EMBED_MODES.find(m => m === rec.mode) ?? 'any'
  const origins = mode === 'list' && Array.isArray(rec.origins)
    ? rec.origins.filter((o): o is string => typeof o === 'string')
    : []
  return { mode, origins }
}
