-- 0016_node_identity_singleton.sql — enforce the node_identity
-- singleton invariant at the schema level.
--
-- `node_identity` is conceptually a one-row table (the whole catalog
-- reads it via `SELECT ... LIMIT 1`, and every dataset's NOT NULL
-- `origin_node` is stamped from it). The row's PK is a generated
-- ULID, so nothing previously stopped a second row from being
-- inserted — e.g. two concurrent first-time `init-node` /
-- `upsertNodeIdentity` calls both observing an empty table. With two
-- rows, `LIMIT 1` returns an arbitrary identity and `origin_node`
-- values can diverge.
--
-- Pin it to a single row: a `singleton` column defaulting to 1 plus a
-- UNIQUE index means a second insert (which also defaults to 1)
-- violates the constraint and is rejected. Existing deployments get
-- `singleton = 1` on their single row via the column default, so the
-- index builds cleanly. The application-side insert keeps a
-- `WHERE NOT EXISTS` guard so the common idempotent re-run path
-- no-ops gracefully instead of surfacing a constraint error; this
-- index is the hard backstop against a genuine race.

ALTER TABLE node_identity ADD COLUMN singleton INTEGER NOT NULL DEFAULT 1;

CREATE UNIQUE INDEX idx_node_identity_singleton ON node_identity(singleton);
