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

import { PROFILE_TONE_MAX_LEN, type NodeProfileRow } from './node-profile-store'
import type { CurrentEventRow } from './events-store'
import { extractModelText, extractJsonObject, ENRICH_MODEL_ID, type EnrichEnv } from './events-enrich'

/** A long generation is still bounded — past this the route returns a
 *  typed failure and the curator retries (mirrors the enrichment /
 *  caption timeouts, sized up for a full post). */
const GENERATE_TIMEOUT_MS = 30_000

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
    'Ground EVERY claim in the facts provided — never invent numbers, dates, places, quotes, or ' +
    'findings that are not in the given text. Where the post draws on a dataset, name it. ' +
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

/** Parse the model reply into a draft; null when unusable. */
export function parseDraftReply(text: string): BlogDraft | null {
  const parsed = extractJsonObject(text)
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
      max_tokens: 2_000,
    })
    // A late rejection from the losing branch must never surface as an
    // unhandled rejection in the Workers runtime.
    void modelCall.catch(() => {})
    const raced = await Promise.race([
      modelCall,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('generation timeout')), GENERATE_TIMEOUT_MS)
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
