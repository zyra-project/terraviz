// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import type { CatalogEnv } from '../_lib/env'
import type { PublisherData } from './_middleware'
import { isPrivileged } from '../_lib/publisher-store'
import { readStacPublication } from '../_lib/stac-publication'

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store' } })
}

export const onRequestGet: PagesFunction<CatalogEnv> = async context => {
  const publisher = (context.data as Partial<PublisherData>).publisher
  if (!publisher) return json(401, { error: 'unauthenticated' })
  if (publisher.status !== 'active' || !isPrivileged(publisher)) return json(403, { error: 'forbidden' })
  if (!context.env.CATALOG_DB) return json(503, { error: 'binding_missing' })
  if (new URL(context.request.url).search) return json(400, { error: 'invalid_query' })
  try {
    const publication = await readStacPublication(context.env, { operatorReport: true })
    const rows = publication.report
    const excluded = rows.filter(row => !row.included).length
    return json(200, { schema_version: 1, publication_enabled: context.env.STAC_ENABLED === 'true',
      totals: { evaluated: rows.length, included: rows.length - excluded, excluded }, records: rows })
  } catch {
    return json(503, { error: 'stac_report_unavailable' })
  }
}