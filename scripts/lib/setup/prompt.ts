// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Terminal prompting for `npm run setup --interactive`.
 *
 * ## Why an interface rather than calling readline directly
 *
 * Every interesting behaviour here — re-prompting on an invalid
 * answer, refusing to block when there is no terminal, not echoing a
 * secret — is behaviour worth testing, and none of it is testable
 * against a real TTY. So the orchestrator talks to a `Prompter`, and
 * the readline implementation is a thin adapter at the edge.
 *
 * ## Never block a non-interactive run
 *
 * A prompt that waits forever in CI is worse than a clean failure:
 * the job burns its timeout and the log says nothing useful. When
 * stdin is not a TTY, `NonInteractivePrompter` answers every question
 * with null, which callers treat as "unavailable" and report as a
 * missing value with the environment variable that would supply it.
 *
 * ## Secrets are read without echo
 *
 * Not masked with asterisks — simply not echoed, then acknowledged
 * with a length. Character-by-character masking needs raw mode and
 * hand-rolled line editing (backspace, paste, ^U), and getting that
 * subtly wrong mangles the one value you cannot see to check.
 */

export interface Question {
  /** Stable key, used for state mapping and test assertions. */
  key: string
  /** One-line prompt, e.g. `Cloudflare account ID`. */
  label: string
  /** Where the value comes from. Printed above the prompt. */
  help?: string[]
  /** Shown as `(e.g. …)`. */
  example?: string
  /** Offered as the answer when the operator presses enter. */
  defaultValue?: string
  /** Read without echo. */
  secret?: boolean
  /** An empty answer is acceptable and resolves to null. */
  optional?: boolean
  /** Returns an error string, or null when the answer is good. */
  validate?: (value: string) => string | null
}

export interface Prompter {
  /** Resolves to the answer, or null when skipped/unavailable. */
  ask(question: Question): Promise<string | null>
  /** Yes/no gate. Resolves false when unavailable. */
  confirm(text: string, defaultYes?: boolean): Promise<boolean>
  /** Free-form output — headings, instructions, results. */
  say(text: string): void
  close(): void
}

/** Used when stdin is not a terminal. Never blocks, never guesses. */
export class NonInteractivePrompter implements Prompter {
  constructor(private readonly out: (s: string) => void) {}
  async ask(): Promise<string | null> {
    return null
  }
  async confirm(): Promise<boolean> {
    return false
  }
  say(text: string): void {
    this.out(text)
  }
  close(): void {}
}

// ── Validators ────────────────────────────────────────────────────

export const validators = {
  /** Cloudflare account IDs are 32 lowercase hex characters. */
  accountId(value: string): string | null {
    return /^[0-9a-f]{32}$/i.test(value.trim())
      ? null
      : 'expected 32 hex characters — copy it from the dashboard sidebar'
  },

  /** Access application AUD tags are 64 hex characters. */
  aud(value: string): string | null {
    return /^[0-9a-f]{64}$/i.test(value.trim())
      ? null
      : 'expected 64 hex characters from the application\'s Overview tab'
  },

  /**
   * A bare hostname. Rejects a scheme or path outright rather than
   * silently stripping them: if someone pastes a full URL here, the
   * value they think they set is not the value that is stored, and
   * that surfaces much later as a domain that never validates.
   */
  hostname(value: string): string | null {
    const v = value.trim()
    if (/^https?:\/\//i.test(v)) return 'drop the https:// — just the hostname'
    if (v.includes('/')) return 'drop the path — just the hostname'
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(v)) return 'expected something like terraviz.your-org.org'
    return null
  },

  /** An email *domain*, not an address — the Access policy is a suffix match. */
  emailDomain(value: string): string | null {
    const v = value.trim().replace(/^@/, '')
    if (v.includes('@')) return 'a domain, not an address — drop everything before the @'
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(v)) return 'expected something like your-org.org'
    return null
  },

  /** Comma-separated email domains. */
  emailDomainList(value: string): string | null {
    for (const part of value.split(',')) {
      const err = validators.emailDomain(part)
      if (err) return `"${part.trim()}": ${err}`
    }
    return null
  },

  url(value: string): string | null {
    try {
      const u = new URL(value.trim())
      return u.protocol === 'https:' || u.protocol === 'http:' ? null : 'expected an http(s) URL'
    } catch {
      return 'expected a full URL, e.g. https://assets.your-org.org'
    }
  },

  /** `owner/repo`. */
  repoSlug(value: string): string | null {
    return /^[\w.-]+\/[\w.-]+$/.test(value.trim()) ? null : 'expected owner/repo'
  },

  /** Cloudflare project names are lowercase alphanumeric plus dashes. */
  projectName(value: string): string | null {
    return /^[a-z0-9][a-z0-9-]{0,57}[a-z0-9]$/.test(value.trim())
      ? null
      : 'lowercase letters, digits and dashes only'
  },

  nonEmpty(value: string): string | null {
    return value.trim().length > 0 ? null : 'required'
  },
}

