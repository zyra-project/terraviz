#!/usr/bin/env tsx
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Fails the build when operator-facing prose drifts away from plain
 * language.
 *
 * The install guide is read by people standing up a node for a museum
 * or a lab, often not full-time engineers, and often at the point
 * where something has already gone wrong. Long sentences are where
 * that reader is lost, so long sentences are what this gates on. See
 * `scripts/lib/plain-language.ts` for why the readability scores are
 * reported rather than enforced.
 *
 *   npm run check:plain-language          report and gate
 *   npm run check:plain-language -- --report   report only, exit 0
 */

import { readFileSync, existsSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  longSentences,
  measure,
  stripHtmlToProse,
  stripToProse,
} from './lib/plain-language'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * The hard limit, in words.
 *
 * 25 is the usual plain-language advice and 30 is the point past which
 * a sentence is doing too much. Gating at 30 keeps the check credible:
 * it fires on sentences that are genuinely hard to follow rather than
 * on every considered one, so a failure means "fix this" instead of
 * "tune the threshold". Average and median are reported against the
 * ~20-word guidance separately.
 */
const MAX_SENTENCE_WORDS = 30

interface Target {
  path: string
  strip: (raw: string) => string
  /** Why this file is operator-facing enough to gate. */
  why: string
}

const TARGETS: Target[] = [
  {
    path: 'docs/SELF_HOSTING.md',
    strip: stripToProse,
    why: 'the install guide',
  },
  {
    path: 'public/setup.html',
    strip: stripHtmlToProse,
    why: 'the generated install console',
  },
]

function main(): void {
  const reportOnly = process.argv.includes('--report')
  let failed = 0

  for (const target of TARGETS) {
    const full = resolve(ROOT, target.path)
    if (!existsSync(full)) {
      process.stderr.write(`skipped ${target.path} — not found\n`)
      continue
    }
    const prose = target.strip(readFileSync(full, 'utf8'))
    const m = measure(prose)
    const long = longSentences(prose, MAX_SENTENCE_WORDS)

    process.stdout.write(
      `\n${relative(ROOT, full)} — ${target.why}\n` +
        `  ${m.words} words, ${m.sentences} sentences\n` +
        `  sentence length: ${m.averageSentenceWords.toFixed(1)} avg, ` +
        `${m.medianSentenceWords} median  (aim for 20 or under)\n` +
        `  reading ease: ${m.readingEase.toFixed(0)}  ` +
        `grade level: ${m.gradeLevel.toFixed(1)}  ` +
        `passive: ${m.passivePer1000.toFixed(1)}/1000 words\n`,
    )

    if (long.length) {
      failed += long.length
      process.stdout.write(
        `  ✘ ${long.length} sentence(s) over ${MAX_SENTENCE_WORDS} words:\n`,
      )
      for (const s of long.slice(0, 10)) {
        process.stdout.write(`     [${s.words}w] ${s.text.slice(0, 120)}…\n`)
      }
      if (long.length > 10) {
        process.stdout.write(`     … and ${long.length - 10} more\n`)
      }
    } else {
      process.stdout.write(`  ✓ no sentence over ${MAX_SENTENCE_WORDS} words\n`)
    }
  }

  if (failed && !reportOnly) {
    process.stderr.write(
      `\n${failed} sentence(s) over ${MAX_SENTENCE_WORDS} words.\n` +
        'Split them. A reader part-way through a broken install is not\n' +
        'going to parse a 50-word sentence, and this guide exists for\n' +
        'exactly that reader.\n\n' +
        'If a sentence genuinely has to be long, rewrite it as a list —\n' +
        'that is almost always what a long sentence is trying to be.\n',
    )
    process.exit(1)
  }
  process.stdout.write('\n')
}

main()
