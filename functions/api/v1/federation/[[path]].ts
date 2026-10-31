// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import type { CatalogEnv } from '../_lib/env'

export const onRequest: PagesFunction<CatalogEnv> = async context =>
  new Response(context.request.method === 'HEAD' ? null : JSON.stringify({ error: 'not_found' }), {
    status: 404,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  })