/**
 * AI blog-draft generation (Phase 3d; `docs/CURRENT_EVENTS_PLAN.md` §7).
 *
 * One Workers AI call turns the curator's selections — datasets, an
 * optional cited current event, the node profile (0028) — into a
 * markdown draft `{ title, summary, bodyMd }`. The draft is returned
 * to the portal editor, NOT persisted: the curator edits and saves
 * through the normal create route, and publishing stays a separate
 * curator action. Same trust discipline as Orbit and the event-tour
 * captions: the model is given ONLY the node's own profile text, the
 * approved catalog metadata, and the cited event's own words — and is
 * told to invent nothing beyond them.
 *
 * Unlike enrichment (a best-effort side effect), generation IS the
 * feature — so an unbound AI or an unusable reply is a typed failure
 * the route surfaces, not a silent fallback.
 */

import { PROFILE_TONE_MAX_LEN, toPublicProfile, type NodeProfileRow } from './node-profile-store'
import type { CurrentEventRow } from './events-store'
import { extractModelText, extractJsonObject, ENRICH_MODEL_ID, type EnrichEnv } from './events-enrich'

/** A generation is still bounded — past this the route returns a
 *  typed failure and the curator retries (mirrors the enrichment /
 *  caption timeouts, sized up for a full post). Scaled by requested
 *  length: a ~900-word draft routinely needs more than 30 s of model
 *  time, and the Workers runtime is happy to await I/O that long. */
const GENERATE_TIMEOUT_MS: Record<BlogDraftLength, number> = {
  short: 30_000,
  medium: 30_000,
  long: 60_000,
}

/** Word-count guidance per requested length. */
export const LENGTH_WORDS: Record<BlogDraftLength, number> = {
  short: 250,
  medium: 500,
  long: 900,
}

export type BlogDraftLength = 'short' | 'medium' | 'long'

/** The dataset facts the prompt grounds itself in. */
export interface GenerateDataset {
  id: string
  title: string
  abstract: string | null
}

export interface GenerateInputs {
  profile: NodeProfileRow | null
  event: CurrentEventRow | null
  datasets: readonly GenerateDataset[]
  /** Overrides the profile's default_tone for this draft. */
  tone?: string | null
  length?: BlogDraftLength
}

export interface BlogDraft {
  title: string
  summary: string
  bodyMd: string
}

export type GenerateOutcome =
  | { ok: true; draft: BlogDraft }
  | { ok: false; error: 'ai_unavailable' | 'generation_failed'; message: string }

/** Truncation keeps any one abstract from dominating the prompt. */
const ABSTRACT_CLIP = 500

