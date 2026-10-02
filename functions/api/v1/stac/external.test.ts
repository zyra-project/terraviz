// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFileSync } from 'node:fs'
import { afterEach, expect, it, vi } from 'vitest'
import { stacRouteFixture } from '../_lib/stac-test-helpers'
import { serveStac } from '../_lib/stac-http'
import { publishDataset } from '../_lib/dataset-mutations'
import type { CatalogEnv } from '../_lib/env'
import extension from '../../../../docs/metadata/schemas/terraviz-v1.0.0.json'

afterEach(() => vi.unstubAllGlobals())

it.skipIf(process.env.STAC_EXTERNAL !== 'true')('passes the pinned official STAC API validator over real HTTP', async () => {
  const { sqlite, ids, env: base } = stacRouteFixture(2)
  const manifest = Array.from({ length: 120 }, (_, index) => ({ index, filename: `${index}.png`, digest: `sha256:${index.toString(16).padStart(64, '0')}` }))
  const env: CatalogEnv = { ...base, STAC_HISTORY_CAPTURE: 'true',
    CATALOG_R2: { get: async () => ({ text: async () => JSON.stringify(manifest) }) } as unknown as R2Bucket }
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { headers: { 'content-type': 'image/png' } })))
  const server = createServer(async (incoming, outgoing) => {
    try {
      const address = server.address() as { port: number }
      const url = `http://127.0.0.1:${address.port}${incoming.url}`
      const chunks: Buffer[] = []
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk))
      const method = incoming.method ?? 'GET'
      const request = new Request(url, { method, headers: incoming.headers as Record<string, string>,
        ...(method === 'GET' || method === 'HEAD' ? {} : { body: Buffer.concat(chunks) }) })
      const response = incoming.url?.startsWith('/schema/stac/')
        ? new Response(JSON.stringify(extension), { headers: { 'content-type': 'application/schema+json' } })
        : incoming.url?.startsWith('/assets/')
          ? new Response(readFileSync('public/assets/equirect-sample.png'), { headers: { 'content-type': 'image/png' } })
          : await serveStac(request, env)
      const headers: Record<string, string> = {}
      response.headers.forEach((value, key) => { headers[key] = value })
      outgoing.writeHead(response.status, headers)
      outgoing.end(Buffer.from(await response.arrayBuffer()))
    } catch (error) { outgoing.writeHead(500); outgoing.end(String(error)) }
  })
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    sqlite.prepare('UPDATE node_identity SET base_url=?').run(origin)
    sqlite.prepare("UPDATE datasets SET slug='validator-sequence',frame_count=120,frame_extension='png',frame_source_filenames_ref='r2:manifest.json',period='P1D',format='video/mp4',end_time='2026-05-01T00:00:00Z' WHERE id=?").run(ids[0])
    env.R2_PUBLIC_BASE = 'https://data.example'
    expect(await publishDataset(env, ids[0])).toMatchObject({ ok: true })
    const args = ['tool', 'run', '--from', 'stac-api-validator==0.6.8', 'stac-api-validator', '--root-url', `${origin}/api/v1/stac`,
      '--conformance', 'core', '--conformance', 'collections', '--conformance', 'features', '--conformance', 'item-search',
      '--collection', `NODE000-${ids[0]}`, '--geometry', JSON.stringify({ type: 'Polygon', coordinates: [[[-1, -1], [1, -1], [1, 1], [-1, 1], [-1, -1]]] }), '--validate-pagination']
    const result = await promisify(execFile)('uv', args, { timeout: 240000, maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' } })
      .catch((error: { stdout: string; stderr: string }) => { throw new Error(error.stdout + '\n' + error.stderr) })
    console.log(result.stdout)
    console.log(result.stderr)
    expect(result.stdout + result.stderr).toMatch(/errors: none/i)
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    sqlite.close()
  }
}, 300000)