// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, expect, it, vi } from 'vitest'
import { ROLES, roleCan } from '../../../../src/types/publisher-roles'
import { newUlid } from './ulid'
import {
  canManageMetadataPolicy, decideExtensionField, isCanonicalMetadataUri,
  METADATA_POLICY_LIMITS, RESERVED_METADATA_PREFIXES, SKOS_MAPPING_RELATIONS,
  validateExtensionRegistration, validateExtensionRegistry, validateVocabularyDescriptor,
  validateVocabularyReferences, type ExtensionRegistration, type MetadataReviewEvidence,
  type VocabularyDescriptor, type VocabularyReference,
} from './metadata-policy'

function approval(): MetadataReviewEvidence {
  return { authorId: 'operator-a', authorRole: 'admin', reviewerId: 'operator-b', reviewerRole: 'service', changeId: 'review-1', reason: 'Reviewed public metadata selection' }
}
function registration(overrides: Partial<ExtensionRegistration> = {}): ExtensionRegistration {
  return {
    prefix: 'museum', ownerNodeId: 'museum-node-1', schemaUri: 'https://museum.example/extensions/accession/v1.0.0/schema.json',
    version: '1.0.0', schemaSha256: 'sha256:' + 'a'.repeat(64), scopes: ['Collection', 'Item', 'Asset'],
    fields: [{ key: 'museum:accession', scopes: ['Item', 'Asset'] }], maxPayloadBytes: 1_024, approval: approval(), ...overrides,
  }
}
function descriptor(overrides: Partial<VocabularyDescriptor> = {}): VocabularyDescriptor {
  return {
    formatVersion: 1, vocabularyUri: 'https://museum.example/vocab/themes', ownerNodeId: 'museum-node-1', revision: 1,
    facets: [{ id: 'theme', labels: [{ language: 'en', label: 'Theme' }], definition: 'Museum exhibition themes.', terms: [
      { id: 'oceans', labels: [{ language: 'en', label: 'Oceans' }], definition: 'The ocean exhibition wing.', mappings: [] },
    ] }], approval: approval(), ...overrides,
  }
}
function reference(overrides: Partial<VocabularyReference> = {}): VocabularyReference {
  return { vocabularyUri: descriptor().vocabularyUri, ownerNodeId: 'museum-node-1', revision: 1, facetId: 'theme', termIds: ['oceans'], ...overrides }
}
function field(overrides: Record<string, unknown> = {}) {
  return { key: 'museum:accession', value: 'A-1', scope: 'Item', ownerNodeId: 'museum-node-1', essential: false, ...overrides }
}

