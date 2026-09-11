// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { readFileSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import type { ParsedArgs } from './lib/args'
import { buildMetadataAudit, buildSnapshotMetadataAudit, METADATA_AUDIT_SCHEMA_VERSION, parseCanonicalRows } from './lib/metadata-audit'
import type { RawSosEntry, RawEnrichedEntry } from './lib/snapshot-import'
import type { SnapshotCrosswalk } from './lib/snapshot-crosswalk'

/** Intentionally no CommandContext/client/config: even an unauthenticated CLI
 * invocation with invalid server settings must work entirely offline. */
export interface MetadataAuditContext {
  args: ParsedArgs
  stdout: { write(chunk: string): boolean }
  readFile?: (path: string) => string
}

const DEFAULTS = {
  list: 'public/assets/sos-dataset-list.json',
  enriched: 'public/assets/sos_dataset_metadata.json',
  crosswalk: 'public/assets/sos-enrichment-crosswalk.json',
}

export function runMetadataAudit(ctx: MetadataAuditContext): number {
  const emit = (value: unknown) => ctx.stdout.write(JSON.stringify(value, null, 2) + '\n')
  try {
    const { options, positional } = ctx.args
    const allowed = new Set(['snapshot', 'strict', 'list', 'enriched', 'crosswalk'])
    if (Object.keys(options).some(key => !allowed.has(key))) throw new Error('audit_option_unsupported')
    for (const flag of ['snapshot', 'strict']) {
      if (options[flag] != null && typeof options[flag] !== 'boolean') throw new Error('audit_boolean_option_required')
    }
    const snapshot = options.snapshot === true
    if ((snapshot && positional.length !== 0) || (!snapshot && positional.length !== 1)) throw new Error('audit_input_required')
    if (!snapshot && ['list', 'enriched', 'crosswalk'].some(key => options[key] != null)) throw new Error('audit_snapshot_options_require_snapshot')
    const read = (path: string): unknown => {
      // Deny URL schemes and UNC/network shares; only explicitly named local
      // JSON regular files. No stdin, env files, secret discovery, or config read.
      if (!/\.json$/i.test(path) || /^[/\\]{2}/.test(path) || (/^[a-z][a-z0-9+.-]*:/i.test(path) && !/^[a-z]:[/\\]/i.test(path)) ||
          (path.includes(':') && !isAbsolute(path)) || /[\u0000-\u001f]/.test(path)) throw new Error('audit_local_json_path_required')
      let text: string
      try {
        if (!ctx.readFile && !statSync(path).isFile()) throw new Error()
        text = ctx.readFile ? ctx.readFile(path) : readFileSync(path, 'utf8')
      } catch { throw new Error('audit_input_unreadable') }
      try { return JSON.parse(text) } catch { throw new Error('audit_input_invalid_json') }
    }
    let report
    if (snapshot) {
      const pathFor = (key: keyof typeof DEFAULTS) => {
        if (options[key] != null && typeof options[key] !== 'string') throw new Error('audit_path_option_required')
        return typeof options[key] === 'string' ? options[key] : DEFAULTS[key]
      }
      const source = read(pathFor('list')), enriched = read(pathFor('enriched')), crosswalk = read(pathFor('crosswalk'))
      // Committed SOS source is { datasets: [...] }; accept a bare local array
      // too, while canonical-export mode remains strictly array-only.
      const list = source && typeof source === 'object' && 'datasets' in source ? source.datasets : source
      if (!Array.isArray(list) || !Array.isArray(enriched) || !list.every(row => row && typeof row === 'object' && !Array.isArray(row)) ||
          !enriched.every(row => row && typeof row === 'object' && !Array.isArray(row))) throw new Error('audit_snapshot_array_required')
      report = buildSnapshotMetadataAudit(list as RawSosEntry[], enriched as RawEnrichedEntry[], crosswalk as SnapshotCrosswalk)
    } else report = buildMetadataAudit(parseCanonicalRows(read(positional[0])))
    emit(report)
    return options.strict === true && report.strict_failure ? 1 : 0
  } catch (error) {
    // Never echo JSON contents, stack traces, file-system errors, or secret values.
    const message = error instanceof Error ? error.message : ''
    const reason = /^(audit_[a-z_]+|input_array_required|canonical_row_invalid:\d+)$/.test(message) ? message : 'audit_input_invalid'
    emit({ schema_version: METADATA_AUDIT_SCHEMA_VERSION, input_scope: 'invalid_input', reasons: [reason] })
    return 2
  }
}