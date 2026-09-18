// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { PUBLIC_DATASET_PREDICATE, type DatasetRow, type DecorationRows, type NodeIdentityRow } from './catalog-store'
import type { StacMediaIntrinsics, StacReadModel, StacRendition } from './stac-read-model'

interface SnapshotRow extends DatasetRow, StacMediaIntrinsics {
  stac_tags: string
  stac_categories: string
  stac_keywords: string
  stac_developers: string
  stac_related: string
  stac_renditions: string
  stac_workflow: number
}

export interface StacPublicationInput extends StacReadModel {
  branding: { org_name: string; logo_ref: string | null } | null
}

export async function readStacPublicationInput(db: D1Database): Promise<StacPublicationInput> {
  const session = db.withSession('first-primary')
  const results = await session.batch([
    session.prepare('SELECT node_id, display_name, base_url, description, contact_email, public_key, created_at FROM node_identity LIMIT 1'),
    session.prepare(`SELECT datasets.*,
      (SELECT json_group_array(tag) FROM (SELECT tag FROM dataset_tags WHERE dataset_id = datasets.id ORDER BY tag)) AS stac_tags,
      (SELECT json_group_array(json_object('facet', facet, 'value', value)) FROM (SELECT facet, value FROM dataset_categories WHERE dataset_id = datasets.id ORDER BY facet, value)) AS stac_categories,
      (SELECT json_group_array(keyword) FROM (SELECT keyword FROM dataset_keywords WHERE dataset_id = datasets.id ORDER BY keyword)) AS stac_keywords,
      (SELECT json_group_array(json_object('role', role, 'name', name, 'affiliation_url', affiliation_url)) FROM (SELECT role, name, affiliation_url FROM dataset_developers WHERE dataset_id = datasets.id ORDER BY role, name, affiliation_url)) AS stac_developers,
      (SELECT json_group_array(json_object('related_title', related_title, 'related_url', related_url)) FROM (SELECT related_title, related_url FROM dataset_related WHERE dataset_id = datasets.id ORDER BY related_title, related_url)) AS stac_related,
      (SELECT json_group_array(json_object('dataset_id', dataset_id, 'rendition_id', rendition_id,
        'codec', codec, 'color_space', color_space, 'bit_depth', bit_depth, 'has_alpha', has_alpha,
        'alpha_encoding', alpha_encoding, 'width', width, 'height', height, 'bitrate_kbps', bitrate_kbps,
        'ref', ref, 'mime_type', mime_type, 'content_digest', content_digest, 'created_at', created_at))
        FROM (SELECT * FROM dataset_renditions WHERE dataset_id = datasets.id ORDER BY rendition_id)) AS stac_renditions,
      EXISTS(SELECT 1 FROM workflows WHERE target_dataset_id = datasets.id) AS stac_workflow
      FROM datasets WHERE ${PUBLIC_DATASET_PREDICATE} ORDER BY id`),
    session.prepare('SELECT org_name, logo_ref FROM node_profile WHERE id = 1'),
  ])
  if (results.some(result => !result.success)) throw new Error('STAC snapshot read failed')
  const identity = results[0].results[0] as NodeIdentityRow | undefined
  return {
    node: identity ? { identity } : null,
    branding: (results[2].results[0] as StacPublicationInput['branding']) ?? null,
    datasets: (results[1].results as unknown as SnapshotRow[]).map(snapshot => {
      const { stac_tags, stac_categories, stac_keywords, stac_developers, stac_related, stac_renditions, stac_workflow, ...row } = snapshot
      const decorations: DecorationRows = { tags: JSON.parse(stac_tags), categories: JSON.parse(stac_categories),
        keywords: JSON.parse(stac_keywords), developers: JSON.parse(stac_developers), related: JSON.parse(stac_related) }
      const { width, height, render_width, render_height, color_space, bit_depth, hdr_transfer, has_alpha, alpha_encoding, primary_codec } = row
      return { row, decorations,
        media: { width, height, render_width, render_height, color_space, bit_depth, hdr_transfer, has_alpha, alpha_encoding, primary_codec },
        renditions: JSON.parse(stac_renditions) as StacRendition[], publicationKind: stac_workflow ? 'workflow' as const : undefined }
    }),
  }
}