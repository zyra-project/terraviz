/**
 * Push per-string metadata from `locales/_explanations.json` to
 * Weblate's "Explanation" field via the REST API.
 *
 * Run manually after editing the sidecar:
 *
 *     WEBLATE_TOKEN=<token> npm run sync:weblate
 *
 * The sidecar lives in the repo so context is reviewable in PRs;
 * this script is the one-way bridge that surfaces it to translators
 * in the Weblate editor. It does not pull explanations back — Weblate
 * is downstream of the source of truth.
 *
 * Defaults match the live Weblate component:
 *   - URL:        https://hosted.weblate.org
 *   - Project:    terraviz
 *   - Component:  app-locales
 *
 * Override via environment variables (`WEBLATE_URL`, `WEBLATE_PROJECT`,
 * `WEBLATE_COMPONENT`) if you're testing against a fork or a self-
 * hosted instance.
 *
 * Token: create at https://hosted.weblate.org/accounts/profile/#api
 * with at least the "Manage component" permission on the project.
 *
 * Idempotent: skips units whose explanation already matches the
 * sidecar value. Safe to run on every push to main.
 *
 * Pairs with `scripts/generate-locales.ts` (which validates the
 * sidecar shape and key set on every build) — by the time this
 * script runs, the sidecar is already known to be well-formed and
 * key-aligned with `en.json`.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { readExplanations } from './generate-locales'
import {
  authHeaders,
  fetchSourceUnits,
  hasToken,
  unitsByContext,
  WeblateError,
  WEBLATE_COMPONENT,
  WEBLATE_PROJECT,
  WEBLATE_URL,
} from './weblate-client'

const HERE = resolve(fileURLToPath(import.meta.url), '..')
const REPO_ROOT = resolve(HERE, '..')
const LOCALES_DIR = resolve(REPO_ROOT, 'locales')

async function patchExplanation(unitId: number, explanation: string): Promise<void> {
  const url = `${WEBLATE_URL}/api/units/${unitId}/`
  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      ...authHeaders(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ explanation }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new WeblateError(
      `PATCH ${url} → ${res.status} ${res.statusText}${body ? `\n  ${body}` : ''}`,
    )
  }
}

async function run(): Promise<void> {
  if (!hasToken()) {
    console.error(
      'WEBLATE_TOKEN not set. Create one at ' +
        `${WEBLATE_URL}/accounts/profile/#api and pass via env var:\n` +
        '  WEBLATE_TOKEN=<token> npm run sync:weblate',
    )
    process.exit(1)
  }

  // Read the sidecar — but we need en.json's keys to validate it. Read
  // them straight off disk rather than running the full build, so this
  // script stays cheap.
  const enRaw = readFileSync(resolve(LOCALES_DIR, 'en.json'), 'utf-8')
  const enKeys = new Set(Object.keys(JSON.parse(enRaw) as Record<string, string>))

  const explanations = readExplanations(LOCALES_DIR, enKeys)
  if (!explanations) {
    // eslint-disable-next-line no-console
    console.log('No locales/_explanations.json found — nothing to sync.')
    return
  }
  const desired = Object.entries(explanations)
  if (desired.length === 0) {
    // eslint-disable-next-line no-console
    console.log('locales/_explanations.json is empty — nothing to sync.')
    return
  }

  // eslint-disable-next-line no-console
  console.log(
    `Syncing ${desired.length} explanation(s) to ${WEBLATE_URL}/projects/${WEBLATE_PROJECT}/${WEBLATE_COMPONENT}/`,
  )

  const units = await fetchSourceUnits()
  const byKey = unitsByContext(units)

  let updated = 0
  let skipped = 0
  let missing = 0
  for (const [key, explanation] of desired) {
    const unit = byKey.get(key)
    if (!unit) {
      // eslint-disable-next-line no-console
      console.warn(
        `! ${key}: no matching unit in Weblate — sidecar may be ahead of the next sync cycle.`,
      )
      missing++
      continue
    }
    if (unit.explanation === explanation) {
      skipped++
      continue
    }
    await patchExplanation(unit.id, explanation)
    // eslint-disable-next-line no-console
    console.log(`✓ ${key}`)
    updated++
  }

  // eslint-disable-next-line no-console
  console.log(
    `\nDone. ${updated} updated, ${skipped} already current, ${missing} missing in Weblate.`,
  )
  if (missing > 0) {
    // Don't fail — missing units usually mean Weblate hasn't pulled the
    // latest main yet. Re-running after Weblate's next sync cycle
    // resolves it. CI can retry on a schedule.
    // eslint-disable-next-line no-console
    console.warn(
      'Missing units are non-fatal; trigger a Weblate Repository → Update and re-run.',
    )
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  run().catch((err) => {
    // Treat any thrown Error as a clean exit so the operator sees
    // the message, not a stack trace. Covers WeblateError (HTTP /
    // auth failures from the shared client) and LocaleBuildError /
    // anything else `readExplanations` rethrows (stale key,
    // invalid JSON, IO failure on the sidecar).
    if (err instanceof Error) {
      console.error(err.message)
      process.exit(1)
    }
    throw err
  })
}

export { run }