// ── Rendering ─────────────────────────────────────────────────────

/**
 * The block printed above a prompt. Kept pure so the wording is
 * testable and so `--manual` can render the same text without a
 * terminal.
 */
export function renderQuestion(question: Question): string {
  const lines: string[] = []
  for (const line of question.help ?? []) lines.push(`    ${line}`)
  if (question.example) lines.push(`    e.g. ${question.example}`)
  return lines.join('\n')
}

/** `label [default]: ` / `label (optional): ` */
export function promptLine(question: Question): string {
  const suffix = question.defaultValue
    ? ` [${question.defaultValue}]`
    : question.optional
      ? ' (optional, enter to skip)'
      : ''
  return `  ${question.label}${suffix}: `
}

// ── readline implementation ───────────────────────────────────────

export interface ReadlineLike {
  question(query: string): Promise<string>
  close(): void
}

export interface WritableLike {
  write(chunk: string): boolean
}

/**
 * Wraps a readline interface with validation, re-prompting and
 * no-echo secret entry.
 *
 * `mute` is a callback the caller wires to whatever suppresses the
 * output stream — the node adapter swaps `stdout.write`. Keeping it
 * injected rather than reaching for `process.stdout` here is what
 * lets the retry and validation logic be tested at all.
 */
export class InteractivePrompter implements Prompter {
  constructor(
    private readonly rl: ReadlineLike,
    private readonly out: WritableLike,
    private readonly mute: (on: boolean) => void = () => {},
    private readonly maxAttempts = 3,
  ) {}

  say(text: string): void {
    this.out.write(text)
  }

  async ask(question: Question): Promise<string | null> {
    const help = renderQuestion(question)
    if (help) this.out.write(help + '\n')

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      let answer: string
      if (question.secret) {
        this.out.write(promptLine(question))
        this.mute(true)
        // `finally`, not a trailing call: muting is a process-wide side
        // effect on stdout. If the read rejects — an aborted signal, a
        // closed stream, Ctrl-C — an unmuted terminal is the only way
        // the operator can see anything they type for the rest of the
        // run, including in whatever error path handles the rejection.
        try {
          answer = await this.rl.question('')
        } finally {
          this.mute(false)
        }
        this.out.write(answer.trim() ? `(${answer.trim().length} characters)\n` : '\n')
      } else {
        answer = await this.rl.question(promptLine(question))
      }

      const value = answer.trim() || question.defaultValue || ''
      if (!value) {
        if (question.optional) return null
        this.out.write('    → required\n')
        continue
      }
      const error = question.validate?.(value)
      if (error) {
        this.out.write(`    → ${error}\n`)
        continue
      }
      return value
    }
    this.out.write('    → giving up on this one; set it later and re-run\n')
    return null
  }

  async confirm(text: string, defaultYes = false): Promise<boolean> {
    const hint = defaultYes ? '[Y/n]' : '[y/N]'
    const answer = (await this.rl.question(`  ${text} ${hint} `)).trim().toLowerCase()
    if (!answer) return defaultYes
    return answer === 'y' || answer === 'yes'
  }

  close(): void {
    this.rl.close()
  }
}

/** Naive word wrap — enough for prose in a fixed-width terminal report. */
export function wrap(text: string, width: number): string[] {
  const words = text.split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let line = ''
  for (const word of words) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line)
      line = word
    } else {
      line = line ? `${line} ${word}` : word
    }
  }
  if (line) lines.push(line)
  return lines
}
