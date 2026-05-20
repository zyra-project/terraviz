/**
 * `terraviz` CLI entry point.
 *
 * Hand-rolled command dispatch — see `lib/args.ts` for the parser
 * and `commands.ts` for the implementations. Kept thin so tests
 * cover the commands directly with a stubbed client.
 *
 * Spawned by `bin/terraviz.cjs` via `tsx`. The `bin` shim is
 * deliberately a separate JS file so a global install
 * (`npm install -g .`) works on Windows + macOS + Linux without
 * relying on `.ts` shebang support.
 *
 * Argv shape: global flags (`--server`, `--insecure-local`, etc.)
 * may appear before OR after the subcommand. The dispatcher runs
 * `parseArgs` on the full argv and reads the subcommand off the
 * first positional, so both
 *   `terraviz --insecure-local publish foo.json`
 * and
 *   `terraviz publish foo.json --insecure-local`
 * are equivalent. This matches how the older 1a/1b/1c contributor
 * docs phrased the invocations and what most operators reach for
 * by reflex.
 */

import { TerravizClient } from './lib/client'
import { resolveConfig } from './lib/config'
import { parseArgs, getString, getBool } from './lib/args'
import {
  HELP_TEXT,
  runFrames,
  runGet,
  runList,
  runMe,
  runPreview,
  runPublish,
  runRetract,
  runTour,
  runUpdate,
  runUpload,
  type CommandContext,
} from './commands'
import { runImportSnapshot } from './import-snapshot'
import { runVerifyDeploy } from './verify-deploy'
import { runMigrateR2Hls } from './migrate-r2-hls'
import { runRollbackR2Hls } from './rollback-r2-hls'
import { runListRealtimeR2 } from './list-realtime-r2'
import { runMigrateR2Assets } from './migrate-r2-assets'
import { runMigrateR2Tours } from './migrate-r2-tours'
import { runRollbackR2Tours } from './rollback-r2-tours'
import { runRollbackR2Assets } from './rollback-r2-assets'

async function main(argv: string[]): Promise<number> {
  // Bare `-h` short flag — parseArgs only knows about `--`, so handle
  // the short form here before delegating.
  if (argv.includes('-h')) {
    process.stdout.write(HELP_TEXT)
    return 0
  }

  const parsed = parseArgs(argv)
  const command = parsed.positional[0]
  const remainingPositionals = parsed.positional.slice(1)

  if (
    argv.length === 0 ||
    !command ||
    command === 'help' ||
    parsed.options.help === true
  ) {
    process.stdout.write(HELP_TEXT)
    return 0
  }

  const config = resolveConfig({
    flagServer: getString(parsed.options, 'server'),
    flagInsecureLocal: getBool(parsed.options, 'insecure-local'),
    flagClientId: getString(parsed.options, 'client-id'),
    flagClientSecret: getString(parsed.options, 'client-secret'),
  })
  const client = new TerravizClient(config)

  const ctx: CommandContext = {
    client,
    args: { positional: remainingPositionals, options: parsed.options },
    stdout: process.stdout,
    stderr: process.stderr,
  }

  switch (command) {
    case 'me':
      return runMe(ctx)
    case 'list':
      return runList(ctx)
    case 'get':
      return runGet(ctx)
    case 'publish':
      return runPublish(ctx)
    case 'update':
      return runUpdate(ctx)
    case 'retract':
      return runRetract(ctx)
    case 'preview':
      return runPreview(ctx)
    case 'upload':
      return runUpload(ctx)
    case 'tour':
      return runTour(ctx)
    case 'frames':
      return runFrames(ctx)
    case 'import-snapshot':
      return runImportSnapshot(ctx)
    case 'verify-deploy':
      return runVerifyDeploy(ctx, { config })
    case 'migrate-r2-hls':
      return runMigrateR2Hls(ctx)
    case 'rollback-r2-hls':
      return runRollbackR2Hls(ctx)
    case 'list-realtime-r2':
      return runListRealtimeR2(ctx)
    case 'migrate-r2-assets':
      return runMigrateR2Assets(ctx)
    case 'rollback-r2-assets':
      return runRollbackR2Assets(ctx)
    case 'migrate-r2-tours':
      return runMigrateR2Tours(ctx)
    case 'rollback-r2-tours':
      return runRollbackR2Tours(ctx)
    default:
      process.stderr.write(`Unknown command: ${command}\n\nRun \`terraviz help\` for usage.\n`)
      return 2
  }
}

main(process.argv.slice(2))
  .then(code => process.exit(code))
  .catch(e => {
    process.stderr.write(`Unhandled error: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`)
    process.exit(1)
  })
