// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import type { CatalogEnv } from '../_lib/env'
import { serveStac, stacError } from '../_lib/stac-http'

export const onRequestGet: PagesFunction<CatalogEnv> = async context => {
  try { return await serveStac(context.request, context.env) }
  catch (error) {
    console.error('[stac] publication failed', error instanceof Error ? error.name : 'UnknownError')
    return stacError(503, 'stac_unavailable')
  }
}