/** Build the grounded prompt. Exported for tests. */
export function buildBlogPrompt(inputs: GenerateInputs): { system: string; user: string } {
  const words = LENGTH_WORDS[inputs.length ?? 'medium']
  // Same bound for both tone sources — the profile's default_tone is
  // already validated to this length at write time.
  const tone = (
    (inputs.tone && inputs.tone.trim())
    || inputs.profile?.default_tone
    || 'curious, educational, accessible to the general public'
  ).slice(0, PROFILE_TONE_MAX_LEN)

  const system =
    'You draft a blog post for the website of the organization described below. ' +
    'Respond with ONLY a JSON object, no prose around it, of the shape ' +
    '{"title": string, "summary": string, "bodyMd": string}. ' +
    '"title" is a compelling post title (under 100 characters). ' +
    '"summary" is a one-to-two sentence standfirst. ' +
    '"bodyMd" is the post in markdown (headings, short paragraphs, a bullet list where it helps), ' +
    `about ${words} words, in this tone: ${tone}. ` +
    'The reply must be valid JSON — escape newlines inside strings as \\n. ' +
    'Ground EVERY claim in the facts provided — never invent numbers, dates, places, quotes, or ' +
    'findings that are not in the given text. ' +
    'Include a URL only if it appears VERBATIM in the facts below — never guess, reconstruct, ' +
    'or abbreviate one. Where the post draws on a dataset, name it. ' +
    'If a news event is given, cite its source by name and link to its URL in the body. ' +
    'Write in the organization\'s voice ("we") when the profile describes one.'

  const parts: string[] = []
  if (inputs.profile) {
    parts.push(
      `Organization: ${inputs.profile.org_name}`
      + (inputs.profile.mission ? `\nMission: ${inputs.profile.mission}` : '')
      + (inputs.profile.region_focus ? `\nGeographic focus: ${inputs.profile.region_focus}` : ''),
    )
    if (inputs.profile.about_md) parts.push(`About the organization:\n${inputs.profile.about_md.slice(0, 1_500)}`)
    // The profile's validated links — without these the model has no
    // verbatim URL to copy and reconstructs a plausible one from the
    // org name instead (observed live: zyra-project.org came back
    // with its dash dropped).
    const links = toPublicProfile(inputs.profile).links
    if (links.length > 0) {
      parts.push(`Official links:\n${links.map(l => `- ${l.label}: ${l.url}`).join('\n')}`)
    }
  }
  if (inputs.event) {
    const ev = inputs.event
    parts.push(
      `News event: ${ev.title}`
      + (ev.summary ? `\nEvent summary: ${ev.summary}` : '')
      + `\nSource: ${ev.source_name} (${ev.source_url})`
      + (ev.occurred_start ? `\nOccurred: ${ev.occurred_start.slice(0, 10)}` : '')
      + (ev.region_name ? `\nRegion: ${ev.region_name}` : ''),
    )
  }
  const datasetLines = inputs.datasets
    .map((d, i) => `${i + 1}. "${d.title}"${d.abstract ? ` — ${d.abstract.slice(0, ABSTRACT_CLIP)}` : ''}`)
    .join('\n')
  parts.push(`Datasets the post should draw on:\n${datasetLines}`)

  return { system, user: parts.join('\n\n') }
}

/**
 * Escape raw control characters inside JSON string literals.
 *
 * Models asked for a JSON object whose value is multi-paragraph
 * markdown routinely emit *literal* newlines inside the string —
 * invalid JSON (`JSON.parse` rejects unescaped control chars), and
 * the single most common reason a well-formed draft reply failed to
 * parse. The walker only rewrites characters while inside a string
 * literal (tracking escape state), so valid JSON passes through
 * unchanged.
 */
export function repairJsonStringNewlines(text: string): string {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) return text
  const slice = text.slice(start, end + 1)
  let out = ''
  let inString = false
  let escaped = false
  for (const ch of slice) {
    if (!inString) {
      if (ch === '"') inString = true
      out += ch
      continue
    }
    if (escaped) {
      out += ch
      escaped = false
      continue
    }
    if (ch === '\\') {
      out += ch
      escaped = true
    } else if (ch === '"') {
      inString = false
      out += ch
    } else if (ch === '\n') {
      out += '\\n'
    } else if (ch === '\r') {
      out += '\\r'
    } else if (ch === '\t') {
      out += '\\t'
    } else if (ch.charCodeAt(0) < 0x20) {
      // JSON.parse rejects EVERY unescaped U+0000–U+001F in a string,
      // not just the common three — \b, \f, vertical tab, etc.
      out += `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`
    } else {
      out += ch
    }
  }
  return out
}

/** Match http(s) URLs; trailing sentence punctuation excluded. */
const URL_RE = /https?:\/\/[^\s)\]}"'<>]+/g

/** Comparison form: scheme + host case-normalized (they're
 *  case-insensitive; the path/query are NOT), trailing
 *  slash/punctuation trimmed — `https://x.org/` and `https://x.org`
 *  are one URL, but `/Path` and `/path` stay distinct. */
function normalizeUrl(raw: string): string {
  const trimmed = raw.replace(/[.,;:!?]+$/, '').replace(/\/+$/, '')
  try {
    const u = new URL(trimmed)
    // The URL parser lowercases protocol + host; path/query/hash keep
    // their original case.
    return `${u.protocol}//${u.host}${u.pathname}${u.search}${u.hash}`.replace(/\/+$/, '')
  } catch {
    return trimmed
  }
}

