-- Organization logo for the node profile (Phase 3d follow-up).
--
-- `logo_ref` holds an `r2:<key>` handle pointing at a content-addressed
-- object under `node/logo/sha256/{hex}/logo.{ext}` (uploaded through
-- `POST /api/v1/publish/node-profile/logo`), or NULL when no logo is
-- set. Additive only.

ALTER TABLE node_profile ADD COLUMN logo_ref TEXT;