describe('case-preserving persisted node namespace contract', () => {
  it.each([
    { kind: 'real newUlid node', ownerNodeId: newUlid(Date.UTC(2026, 8, 11)) },
    { kind: 'mixed case and all allowed separators', ownerNodeId: 'Museum.Node_1-prod' },
    { kind: 'single letter', ownerNodeId: 'A' },
    { kind: 'single digit', ownerNodeId: '0' },
    { kind: '128-character boundary', ownerNodeId: 'A' + 'z'.repeat(127) },
  ])('accepts $kind unchanged across policy paths', ({ kind, ownerNodeId }) => {
    if (kind === 'real newUlid node') {
      expect(ownerNodeId).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/)
      expect(ownerNodeId).toMatch(/[A-Z]/)
    }
    const extension = registration({ ownerNodeId })
    const vocabulary = descriptor({ ownerNodeId })
    const references = [reference({ ownerNodeId })]
    expect(validateExtensionRegistration(extension)).toEqual({ ok: true, value: extension })
    expect(validateExtensionRegistry([extension])).toEqual({ ok: true, value: [extension] })
    expect(validateVocabularyDescriptor(vocabulary)).toEqual({ ok: true, value: vocabulary })
    expect(validateVocabularyReferences(references, [vocabulary])).toEqual({ ok: true, value: references })
    expect(decideExtensionField(field({ ownerNodeId }), [extension])).toEqual({
      decision: 'validate_with_serializer', reasons: ['schema_validation_required'], schemaUri: extension.schemaUri,
    })
  })
  it.each([
    '', 'A'.repeat(129), '.node', '_node', '-node', 'node name', ' node', 'node ',
    'node/name', 'node\\name', 'node:1', 'nödé', 'node\n', 'node\u0000',
  ])('rejects invalid node namespace %j across policy paths', ownerNodeId => {
    expect(validateExtensionRegistration(registration({ ownerNodeId }))).toEqual({ ok: false, reasons: ['owner_invalid'] })
    expect(validateVocabularyDescriptor(descriptor({ ownerNodeId }))).toEqual({ ok: false, reasons: ['owner_invalid'] })
    expect(validateVocabularyReferences([reference({ ownerNodeId })], [descriptor()])).toEqual({ ok: false, reasons: ['reference_invalid'] })
    expect(decideExtensionField(field({ ownerNodeId }), [registration()])).toEqual({ decision: 'withhold', reasons: ['field_context_invalid'] })
  })
  it('does not lowercase owners for matching or immutable identity checks', () => {
    const ownerNodeId = newUlid(Date.UTC(2026, 8, 11))
    const lower = ownerNodeId.toLowerCase()
    expect(lower).not.toBe(ownerNodeId)
    const extension = registration({ ownerNodeId })
    const vocabulary = descriptor({ ownerNodeId })
    expect(decideExtensionField(field({ ownerNodeId: lower }), [extension])).toEqual({ decision: 'withhold', reasons: ['owner_mismatch'] })
    expect(validateVocabularyReferences([reference({ ownerNodeId: lower })], [vocabulary])).toEqual({ ok: false, reasons: ['vocabulary_owner_mismatch'] })
    expect(validateExtensionRegistry([registration({ ownerNodeId: lower })], [extension])).toEqual({ ok: false, reasons: ['namespace_owner_collision'] })
    expect(validateVocabularyDescriptor(descriptor({ ownerNodeId: lower }), vocabulary)).toEqual({ ok: false, reasons: ['vocabulary_identity_immutable'] })
  })
})

describe('existing role capability gate, not a new server authorization surface', () => {
  it.each(ROLES)('uses operator.manage for %s', role => {
    expect(canManageMetadataPolicy(role)).toBe(roleCan(role, 'operator.manage'))
    expect(canManageMetadataPolicy(role)).toBe(role === 'admin' || role === 'service')
  })
  it.each(['authorRole', 'reviewerRole'] as const)('rejects unauthorized or invented %s evidence', key => {
    for (const role of ['editor', 'author', 'contributor', 'reviewer', 'publisher', 'owner', null]) {
      expect(validateExtensionRegistration({ ...registration(), approval: { ...approval(), [key]: role } })).toMatchObject({ ok: false, reasons: ['approval_invalid'] })
    }
  })
  it('requires distinct actors, a change ID, and a reason; no silent approval', () => {
    for (const change of [{ reviewerId: 'operator-a' }, { changeId: '' }, { reason: ' ' }, { reason: 'x'.repeat(1001) }, { extra: true }]) {
      expect(validateExtensionRegistration({ ...registration(), approval: { ...approval(), ...change } }).ok).toBe(false)
    }
    expect(validateExtensionRegistration(registration({ approval: null })).ok).toBe(true)
    expect(validateExtensionRegistration({ ...registration(), approval: true }).ok).toBe(false)
  })
})

describe('strict canonical URI syntax (never reachability)', () => {
  it.each([
    'http://example.org/schema.json', 'https:example.org/schema', '//example.org/schema',
    'https://user:pass@example.org/schema', 'https://example.org/schema?rev=1', 'https://example.org/schema#v1',
    'https://EXAMPLE.org/schema', 'https://example.org:443/schema', 'https://example.org/a/../schema',
    'https://example.org/white space', 'https://example.org/\nfile', 'https://example.org\\schema',
    'javascript:alert(1)', 'file:///schema', 'https://example.org/' + 'x'.repeat(2048),
  ])('rejects noncanonical/unsafe schema syntax: %s', uri => {
    expect(isCanonicalMetadataUri(uri)).toBe(false)
  })
  it('permits canonical HTTP concept identifiers and fragments without rewriting them', () => {
    expect(isCanonicalMetadataUri('http://vocab.example/concepts#ocean', true)).toBe(true)
    expect(isCanonicalMetadataUri('https://vocab.example/concepts#ocean', true)).toBe(true)
    expect(isCanonicalMetadataUri('http://vocab.example/concepts#ocean')).toBe(false)
  })
})

