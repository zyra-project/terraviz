// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/** Phase 0 input contracts only. No storage, fetching, schema execution, or publication. */
import { roleCan, ROLES, type Role as PublisherRole } from '../../../../src/types/publisher-roles'

export const METADATA_POLICY_LIMITS = Object.freeze({
  registrations: 32, fields: 64, extensionBytes: 16_384, registrationBytes: 32_768,
  descriptorBytes: 262_144, facets: 32, terms: 512, labels: 8, mappings: 16,
  references: 64, uri: 2_048, definition: 2_000, label: 200, jsonDepth: 16,
})
export const METADATA_SCOPES = ['Catalog', 'Collection', 'Item', 'Asset'] as const
export type MetadataScope = (typeof METADATA_SCOPES)[number]
export const RESERVED_METADATA_PREFIXES = ['terraviz', 'sci', 'file', 'proj', 'core'] as const
export const SKOS_MAPPING_RELATIONS = [
  'http://www.w3.org/2004/02/skos/core#exactMatch',
  'http://www.w3.org/2004/02/skos/core#broadMatch',
  'http://www.w3.org/2004/02/skos/core#narrowMatch',
  'http://www.w3.org/2004/02/skos/core#relatedMatch',
] as const

export interface MetadataReviewEvidence {
  authorId: string
  authorRole: PublisherRole
  reviewerId: string
  reviewerRole: PublisherRole
  changeId: string
  reason: string
}
export interface ExtensionRegistration {
  prefix: string
  ownerNodeId: string
  schemaUri: string
  version: string
  schemaSha256: string
  scopes: MetadataScope[]
  fields: { key: string; scopes: MetadataScope[] }[]
  maxPayloadBytes: number
  approval: MetadataReviewEvidence | null
}
export interface VocabularyLabel { language: string; label: string }
export interface VocabularyTerm {
  id: string
  labels: VocabularyLabel[]
  definition: string
  mappings: { relation: (typeof SKOS_MAPPING_RELATIONS)[number]; conceptUri: string }[]
}
export interface VocabularyDescriptor {
  formatVersion: 1
  vocabularyUri: string
  ownerNodeId: string
  revision: number
  facets: { id: string; labels: VocabularyLabel[]; definition: string; terms: VocabularyTerm[] }[]
  approval: MetadataReviewEvidence | null
}
export interface VocabularyReference {
  vocabularyUri: string
  ownerNodeId: string
  revision: number
  facetId: string
  termIds: string[]
}
export type PolicyValidation<T> = { ok: true; value: T } | { ok: false; reasons: string[] }
const fail = (reason: string): { ok: false; reasons: string[] } => ({ ok: false, reasons: [reason] })
const success = <T>(value: T): PolicyValidation<T> => ({ ok: true, value })
const ID = /^[a-z][a-z0-9_-]{0,63}$/
// Same opaque, case-preserving persisted node namespace as metadata readiness.
const NODE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const PREFIX = /^[a-z][a-z0-9]{1,15}$/
const VERSION = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/
const SHA256 = /^sha256:[a-f0-9]{64}$/
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
type RecordValue = Record<string, unknown>

function record(value: unknown): value is RecordValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
}
function shape(value: unknown, keys: readonly string[]): value is RecordValue {
  return record(value) && Object.keys(value).length === keys.length
    && keys.every(key => Object.hasOwn(value, key))
}
function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max
    && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value)
}
function matches(value: unknown, pattern: RegExp): value is string {
  return typeof value === 'string' && pattern.test(value)
}
function list(value: unknown, max: number, min = 1): value is unknown[] {
  return Array.isArray(value) && value.length >= min && value.length <= max
}
function positiveInteger(value: unknown, max = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= max
}

/** Canonical syntax only, NOT a network/SSRF or reachability verification. */
export function isCanonicalMetadataUri(value: unknown, concept = false): value is string {
  if (!text(value, METADATA_POLICY_LIMITS.uri) || /[\s\\]/.test(value)) return false
  try {
    const url = new URL(value)
    return (url.protocol === 'https:' || (concept && url.protocol === 'http:'))
      && url.username === '' && url.password === '' && url.search === ''
      && (concept || url.hash === '') && url.href === value
  } catch { return false }
}