/**
 * Remove URLs the grounding facts never contained — the deterministic
 * backstop behind the prompt's "verbatim URLs only" instruction.
 * Models asked to "link to our site" without the link available will
 * reconstruct a plausible-looking domain (observed: the org's
 * hyphenated domain came back with the hyphen dropped — a working
 * link to someone else's domain). A markdown link with a fabricated
 * target keeps its text; a bare fabricated URL is dropped.
 */
export function stripUngroundedUrls(bodyMd: string, groundedText: string): string {
  const allowed = new Set<string>()
  for (const url of groundedText.match(URL_RE) ?? []) allowed.add(normalizeUrl(url))

  // Markdown links first, so a kept/stripped decision applies to the
  // whole construct rather than its inner URL.
  let removed = false
  let out = bodyMd.replace(/\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g, (whole, text: string, url: string) => {
    if (allowed.has(normalizeUrl(url))) return whole
    removed = true
    return text
  })
  // Bare URLs (grounded ones survive the same check).
  out = out.replace(URL_RE, m => {
    if (allowed.has(normalizeUrl(m))) return m
    removed = true
    return ''
  })
  if (!removed) return bodyMd
  // Tidy artifacts a dropped bare URL can leave: "( )" and doubled
  // spaces. The collapse requires a non-whitespace char before the
  // run so leading indentation (nested lists, code blocks) survives.
  return out.replace(/\(\s*\)/g, '').replace(/(\S)[^\S\n]{2,}/g, '$1 ')
}

/** Parse the model reply into a draft; null when unusable. */
export function parseDraftReply(text: string): BlogDraft | null {
  const parsed = extractJsonObject(text) ?? extractJsonObject(repairJsonStringNewlines(text))
  if (!parsed) return null
  const title = typeof parsed.title === 'string' ? parsed.title.trim() : ''
  const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : ''
  const bodyMd = typeof parsed.bodyMd === 'string' ? parsed.bodyMd.trim() : ''
  if (!title || !bodyMd) return null
  return { title: title.slice(0, 200), summary: summary.slice(0, 500), bodyMd }
}

/** Run the generation. */
export async function generateBlogDraft(env: EnrichEnv, inputs: GenerateInputs): Promise<GenerateOutcome> {
  if (!env.AI) {
    return { ok: false, error: 'ai_unavailable', message: 'Workers AI is not bound on this deployment.' }
  }
  const { system, user } = buildBlogPrompt(inputs)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const modelCall = env.AI.run(env.EVENTS_ENRICH_MODEL || ENRICH_MODEL_ID, {
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      // Headroom over the requested word count: ~900 words of body is
      // already ~1,300 tokens before JSON overhead — a 2,000 cap
      // truncated Long drafts mid-string, which parses as garbage.
      max_tokens: 4_096,
    })
    // A late rejection from the losing branch must never surface as an
    // unhandled rejection in the Workers runtime.
    void modelCall.catch(() => {})
    const raced = await Promise.race([
      modelCall,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('generation timeout')),
          GENERATE_TIMEOUT_MS[inputs.length ?? 'medium'],
        )
      }),
    ])
    const text = extractModelText(raced)
    if (!text) {
      return { ok: false, error: 'generation_failed', message: 'The model returned an empty or unrecognisable reply.' }
    }
    const draft = parseDraftReply(text)
    if (!draft) {
      return { ok: false, error: 'generation_failed', message: 'The model reply could not be parsed into a draft.' }
    }
    // Deterministic URL grounding: only URLs present verbatim in the
    // facts we supplied may survive into the draft.
    draft.bodyMd = stripUngroundedUrls(draft.bodyMd, user)
    return { ok: true, draft }
  } catch (e) {
    // Same discipline: the real error goes to the deployment logs,
    // the wire gets a generic retryable message.
    console.warn('[blog-generate] model call failed:', e instanceof Error ? e.message : String(e))
    return { ok: false, error: 'generation_failed', message: 'The model call failed or timed out — try again.' }
  } finally {
    clearTimeout(timer)
  }
}
