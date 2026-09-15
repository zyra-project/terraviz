// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, expect, it, vi } from 'vitest'
import { runMetadataAudit } from './metadata-audit'
import { HELP_TEXT } from './commands'
import { BOOLEAN_FLAGS, parseArgs } from './lib/args'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

function invoke(argv: string[], text: string) {
  let stdout = ''
  const readFile = vi.fn(() => text)
  const code = runMetadataAudit({ args: parseArgs(argv, new Set([...BOOLEAN_FLAGS, 'snapshot', 'strict'])), stdout: { write: chunk => { stdout += chunk; return true } }, readFile })
  return { code, report: JSON.parse(stdout), readFile }
}

describe('offline metadata-audit CLI', () => {
  it('prints JSON for an empty canonical export', () => {
    expect(invoke(['catalog.json'], '[]')).toMatchObject({ code: 0, report: { schema_version: 1, input_scope: 'canonical_enriched_rows', counts: { total: 0 } } })
  })
  it('returns 1 only in strict mode for excluded/unresolved records', () => {
    const data = JSON.stringify([{ id: '01HYAAAAAAAAAAAAAAAAAAAAAA', origin_node: 'origin', format: 'tour/json' }])
    expect(invoke(['catalog.json'], data).code).toBe(0)
    expect(invoke(['--strict', 'catalog.json'], data).code).toBe(1)
    expect(invoke(['catalog.json', '--strict'], data).report.counts.excluded).toBe(1)
  })
  it.each([[], ['one.json', 'two.json'], ['--strict=true', 'one.json'], ['one.json', '--server=https://example.org'], ['one.json', '--list=list.json'], ['--snapshot', 'one.json']].map(argv => ({ argv })))('always emits JSON for invalid args: $argv', ({ argv }) => {
    const result = invoke(argv, '[]')
    expect(result.code).toBe(2)
    expect(result.report.input_scope).toBe('invalid_input')
    expect(result.readFile).not.toHaveBeenCalled()
  })
  it.each(['https://example.org/data.json', '//server/share/data.json', '\\\\server\\share\\data.json', '.env', '-', 'file:///data.json'])('refuses network/secret/discovery paths: %s', path => {
    const result = invoke([path], '[]')
    expect(result.report.reasons).toEqual(['audit_local_json_path_required'])
    expect(result.readFile).not.toHaveBeenCalled()
  })
  it('does not leak malformed JSON or raw WireDataset contents', () => {
    expect(JSON.stringify(invoke(['catalog.json'], '{"secret":"DO_NOT_ECHO"').report)).not.toContain('DO_NOT_ECHO')
    expect(invoke(['catalog.json'], '[{"id":"DO_NOT_ECHO","originNode":"public-wire"}]').report.reasons).toEqual(['canonical_row_invalid:0'])
  })
  it('uses only the three explicit/default snapshot files', () => {
    const paths: string[] = []
    let stdout = ''
    const code = runMetadataAudit({ args: { positional: [], options: { snapshot: true, strict: true } }, stdout: { write: chunk => { stdout += chunk; return true } }, readFile: path => { paths.push(path); return path.includes('crosswalk') ? '{}' : '[]' } })
    expect(paths).toEqual(['public/assets/sos-dataset-list.json', 'public/assets/sos_dataset_metadata.json', 'public/assets/sos-enrichment-crosswalk.json'])
    expect(JSON.parse(stdout).snapshot.reasons).toContain('snapshot_crosswalk_invalid')
    expect(code).toBe(1)
  })
  it('help retains init-node public-description warning and adds audit scope', () => {
    expect(HELP_TEXT).toContain('metadata-audit <catalog-export.json>')
    expect(HELP_TEXT).toContain('not public WireDataset')
    expect(HELP_TEXT).toContain('No secrets or internal prose.')
    expect(HELP_TEXT).toContain('does not publish it; review existing values')
  })
  it('dispatches before config or credential resolution (invalid server env cannot block audit)', () => {
    const output = execFileSync(process.execPath, ['--import', 'tsx', resolve('cli/terraviz.ts'), 'metadata-audit', '--snapshot'], {
      cwd: resolve('.'), encoding: 'utf8', env: { ...process.env, TERRAVIZ_SERVER: 'not-a-url', TERRAVIZ_ACCESS_CLIENT_ID: '', TERRAVIZ_ACCESS_CLIENT_SECRET: '' },
    })
    expect(JSON.parse(output)).toMatchObject({ schema_version: 1, input_scope: 'bundled_snapshot_mapping' })
  })
})