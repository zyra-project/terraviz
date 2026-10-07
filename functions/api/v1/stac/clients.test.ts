// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { execFile } from 'node:child_process'
import { request } from 'node:http'
import { promisify } from 'node:util'
import { it, expect, vi } from 'vitest'
import { chromium } from 'playwright'
import { withStacClientFixture } from './client-fixture'

it('keeps request exception details out of fixture HTTP responses', async () => {
  const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    await withStacClientFixture(async ({ origin }) => {
      const response = await new Promise<{ status: number | undefined; body: string; contentType: string | undefined }>((resolve, reject) => {
        const outgoing = request(`${origin}/api/v1/stac`, { method: 'TRACE' }, incoming => {
          const chunks: Buffer[] = []
          incoming.on('data', chunk => chunks.push(Buffer.from(chunk)))
          incoming.on('error', reject)
          incoming.on('end', () => resolve({ status: incoming.statusCode, body: Buffer.concat(chunks).toString(), contentType: incoming.headers['content-type'] }))
        })
        outgoing.on('error', reject)
        outgoing.end()
      })
      expect(response).toEqual({ status: 500, body: 'Internal Server Error', contentType: 'text/plain; charset=utf-8' })
      expect(diagnostic).toHaveBeenCalledWith('STAC client fixture request failed', expect.any(Error))
    })
  } finally { diagnostic.mockRestore() }
})

it.skipIf(!process.env.STAC_QGIS_PYTHON)('loads all Items through the actual QGIS OGC API Features provider', async () => {
  await withStacClientFixture(async ({ origin, collection }) => {
    const result = await promisify(execFile)(process.env.STAC_QGIS_PYTHON!, ['scripts/stac-qgis-client.py', `${origin}/api/v1/stac`, collection], {
      timeout: 120000, env: { ...process.env, QT_QPA_PLATFORM: 'offscreen', PYTHONUTF8: '1' },
    }).catch((error: { stdout: string; stderr: string }) => { throw new Error(error.stdout + '\n' + error.stderr) })
    console.log(result.stdout)
    expect(JSON.parse(result.stdout).features).toBe(120)
  })
}, 180000)

it.skipIf(process.env.STAC_CLIENTS !== 'true')('works with PySTAC Client and an independent GeoParquet indexer', async () => {
  await withStacClientFixture(async ({ origin, collection }) => {
    const result = await promisify(execFile)('uv', ['run', '--python', '3.11', '--exclude-newer', '2026-10-02T00:00:00Z', '--with', 'pystac-client==0.9.0', '--with', 'stac-geoparquet==0.8.2',
      'python', 'scripts/stac-clients.py', `${origin}/api/v1/stac`, collection], {
      timeout: 120000, env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
    }).catch((error: { stdout: string; stderr: string }) => { throw new Error(error.stdout + '\n' + error.stderr) })
    console.log(result.stdout)
    expect(JSON.parse(result.stdout)).toMatchObject({ indexed_items: 120, gdal_features: 120 })
  })
}, 180000)

it.skipIf(process.env.STAC_CLIENTS !== 'true' || !process.env.STAC_BROWSER_DIST)('browses actual STAC Browser v5.1.0 cross-origin with GET and POST search', async () => {
  await withStacClientFixture(async ({ origin, browserOrigin, collection }) => {
    expect(browserOrigin).toBeTruthy()
    expect(browserOrigin).not.toBe(origin)
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage()
      const failures: string[] = []
      page.on('pageerror', error => failures.push(error.message))
      const root = `${origin}/api/v1/stac`
      const loaded = page.waitForResponse(response => response.url() === root && response.status() === 200)
      await page.goto(`${browserOrigin}/#/external/${root}`)
      await loaded
      await page.getByRole('heading', { name: 'Test Node', exact: true }).waitFor()
      const searches = await page.evaluate(async api => {
        const get = await fetch(`${api}/search?limit=1`, { headers: { Accept: 'application/json' } })
        const post = await fetch(`${api}/search`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ limit: 1 }) })
        const invalid = await fetch(`${api}/search?limit=0`)
        return { getStatus: get.status, postStatus: post.status, invalidStatus: invalid.status,
          get: await get.json() as { features: unknown[] }, post: await post.json() as { features: unknown[] }, etag: post.headers.get('etag') }
      }, root)
      expect(searches.getStatus).toBe(200)
      expect(searches.postStatus).toBe(200)
      expect(searches.invalidStatus).toBe(400)
      expect(searches.get.features).toEqual(searches.post.features)
      expect(searches.etag).toBeTruthy()
      await page.goto('about:blank')
      await page.goto(`${browserOrigin}/#/search/external/${root}`)
      await page.getByRole('tab', { name: 'Search for Items', exact: true }).click()
      const searched = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/stac/search' && response.request().method() !== 'OPTIONS')
      await page.getByRole('button', { name: 'Submit', exact: true }).click()
      const searchResponse = await searched
      expect(searchResponse.status()).toBe(200)
      expect((await searchResponse.json()).features.length).toBeGreaterThan(0)
      await page.locator('main.search #search-map').waitFor()
      await page.screenshot({ path: '.wrangler/stac-browser-search.png', fullPage: true })
      await page.goto('about:blank')
      const collectionLoaded = page.waitForResponse(response => response.url() === `${root}/collections/${collection}` && response.status() === 200)
      await page.goto(`${browserOrigin}/#/external/${root}/collections/${collection}`)
      await collectionLoaded
      await page.getByRole('heading', { name: 'Scientific image', exact: true, level: 1 }).waitFor()
      const response = await page.request.get(`${root}/collections/${collection}/items?limit=1`)
      const body = await response.json()
      const item = body.features[0]
      await page.goto('about:blank')
      const itemLoaded = page.waitForResponse(response => response.url() === `${root}/items/${item.id}` && response.status() === 200)
      await page.goto(`${browserOrigin}/#/external/${root}/items/${item.id}`)
      await itemLoaded
      await page.getByRole('heading', { name: 'Scientific image', exact: true, level: 1 }).waitFor()
      await page.screenshot({ path: '.wrangler/stac-browser-item.png', fullPage: true })
      expect(failures).toEqual([])
    } finally { await browser.close() }
  })
}, 180000)