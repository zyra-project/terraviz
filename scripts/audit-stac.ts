// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { isInvokedAsScript } from './lib/cli'
import terravizSchema from '../docs/metadata/schemas/terraviz-v1.0.0.json'

interface AuditOptions {
  root: string
  allowedOrigins?: string[]
  fetchImpl?: typeof fetch
  maxDocuments?: number
  maxAssets?: number
}
interface AuditIssue { url: string; code: string }
interface AuditReport { schema_version: 1; ok: boolean; documents: number; assets: number; schemas: number; issues: AuditIssue[] }
type JsonObject = Record<string, unknown>

function object(value: unknown): value is JsonObject { return value !== null && typeof value === 'object' && !Array.isArray(value) }

async function boundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader()
  if (!reader) throw new Error('empty_json')
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      length += chunk.value.byteLength
      if (length > 2 * 1024 * 1024) throw new Error('json_size_limit')
      chunks.push(chunk.value)
    }
  } finally { await reader.cancel() }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return JSON.parse(new TextDecoder().decode(bytes))
}

export async function auditStac(options: AuditOptions): Promise<AuditReport> {
  const root = new URL(options.root)
  if (root.protocol !== 'https:' || root.username || root.password || root.search || root.hash) throw new Error('Root must be a credential-free HTTPS URL')
  root.pathname = root.pathname.replace(/\/$/, '')
  const fetchImpl = options.fetchImpl ?? fetch
  const origins = new Set([root.origin, 'https://terraviz.zyra-project.org', 'https://stac-extensions.github.io', ...(options.allowedOrigins ?? [])])
  const report: AuditReport = { schema_version: 1, ok: true, documents: 0, assets: 0, schemas: 0, issues: [] }
  const issue = (url: string, code: string) => { report.ok = false; report.issues.push({ url, code }) }
  const safe = (href: unknown): href is string => {
    if (typeof href !== 'string' || /\s/.test(href)) return false
    try {
      const url = new URL(href)
      return url.protocol === 'https:' && !url.username && !url.password && !url.hash && origins.has(url.origin)
    } catch { return false }
  }
  const queue = [root.href]
  const visited = new Set<string>()
  const assets = new Map<string, string | undefined>()
  const schemas = new Set<string>()
  const expectedTypes = new Map<string, string>()
  const registerAsset = (href: unknown, type: unknown): void => {
    if (!safe(href)) { issue(typeof href === 'string' ? href : root.href, 'unsafe_or_untrusted_asset'); return }
    if (!assets.has(href) && assets.size >= (options.maxAssets ?? 1000)) { issue(root.href, 'asset_limit'); return }
    assets.set(href, typeof type === 'string' ? type.toLowerCase() : undefined)
  }
  const inspect = (document: JsonObject, location: string): void => {
    const isResource = ['Catalog', 'Collection', 'Feature'].includes(String(document.type))
    if (isResource && document.stac_version !== '1.1.0') issue(location, 'stac_version')
    if (!Array.isArray(document.links)) { issue(location, 'links_missing'); return }
    if (isResource && !document.links.some(link => object(link) && link.rel === 'self' && safe(link.href))) issue(location, 'self_missing')
    for (const link of document.links) {
      if (!object(link) || !safe(link.href)) { issue(location, 'invalid_or_untrusted_link'); continue }
      if (['self', 'root', 'parent', 'child', 'item', 'collection', 'items', 'next'].includes(String(link.rel))) {
        const target = new URL(link.href)
        if (target.origin !== root.origin || !(target.pathname === root.pathname || target.pathname.startsWith(root.pathname + '/'))) {
          issue(link.href, 'traversal_outside_root'); continue
        }
        if (typeof link.type === 'string') expectedTypes.set(link.href, link.type)
        if (!visited.has(link.href) && !queue.includes(link.href)) {
          if (queue.length + visited.size >= (options.maxDocuments ?? 1000)) issue(root.href, 'document_limit')
          else queue.push(link.href)
        }
      } else if (['icon', 'license', 'via', 'about', 'related'].includes(String(link.rel))) registerAsset(link.href, link.type)
    }
    if (object(document.assets)) for (const asset of Object.values(document.assets)) {
      if (!object(asset)) { issue(location, 'invalid_asset'); continue }
      registerAsset(asset.href, asset.type)
    }
    if (Array.isArray(document.stac_extensions)) for (const uri of document.stac_extensions) {
      if (!safe(uri)) issue(location, 'invalid_or_untrusted_schema')
      else if (schemas.size >= 32 && !schemas.has(uri)) issue(location, 'schema_limit')
      else schemas.add(uri)
    }
  }
  while (queue.length) {
    const href = queue.shift()!
    if (visited.has(href)) continue
    visited.add(href)
    try {
      const response = await fetchImpl(href, { redirect: 'manual', credentials: 'omit', signal: AbortSignal.timeout(10000) })
      report.documents++
      if (!response.ok) { issue(href, `document_http_${response.status}`); await response.body?.cancel(); continue }
      const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()
      if (!['application/json', 'application/geo+json'].includes(type ?? '')) { issue(href, 'document_media_type'); await response.body?.cancel(); continue }
      if (expectedTypes.has(href) && type !== expectedTypes.get(href)) issue(href, 'link_media_type_mismatch')
      const document = await boundedJson(response)
      if (!object(document)) { issue(href, 'document_shape'); continue }
      const geojson = document.type === 'Feature' || document.type === 'FeatureCollection'
      if (type !== (geojson ? 'application/geo+json' : 'application/json')) issue(href, 'resource_media_type')
      if (href === root.href && document.type !== 'Catalog') issue(href, 'root_not_catalog')
      inspect(document, href)
      for (const key of ['collections', 'features']) if (Array.isArray(document[key])) {
        for (const child of document[key]) {
          if (object(child)) inspect(child, href)
          else issue(href, 'member_shape')
        }
      }
    } catch { issue(href, 'document_fetch_or_json_failed') }
  }
  for (const uri of schemas) {
    try {
      const response = await fetchImpl(uri, { redirect: 'manual', credentials: 'omit', signal: AbortSignal.timeout(10000) })
      report.schemas++
      if (!response.ok) { issue(uri, `schema_http_${response.status}`); await response.body?.cancel(); continue }
      const schema = await boundedJson(response)
      if (!object(schema) || schema.$id !== uri) issue(uri, 'schema_identity')
      if (uri === terravizSchema.$id && JSON.stringify(schema) !== JSON.stringify(terravizSchema)) issue(uri, 'terraviz_schema_drift')
    } catch { issue(uri, 'schema_fetch_or_json_failed') }
  }
  for (const [href, expected] of assets) {
    try {
      const response = await fetchImpl(href, { method: 'HEAD', redirect: 'manual', credentials: 'omit', signal: AbortSignal.timeout(10000) })
      report.assets++
      if (!response.ok) issue(href, `asset_http_${response.status}`)
      const actual = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()
      if (response.ok && expected && actual !== expected) issue(href, 'asset_media_type')
      await response.body?.cancel()
    } catch { issue(href, 'asset_fetch_failed') }
  }
  return report
}

if (isInvokedAsScript(import.meta.url)) {
  try {
    const root = process.env.STAC_AUDIT_ROOT
    if (!root) throw new Error('Set STAC_AUDIT_ROOT to the enabled public STAC root')
    const report = await auditStac({ root, allowedOrigins: (process.env.STAC_AUDIT_ORIGINS ?? '').split(',').map(value => value.trim()).filter(Boolean) })
    await new Promise<void>((resolve, reject) => process.stdout.write(JSON.stringify(report, null, 2) + '\n', error => error ? reject(error) : resolve()))
    process.exitCode = report.ok ? 0 : 1
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'STAC audit failed')
    process.exitCode = 1
  }
}