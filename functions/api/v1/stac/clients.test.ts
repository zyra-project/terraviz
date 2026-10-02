// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { it, expect } from 'vitest'
import { chromium } from 'playwright'
import { withStacClientFixture } from './client-fixture'

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
    const result = await promisify(execFile)('uv', ['run', '--python', '3.11', '--with', 'pystac-client==0.9.0', '--with', 'stac-geoparquet==0.8.2',
      'python', 'scripts/stac-clients.py', `${origin}/api/v1/stac`, collection], {
      timeout: 120000, env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
    }).catch((error: { stdout: string; stderr: string }) => { throw new Error(error.stdout + '\n' + error.stderr) })
    console.log(result.stdout)
    expect(JSON.parse(result.stdout).indexed_items).toBe(120)
  })
}, 180000)

it.skipIf(process.env.STAC_CLIENTS !== 'true' || !process.env.STAC_BROWSER_DIST)('browses actual STAC Browser v5.1.0 catalog, collection and Item pages', async () => {
  await withStacClientFixture(async ({ origin, collection }) => {
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage()
      const failures: string[] = []
      page.on('pageerror', error => failures.push(error.message))
      const root = `${origin}/api/v1/stac`
      const loaded = page.waitForResponse(response => response.url() === root && response.status() === 200)
      await page.goto(`${origin}/#/external/${root}`)
      await loaded
      await page.getByRole('heading', { name: 'Test Node', exact: true }).waitFor()
      await page.goto('about:blank')
      const collectionLoaded = page.waitForResponse(response => response.url() === `${root}/collections/${collection}` && response.status() === 200)
      await page.goto(`${origin}/#/external/${root}/collections/${collection}`)
      await collectionLoaded
      await page.getByRole('heading', { name: 'Scientific image', exact: true, level: 1 }).waitFor()
      const response = await page.request.get(`${root}/collections/${collection}/items?limit=1`)
      const body = await response.json()
      const item = body.features[0]
      await page.goto('about:blank')
      const itemLoaded = page.waitForResponse(response => response.url() === `${root}/items/${item.id}` && response.status() === 200)
      await page.goto(`${origin}/#/external/${root}/items/${item.id}`)
      await itemLoaded
      await page.getByRole('heading', { name: 'Scientific image', exact: true, level: 1 }).waitFor()
      await page.screenshot({ path: '.wrangler/stac-browser-item.png', fullPage: true })
      expect(failures).toEqual([])
    } finally { await browser.close() }
  })
}, 180000)