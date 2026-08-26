// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Placeholder support for Zyra workflow pipeline args (the follow-up
 * to array args — `docs/ZYRA_INTEGRATION_PLAN.md` §Pipeline arg
 * placeholders).
 *
 * Model-output sources embed the forecast cycle in their paths
 * (`gefs.20260724/00/...`), so a static pipeline can only ever fetch
 * one frozen cycle. String arg values may therefore reference:
 *
 *   - `{{run_date}}`  — the run's UTC date, `YYYY-MM-DD` (same value
 *     the metadata sidecar interpolates)
 *   - `{{run_id}}`    — the workflow_runs ULID
 *   - `{{cycle_date:INTERVAL:LAG}}` — `YYYYMMDD` of the most recent
 *     model cycle, where cycles start every INTERVAL and become
 *     available LAG after their nominal time (both ISO-8601
 *     durations): cycle = floor((now − LAG) / INTERVAL) · INTERVAL,
 *     anchored to the Unix epoch (midnight-aligned for divisors of
 *     24 h)
 *   - `{{cycle_hour:INTERVAL:LAG}}` — zero-padded `HH` of that same
 *     cycle (INTERVAL and LAG must match the `cycle_date` reference
 *     in the same pipeline for the pair to describe one cycle)
 *   - `{{valid_iso:INTERVAL:LAG[:OFFSET]}}` — the *valid time* of a
 *     frame, as `YYYY-MM-DDTHH:MM:SSZ`. OFFSET is the frame's
 *     forecast hour as an ISO duration, so `f042` of a 6-hourly
 *     cycle is `{{valid_iso:PT6H:PT7H:PT42H}}`; omitted means the
 *     cycle itself (`f000`).
 *   - `{{valid_compact:INTERVAL:LAG[:OFFSET]}}` — the same instant
 *     as `YYYYMMDDTHHMMSS`, which is filename-safe and what Zyra's
 *     `--datetime-format %Y%m%dT%H%M%S` parses back out. Pair it
 *     with `process convert-format --output-names` to name frames by
 *     valid time instead of by the cycle-relative source name.
 *
 * Shared by the save/dispatch-time validator (`functions/`) and the
 * runner (`cli/`), which interpolates just before writing
 * `pipeline.json`. Unlike the metadata sidecar's drop-with-warning
 * behavior, an unresolved or malformed pipeline placeholder is a
 * hard error: a URL with a missing date fetches garbage, and the
 * run must fail loudly instead.
 *
 * The parser is also reused by the metadata sidecar, whose variable
 * vocabulary differs — hence `parsePlaceholder`'s `allowed`
 * parameter, which decides which names are in scope without
 * duplicating the syntax.
 */

export const PIPELINE_ARG_VARIABLES = [
  'run_date',
  'run_id',
  'cycle_date',
  'cycle_hour',
  'valid_iso',
  'valid_compact',
] as const

/** Variables derived from the current model cycle, all of which take
 *  `:INTERVAL:LAG`. */
const CYCLE_VARIABLES = new Set(['cycle_date', 'cycle_hour', 'valid_iso', 'valid_compact'])

/** Of those, the ones that also accept a trailing `:OFFSET` (the
 *  forecast hour). `cycle_date`/`cycle_hour` name the cycle itself,
 *  so an offset would be meaningless there. */
const OFFSET_VARIABLES = new Set(['valid_iso', 'valid_compact'])

/** Matches `{{name}}` and `{{name:P1:P2...}}`; loose on the inside so
 *  malformed contents surface as validation errors, not silent
 *  literals. */
export const PLACEHOLDER_RE = /\{\{([^{}]*)\}\}/g

/** Name plus a colon-separated parameter tail. The tail is captured
 *  whole and split afterwards rather than matched as a fixed arity,
 *  so "wrong number of parameters" is a specific error message
 *  instead of an unhelpful "malformed placeholder". */
const BODY_RE = /^\s*([a-z_]+)((?::[A-Za-z0-9.]+)*)\s*$/

/**
 * Minimal ISO-8601 duration parser (`PnW`, `PnD`, `PTnH`, `PTnM`,
 * `PTnS`, and combinations). Returns seconds, or null when the
 * string is not a valid duration. Kept dependency-free because it
 * runs in both the Pages functions and the node runner.
 */
export function isoDurationSeconds(duration: string): number | null {
  const m = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(duration)
  if (!m) return null
  const [, w, d, h, min, s] = m
  if (!w && !d && !h && !min && !s) return null
  return (
    (Number(w ?? 0) * 7 + Number(d ?? 0)) * 86_400 +
    Number(h ?? 0) * 3_600 +
    Number(min ?? 0) * 60 +
    Number(s ?? 0)
  )
}

