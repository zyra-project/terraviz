/**
 * Soft-pass decision for a transient NOAA-FTP `acquire` failure in a
 * scheduled Zyra workflow run.
 *
 * The problem this solves (`.github/workflows/zyra-run.yml`): zyra's
 * FTP backend has no retry and no reconnect (an MDTM storm can
 * self-inflict a disconnect mid-`sync_directory`), so a single
 * transient NOAA-FTP hiccup crashes the `acquire` stage and fails the
 * whole run — firing a red GitHub job + a `failed` workflow_run status
 * even though the published dataset is intact and self-heals on the
 * next tick (acquire is incremental: the missing frames are fetched
 * next run). Those are false-positive notifications.
 *
 * The fix: when `zyra run` fails *specifically* at acquire AND the
 * dataset already has a published, still-fresh bundle, finish the run
 * GREEN as a no-op ("no new data this tick") instead of red. A
 * *sustained* outage still escalates — once the published bundle's
 * trailing edge falls behind `staleAfterSeconds`, the run fails loudly
 * so the operator is paged. Anything that isn't a recognized transient
 * acquire/FTP error (a compose-video crash, a code error, a
 * never-published dataset) always fails loudly — this only ever
 * softens the one well-understood transient.
 *
 * Pure logic, unit-tested. The runner phase
 * (`cli/zyra-publish-from-dispatch.ts --phase=acquire-softpass`) wires
 * the captured `zyra run` log + the dataset row into these helpers and
 * either posts a no-op `succeeded` (soft-pass) or returns non-zero
 * (escalate → the workflow's `if: failure()` step posts `failed`).
 */

/**
 * Signatures that mark a `zyra run` failure as an *acquire-stage*
 * fetch failure rather than a downstream (compose / code) failure.
 *
 * Split into two tiers by how much context they need:
 *
 *   - STRONG — zyra's `connectors/backends/ftp.py` specifics (`ftplib`,
 *     MDTM, `ensure_ftp_connection`, the ftplib exception classes).
 *     These name the FTP connector's own code path, so they only ever
 *     appear when acquire ran the FTP backend. Safe to match anywhere
 *     in the log.
 *   - NETWORK — generic transport errors (timeouts, resets, DNS). These
 *     are NOT acquire-specific: the in-container `pip install pillow`
 *     step (which runs *before* `zyra run`) can emit them too, and a
 *     compose stage hitting a CDN theoretically could. So a generic
 *     network signature only counts as an acquire failure when the log
 *     also shows the acquire stage actually ran (see
 *     `ACQUIRE_STAGE_ANCHOR`).
 *
 * Deliberately conservative throughout: an unrecognized failure — or a
 * generic network error with no acquire context — returns
 * `acquireFailure: false` and escalates (the current, notify-loudly
 * behaviour), so a real bug can never be silently swallowed.
 *
 * Note we do NOT key off a bare `ftp://` URL: that string appears in
 * normal pipeline configs (the `ftp-frames-sos` template) and is echoed
 * even on a *successful* acquire, so it can't distinguish a failure.
 */
const STRONG_ACQUIRE_SIGNATURES: ReadonlyArray<{ re: RegExp; label: string }> = [
  { re: /ftplib/i, label: 'ftplib' },
  { re: /ensure_ftp_connection|sync_directory/i, label: 'ftp-connector' },
  { re: /\bMDTM\b/, label: 'ftp-mdtm' },
  { re: /error_perm|error_temp|error_proto|error_reply/i, label: 'ftplib-error' },
]

const NETWORK_SIGNATURES: ReadonlyArray<{ re: RegExp; label: string }> = [
  { re: /TimeoutError|socket\.timeout|timed out/i, label: 'timeout' },
  { re: /Connection reset|ConnectionResetError|\[Errno 104\]/i, label: 'conn-reset' },
  { re: /Broken pipe|\[Errno 32\]/i, label: 'broken-pipe' },
  { re: /Connection refused|\[Errno 111\]/i, label: 'conn-refused' },
  { re: /Network is unreachable|\[Errno 101\]|\[Errno 110\]/i, label: 'net-unreachable' },
  { re: /\bEOFError\b/, label: 'eof' },
  {
    re: /Temporary failure in name resolution|getaddrinfo|Name or service not known/i,
    label: 'dns',
  },
]

