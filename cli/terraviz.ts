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
 */

import { TerravizClient } from './lib/client'
import { resolveConfig } from './lib/config'
import { parseArgs, getString, getBool } from './lib/args'
import {
  HELP_TEXT,
  runGet,
  runHelp,
  runList,
  runMe,
  runPreview,
  runPublish,
  runRetract,
  runTour,
  runUpdate,
  type CommandContext,
} from './commands'

async function main(argv: string[]): Promise<number> {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') {
    process.stdout.write(HELP_TEXT)
    return 0
  }

  const [command, ...rest] = argv
  const parsed = parseArgs(rest)
  const config = resolveConfig({
    flagServer: getString(parsed.options, 'server'),
    flagInsecureLocal: getBool(parsed.options, 'insecure-local'),
    flagClientId: getString(parsed.options, 'client-id'),
    flagClientSecret: getString(parsed.options, 'client-secret'),
  })
  const client = new TerravizClient(config)

  const ctx: CommandContext = {
    client,
    args: parsed,
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
    case 'tour':
      return runTour(ctx)
    case 'help':
    case '--help':
    case '-h':
      return runHelp(ctx)
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
