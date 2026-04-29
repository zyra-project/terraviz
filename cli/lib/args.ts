/**
 * Hand-rolled argv parser for the `terraviz` CLI. Avoids a
 * `commander` / `yargs` dependency for what is, in the end, three
 * dozen lines of "split positional from options" logic.
 *
 * Supports:
 *   - `--key value` and `--key=value`
 *   - `--flag` (boolean true)
 *   - `--no-flag` (boolean false; not currently used but standard)
 *   - Stop-at-end positionals: any arg after `--` is treated as
 *     a positional.
 *
 * Returns `{ positional, options }`. Unknown options are kept on
 * `options` so commands can opt into their own validation rather
 * than the parser refusing unknown keys upfront.
 */

export interface ParsedArgs {
  positional: string[]
  options: Record<string, string | boolean>
}

/**
 * Names treated as boolean flags — `--insecure-local` etc. won't
 * consume the following positional even when one is present. Kept
 * as a module-level set so commands can extend it without refactoring
 * every caller; everything else is a string flag whose value is the
 * next arg.
 */
export const BOOLEAN_FLAGS = new Set<string>([
  'insecure-local',
  'json',
  'draft-only',
  'help',
])

export function parseArgs(argv: string[], booleans: Set<string> = BOOLEAN_FLAGS): ParsedArgs {
  const positional: string[] = []
  const options: Record<string, string | boolean> = {}
  let stopOptions = false

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (stopOptions) {
      positional.push(arg)
      continue
    }
    if (arg === '--') {
      stopOptions = true
      continue
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=')
      if (eq !== -1) {
        const key = arg.slice(2, eq)
        options[key] = arg.slice(eq + 1)
        continue
      }
      const key = arg.slice(2)
      if (key.startsWith('no-')) {
        options[key.slice(3)] = false
        continue
      }
      if (booleans.has(key)) {
        options[key] = true
        continue
      }
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('--')) {
        options[key] = next
        i++
      } else {
        options[key] = true
      }
    } else {
      positional.push(arg)
    }
  }

  return { positional, options }
}

/** Helper: read a string option, falling back to undefined. */
export function getString(
  options: Record<string, string | boolean>,
  key: string,
): string | undefined {
  const v = options[key]
  if (typeof v === 'string') return v
  return undefined
}

/** Helper: read a number option, returning NaN if not numeric. */
export function getNumber(
  options: Record<string, string | boolean>,
  key: string,
): number | undefined {
  const v = options[key]
  if (typeof v !== 'string') return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

/** Helper: read a boolean flag (presence only). */
export function getBool(
  options: Record<string, string | boolean>,
  key: string,
): boolean {
  return options[key] === true
}
