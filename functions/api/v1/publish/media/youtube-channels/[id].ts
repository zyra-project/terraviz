/**
 * /api/v1/publish/media/youtube-channels/:id — one agency-YouTube
 * channel (task: media suggestion engine).
 *
 *   POST   — `{ disabled: boolean }`. Switch a BUILT-IN channel off or
 *            back on for this node (built-ins are code constants, so
 *            "off" is a row in `youtube_channels_disabled`, not a
 *            delete). Only valid for a built-in id; a custom id is
 *            managed with DELETE instead.
 *   DELETE — remove one of the node's CUSTOM channels. Built-in curated
 *            channels can't be removed (they aren't in the table); a
 *            delete of an unknown/built-in id is a no-op 404.
 *
 * Privileged-only (admin / service), audit-logged
 * (`youtube_channel.disable` / `.enable` / `.remove`).
 */

import type { CatalogEnv } from '../../../_lib/env'
import type { PublisherData } from '../../_middleware'
import { isPrivileged } from '../../../_lib/publisher-store'
import { writeAuditEvent } from '../../../_lib/audit-store'
import { AGENCY_YOUTUBE_CHANNELS } from '../../../_lib/youtube-channels'
import { isChannelId, removeCustomChannel, setBuiltinChannelDisabled } from '../../../_lib/youtube-channels-store'

const CONTENT_TYPE = 'application/json; charset=utf-8'

function jsonError(status: number, error: string, message: string): Response {
  return new Response(JSON.stringify({ error, message }), {
    status,
    headers: { 'Content-Type': CONTENT_TYPE },
  })
}

function channelIdParam(context: Parameters<PagesFunction<CatalogEnv, 'id'>>[0]): string | null {
  const idParam = context.params.id
  const id = Array.isArray(idParam) ? idParam[0] : idParam
  return id && isChannelId(id) ? id : null
}

export const onRequestPost: PagesFunction<CatalogEnv, 'id'> = async context => {
  if (!context.env.CATALOG_DB) {
    return jsonError(503, 'binding_missing', 'CATALOG_DB binding is not configured on this deployment.')
  }
  const publisher = (context.data as unknown as PublisherData).publisher
  if (!isPrivileged(publisher)) {
    return jsonError(403, 'forbidden_role', 'Managing YouTube channels is restricted to admin and service callers.')
  }

  const id = channelIdParam(context)
  if (!id) return jsonError(400, 'invalid_request', 'A channel id is required.')
  // Disable/enable is only meaningful for a built-in channel; a custom
  // channel is turned off by removing it (DELETE).
  if (!(id in AGENCY_YOUTUBE_CHANNELS)) {
    return jsonError(404, 'not_found', `Channel ${id} is not a built-in channel. Remove a custom channel with DELETE.`)
  }

  let body: { disabled?: unknown }
  try {
    body = (await context.request.json()) as typeof body
  } catch {
    return jsonError(400, 'invalid_json', 'Request body is not valid JSON.')
  }
  if (typeof body.disabled !== 'boolean') {
    return jsonError(400, 'invalid_request', '`disabled` must be a boolean.')
  }

  await setBuiltinChannelDisabled(context.env.CATALOG_DB, id, body.disabled, publisher.id)
  await writeAuditEvent(context.env.CATALOG_DB, {
    actor_kind: 'publisher',
    actor_id: publisher.id,
    action: body.disabled ? 'youtube_channel.disable' : 'youtube_channel.enable',
    subject_kind: 'youtube_channel',
    subject_id: id,
    metadata_json: null,
  })

  return new Response(JSON.stringify({ channelId: id, builtin: true, disabled: body.disabled }), {
    status: 200,
    headers: { 'Content-Type': CONTENT_TYPE, 'Cache-Control': 'private, no-store' },
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