describe('node extension registration and immutable namespace history', () => {
  it('accepts a strict approved registration without fetching its schema', () => {
    expect(validateExtensionRegistration(registration())).toEqual({ ok: true, value: registration() })
    expect(validateExtensionRegistry([registration()])).toEqual({ ok: true, value: [registration()] })
  })
  it.each(RESERVED_METADATA_PREFIXES)('reserves %s', prefix => {
    expect(validateExtensionRegistration(registration({ prefix })).ok).toBe(false)
  })
  it.each(['x', 'Museum', '_museum', 'museum-name', 'abcdefghijklmnopq', 'museum:', ''])('bounds prefix: %s', prefix => {
    expect(validateExtensionRegistration(registration({ prefix })).ok).toBe(false)
  })
  it.each([
    { ownerNodeId: '' }, { ownerNodeId: 'x'.repeat(129) }, { ownerNodeId: 'owner name' },
    { version: 'latest' }, { version: '01.0.0' }, { version: '1.0.0-beta' },
    { schemaUri: 'https://museum.example/extensions/accession/latest/schema.json' },
    { schemaUri: 'https://museum.example/extensions/accession/v2.0.0/schema.json' },
    { schemaSha256: 'a'.repeat(64) }, { schemaSha256: 'sha256:' + 'A'.repeat(64) },
    { maxPayloadBytes: 0 }, { maxPayloadBytes: 16385 }, { maxPayloadBytes: 1.5 },
    { scopes: [] }, { scopes: ['Item', 'Item'] }, { scopes: ['Feature'] },
    { fields: [] }, { fields: [{ key: 'id', scopes: ['Item'] }] },
    { fields: [{ key: 'museum:constructor', scopes: ['Item'] }] },
    { fields: [{ key: 'other:accession', scopes: ['Item'] }] },
    { fields: [{ key: 'museum:accession', scopes: ['Catalog'] }] },
    { fields: [{ key: 'museum:accession', scopes: ['Item'], extra: true }] },
    { fields: Array.from({ length: 65 }, (_, i) => ({ key: `museum:f${i}`, scopes: ['Item'] })) },
    { extra: true },
  ])('rejects malformed registration %j', overrides => {
    expect(validateExtensionRegistration({ ...registration(), ...overrides }).ok).toBe(false)
  })
  it('rejects missing fields, duplicates, bad JSON, and oversized registration envelopes', () => {
    const { approval: _omitted, ...missing } = registration()
    expect(validateExtensionRegistration(missing).ok).toBe(false)
    expect(validateExtensionRegistration(registration({ fields: [...registration().fields, ...registration().fields] })).ok).toBe(false)
    expect(validateExtensionRegistration({ ...registration(), extra: 'x'.repeat(32769) })).toMatchObject({ reasons: ['registration_json_bounds'] })
    expect(validateExtensionRegistry(Array(33).fill(registration())).ok).toBe(false)
    expect(validateExtensionRegistry([], Array(1025).fill(registration())).ok).toBe(false)
  })
  it('rejects all simultaneous prefix claims, including different versions or owners', () => {
    for (const other of [registration(), registration({ ownerNodeId: 'other' }), registration({ version: '2.0.0', schemaUri: 'https://museum.example/extensions/accession/v2.0.0/schema.json' })]) {
      expect(validateExtensionRegistry([registration(), other])).toMatchObject({ reasons: ['prefix_collision'] })
    }
  })
  it('preserves stable owner/base across versions and immutable contract bytes at a version', () => {
    const v2 = registration({ version: '2.0.0', schemaUri: 'https://museum.example/extensions/accession/v2.0.0/schema.json' })
    expect(validateExtensionRegistry([v2], [registration()]).ok).toBe(true)
    expect(validateExtensionRegistry([registration({ ownerNodeId: 'renamed-node' })], [registration()]).ok).toBe(false)
    expect(validateExtensionRegistry([registration({ schemaUri: 'https://new.example/v1.0.0/schema.json' })], [registration()]).ok).toBe(false)
    for (const changed of [{ schemaSha256: 'sha256:' + 'b'.repeat(64) }, { maxPayloadBytes: 2048 }, { scopes: ['Item'] as const }]) {
      expect(validateExtensionRegistry([{ ...registration(), ...changed }], [registration()]).ok).toBe(false)
    }
    expect(validateExtensionRegistry([registration({ approval: null })], [registration()]).ok).toBe(true)
  })
  it('rejects the same schema registered under another prefix', () => {
    const other = registration({ prefix: 'archive', fields: [{ key: 'archive:accession', scopes: ['Item'] }] })
    expect(validateExtensionRegistry([registration(), other]).ok).toBe(false)
  })
})