export interface PipelinePlaceholder {
  name: string
  intervalSeconds?: number
  lagSeconds?: number
  offsetSeconds?: number
}

/**
 * Parse one placeholder body (the text between the braces). Returns
 * the parsed placeholder or an error message.
 *
 * `allowed` is the vocabulary in scope — pipeline args by default,
 * `METADATA_TEMPLATE_VARIABLES` when the sidecar calls it. Syntax is
 * shared; only the set of legal names differs.
 */
export function parsePlaceholder(
  body: string,
  allowed: readonly string[] = PIPELINE_ARG_VARIABLES,
): PipelinePlaceholder | string {
  const m = BODY_RE.exec(body)
  if (!m) return `Malformed placeholder "{{${body}}}".`
  const [, name, paramTail] = m
  // paramTail is '' or ':A:B...' — drop the leading colon before splitting
  // so a bare name yields no params rather than one empty one.
  const params = paramTail ? paramTail.slice(1).split(':') : []
  if (!allowed.includes(name)) {
    return `Unknown placeholder "${name}" — allowed: ${allowed.join(', ')}.`
  }
  if (!CYCLE_VARIABLES.has(name)) {
    if (params.length > 0) return `"${name}" takes no parameters.`
    return { name }
  }
  const takesOffset = OFFSET_VARIABLES.has(name)
  if (params.length < 2 || params.length > (takesOffset ? 3 : 2)) {
    return takesOffset
      ? `"${name}" requires interval and lag with an optional offset, e.g. {{${name}:PT6H:PT5H:PT12H}}.`
      : `"${name}" requires interval and lag, e.g. {{${name}:PT6H:PT5H}}.`
  }
  const [interval, lag, offset] = params
  const intervalSeconds = isoDurationSeconds(interval)
  const lagSeconds = isoDurationSeconds(lag)
  if (intervalSeconds == null || intervalSeconds <= 0) {
    return `"${name}": interval "${interval}" is not a positive ISO-8601 duration.`
  }
  if (lagSeconds == null || lagSeconds < 0) {
    return `"${name}": lag "${lag}" is not an ISO-8601 duration.`
  }
  if (offset === undefined) return { name, intervalSeconds, lagSeconds }
  const offsetSeconds = isoDurationSeconds(offset)
  if (offsetSeconds == null || offsetSeconds < 0) {
    return `"${name}": offset "${offset}" is not an ISO-8601 duration.`
  }
  return { name, intervalSeconds, lagSeconds, offsetSeconds }
}

const RESIDUAL_BRACES_MESSAGE =
  'Unterminated or mismatched placeholder braces — every "{{" needs a matching "}}".'

/** True when brace tokens remain after removing complete
 *  placeholders — an unterminated `{{...` (or stray `}}`) that the
 *  match-based scan cannot see and would otherwise pass through
 *  verbatim into a URL. */
function hasResidualBraces(value: string): boolean {
  const stripped = value.replace(PLACEHOLDER_RE, '')
  return stripped.includes('{{') || stripped.includes('}}')
}

/**
 * `unknown_placeholder` is reserved for a name that is not in the
 * vocabulary — the typo case, and the one a client can usefully
 * special-case with a "did you mean…". Everything else (arity, a bad
 * duration, unmatched braces) is `invalid_placeholder`: the name was
 * recognised, the rest of it was not.
 */
export type PlaceholderErrorCode = 'unknown_placeholder' | 'invalid_placeholder'

export interface PlaceholderError {
  code: PlaceholderErrorCode
  message: string
}

function placeholderErrorCode(
  body: string,
  allowed: readonly string[],
): PlaceholderErrorCode {
  const name = BODY_RE.exec(body)?.[1]
  return name !== undefined && !allowed.includes(name)
    ? 'unknown_placeholder'
    : 'invalid_placeholder'
}

/**
 * Validate every placeholder in one string. Returns coded errors
 * (empty when the string is placeholder-free or all placeholders are
 * well-formed). `allowed` selects the vocabulary — the metadata
 * template validator passes its own.
 */
