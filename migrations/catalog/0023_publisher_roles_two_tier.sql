-- 0023_publisher_roles_two_tier.sql — formalize the publisher role
-- taxonomy into a two-tier human model.
--
-- Before: role ∈ { staff | community | readonly | service } with a
-- separate is_admin flag, and isPrivileged() conflating staff/service/
-- is_admin. After: role is the canonical privilege source of truth —
--   admin     — full administrator (the old `staff`, plus any row a
--               prior operator manually flipped to is_admin=1).
--   publisher — the secondary authoring role (the old `community`).
--   readonly  — reviewer (unchanged; reviewer semantics land later).
--   service   — machine credential / service token (unchanged).
--
-- The legacy is_admin column is retained and kept in lockstep with the
-- canonical role (is_admin = 1 iff role = 'admin') so the /me wire
-- contract and existing UI badge keep working; it is a candidate for
-- removal in a later pass.
--
-- role has no SQL CHECK constraint (see 0005_publishers_audit.sql), so
-- the additive values need no column rebuild. Pure data migration —
-- it UPDATEs existing rows and adds no schema.

-- Promote admins first. staff was always provisioned is_admin=1; also
-- catch any row a prior operator hand-flipped to is_admin=1 regardless
-- of its role string (e.g. a community row promoted via the old
-- SELF_HOSTING SQL variants).
UPDATE publishers SET role = 'admin'     WHERE role = 'staff' OR is_admin = 1;

-- Remaining community accounts become the secondary publisher role.
UPDATE publishers SET role = 'publisher' WHERE role = 'community';

-- Keep the legacy flag in lockstep with the canonical role.
UPDATE publishers SET is_admin = CASE WHEN role = 'admin' THEN 1 ELSE 0 END;
