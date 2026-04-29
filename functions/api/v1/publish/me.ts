/**
 * GET /api/v1/publish/me — return the calling publisher's profile.
 *
 * The middleware has already verified Access and resolved the
 * publishers row; we just hand it back. Kept as a separate file
 * (rather than a `_middleware`-side branch) so the route is
 * symmetric with the rest of the publisher API and easy to test.
 */

import type { CatalogEnv } from '../_lib/env'
import type { PublisherData } from './_middleware'

const CONTENT_TYPE = 'application/json; charset=utf-8'

export const onRequestGet: PagesFunction<CatalogEnv> = async context => {
  const publisher = (context.data as unknown as PublisherData).publisher
  return new Response(
    JSON.stringify({
      id: publisher.id,
      email: publisher.email,
      display_name: publisher.display_name,
      affiliation: publisher.affiliation,
      role: publisher.role,
      is_admin: publisher.is_admin === 1,
      status: publisher.status,
      created_at: publisher.created_at,
    }),
    {
      status: 200,
      headers: { 'Content-Type': CONTENT_TYPE, 'Cache-Control': 'private, no-store' },
    },
  )
}