/** Exact serialized UTF-8 byte count; rejects non-JSON values, accessors, cycles and deep input.
 * Inputs must be inert data (e.g. JSON.parse), never hostile JS proxies. Does not invoke toJSON.
 */
function jsonBytes(value: unknown, max: number): number | null {
  let bytes = 0
  let nodes = 0
  const seen = new Set<object>()
  const encoder = new TextEncoder()
  function add(token: string): boolean {
    bytes += encoder.encode(token).length
    return bytes <= max
  }
  function visit(v: unknown, depth: number): boolean {
    if (++nodes > 32_768 || depth > METADATA_POLICY_LIMITS.jsonDepth) return false
    if (v === null || typeof v === 'boolean') return add(JSON.stringify(v))
    if (typeof v === 'string') return v.length <= max && add(JSON.stringify(v))
    if (typeof v === 'number') return Number.isFinite(v) && add(JSON.stringify(v))
    if (!Array.isArray(v) && !record(v)) return false
    if (seen.has(v)) return false
    seen.add(v)
    const array = Array.isArray(v)
    const keys = Object.keys(v)
    if (Reflect.ownKeys(v).length !== keys.length + (array ? 1 : 0)) return false
    if (array && keys.length !== v.length) return false
    if (!add(array ? '[' : '{')) return false
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i]
      if (array && key !== String(i)) return false
      const descriptor = Object.getOwnPropertyDescriptor(v, key)!
      if (!('value' in descriptor) || DANGEROUS_KEYS.has(key)) return false
      if (i && !add(',')) return false
      if (!array && !add(JSON.stringify(key) + ':')) return false
      if (!visit(descriptor.value, depth + 1)) return false
    }
    seen.delete(v)
    return add(array ? ']' : '}')
  }
  return visit(value, 0) ? bytes : null
}

/** This is the existing admin/service gate, not a new capability or an authentication check. */
export function canManageMetadataPolicy(role: PublisherRole): boolean {
  return roleCan(role, 'operator.manage')
}
function approved(value: unknown): value is MetadataReviewEvidence {
  if (!shape(value, ['authorId', 'authorRole', 'reviewerId', 'reviewerRole', 'changeId', 'reason'])) return false
  return text(value.authorId, 128) && text(value.reviewerId, 128) && value.authorId !== value.reviewerId
    && text(value.changeId, 128) && text(value.reason, 1_000)
    && ROLES.includes(value.authorRole as PublisherRole) && ROLES.includes(value.reviewerRole as PublisherRole)
    && canManageMetadataPolicy(value.authorRole as PublisherRole)
    && canManageMetadataPolicy(value.reviewerRole as PublisherRole)
}
function scopes(value: unknown): value is MetadataScope[] {
  return list(value, 4) && new Set(value).size === value.length
    && value.every(scope => METADATA_SCOPES.includes(scope as MetadataScope))
}

export function validateExtensionRegistration(input: unknown): PolicyValidation<ExtensionRegistration> {
  if (jsonBytes(input, METADATA_POLICY_LIMITS.registrationBytes) === null) return fail('registration_json_bounds')
  if (!shape(input, ['prefix', 'ownerNodeId', 'schemaUri', 'version', 'schemaSha256', 'scopes', 'fields', 'maxPayloadBytes', 'approval'])) return fail('registration_shape')
  if (!matches(input.prefix, PREFIX)) return fail('prefix_invalid')
  if ((RESERVED_METADATA_PREFIXES as readonly string[]).includes(input.prefix)) return fail('prefix_reserved')
  if (!matches(input.ownerNodeId, NODE_ID)) return fail('owner_invalid')
  if (!matches(input.version, VERSION)) return fail('version_invalid')
  if (!isCanonicalMetadataUri(input.schemaUri) || !input.schemaUri.endsWith(`/v${input.version}/schema.json`)) return fail('schema_uri_invalid')
  if (!matches(input.schemaSha256, SHA256)) return fail('schema_digest_invalid')
  if (!scopes(input.scopes)) return fail('scopes_invalid')
  const allowedScopes = input.scopes
  if (!positiveInteger(input.maxPayloadBytes, METADATA_POLICY_LIMITS.extensionBytes)) return fail('payload_limit_invalid')
  if (!list(input.fields, METADATA_POLICY_LIMITS.fields)) return fail('fields_invalid')
  const keys = new Set<string>()
  for (const field of input.fields) {
    if (!shape(field, ['key', 'scopes']) || typeof field.key !== 'string'
      || !field.key.startsWith(input.prefix + ':') || !ID.test(field.key.slice(input.prefix.length + 1))
      || DANGEROUS_KEYS.has(field.key.slice(input.prefix.length + 1))) return fail('field_key_invalid')
    if (keys.has(field.key)) return fail('field_collision')
    keys.add(field.key)
    if (!scopes(field.scopes) || !field.scopes.every(scope => allowedScopes.includes(scope))) return fail('field_scope_invalid')
  }
  if (input.approval !== null && !approved(input.approval)) return fail('approval_invalid')
  return success(input as unknown as ExtensionRegistration)
}

