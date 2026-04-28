-- 0005_publishers_audit.sql — Phase 1a — publishers + audit_events.
--
-- publishers is the row a Cloudflare Access middleware JIT-creates
-- when an authenticated caller hits /api/v1/publish/** for the
-- first time (Commit E). is_admin gates sensitive node-wide actions
-- (peer management, hard delete, node-wide audit log read); the
-- middleware auto-promotes the first staff row on a fresh deploy.
--
-- org_id is included as a nullable column without a FOREIGN KEY
-- declaration. The orgs table and the FK arrive together in the
-- Phase 6 community-publishing migration; until then the column
-- reads NULL on every row.
--
-- audit_events is the append-only operational record of every
-- privileged action — publish, retract, grant, revoke, peer
-- subscribe, integrity_failure, hard delete. ULID ordering means
-- the per-subject timeline is queryable without a separate index;
-- idx_audit_subject covers the common "what happened to dataset X"
-- query shape.

CREATE TABLE publishers (
  id              TEXT PRIMARY KEY,           -- ULID
  email           TEXT NOT NULL UNIQUE,
  display_name    TEXT NOT NULL,
  affiliation     TEXT,
  org_id          TEXT,                       -- nullable; FK + orgs table arrive in Phase 6
  role            TEXT NOT NULL,              -- staff | community | readonly
  is_admin        INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL,              -- pending | active | suspended
  created_at      TEXT NOT NULL
);

CREATE TABLE audit_events (
  id              TEXT PRIMARY KEY,           -- ULID
  actor_kind      TEXT NOT NULL,              -- publisher | peer | system
  actor_id        TEXT,
  action          TEXT NOT NULL,
  subject_kind   TEXT NOT NULL,               -- dataset | tour | peer | grant
  subject_id     TEXT,
  metadata_json  TEXT,
  created_at     TEXT NOT NULL
);

CREATE INDEX idx_audit_subject ON audit_events(subject_kind, subject_id, created_at);
