// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, expect, it } from 'vitest'
import { EXPECTED_BINDINGS } from '../expected-bindings'
import {
  bucketEnvConflict,
  buildPatchBody,
  formatBindingsPlan,
  OPTIONAL_EXTRAS,
  planBindings,
} from './bindings-plan'
import { applyEnvOverrides, defaultState, type SetupState } from './state'

function provisionedState(): SetupState {
  return {
    ...defaultState(),
    accountId: 'acct',
    d1: { name: 'sphere-feedback', id: 'd1-uuid' },
    telemetryKv: { name: 'TELEMETRY_KILL_SWITCH', id: 'kv-tel' },
    catalogKv: { name: 'CATALOG_KV', id: 'kv-cat' },
    accessTeamDomain: 'org.cloudflareaccess.com',
    accessAud: 'aud-hex',
  }
}

describe('planBindings', () => {
  it('resolves the data-plane bindings once resources exist', () => {
    const plan = planBindings(provisionedState())
    const byName = new Map(plan.resolutions.map(r => [r.name, r]))
    expect(byName.get('CATALOG_DB')?.payload).toEqual({ id: 'd1-uuid' })
    expect(byName.get('FEEDBACK_DB')?.payload).toEqual({ id: 'd1-uuid' })
    expect(byName.get('CATALOG_KV')?.payload).toEqual({ namespace_id: 'kv-cat' })
    expect(byName.get('TELEMETRY_KILL_SWITCH')?.payload).toEqual({ namespace_id: 'kv-tel' })
    expect(byName.get('CATALOG_R2')?.payload).toEqual({ name: 'terraviz-assets' })
    expect(byName.get('CATALOG_VECTORIZE')?.payload).toEqual({
      index_name: 'terraviz-datasets',
    })
    expect(byName.get('ANALYTICS')?.payload).toEqual({ dataset: 'terraviz_events' })
    expect(byName.get('AI')?.payload).toEqual({})
  })

  it('skips D1/KV bindings before the resources are created', () => {
    const plan = planBindings(defaultState())
    const catalog = plan.resolutions.find(r => r.name === 'CATALOG_DB')
    expect(catalog?.status).toBe('skipped')
    expect(catalog?.reason).toMatch(/not created yet/)
  })

  it('never writes an empty secret — an unset one is skipped', () => {
    const plan = planBindings(provisionedState(), {})
    const secret = plan.resolutions.find(r => r.name === 'PREVIEW_SIGNING_KEY')
    expect(secret?.status).toBe('skipped')
    expect(secret?.payload).toBeUndefined()
  })

  it('resolves a secret when a value is supplied, and masks it for display', () => {
    const plan = planBindings(provisionedState(), { PREVIEW_SIGNING_KEY: 's3cret' })
    const secret = plan.resolutions.find(r => r.name === 'PREVIEW_SIGNING_KEY')
    expect(secret?.payload).toEqual({ type: 'secret_text', value: 's3cret' })
    expect(secret?.display).not.toContain('s3cret')
  })

  it('never leaks a secret value into the rendered table', () => {
    const plan = planBindings(provisionedState(), {
      PREVIEW_SIGNING_KEY: 'TOP-SECRET-VALUE',
      NODE_ID_PRIVATE_KEY_PEM: 'ALSO-SECRET',
    })
    const table = formatBindingsPlan(plan)
    expect(table).not.toContain('TOP-SECRET-VALUE')
    expect(table).not.toContain('ALSO-SECRET')
    expect(table).toContain('PREVIEW_SIGNING_KEY')
  })

  it('covers every manifest entry, so the audit can never expect something we ignore', () => {
    const plan = planBindings(provisionedState(), {}, [...EXPECTED_BINDINGS])
    expect(plan.resolutions).toHaveLength(EXPECTED_BINDINGS.length)
    const names = new Set(plan.resolutions.map(r => r.name))
    for (const exp of EXPECTED_BINDINGS) expect(names.has(exp.name)).toBe(true)
  })

  it('treats TRUSTED_PUBLISHER_DOMAINS as optional, not audit-required', () => {
    expect(EXPECTED_BINDINGS.some(b => b.name === 'TRUSTED_PUBLISHER_DOMAINS')).toBe(false)
    expect(OPTIONAL_EXTRAS.some(b => b.name === 'TRUSTED_PUBLISHER_DOMAINS')).toBe(true)
  })

  // Setup cannot know which Access app covers the feedback admin
  // paths, so the value comes from the operator or not at all.
  it('writes ACCESS_FEEDBACK_AUD only from the operator, never a guess', () => {
    expect(EXPECTED_BINDINGS.some(b => b.name === 'ACCESS_FEEDBACK_AUD')).toBe(false)
    const find = (state: ReturnType<typeof provisionedState>) =>
      planBindings(state).resolutions.find(r => r.name === 'ACCESS_FEEDBACK_AUD')
    expect(find(provisionedState())?.status).toBe('skipped')
    const exported = applyEnvOverrides(provisionedState(), { ACCESS_FEEDBACK_AUD: '  none\n' })
    expect(find(exported)).toMatchObject({ status: 'resolved', payload: { type: 'plain_text', value: 'none' } })
  })

  // The S3-API paths read CATALOG_R2_BUCKET and fall back to
  // terraviz-assets. Writing the binding without the variable left a
  // renamed bucket addressed by two different names.
  it('writes CATALOG_R2_BUCKET from the same name as the CATALOG_R2 binding', () => {
    const renamed = applyEnvOverrides(provisionedState(), { TERRAVIZ_R2_BUCKET: 'node-assets' })
    const plan = planBindings(renamed)
    const byName = new Map(plan.resolutions.map(r => [r.name, r]))
    expect(byName.get('CATALOG_R2')?.payload).toEqual({ name: 'node-assets' })
    expect(byName.get('CATALOG_R2_BUCKET')).toMatchObject({
      status: 'resolved',
      payload: { type: 'plain_text', value: 'node-assets' },
    })

    const body = buildPatchBody(plan)
    for (const env of ['production', 'preview'] as const) {
      const config = body.deployment_configs[env]
      expect(config?.r2_buckets?.CATALOG_R2).toEqual({ name: 'node-assets' })
      expect(config?.env_vars?.CATALOG_R2_BUCKET).toEqual({
        type: 'plain_text',
        value: 'node-assets',
      })
    }
  })

  it('writes CATALOG_R2_BUCKET for an unrenamed bucket too, so the name is explicit', () => {
    const bucket = planBindings(provisionedState()).resolutions.find(
      r => r.name === 'CATALOG_R2_BUCKET',
    )
    expect(bucket?.payload).toEqual({ type: 'plain_text', value: 'terraviz-assets' })
  })
})

