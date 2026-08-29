-- Coverage of the fields tour shot sequencing depends on.
--
--   npx wrangler d1 execute <DB> --remote --file=scripts/experiments/tour-sequencing/coverage.sql
--
-- Why this matters: orderTourStops scores dataset similarity on
-- categories (0.50), keywords (0.30) and bounding box (0.20). Where
-- those are sparse the pair scores 0, candidates tie, and the sequencer
-- degrades to plain match-score order.
--
-- The public federation API DOES expose all three (enriched.categories,
-- enriched.keywords, boundingBox), and on the live node they run 69% /
-- 75% / 12%. This query is still worth running because the API view is
-- not the whole story: it answers coverage among the datasets actually
-- LINKED TO EVENTS, which is the only population the sequencer ever
-- orders, and it reports richness rather than mere presence.

-- 1. The population. Sequencing only ever sees published, visible rows.
SELECT 'population' AS metric, COUNT(*) AS n
FROM datasets
WHERE published_at IS NOT NULL AND is_hidden = 0 AND retracted_at IS NULL;

-- 2. Per-signal coverage over that population.
SELECT
  'with_categories' AS metric,
  COUNT(DISTINCT d.id) AS n
FROM datasets d JOIN dataset_categories c ON c.dataset_id = d.id
WHERE d.published_at IS NOT NULL AND d.is_hidden = 0 AND d.retracted_at IS NULL;

SELECT 'with_keywords' AS metric, COUNT(DISTINCT d.id) AS n
FROM datasets d JOIN dataset_keywords k ON k.dataset_id = d.id
WHERE d.published_at IS NOT NULL AND d.is_hidden = 0 AND d.retracted_at IS NULL;

SELECT 'with_tags' AS metric, COUNT(DISTINCT d.id) AS n
FROM datasets d JOIN dataset_tags t ON t.dataset_id = d.id
WHERE d.published_at IS NOT NULL AND d.is_hidden = 0 AND d.retracted_at IS NULL;

SELECT 'with_full_bbox' AS metric, COUNT(*) AS n
FROM datasets
WHERE published_at IS NOT NULL AND is_hidden = 0 AND retracted_at IS NULL
  AND bbox_n IS NOT NULL AND bbox_s IS NOT NULL
  AND bbox_w IS NOT NULL AND bbox_e IS NOT NULL;

SELECT 'with_both_times' AS metric, COUNT(*) AS n
FROM datasets
WHERE published_at IS NOT NULL AND is_hidden = 0 AND retracted_at IS NULL
  AND start_time IS NOT NULL AND end_time IS NOT NULL;

-- 3. Richness, not just presence. A facet present once per dataset
--    with the same value everywhere is no more useful than none:
--    Jaccard between two identical single-value sets is 1, which reads
--    as "these are the same thing" for every pair in the catalogue.
SELECT 'distinct_category_facet_values' AS metric, COUNT(*) AS n
FROM (SELECT DISTINCT facet, value FROM dataset_categories);

SELECT 'distinct_keywords' AS metric, COUNT(*) AS n
FROM (SELECT DISTINCT keyword FROM dataset_keywords);

SELECT 'distinct_tags' AS metric, COUNT(*) AS n
FROM (SELECT DISTINCT tag FROM dataset_tags);

-- 4. The sharpest number: coverage among datasets that are actually
--    LINKED to events, since that is the only population the sequencer
--    ever orders. Catalogue-wide coverage can look fine while the
--    linked subset is bare (or the reverse).
SELECT
  'linked_datasets' AS metric,
  COUNT(DISTINCT l.dataset_id) AS n
FROM event_dataset_links l;

SELECT
  'linked_with_categories' AS metric,
  COUNT(DISTINCT l.dataset_id) AS n
FROM event_dataset_links l
JOIN dataset_categories c ON c.dataset_id = l.dataset_id;

SELECT
  'linked_with_keywords' AS metric,
  COUNT(DISTINCT l.dataset_id) AS n
FROM event_dataset_links l
JOIN dataset_keywords k ON k.dataset_id = l.dataset_id;

SELECT
  'linked_with_full_bbox' AS metric,
  COUNT(DISTINCT l.dataset_id) AS n
FROM event_dataset_links l
JOIN datasets d ON d.id = l.dataset_id
WHERE d.bbox_n IS NOT NULL AND d.bbox_s IS NOT NULL
  AND d.bbox_w IS NOT NULL AND d.bbox_e IS NOT NULL;

-- 5. How many events even have enough links to sequence. With fewer
--    than three approved stops there is nothing to reorder.
SELECT
  'events_with_3plus_links' AS metric,
  COUNT(*) AS n
FROM (
  SELECT event_id FROM event_dataset_links
  GROUP BY event_id HAVING COUNT(*) >= 3
);