// Object ordering is irrelevant to immutable contract comparison; array ordering is significant.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (record(value)) return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}'
  return JSON.stringify(value)
}
function schemaBase(registration: ExtensionRegistration): string {
  return registration.schemaUri.slice(0, -`v${registration.version}/schema.json`.length)
}
function extensionIdentityConflict(a: ExtensionRegistration, b: ExtensionRegistration): string | null {
  if (a.prefix === b.prefix && (a.ownerNodeId !== b.ownerNodeId || schemaBase(a) !== schemaBase(b))) return 'namespace_owner_collision'
  if (a.schemaUri === b.schemaUri && canonical({ ...a, approval: null }) !== canonical({ ...b, approval: null })) return 'schema_version_immutable'
  if (a.schemaUri === b.schemaUri && a.prefix !== b.prefix) return 'schema_namespace_collision'
  return null
}

/** One active version per prefix. Supply the entire retained identity ledger to prevent reuse.
 * The bounded history is an input batch; persistence/ledger completeness are the caller's duty.
 */
export function validateExtensionRegistry(input: unknown, history: unknown = []): PolicyValidation<ExtensionRegistration[]> {
  if (!list(input, METADATA_POLICY_LIMITS.registrations, 0) || !list(history, 1_024, 0)) return fail('registry_bounds')
  const active: ExtensionRegistration[] = []
  const previous: ExtensionRegistration[] = []
  for (const [entries, target] of [[input, active], [history, previous]] as const) {
    for (const entry of entries) {
      const result = validateExtensionRegistration(entry)
      if (!result.ok) return result
      target.push(result.value)
    }
  }
  for (let i = 0; i < active.length; i++) {
    const entry = active[i]
    if (active.slice(0, i).some(other => other.prefix === entry.prefix)) return fail('prefix_collision')
    for (const other of [...active.slice(0, i), ...previous]) {
      const conflict = extensionIdentityConflict(entry, other)
      if (conflict) return fail(conflict)
    }
  }
  return success(active)
}

export interface ExtensionFieldDecision {
  decision: 'omit' | 'withhold' | 'validate_with_serializer'
  reasons: string[]
  schemaUri?: string
}

/** Scope/allowlist/approval gate only. Never returns `emit`: the future serializer must validate
 * the whole extension payload + core resource against pinned, locally verified schema bytes.
 */
