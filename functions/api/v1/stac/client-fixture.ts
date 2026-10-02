// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { resolve, sep, extname } from 'node:path'
import { expect, vi } from 'vitest'
import { stacRouteFixture } from '../_lib/stac-test-helpers'
import { serveStac } from '../_lib/stac-http'
import { publishDataset } from '../_lib/dataset-mutations'
import type { CatalogEnv } from '../_lib/env'
import extension from '../../../../docs/metadata/schemas/terraviz-v1.0.0.json'

export async function withStacClientFixture(run: (fixture: { origin: string; ids: string[]; collection: string }) => Promise<void>): Promise<void> {
  const { sqlite, ids, env: base } = stacRouteFixture(2)
  const manifest = Array.from({ length: 120 }, (_, index) => ({ index, filename: `${index}.png`, digest: `sha256:${index.toString(16).padStart(64, '0')}` }))
  const env: CatalogEnv = { ...base, STAC_HISTORY_CAPTURE: 'true', R2_PUBLIC_BASE: 'https://data.example',
    CATALOG_R2: { get: async () => ({ text: async () => JSON.stringify(manifest) }) } as unknown as R2Bucket }
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { headers: { 'content-type': 'image/png' } })))
  const server = createServer(async (incoming, outgoing) => {
    try {
      const url = new URL(`http://127.0.0.1:${(server.address() as { port: number }).port}${incoming.url}`)
      const chunks: Buffer[] = []
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk))
      const method = incoming.method ?? 'GET'
      const request = new Request(url, { method, headers: incoming.headers as Record<string, string>,
        ...(method === 'GET' || method === 'HEAD' ? {} : { body: Buffer.concat(chunks) }) })
      let response: Response
      if (url.pathname.startsWith('/api/v1/stac')) response = await serveStac(request, env)
      else if (url.pathname.startsWith('/schema/stac/')) response = new Response(JSON.stringify(extension), { headers: { 'content-type': 'application/schema+json' } })
      else if (process.env.STAC_BROWSER_DIST) {
        const base = resolve(process.env.STAC_BROWSER_DIST)
        const path = resolve(base, '.' + (url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname)))
        if (!path.startsWith(base + sep)) throw new Error('Invalid static path')
        const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' }
        response = new Response(readFileSync(path), { headers: { 'content-type': types[extname(path)] ?? 'application/octet-stream' } })
      } else response = new Response(null, { status: 404 })
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
    expect(await publishDataset(env, ids[0])).toMatchObject({ ok: true })
    await run({ origin, ids, collection: `NODE000-${ids[0]}` })
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    sqlite.close()
    vi.unstubAllGlobals()
  }
}