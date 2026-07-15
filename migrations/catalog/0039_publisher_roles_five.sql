-- 0039_publisher_roles_five.sql — canonical five-role names.
--
-- Renames the two legacy publisher role strings to their canonical
-- WordPress-style identifiers, as the data half of the role/capability
-- model (docs/PUBLISHER_ROLES_PLAN.md):
--
--   publisher → author     (create + publish/edit OWN content)
--   readonly  → reviewer    (read-only)
--
-- The two new roles introduced by the model — `editor` and
-- `contributor` — need no backfill: no existing row holds them, and
-- they are assigned going forward through the Users tab. `admin` and
-- `service` are unchanged.
--
-- Follows the pattern of 0023_publisher_roles_two_tier.sql, which
-- renamed staff/community → admin/publisher. The `role` column has no
-- CHECK constraint (see 0005_publishers_audit.sql), so the enum is a
-- runtime concern; this migration only rewrites stored values.
--
-- `is_admin` is the synced mirror of `role = 'admin'` and is unaffected
-- (neither renamed role was ever admin). Application code accepts the
-- legacy strings as aliases (normalizeRole) so a mid-deploy read of an
-- un-migrated replica still resolves correctly.
--
-- Additive/idempotent: re-running is a no-op once values are canonical.

UPDATE publishers SET role = 'author'   WHERE role = 'publisher';
UPDATE publishers SET role = 'reviewer' WHERE role = 'readonly';