describe('field decisions are not runtime schema validation', () => {
  it('returns only a pending serializer gate, including Asset fields', () => {
    for (const scope of ['Item', 'Asset']) {
      expect(decideExtensionField(field({ scope }), [registration()])).toEqual({ decision: 'validate_with_serializer', reasons: ['schema_validation_required'], schemaUri: registration().schemaUri })
    }
  })
  it.each([false, true])('unknown/unapproved omission honors essential=%s', essential => {
    expect(decideExtensionField(field({ key: 'other:value', essential }), [registration()])).toMatchObject({ decision: essential ? 'withhold' : 'omit', reasons: ['unknown_prefix'] })
    expect(decideExtensionField(field({ essential }), [registration({ approval: null })])).toMatchObject({ decision: essential ? 'withhold' : 'omit', reasons: ['extension_unapproved'] })
  })
  it.each(['id', 'geometry', 'bbox', 'license', 'properties', 'visibility', 'terraviz:origin_node', 'sci:doi', 'file:size', 'proj:code', 'core:id', 'museum:constructor'])('never overrides core/project/standard keys: %s', key => {
    expect(decideExtensionField(field({ key }), [registration()]).decision).toBe('withhold')
  })
  it.each([
    [{ key: 'museum:unknown' }, 'field_not_allowlisted'], [{ scope: 'Collection' }, 'scope_not_allowed'],
    [{ ownerNodeId: 'another-node' }, 'owner_mismatch'], [{ scope: 'Feature' }, 'field_context_invalid'],
    [{ essential: 'false' }, 'field_input_invalid'], [{ extra: true }, 'field_input_invalid'],
  ])('withholds invalid field context %j', (overrides, reason) => {
    expect(decideExtensionField(field(overrides as Record<string, unknown>), [registration()])).toMatchObject({ decision: 'withhold', reasons: [reason] })
  })
  it('withholds a prefix collision instead of taking the first registration', () => {
    expect(decideExtensionField(field(), [registration(), registration()])).toMatchObject({ decision: 'withhold', reasons: ['prefix_collision'] })
  })
  it('counts the full single-field payload as UTF-8 bytes, including JSON overhead', () => {
    const value = '🌊'
    const bytes = new TextEncoder().encode(JSON.stringify({ 'museum:accession': value })).length
    expect(decideExtensionField(field({ value }), [registration({ maxPayloadBytes: bytes })]).decision).toBe('validate_with_serializer')
    expect(decideExtensionField(field({ value }), [registration({ maxPayloadBytes: bytes - 1 })])).toMatchObject({ reasons: ['payload_limit_exceeded'] })
  })
  it.each([undefined, NaN, Infinity, BigInt(1), () => 1, new Date(), { toJSON: () => 'hidden' }, JSON.parse('{"__proto__":{}}')])('rejects non-JSON or dangerous field values (%s)', value => {
    expect(decideExtensionField(field({ value }), [registration()]).decision).toBe('withhold')
  })
  it('rejects cycles, depth overflow, sparse arrays, and getters without executing them', () => {
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic
    let deep: unknown = 1
    for (let i = 0; i < METADATA_POLICY_LIMITS.jsonDepth + 1; i++) deep = { child: deep }
    const getter = vi.fn(() => 'secret')
    const accessor = Object.defineProperty({}, 'private', { enumerable: true, get: getter })
    for (const value of [cyclic, deep, Array(2), accessor]) expect(decideExtensionField(field({ value }), [registration()]).decision).toBe('withhold')
    expect(getter).not.toHaveBeenCalled()
  })
})