/**
 * Evidence that the `acquire` stage itself ran or failed — required
 * before a *generic* network error (the NETWORK tier) is accepted as a
 * soft-passable acquire failure. Matches zyra's stage-name logging
 * (`acquire` / `acquiring`) or the FTP connector's source path. A
 * pip-install network failure (which logs "...for the pad-missing
 * stage...", not "acquire") therefore does NOT qualify and escalates.
 */
const ACQUIRE_STAGE_ANCHOR =
  /\bacquir(?:e|ing)\b|connectors\/backends\/ftp\.py|\bFTPConnector\b/i

/**
 * zyra's authoritative stage-failure line — e.g.
 * `Stage 1 [acquire] failed with exit code 2.` zyra stops at the first
 * failed stage and names it, so this captures *which* stage broke
 * directly rather than guessing from error keywords. This is the
 * primary classifier signal: it both confirms an acquire failure and —
 * crucially — rules one OUT when a downstream stage (`visualize`,
 * `process`, …) is what failed, even though the log is littered with
 * the FTP `MDTM` debug noise that every run emits.
 */
const STAGE_FAILURE_RE = /Stage\s+\d+\s+\[([a-z0-9_+-]+)\]\s+failed/gi

export interface FailureClassification {
  /** True when the failure is attributable to the acquire stage. */
  acquireFailure: boolean
  /** The matched signal label (for logging), or null. */
  signal: string | null
}

/**
 * Classify a failed `zyra run`'s captured combined output.
 *
 * 1. Primary — parse zyra's own `Stage N [<stage>] failed` line. If the
 *    failed stage is `acquire`, it's an acquire failure; if it names any
 *    other stage, escalate (a downstream/code failure), regardless of
 *    how much FTP/MDTM noise the log carries.
 * 2. Fallback (no structured stage line — older/different zyra output):
 *    a STRONG FTP-connector signature matches anywhere; a generic
 *    NETWORK signature only matches with acquire-stage context.
 *
 * Anything else reports a non-acquire failure (which the caller
 * escalates) — deliberately conservative so a real bug is never
 * silently swallowed.
 */
export function classifyZyraFailure(log: string): FailureClassification {
  let failedStage: string | null = null
  for (const m of log.matchAll(STAGE_FAILURE_RE)) failedStage = m[1].toLowerCase()
  if (failedStage !== null) {
    return failedStage === 'acquire'
      ? { acquireFailure: true, signal: 'stage:acquire' }
      : { acquireFailure: false, signal: null }
  }
  for (const sig of STRONG_ACQUIRE_SIGNATURES) {
    if (sig.re.test(log)) return { acquireFailure: true, signal: sig.label }
  }
  if (ACQUIRE_STAGE_ANCHOR.test(log)) {
    for (const sig of NETWORK_SIGNATURES) {
      if (sig.re.test(log)) return { acquireFailure: true, signal: sig.label }
    }
  }
  return { acquireFailure: false, signal: null }
}

/** A dataset is "published" once it has any non-empty `data_ref` — it
 *  has been through a successful transcode at least once and is
 *  serving content. A never-published dataset (null/empty ref) has
 *  nothing to fall back to, so its acquire failure must escalate. */
export function hasPublishedBundle(dataRef: string | null | undefined): boolean {
  return typeof dataRef === 'string' && dataRef.trim().length > 0
}

export interface FreshnessInput {
  dataRef: string | null | undefined
  /** The dataset row's `end_time` (the data's trailing edge). A
   *  soft-pass never advances it — during an outage it freezes while
   *  `now` marches on, so its age is the outage duration. */
  endTime: string | null | undefined
  /** The dataset row's `updated_at`, used as the staleness reference
   *  when `end_time` is null/unparseable. Real-time rows can carry a
   *  null `end_time` (treated as "still updating" elsewhere); without
   *  a fallback the bundle would read as fresh forever and a sustained
   *  outage would never escalate. A soft-pass skips the metadata PATCH,
   *  so `updated_at` also freezes during an outage. */
  updatedAt?: string | null | undefined
  nowMs: number
  staleAfterSeconds: number
}

