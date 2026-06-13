/**
 * /api/v1/publish/publishers/{id}
 *
 * GET   → Fetch a single publisher account (admin Users tab detail).
 * PATCH → Partially update a publisher: `role`, `status`,
 *         `display_name`, `affiliation`. Drives approve / reject /
 *         suspend / reactivate / promote / demote / edit-role.
 *
 * Authorisation: admin-only (`isAdmin`). 403 `forbidden_role`
 * otherwise. `service` is not an assignable role through this route —
 * it is reserved for machine tokens (see `ASSIGNABLE_ROLES`).
 *
 * Failure envelopes match the rest of the publisher API:
 *   `{ error, message }` for system-level errors,
 *   `{ errors: [...] }` for body-validation arrays. The store layer
 *   enforces the self-lockout / last-admin guardrails and surfaces
 *   them as 409 `self_lockout` / `last_admin`.
 */

import type { CatalogEnv } from '../../_lib/env'
import type { PublisherData } from '../_middleware'
import { isAdmin, ASSIGNABLE_ROLES } from '../../_lib/publisher-store'
import { getPublisher, updatePublisher, type PublisherUpdatePayload } from '../../_lib/publisher-mutations'

const CONTENT_TYPE = 'application/json; charset=utf-8'

/** Statuses an admin may set via PATCH. `pending` (the provisioning
 *  default) is intentionally excluded — see the validation note. */
const PATCHABLE_STATUSES = ['active', 'suspended'] as const

function jsonError(status: number, error: string, message: string): Response {
  return new Response(JSON.stringify({ error, message }), {
    status,
    headers: { 'Content-Type': CONTENT_TYPE },
  })
}

function validationFailure(
  errors: Array<{ field: string; code: string; message: string }>,
  status = 400,
): Response {
  return new Response(JSON.stringify({ errors }), {
    status,
    headers: { 'Content-Type': CONTENT_TYPE },
  })
}

function pickId(context: { params: { id?: string | string[] } }): string | null {
  const idParam = context.params.id
  const id = Array.isArray(idParam) ? idParam[0] : idParam
  return id || null
}

export const onRequestGet: PagesFunction<CatalogEnv, 'id'> = async context => {
  const publisher = (context.data as unknown as PublisherData).publisher
  if (!isAdmin(publisher)) {
    return jsonError(403, 'forbidden_role', 'User administration is restricted to admins.')
  }
  const id = pickId(context)
  if (!id) return jsonError(400, 'invalid_request', 'Missing publisher id.')

  const row = await getPublisher(context.env.CATALOG_DB!, id)
  if (!row) return jsonError(404, 'not_found', `Publisher ${id} not found.`)

  return new Response(JSON.stringify({ publisher: row }), {
    status: 200,
    headers: { 'Content-Type': CONTENT_TYPE, 'Cache-Control': 'private, no-store' },
  })
}

export const onRequestPatch: PagesFunction<CatalogEnv, 'id'> = async context => {
  const caller = (context.data as unknown as PublisherData).publisher
  if (!isAdmin(caller)) {
    return jsonError(403, 'forbidden_role', 'User administration is restricted to admins.')
  }
  const id = pickId(context)
  if (!id) return jsonError(400, 'invalid_request', 'Missing publisher id.')

  let body: unknown
  try {
    body = await context.request.json()
  } catch {
    return jsonError(400, 'invalid_json', 'Request body is not valid JSON.')
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return jsonError(400, 'invalid_body', 'Request body must be an object.')
  }

  const { role, status, display_name, affiliation } = body as Record<string, unknown>
  const errors: Array<{ field: string; code: string; message: string }> = []

  if (role !== undefined) {
    if (typeof role !== 'string' || !(ASSIGNABLE_ROLES as readonly string[]).includes(role)) {
      errors.push({
        field: 'role',
        code: 'invalid_role',
        message: `role must be one of: ${ASSIGNABLE_ROLES.join(', ')}.`,
      })
    }
  }
  if (status !== undefined) {
    // Only active | suspended are reachable through admin actions
    // (approve / reactivate → active, reject / suspend → suspended).
    // `pending` is the provisioning default and is never set via PATCH
    // — accepting it would allow odd transitions (e.g. active→pending)
    // and misclassify the audit action.
    if (typeof status !== 'string' || !(PATCHABLE_STATUSES as readonly string[]).includes(status)) {
      errors.push({
        field: 'status',
        code: 'invalid_status',
        message: `status must be one of: ${PATCHABLE_STATUSES.join(', ')}.`,
      })
    }
  }
  if (display_name !== undefined && (typeof display_name !== 'string' || display_name.trim() === '')) {
    errors.push({
      field: 'display_name',
      code: 'invalid_display_name',
      message: 'display_name must be a non-empty string.',
    })
  }
  if (affiliation !== undefined && affiliation !== null && typeof affiliation !== 'string') {
    errors.push({
      field: 'affiliation',
      code: 'invalid_affiliation',
      message: 'affiliation must be a string or null.',
    })
  }
  if (errors.length) return validationFailure(errors)

  const payload: PublisherUpdatePayload = {
    role: role as string | undefined,
    status: status as string | undefined,
    display_name: display_name as string | undefined,
    affiliation: affiliation as string | null | undefined,
  }

  const result = await updatePublisher(context.env.CATALOG_DB!, id, payload, caller)
  if (!result.ok) {
    return jsonError(result.status, result.error, result.message)
  }

  return new Response(JSON.stringify({ publisher: result.publisher }), {
    status: 200,
    headers: { 'Content-Type': CONTENT_TYPE, 'Cache-Control': 'private, no-store' },
  })
}