describe('plain-JSON, versioned, node-local vocabulary contract', () => {
  it('accepts unaligned terms and independently curated SKOS relation identifiers', () => {
    expect(validateVocabularyDescriptor(descriptor()).ok).toBe(true)
    for (const relation of SKOS_MAPPING_RELATIONS) {
      const value = descriptor()
      value.facets[0].terms[0].mappings = [{ relation, conceptUri: 'http://concepts.example/ocean' }]
      expect(validateVocabularyDescriptor(value)).toEqual({ ok: true, value })
    }
  })
  it.each([
    { formatVersion: 2 }, { '@context': 'https://schema.org/' }, { ownerNodeId: '' }, { revision: 0 }, { revision: 1.5 },
    { revision: Number.MAX_SAFE_INTEGER + 1 }, { vocabularyUri: 'https://museum.example/vocab#latest' },
    { facets: [] }, { approval: { ...approval(), reviewerRole: 'reviewer' } },
  ])('rejects invalid descriptor %j', overrides => {
    expect(validateVocabularyDescriptor({ ...descriptor(), ...overrides }).ok).toBe(false)
  })
  it('enforces unique facet/term IDs but never merges labels', () => {
    const value = descriptor()
    value.facets.push({ ...structuredClone(value.facets[0]), id: 'discipline', terms: [{ ...structuredClone(value.facets[0].terms[0]), id: 'ocean-science' }] })
    expect(validateVocabularyDescriptor(value).ok).toBe(true)
    value.facets[1].terms[0].id = 'oceans'
    expect(validateVocabularyDescriptor(value).ok).toBe(false)
    value.facets[1].terms[0].id = 'theme'
    expect(validateVocabularyDescriptor(value).ok).toBe(false)
  })
  it.each([
    { labels: [{ language: 'en', label: '' }] }, { labels: [{ language: 'en', label: 'x'.repeat(201) }] },
    { labels: [{ language: 'EN', label: 'Oceans' }] }, { labels: [{ language: 'en', label: 'Oceans' }, { language: 'en', label: 'Sea' }] },
    { labels: [{ language: 'en', label: 'Oceans', extra: 'no' }] }, { labels: [] },
  ])('rejects malformed or duplicate language labels', ({ labels }) => {
    const value = descriptor(); value.facets[0].terms[0].labels = labels
    expect(validateVocabularyDescriptor(value).ok).toBe(false)
  })
  it('bounds facet/term/label/definition/mapping counts and descriptor bytes', () => {
    const value = descriptor()
    value.facets[0].terms[0].definition = 'x'.repeat(2001)
    expect(validateVocabularyDescriptor(value).ok).toBe(false)
    const term = descriptor().facets[0].terms[0]
    const many = descriptor(); many.facets[0].terms = Array.from({ length: 513 }, (_, i) => ({ ...term, id: `term-${i}` }))
    expect(validateVocabularyDescriptor(many).ok).toBe(false)
    expect(validateVocabularyDescriptor({ ...descriptor(), facets: Array(33).fill(descriptor().facets[0]) }).ok).toBe(false)
    const labels = descriptor(); labels.facets[0].labels = Array.from({ length: 9 }, (_, i) => ({ language: `en-x${i}`, label: 'Theme' }))
    expect(validateVocabularyDescriptor(labels).ok).toBe(false)
    const mappings = descriptor(); mappings.facets[0].terms[0].mappings = Array.from({ length: 17 }, (_, i) => ({ relation: SKOS_MAPPING_RELATIONS[0], conceptUri: `https://concepts.example/${i}` }))
    expect(validateVocabularyDescriptor(mappings).ok).toBe(false)
    expect(validateVocabularyDescriptor({ ...descriptor(), extra: 'x'.repeat(262145) })).toMatchObject({ reasons: ['vocabulary_json_bounds'] })
  })
  it('rejects guessed equivalence relations, unsafe targets and conflicting mappings', () => {
    for (const mapping of [
      { relation: 'exactMatch', conceptUri: 'https://concepts.example/ocean' },
      { relation: 'http://www.w3.org/2002/07/owl#sameAs', conceptUri: 'https://concepts.example/ocean' },
      { relation: SKOS_MAPPING_RELATIONS[0], conceptUri: 'javascript:alert(1)' },
    ]) {
      const value = descriptor(); Object.assign(value.facets[0].terms[0], { mappings: [mapping] })
      expect(validateVocabularyDescriptor(value).ok).toBe(false)
    }
    const value = descriptor()
    value.facets[0].terms[0].mappings = SKOS_MAPPING_RELATIONS.slice(0, 2).map(relation => ({ relation, conceptUri: 'https://concepts.example/ocean' }))
    expect(validateVocabularyDescriptor(value).ok).toBe(false)
  })
  it('requires a new revision for label/definition/mapping edits and stable owner/URI/IDs', () => {
    const old = descriptor(); const next = descriptor()
    next.facets[0].terms[0].labels[0].label = 'Ocean wing'
    expect(validateVocabularyDescriptor(next, old)).toMatchObject({ reasons: ['vocabulary_revision_immutable'] })
    next.revision = 2
    expect(validateVocabularyDescriptor(next, old).ok).toBe(true)
    expect(validateVocabularyDescriptor(old, next)).toMatchObject({ reasons: ['revision_regressed'] })
    expect(validateVocabularyDescriptor({ ...next, ownerNodeId: 'new-owner' }, old).ok).toBe(false)
    expect(validateVocabularyDescriptor({ ...next, vocabularyUri: 'https://new.example/vocab' }, old).ok).toBe(false)
    next.facets[0].id = 'discipline'
    expect(validateVocabularyDescriptor(next, old)).toMatchObject({ reasons: ['vocabulary_id_repurposed'] })
    expect(validateVocabularyDescriptor(descriptor({ approval: null }), old).ok).toBe(true)
  })
})

