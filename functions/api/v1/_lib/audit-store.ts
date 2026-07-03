/**
 * Append-only writes to the `audit_events` table.
 *
 * Each row records a single privileged action: who acted, what they
 * acted on, and a small JSON metadata blob the reviewer might need
 * to understand the action without joining back to the row's own
 * history. The schema lives in
 * [`migrations/catalog/0005_publishers_audit.sql`](../../../migrations/catalog/0005_publishers_audit.sql).
 *
 * ULID ordering on `id` means the per-subject timeline is queryable
 * without an extra index — newest-first traversal is just an `ORDER
 * BY id DESC`.
 *
 * The writer is best-effort. A failed audit insert must not block
 * the user-facing mutation it accompanies — the mutation has
 * already succeeded by the time we reach here, and we'd rather log
 * the audit failure and move on than tell the caller their write
 * was rejected when in fact it landed.
 */

import { newUlid } from './ulid'

/** Distinct kinds of actor recognised by the schema. */
export type AuditActorKind = 'publisher' | 'peer' | 'system'

/** Distinct kinds of subject the publisher API records actions on. */
export type AuditSubjectKind =
  | 'dataset'
  | 'tour'
  | 'peer'
  | 'grant'
  | 'workflow'
  | 'analytics_day'
  | 'publisher'
  | 'event'
  | 'feed'
  | 'node_profile'
  | 'blog_post'

/**
 * `action` is a free-form, dotted token recording *what happened*.
 * Existing tokens are listed here so cross-file searches surface
 * every call site; new actions should land here too, and ideally
 * also in the actor / subject coverage matrix in
 * [`docs/CATALOG_PUBLISHING_TOOLS.md`](../../../../docs/CATALOG_PUBLISHING_TOOLS.md).
 */
export type AuditAction =
  | 'dataset.create'
  | 'dataset.update'
  | 'dataset.publish'
  | 'dataset.retract'
  | 'dataset.delete'
  | 'hero.set'
  | 'hero.clear'
  | 'workflow.create'
  | 'workflow.update'
  | 'workflow.run'
  | 'analytics.export'
  | 'publisher.approve'
  | 'publisher.reject'
  | 'publisher.suspend'
  | 'publisher.reactivate'
  | 'publisher.role_change'
  | 'event.reviewed'
  | 'event.ingested'
  | 'event.refreshed'
  | 'event.tour_generated'
  | 'feed.created'
  | 'feed.updated'
  | 'feed.deleted'
  | 'node_profile.update'
  | 'node_profile.logo_update'
  | 'blog.create'
  | 'blog.update'
  | 'blog.publish'
  | 'blog.unpublish'
  | 'blog.generate'

export interface AuditEventInput {
  actor_kind: AuditActorKind
  actor_id: string | null
  action: AuditAction
  subject_kind: AuditSubjectKind
  subject_id: string | null
  /** Free-form JSON blob describing the action. Already-serialised
   *  on the wire so a metadata schema change doesn't force a
   *  migration; callers stringify a plain object. Keep small —
   *  this column is read in bulk on the per-subject timeline. */
  metadata_json?: string | null
}

/**
 * Insert a single audit_events row. Returns the new id on success;
 * returns `null` on any failure and logs the error — the caller
 * has no recovery path and the user-facing action has already
 * succeeded.
 */
export async function writeAuditEvent(
  db: D1Database,
  input: AuditEventInput,
): Promise<string | null> {
  const id = newUlid()
  const now = new Date().toISOString()
  try {
    await db
      .prepare(
        `INSERT INTO audit_events
           (id, actor_kind, actor_id, action, subject_kind, subject_id,
            metadata_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        input.actor_kind,
        input.actor_id,
        input.action,
        input.subject_kind,
        input.subject_id,
        input.metadata_json ?? null,
        now,
      )
      .run()
    return id
  } catch (err) {
    // Best-effort: the calling mutation has already committed its
    // row. Log via console.error (surfaced in `wrangler tail`) and
    // return null so the caller can react if they care, but never
    // throw — losing an audit row beats failing a write the user
    // believes succeeded.
    console.error('[audit] failed to write audit_events row', {
      action: input.action,
      subject_id: input.subject_id,
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

/**
 * Convenience builder for the dataset-mutation routes. Computes the
 * actor metadata from the publisher row and stamps `subject_kind:
 * 'dataset'` so the call sites stay terse. The four current
 * publisher-API dataset mutations call this directly.
 */
export async function writeDatasetAudit(
  db: D1Database,
  publisher: { id: string; role: string },
  action: AuditAction,
  datasetId: string,
  metadata?: Record<string, unknown>,
): Promise<string | null> {
  return writeAuditEvent(db, {
    actor_kind: 'publisher',
    actor_id: publisher.id,
    action,
    subject_kind: 'dataset',
    subject_id: datasetId,
    metadata_json: metadata ? JSON.stringify(metadata) : null,
  })
}

/**
 * Convenience builder for the user-administration routes. Records an
 * admin acting on another publisher's row (`subject_kind:
 * 'publisher'`). Used by `publisher-mutations.ts` for approve /
 * reject / suspend / reactivate / role_change.
 */
export async function writePublisherAudit(
  db: D1Database,
  actor: { id: string; role: string },
  action: AuditAction,
  subjectPublisherId: string,
  metadata?: Record<string, unknown>,
): Promise<string | null> {
  return writeAuditEvent(db, {
    actor_kind: 'publisher',
    actor_id: actor.id,
    action,
    subject_kind: 'publisher',
    subject_id: subjectPublisherId,
    metadata_json: metadata ? JSON.stringify(metadata) : null,
  })
}
