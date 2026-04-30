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
    case 'import-snapshot':
      return runImportSnapshot(ctx)
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