describe('per-resource vocabulary URI/revision provenance', () => {
  it('accepts mixed origins and equal labels without conflating meaning', () => {
    const local = descriptor()
    const origin = descriptor({ vocabularyUri: 'https://noaa.example/vocab/themes', ownerNodeId: 'noaa-node', revision: 3 })
    origin.facets[0].terms[0].definition = 'An ocean science discipline, not an exhibition.'
    const references = [reference(), reference({ vocabularyUri: origin.vocabularyUri, ownerNodeId: origin.ownerNodeId, revision: 3 })]
    expect(validateVocabularyReferences(references, [local, origin])).toEqual({ ok: true, value: references })
  })
  it.each([
    [{ ownerNodeId: 'other' }, 'vocabulary_owner_mismatch'], [{ revision: 2 }, 'vocabulary_unknown'],
    [{ facetId: 'not-known' }, 'vocabulary_term_unknown'], [{ termIds: ['unknown'] }, 'vocabulary_term_unknown'],
    [{ termIds: ['oceans', 'oceans'] }, 'reference_invalid'], [{ extra: true }, 'reference_invalid'],
  ])('rejects unresolved or malformed provenance %j', (overrides, reason) => {
    expect(validateVocabularyReferences([{ ...reference(), ...overrides as object }], [descriptor()])).toMatchObject({ ok: false, reasons: [reason] })
  })
  it('rejects unapproved descriptors, duplicates, URI owner collisions, and oversized references', () => {
    expect(validateVocabularyReferences([reference()], [descriptor({ approval: null })])).toMatchObject({ reasons: ['vocabulary_unapproved'] })
    expect(validateVocabularyReferences([reference(), reference()], [descriptor()])).toMatchObject({ reasons: ['reference_duplicate'] })
    expect(validateVocabularyReferences([reference()], [descriptor(), descriptor()])).toMatchObject({ reasons: ['descriptor_collision'] })
    expect(validateVocabularyReferences([reference()], [descriptor(), descriptor({ ownerNodeId: 'other', revision: 2 })])).toMatchObject({ reasons: ['vocabulary_owner_collision'] })
    expect(validateVocabularyReferences(Array(65).fill(reference()), [descriptor()]).ok).toBe(false)
  })
  it('is deterministic, leaves input unchanged, and performs no network I/O', () => {
    const input = descriptor(); const before = JSON.stringify(input)
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(() => { throw new Error('No I/O permitted') })
    try {
      expect(validateVocabularyDescriptor(input)).toEqual(validateVocabularyDescriptor(input))
      expect(validateExtensionRegistry([registration()]).ok).toBe(true)
      expect(decideExtensionField(field(), [registration()]).decision).toBe('validate_with_serializer')
      expect(validateVocabularyReferences([reference()], [input]).ok).toBe(true)
      expect(JSON.stringify(input)).toBe(before)
      expect(fetch).not.toHaveBeenCalled()
    } finally { fetch.mockRestore() }
  })
})