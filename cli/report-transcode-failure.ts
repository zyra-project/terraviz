#!/usr/bin/env -S npx tsx
/**
 * `report-transcode-failure` — releases a dataset's `transcoding` lock
 * when the `transcode-hls` job fails or times out.
 *
 * Run from the workflow's `if: failure() || cancelled()` step. The job
 * timeout SIGKILLs the main `transcode-from-dispatch` runner before it
 * can self-report, so a *separate* step is the only place that survives
 * a cancellation to post the failure. Without it the row stays
 * `transcoding=1` forever — the UI shows a perpetual in-progress state
 * and the `transcoding_in_progress` guard refuses the next upload.
 *
 * POSTs `/api/v1/publish/datasets/{id}/transcode-failed` with the
 * service-token Access headers (same auth as `transcode-complete`).
 * The server clears the lock but leaves `data_ref` on the prior good
 * bundle. Idempotent server-side, so a double-fire is harmless.
 *
 * Env: TERRAVIZ_SERVER, CF_ACCESS_CLIENT_ID, CF_ACCESS_CLIENT_SECRET.
 * Flags: --dataset-id, --upload-id (both required ULIDs),
 *        --error-summary (optional, recorded in the audit trail).
 *
 * Exit codes: 0 success / no-op; 1 arg or env error; 2 callback failed.
 */

import { loadServerEnv, postTranscodeFailed } from './transcode-from-dispatch'

function getFlag(argv: readonly string[], name: string): string | null {
  const prefix = `--${name}=`
  const match = argv.find(a => a.startsWith(prefix))
  return match ? match.slice(prefix.length) : null
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2)
  const datasetId = getFlag(argv, 'dataset-id')
  const uploadId = getFlag(argv, 'upload-id')
  const errorSummary = getFlag(argv, 'error-summary') ?? 'Transcode failed.'

  if (!datasetId || !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(datasetId)) {
    console.error(`error: --dataset-id must be a 26-char ULID; got ${datasetId ?? '(missing)'}`)
    return 1
  }
  if (!uploadId || !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(uploadId)) {
    console.error(`error: --upload-id must be a 26-char ULID; got ${uploadId ?? '(missing)'}`)
    return 1
  }

  const serverEnv = loadServerEnv()
  if ('error' in serverEnv) {
    console.error(`error: ${serverEnv.error}`)
    return 1
  }

  try {
    await postTranscodeFailed(serverEnv, datasetId, uploadId, errorSummary)
    console.error(`[report-failure] released transcoding lock for dataset=${datasetId} upload=${uploadId}`)
    return 0
  } catch (err) {
    console.error(
      `[report-failure] FAILED to release transcoding lock: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    )
    return 2
  }
}

const invokedDirectly =
  typeof process.argv[1] === 'string' && import.meta.url === `file://${process.argv[1]}`
if (invokedDirectly) {
  void main().then(code => process.exit(code))
}
