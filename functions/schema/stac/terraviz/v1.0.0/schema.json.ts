// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import schema from '../../../../../docs/metadata/schemas/terraviz-v1.0.0.json'

export const onRequestGet: PagesFunction = async () => new Response(JSON.stringify(schema), {
  headers: { 'Content-Type': 'application/schema+json; charset=utf-8', 'Cache-Control': 'public, max-age=31536000, immutable',
    'Access-Control-Allow-Origin': '*' },
})