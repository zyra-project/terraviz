/**
 * GET/POST /api/v1/publish/media/youtube-channels — the node's
 * agency-YouTube channel allowlist (task: media suggestion engine).
 *
 * GET  → the effective allowlist: the hardcoded curated agency
 *        channels (`builtin: true`, non-removable) plus this node's
 *        own custom channels (`builtin: false`, removable), so the
 *        Feeds console can render both.
 * POST → `{ url }`. Adds a custom channel by pasted URL. A
 *        `/channel/UC…` URL carries its id directly; a `@handle`,
 *        `/c/name`, or `/user/name` URL is resolved through the
 *        YouTube Data API using the server-side `YOUTUBE_API_KEY`
 *        (1 quota unit). The canonical `UC…` id is what's stored.
 *
 * Privileged-only (admin / service); the add is audit-logged
 * (`youtube_channel.add`). DELETE of a custom channel lives in
 * `[id].ts`.
 */

import type { CatalogEnv } from '../../_lib/env'
import type { PublisherData } from '../_middleware'
import { isPrivileged } from '../../_lib/publisher-store'
import { writeAuditEvent } from '../../_lib/audit-store'
import { AGENCY_YOUTUBE_CHANNELS } from '../../_lib/youtube-channels'
import {
  addCustomChannel,
  disabledBuiltinChannelIds,
  isChannelId,
  listCustomChannels,
  resolveChannelUrl,
} from '../../_lib/youtube-channels-store'

const CONTENT_TYPE = 'application/json; charset=utf-8'
const MAX_URL_CHARS = 300

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': CONTENT_TYPE, 'Cache-Control': 'private, no-store' },
  })
}

function jsonError(status: number, error: string, message: string): Response {
  return json(status, { error, message })
}

export const onRequestGet: PagesFunction<CatalogEnv> = async context => {
  if (!context.env.CATALOG_DB) {
    return jsonError(503, 'binding_missing', 'CATALOG_DB binding is not configured on this deployment.')
  }
  const publisher = (context.data as unknown as PublisherData).publisher
  if (!isPrivileged(publisher)) {
    return jsonError(403, 'forbidden_role', 'Managing YouTube channels is restricted to admin and service callers.')
  }

  // Both tables can be absent during rollout (functions deployed before
  // the migration runs) or on an un-migrated preview D1. Degrade to empty
  // rather than 500 the endpoint and break the Feeds UI — same handling as
  // the search proxy.
  let disabled = new Set<string>()
  try {
    disabled = await disabledBuiltinChannelIds(context.env.CATALOG_DB)
  } catch {
    // No youtube_channels_disabled table yet → nothing is disabled.
  }
  let customChannels: Awaited<ReturnType<typeof listCustomChannels>> = []
  try {
    customChannels = await listCustomChannels(context.env.CATALOG_DB)
  } catch {
    // No youtube_channels table yet → just the built-in defaults.
  }

  const builtin = Object.entries(AGENCY_YOUTUBE_CHANNELS).map(([channelId, channelName]) => ({
    channelId,
    channelName,
    builtin: true,
    // Built-in channels can be switched off per-node; the flag drives the
    // Feeds console's disable/enable toggle.
    disabled: disabled.has(channelId),
  }))
  const custom = customChannels.map(c => ({
    channelId: c.channelId,
    channelName: c.channelName,
    builtin: false,
    // Custom channels aren't disabled — they're removed — but the field
    // is present so the response shape is uniform.
    disabled: false,
  }))
  return json(200, { channels: [...builtin, ...custom] })
}

export const onRequestPost: PagesFunction<CatalogEnv> = async context => {
  if (!context.env.CATALOG_DB) {
    return jsonError(503, 'binding_missing', 'CATALOG_DB binding is not configured on this deployment.')
  }
  const publisher = (context.data as unknown as PublisherData).publisher
  if (!isPrivileged(publisher)) {
    return jsonError(403, 'forbidden_role', 'Managing YouTube channels is restricted to admin and service callers.')
  }

  let body: { url?: unknown }
  try {
    body = (await context.request.json()) as typeof body
  } catch {
    return jsonError(400, 'invalid_json', 'Request body is not valid JSON.')
  }
  const url = typeof body.url === 'string' ? body.url.trim() : ''
  if (!url || url.length > MAX_URL_CHARS) {
    return json(400, { errors: [{ field: 'url', code: 'required', message: 'A channel URL is required.' }] })
  }

  const resolved = await resolveChannelUrl(url, context.env.YOUTUBE_API_KEY, (i, init) => fetch(i, init))
  if (!resolved.ok) {
    const message =
      resolved.code === 'invalid_url'
        ? 'That is not a recognizable YouTube channel URL.'
        : resolved.code === 'unconfigured'
          ? 'Resolving a @handle or custom URL needs YOUTUBE_API_KEY. Paste the youtube.com/channel/UC… URL instead, or configure the key.'
          : 'That channel could not be found. Check the URL.'
    return json(400, { errors: [{ field: 'url', code: resolved.code, message }] })
  }
  // Defense in depth — the resolver only ever returns a canonical id.
  if (!isChannelId(resolved.channelId)) {
    return json(400, { errors: [{ field: 'url', code: 'unresolved', message: 'That channel could not be found.' }] })
  }

  await addCustomChannel(context.env.CATALOG_DB, {
    channelId: resolved.channelId,
    channelName: resolved.channelName,
    addedBy: publisher.id,
  })
  await writeAuditEvent(context.env.CATALOG_DB, {
    actor_kind: 'publisher',
    actor_id: publisher.id,
    action: 'youtube_channel.add',
    subject_kind: 'youtube_channel',
    subject_id: resolved.channelId,
    metadata_json: JSON.stringify({ channel_name: resolved.channelName }),
  })

  return json(201, { channel: { channelId: resolved.channelId, channelName: resolved.channelName, builtin: false } })
}
