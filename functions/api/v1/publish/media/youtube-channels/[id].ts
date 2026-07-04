/**
 * DELETE /api/v1/publish/media/youtube-channels/:id — remove one of
 * the node's custom agency-YouTube channels (task: media suggestion
 * engine). Built-in curated channels can't be removed (they aren't in
 * the table); a delete of an unknown/built-in id is a no-op 404.
 *
 * Privileged-only (admin / service), audit-logged
 * (`youtube_channel.remove`).
 */

import type { CatalogEnv } from '../../../_lib/env'
import type { PublisherData } from '../../_middleware'
import { isPrivileged } from '../../../_lib/publisher-store'
import { writeAuditEvent } from '../../../_lib/audit-store'
import { isChannelId, removeCustomChannel } from '../../../_lib/youtube-channels-store'

const CONTENT_TYPE = 'application/json; charset=utf-8'

function jsonError(status: number, error: string, message: string): Response {
  return new Response(JSON.stringify({ error, message }), {
    status,
    headers: { 'Content-Type': CONTENT_TYPE },
  })
}

export const onRequestDelete: PagesFunction<CatalogEnv, 'id'> = async context => {
  if (!context.env.CATALOG_DB) {
    return jsonError(503, 'binding_missing', 'CATALOG_DB binding is not configured on this deployment.')
  }
  const publisher = (context.data as unknown as PublisherData).publisher
  if (!isPrivileged(publisher)) {
    return jsonError(403, 'forbidden_role', 'Managing YouTube channels is restricted to admin and service callers.')
  }

  const idParam = context.params.id
  const id = Array.isArray(idParam) ? idParam[0] : idParam
  if (!id || !isChannelId(id)) return jsonError(400, 'invalid_request', 'A channel id is required.')

  const removed = await removeCustomChannel(context.env.CATALOG_DB, id)
  if (!removed) return jsonError(404, 'not_found', `Channel ${id} is not a custom channel.`)

  await writeAuditEvent(context.env.CATALOG_DB, {
    actor_kind: 'publisher',
    actor_id: publisher.id,
    action: 'youtube_channel.remove',
    subject_kind: 'youtube_channel',
    subject_id: id,
    metadata_json: null,
  })
  return new Response(JSON.stringify({ removed: true }), {
    status: 200,
    headers: { 'Content-Type': CONTENT_TYPE, 'Cache-Control': 'private, no-store' },
  })
}