export function validateArgPlaceholders(
  value: string,
  allowed: readonly string[] = PIPELINE_ARG_VARIABLES,
): PlaceholderError[] {
  const errors: PlaceholderError[] = []
  for (const match of value.matchAll(PLACEHOLDER_RE)) {
    const parsed = parsePlaceholder(match[1], allowed)
    if (typeof parsed === 'string') {
      errors.push({ code: placeholderErrorCode(match[1], allowed), message: parsed })
    }
  }
  if (hasResidualBraces(value)) {
    errors.push({ code: 'invalid_placeholder', message: RESIDUAL_BRACES_MESSAGE })
  }
  return errors
}

export interface PipelineArgContext {
  now: Date
  runId: string
}

/** The nominal start of the most recent available cycle. */
export function cycleStart(now: Date, intervalSeconds: number, lagSeconds: number): Date {
  const shifted = Math.floor(now.getTime() / 1000) - lagSeconds
  const floored = Math.floor(shifted / intervalSeconds) * intervalSeconds
  return new Date(floored * 1000)
}

/** The instant a cycle-derived placeholder refers to: the cycle
 *  start, advanced by the forecast offset when one was given. */
function placeholderInstant(p: PipelinePlaceholder, ctx: PipelineArgContext): Date {
  const c = cycleStart(ctx.now, p.intervalSeconds!, p.lagSeconds!)
  return p.offsetSeconds ? new Date(c.getTime() + p.offsetSeconds * 1000) : c
}

/**
 * Render one already-parsed placeholder. Split out from
 * `renderArgPlaceholders` so the metadata sidecar — which resolves
 * most of its vocabulary from a lookup table instead — can reuse the
 * cycle-derived cases without reimplementing the arithmetic.
 */
export function renderPlaceholder(parsed: PipelinePlaceholder, ctx: PipelineArgContext): string {
  switch (parsed.name) {
    case 'run_date':
      return ctx.now.toISOString().slice(0, 10)
    case 'run_id':
      return ctx.runId
    case 'cycle_date':
      return placeholderInstant(parsed, ctx).toISOString().slice(0, 10).replace(/-/g, '')
    case 'cycle_hour':
      return placeholderInstant(parsed, ctx).toISOString().slice(11, 13)
    case 'valid_iso':
      // The publisher API's ISO_DATE_RE wants no sub-second part.
      return placeholderInstant(parsed, ctx).toISOString().replace(/\.\d+Z$/, 'Z')
    case 'valid_compact':
      // 2026-07-24T18:00:00.000Z -> 20260724T180000, which is what
      // Zyra's `--datetime-format %Y%m%dT%H%M%S` reads back.
      return placeholderInstant(parsed, ctx)
        .toISOString()
        .replace(/[-:]/g, '')
        .replace(/\.\d+Z$/, '')
    default:
      throw new Error(`Unhandled placeholder "${parsed.name}".`)
  }
}

/**
 * Interpolate every placeholder in one arg string. Throws on a
 * malformed or unknown placeholder — save/dispatch validation should
 * have caught it, so reaching this is a hard bug, and rendering a
 * literal `{{...}}` into a URL must never proceed silently.
 */
export function renderArgPlaceholders(value: string, ctx: PipelineArgContext): string {
  if (hasResidualBraces(value)) throw new Error(RESIDUAL_BRACES_MESSAGE)
  return value.replace(PLACEHOLDER_RE, (_, body: string) => {
    const parsed = parsePlaceholder(body)
    if (typeof parsed === 'string') throw new Error(parsed)
    return renderPlaceholder(parsed, ctx)
  })
}

/**
 * Render a whole pipeline document: walks `stages[].args`,
 * interpolating string values (including strings inside array args).
 * Non-string values pass through untouched. Returns the rendered
 * JSON string, or throws with a message naming the offending stage.
 */
export function renderPipelineJson(pipelineJson: string, ctx: PipelineArgContext): string {
  const doc = JSON.parse(pipelineJson) as { stages?: unknown }
  if (!Array.isArray(doc.stages)) return pipelineJson
  doc.stages.forEach((stage, i) => {
    if (typeof stage !== 'object' || stage === null) return
    const args = (stage as { args?: unknown }).args
    if (typeof args !== 'object' || args === null || Array.isArray(args)) return
    for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
      try {
        if (typeof value === 'string') {
          ;(args as Record<string, unknown>)[key] = renderArgPlaceholders(value, ctx)
        } else if (Array.isArray(value)) {
          ;(args as Record<string, unknown>)[key] = value.map(v =>
            typeof v === 'string' ? renderArgPlaceholders(v, ctx) : v,
          )
        }
      } catch (e) {
        throw new Error(`stages[${i}].args.${key}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  })
  return JSON.stringify(doc)
}