export function decideExtensionField(input: unknown, registry: unknown): ExtensionFieldDecision {
  const withhold = (reason: string): ExtensionFieldDecision => ({ decision: 'withhold', reasons: [reason] })
  // Check descriptors before reading values: accessors are not input data.
  if (jsonBytes(input, METADATA_POLICY_LIMITS.registrationBytes) === null) return withhold('field_json_bounds')
  if (!shape(input, ['key', 'value', 'scope', 'ownerNodeId', 'essential']) || typeof input.essential !== 'boolean') return withhold('field_input_invalid')
  const omit = (reason: string): ExtensionFieldDecision => ({ decision: input.essential ? 'withhold' : 'omit', reasons: [reason] })
  if (typeof input.key !== 'string' || !/^[a-z][a-z0-9]{1,15}:[a-z][a-z0-9_-]{0,63}$/.test(input.key)) return withhold('core_or_invalid_key')
  const [prefix, localKey] = input.key.split(':')
  if ((RESERVED_METADATA_PREFIXES as readonly string[]).includes(prefix) || DANGEROUS_KEYS.has(localKey)) return withhold('reserved_key')
  if (!METADATA_SCOPES.includes(input.scope as MetadataScope) || !matches(input.ownerNodeId, NODE_ID)) return withhold('field_context_invalid')
  const parsed = validateExtensionRegistry(registry)
  if (!parsed.ok) return { decision: 'withhold', reasons: parsed.reasons }
  const registration = parsed.value.find(entry => entry.prefix === prefix)
  if (!registration) return omit('unknown_prefix')
  if (registration.ownerNodeId !== input.ownerNodeId) return withhold('owner_mismatch')
  const field = registration.fields.find(entry => entry.key === input.key)
  if (!field) return withhold('field_not_allowlisted')
  if (!field.scopes.includes(input.scope as MetadataScope)) return withhold('scope_not_allowed')
  if (jsonBytes({ [input.key]: input.value }, registration.maxPayloadBytes) === null) return withhold('payload_limit_exceeded')
  if (!registration.approval) return omit('extension_unapproved')
  return { decision: 'validate_with_serializer', reasons: ['schema_validation_required'], schemaUri: registration.schemaUri }
}

function labels(value: unknown): value is VocabularyLabel[] {
  if (!list(value, METADATA_POLICY_LIMITS.labels)) return false
  const languages = new Set<string>()
  return value.every(label => {
    if (!shape(label, ['language', 'label']) || !text(label.label, METADATA_POLICY_LIMITS.label)
      || !matches(label.language, /^(?:und|[a-z]{2,3})(?:-[a-z0-9]{2,8}){0,3}$/)
      || languages.has(label.language)) return false
    languages.add(label.language)
    return true
  })
}

export function validateVocabularyDescriptor(input: unknown, previous?: unknown): PolicyValidation<VocabularyDescriptor> {
  if (jsonBytes(input, METADATA_POLICY_LIMITS.descriptorBytes) === null) return fail('vocabulary_json_bounds')
  if (!shape(input, ['formatVersion', 'vocabularyUri', 'ownerNodeId', 'revision', 'facets', 'approval']) || input.formatVersion !== 1) return fail('vocabulary_shape')
  if (!isCanonicalMetadataUri(input.vocabularyUri)) return fail('vocabulary_uri_invalid')
  if (!matches(input.ownerNodeId, NODE_ID)) return fail('owner_invalid')
  if (!positiveInteger(input.revision)) return fail('revision_invalid')
  if (input.approval !== null && !approved(input.approval)) return fail('approval_invalid')
  if (!list(input.facets, METADATA_POLICY_LIMITS.facets)) return fail('facets_invalid')
  const ids = new Set<string>()
  let terms = 0
  for (const facet of input.facets) {
    if (!shape(facet, ['id', 'labels', 'definition', 'terms']) || !matches(facet.id, ID)
      || ids.has(facet.id) || DANGEROUS_KEYS.has(facet.id)) return fail('facet_id_invalid_or_duplicate')
    ids.add(facet.id)
    if (!labels(facet.labels) || !text(facet.definition, METADATA_POLICY_LIMITS.definition)) return fail('facet_description_invalid')
    if (!list(facet.terms, METADATA_POLICY_LIMITS.terms)) return fail('terms_invalid')
    terms += facet.terms.length
    if (terms > METADATA_POLICY_LIMITS.terms) return fail('term_limit_exceeded')
    for (const term of facet.terms) {
      if (!shape(term, ['id', 'labels', 'definition', 'mappings']) || !matches(term.id, ID)
        || ids.has(term.id) || DANGEROUS_KEYS.has(term.id)) return fail('term_id_invalid_or_duplicate')
      ids.add(term.id)
      if (!labels(term.labels) || !text(term.definition, METADATA_POLICY_LIMITS.definition)) return fail('term_description_invalid')
      if (!list(term.mappings, METADATA_POLICY_LIMITS.mappings, 0)) return fail('mappings_invalid')
      const targets = new Set<string>()
      for (const mapping of term.mappings) {
        if (!shape(mapping, ['relation', 'conceptUri']) || !(SKOS_MAPPING_RELATIONS as readonly unknown[]).includes(mapping.relation)
          || !isCanonicalMetadataUri(mapping.conceptUri, true) || targets.has(mapping.conceptUri)) return fail('mapping_invalid_or_conflicting')
        targets.add(mapping.conceptUri)
      }
    }
  }
  const descriptor = input as unknown as VocabularyDescriptor
  if (previous !== undefined) {
    const old = validateVocabularyDescriptor(previous)
    if (!old.ok) return fail('previous_vocabulary_invalid')
    if (old.value.ownerNodeId !== descriptor.ownerNodeId || old.value.vocabularyUri !== descriptor.vocabularyUri) return fail('vocabulary_identity_immutable')
    if (descriptor.revision < old.value.revision) return fail('revision_regressed')
    if (descriptor.revision === old.value.revision && canonical({ ...descriptor, approval: null }) !== canonical({ ...old.value, approval: null })) return fail('vocabulary_revision_immutable')
    const oldIds = new Map<string, string>()
    for (const facet of old.value.facets) {
      oldIds.set(facet.id, '')
      for (const term of facet.terms) oldIds.set(term.id, facet.id)
    }
    for (const facet of descriptor.facets) {
      if (oldIds.has(facet.id) && oldIds.get(facet.id) !== '') return fail('vocabulary_id_repurposed')
      for (const term of facet.terms) {
        if (oldIds.has(term.id) && oldIds.get(term.id) !== facet.id) return fail('vocabulary_id_repurposed')
      }
    }
  }
  return success(descriptor)
}