describe('buildPatchBody', () => {
  it('writes every binding to BOTH environments', () => {
    const body = buildPatchBody(planBindings(provisionedState()))
    const prod = body.deployment_configs.production
    const preview = body.deployment_configs.preview
    expect(prod?.d1_databases?.CATALOG_DB).toEqual({ id: 'd1-uuid' })
    expect(preview?.d1_databases?.CATALOG_DB).toEqual({ id: 'd1-uuid' })
    expect(Object.keys(prod?.kv_namespaces ?? {}).sort()).toEqual(
      Object.keys(preview?.kv_namespaces ?? {}).sort(),
    )
  })

  it('groups each binding under the key Cloudflare expects', () => {
    const body = buildPatchBody(planBindings(provisionedState()))
    const prod = body.deployment_configs.production!
    expect(prod.env_vars?.ACCESS_AUD).toEqual({ type: 'plain_text', value: 'aud-hex' })
    expect(prod.r2_buckets?.CATALOG_R2).toBeDefined()
    expect(prod.vectorize_bindings?.CATALOG_VECTORIZE).toBeDefined()
    expect(prod.ai_bindings?.AI).toEqual({})
    expect(prod.analytics_engine_datasets?.ANALYTICS).toBeDefined()
  })

  it('omits skipped bindings so the merge-PATCH cannot clear them', () => {
    const body = buildPatchBody(planBindings(defaultState()))
    const prod = body.deployment_configs.production
    expect(prod?.d1_databases).toBeUndefined()
    expect(prod?.env_vars?.ACCESS_AUD).toBeUndefined()
  })

  it('emits no environment at all when nothing resolved', () => {
    const empty = { resolutions: [], resolved: [], skipped: [] }
    expect(buildPatchBody(empty).deployment_configs).toEqual({})
  })
})

// The bindings step writes the bucket name from setup's state. A shell
// that names another bucket would otherwise be overwritten in both
// places at once, leaving a pair the audit reads as consistent.
describe('bucketEnvConflict', () => {
  const state = { r2Bucket: { name: 'terraviz-assets' } }

  it('refuses when the shell names a different bucket', () => {
    const message = bucketEnvConflict(state, { CATALOG_R2_BUCKET: 'node-assets' })
    expect(message).toContain('"node-assets"')
    expect(message).toContain('export TERRAVIZ_R2_BUCKET=node-assets')
  })

  it('is satisfied when the shell agrees, after trimming as the Worker does', () => {
    expect(bucketEnvConflict(state, { CATALOG_R2_BUCKET: ' terraviz-assets\n' })).toBeNull()
  })

  it('says nothing when the shell does not set it', () => {
    expect(bucketEnvConflict(state, {})).toBeNull()
    expect(bucketEnvConflict(state, { CATALOG_R2_BUCKET: '  ' })).toBeNull()
  })
})
