-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 The Zyra Project

-- 0059_federation_sweep_flag.sql — remember what a full sync itself saw
-- (metadata Phase 5, step 5).
--
-- A finished full sync schedules a deferred sweep of the rows it did not
-- deliver, and the sweep guard (`sweepIsPlausible`) refuses one that would
-- keep nothing, or drop most of the mirror. Judging only the counts when
-- the sweep comes due is not enough: every incremental pull before then
-- stamps the rows it delivers with the sweep's run, so a peer that
-- delivered enough rows in that window could carry a sweep past the
-- guard that the full sync's own counts would fail.
--
-- `sweep_flagged` is 1 when the counts the full sync finished with fail the
-- guard. It is written with `sweep_run` by the full sync that finishes,
-- and cleared when the sweep runs. A flagged sweep is refused when it
-- comes due, whatever its counts are by then, unless it would drop
-- nothing or the pull carries an operator's matching accept.
--
-- A refused sweep is latched by clearing `sweep_after` while keeping
-- `sweep_run` (0058's columns, no schema change): from then on it runs
-- only when an operator accepts it, or when it would drop nothing.
--
-- Additive only: one column with a default, so a database that applied
-- 0058 picks it up. Rows already present read as not flagged.

ALTER TABLE federation_peers ADD COLUMN sweep_flagged INTEGER NOT NULL DEFAULT 0;