/** Per-resource provenance, including mixed-origin resources. No label-based joins. */
export function validateVocabularyReferences(input: unknown, descriptors: unknown): PolicyValidation<VocabularyReference[]> {
  if (jsonBytes(input, METADATA_POLICY_LIMITS.descriptorBytes) === null || !list(input, METADATA_POLICY_LIMITS.references, 0)
    || !list(descriptors, METADATA_POLICY_LIMITS.references, 0)) return fail('references_bounds')
  const known: VocabularyDescriptor[] = []
  for (const descriptor of descriptors) {
    const result = validateVocabularyDescriptor(descriptor)
    if (!result.ok) return result
    const duplicate = known.find(other => other.vocabularyUri === result.value.vocabularyUri && other.revision === result.value.revision)
    if (duplicate) return fail('descriptor_collision')
    if (known.some(other => other.vocabularyUri === result.value.vocabularyUri && other.ownerNodeId !== result.value.ownerNodeId)) return fail('vocabulary_owner_collision')
    known.push(result.value)
  }
  const seen = new Set<string>()
  for (const reference of input) {
    if (!shape(reference, ['vocabularyUri', 'ownerNodeId', 'revision', 'facetId', 'termIds'])
      || !isCanonicalMetadataUri(reference.vocabularyUri) || !matches(reference.ownerNodeId, NODE_ID)
      || !positiveInteger(reference.revision) || !matches(reference.facetId, ID)
      || !list(reference.termIds, METADATA_POLICY_LIMITS.terms)
      || !reference.termIds.every(id => matches(id, ID)) || new Set(reference.termIds).size !== reference.termIds.length) return fail('reference_invalid')
    const key = JSON.stringify([reference.vocabularyUri, reference.revision, reference.facetId])
    if (seen.has(key)) return fail('reference_duplicate')
    seen.add(key)
    const descriptor = known.find(entry => entry.vocabularyUri === reference.vocabularyUri && entry.revision === reference.revision)
    if (!descriptor) return fail('vocabulary_unknown')
    if (descriptor.ownerNodeId !== reference.ownerNodeId) return fail('vocabulary_owner_mismatch')
    if (!descriptor.approval) return fail('vocabulary_unapproved')
    const facet = descriptor.facets.find(entry => entry.id === reference.facetId)
    if (!facet || !reference.termIds.every(id => facet.terms.some(term => term.id === id))) return fail('vocabulary_term_unknown')
  }
  return success(input as VocabularyReference[])
}