-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 The Zyra Project

CREATE INDEX stac_datasets_datetime ON datasets(julianday(start_time), julianday(end_time));
CREATE INDEX stac_datasets_geometry ON datasets(bbox_s, bbox_n, bbox_w, bbox_e);
CREATE INDEX stac_history_items_datetime ON stac_history_items(julianday(start_time), julianday(end_time));
CREATE INDEX stac_history_geometry ON stac_history_publications(
  json_extract(model_json, '$.row.bbox_s'), json_extract(model_json, '$.row.bbox_n'),
  json_extract(model_json, '$.row.bbox_w'), json_extract(model_json, '$.row.bbox_e'));