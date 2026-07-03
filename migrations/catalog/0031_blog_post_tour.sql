-- Companion-tour linkage for blog posts (task: blog ↔ tour).
--
-- `tour_id` holds the tours-row ULID of the post's AI-generated
-- companion tour (or NULL). Plain TEXT, no FK — mirrors dataset_ids:
-- a deleted tour simply leaves a dangling id, and the public read
-- only surfaces the tour while it is published, public, and not
-- retracted, so dangling/draft ids never leak. Additive only.

ALTER TABLE blog_posts ADD COLUMN tour_id TEXT;