export interface FreshnessResult {
  published: boolean
  stale: boolean
  /** Age of the staleness reference in seconds, or null when neither
   *  `end_time` nor `updated_at` is parseable. */
  ageSeconds: number | null
  detail: string
}

function parseTimestampMs(value: string | null | undefined): number | null {
  if (!value) return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

/**
 * Assess whether the dataset's published bundle is fresh enough to
 * soft-pass over a transient acquire failure.
 *
 * - No published bundle → not fresh (escalate: nothing to serve).
 * - Published: measure staleness against `end_time` (the data's
 *   trailing edge), falling back to `updated_at` when `end_time` is
 *   null/unparseable — so a real-time row with no `end_time` still
 *   escalates during a prolonged outage.
 * - Only when BOTH timestamps are unparseable do we treat the bundle
 *   as fresh (can't measure — don't escalate on a pure unknown; the
 *   data is intact and the failure is a recognized transient). With
 *   `updated_at` being NOT NULL in the schema, this is the rare case.
 */
export function assessBundleFreshness(input: FreshnessInput): FreshnessResult {
  if (!hasPublishedBundle(input.dataRef)) {
    return {
      published: false,
      stale: true,
      ageSeconds: null,
      detail: `dataset has no published bundle (data_ref=${input.dataRef ?? '(none)'})`,
    }
  }
  const endMs = parseTimestampMs(input.endTime)
  const updatedMs = parseTimestampMs(input.updatedAt)
  const referenceMs = endMs ?? updatedMs
  const referenceSource = endMs !== null ? 'end_time' : 'updated_at'
  if (referenceMs === null) {
    return {
      published: true,
      stale: false,
      ageSeconds: null,
      detail: `neither end_time (${input.endTime ?? 'unset'}) nor updated_at (${input.updatedAt ?? 'unset'}) is parseable — cannot measure staleness, treating the bundle as fresh`,
    }
  }
  // Floor (not round) for a deterministic boundary, and clamp at 0 so
  // a trailing edge slightly ahead of the runner's clock (real-time
  // rows can carry a near-now end_time) never logs a negative age.
  const ageSeconds = Math.max(0, Math.floor((input.nowMs - referenceMs) / 1000))
  const stale = ageSeconds > input.staleAfterSeconds
  return {
    published: true,
    stale,
    ageSeconds,
    detail: `published bundle is ${ageSeconds}s old (by ${referenceSource}; stale-after ${input.staleAfterSeconds}s)`,
  }
}

export interface SoftPassDecision {
  /** Finish the run GREEN as a no-op (post `succeeded`). */
  softPass: boolean
  /** Human-readable rationale for the run log. */
  reason: string
}

/**
 * Combine the failure classification and bundle freshness into the
 * terminal soft-pass-or-escalate decision. Soft-pass requires BOTH a
 * recognized transient acquire failure AND a published, still-fresh
 * bundle; every other path escalates (fail loudly + notify).
 */
export function decideAcquireSoftPass(opts: {
  classification: FailureClassification
  freshness: FreshnessResult
}): SoftPassDecision {
  if (!opts.classification.acquireFailure) {
    return {
      softPass: false,
      reason:
        'failure is not a recognized transient acquire/FTP error — failing loudly (real error)',
    }
  }
  if (!opts.freshness.published) {
    return {
      softPass: false,
      reason: `acquire failed and ${opts.freshness.detail} — nothing to fall back to, failing loudly`,
    }
  }
  if (opts.freshness.stale) {
    return {
      softPass: false,
      reason: `acquire failed and ${opts.freshness.detail} — sustained outage, escalating`,
    }
  }
  return {
    softPass: true,
    reason: `transient acquire failure (${opts.classification.signal}); ${opts.freshness.detail} — no new data this tick, soft-passing (prior bundle preserved)`,
  }
}
