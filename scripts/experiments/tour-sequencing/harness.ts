// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Shared corpus loading and ordering for the sequencing experiment.
 *
 * Extracted so `run.ts` and `blind-pack.ts` cannot drift apart. The
 * first version of this experiment reported a finding that came from a
 * loader nothing else used; one definition, imported everywhere, is the
 * cheap structural guard against repeating that.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { buildDatasetTerms, tokenize, type MatchDataset } from '../../../functions/api/v1/_lib/events-matcher'

/** One candidate dataset as the experiment sees it. Defined here rather
 *  than beside the similarity variants so the corpus loader carries no
 *  dependency on the sequencer — the matcher evaluation must be
 *  reviewable without it. */
export interface RichCandidate {
  id: string
  title: string
  matchScore: number | null
  categories: readonly string[]
  keywords: readonly string[]
  tags: readonly string[]
  bbox: { n: number; s: number; w: number; e: number } | null
  startMs: number | null
  endMs: number | null
  format: string | null
  /** Cached title tokens — `tokenize` is the matcher's own stemmer. */
  titleTerms: ReadonlySet<string>
}

export type SimilarityFn = (a: RichCandidate, b: RichCandidate) => number

const HERE = dirname(fileURLToPath(import.meta.url))

interface SnapshotRow {
  id: string
  title: string
  abstract: string | null
  tags: string[] | null
  categories: string[] | null
  keywords: string[] | null
  bbox: { n: number; s: number; w: number; e: number } | null
  startTime: string | null
  endTime: string | null
  format: string | null
  slug: string | null
}

export function ms(iso: string | null): number | null {
  if (!iso) return null
  const t = Date.parse(iso)
  return Number.isFinite(t) ? t : null
}

export function loadCorpus(): { rich: Map<string, RichCandidate>; match: MatchDataset[] } {
  const raw = JSON.parse(
    readFileSync(join(HERE, 'catalog-snapshot.json'), 'utf8'),
  ) as { datasets: SnapshotRow[] }
  const rich = new Map<string, RichCandidate>()
  const match: MatchDataset[] = []
  for (const row of raw.datasets) {
    const tags = row.tags ?? []
    const categories = row.categories ?? []
    const keywords = row.keywords ?? []
    rich.set(row.id, {
      id: row.id,
      title: row.title,
      matchScore: null,
      categories,
      keywords,
      tags,
      bbox: row.bbox,
      startMs: ms(row.startTime),
      endMs: ms(row.endTime),
      format: row.format,
      titleTerms: new Set(tokenize(row.title)),
    })
    match.push({
      id: row.id,
      // Production fidelity: runMatcherForEvent's candidate SELECT is
      // `id, title, abstract, start_time, end_time, period` — it reads
      // no bbox columns at all, so a dataset's geo signal is ALWAYS
      // null in production. An earlier revision passed a box here, and
      // passed it under the wrong key (`north/south/west/east` against
      // an EventBoundingBox of `{n,s,w,e}`), so scoreGeo read undefined
      // and silently halved or NaN'd scores. Both bugs are corrected by
      // matching production and passing nothing.
      boundingBox: null,
      startTime: row.startTime,
      endTime: row.endTime,
      subjectTerms: buildDatasetTerms({
        title: row.title,
        abstract: row.abstract,
        tags,
        keywords,
        categoryValues: categories,
      }),
    })
  }
  return { rich, match }
}


