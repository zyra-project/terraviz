import { describe, expect, it } from 'vitest'
import type { PublisherRow } from './publisher-store'
import { can, canOwnOrAny } from './capabilities'

function pub(role: string, id = 'PUB-1'): PublisherRow {
  return {
    id,
    email: `${id}@example.com`,
    display_name: id,
    affiliation: null,
    org_id: null,
    role,
    is_admin: role === 'admin' ? 1 : 0,
    status: 'active',
    created_at: '2026-01-01T00:00:00.000Z',
  }
}

describe('can', () => {
  it('resolves through the shared matrix (incl. legacy role strings)', () => {
    expect(can(pub('admin'), 'users.manage')).toBe(true)
    expect(can(pub('service'), 'users.manage')).toBe(false)
    expect(can(pub('publisher'), 'content.create')).toBe(true) // legacy → author
    expect(can(pub('publisher'), 'content.edit.any')).toBe(false)
    expect(can(pub('editor'), 'content.publish.any')).toBe(true)
    expect(can(pub('contributor'), 'content.publish.own')).toBe(false)
  })
})

describe('canOwnOrAny', () => {
  const author = pub('author', 'A')
  const editor = pub('editor', 'E')

  it('grants the owner via the .own capability', () => {
    expect(canOwnOrAny(author, 'A', 'content.edit.own', 'content.edit.any')).toBe(true)
  })
  it('denies a non-owner who lacks the .any capability', () => {
    expect(canOwnOrAny(author, 'SOMEONE-ELSE', 'content.edit.own', 'content.edit.any')).toBe(false)
  })
  it('grants any-holder regardless of ownership', () => {
    expect(canOwnOrAny(editor, 'SOMEONE-ELSE', 'content.edit.own', 'content.edit.any')).toBe(true)
  })
  it('treats a null owner as not-owned (needs .any)', () => {
    expect(canOwnOrAny(author, null, 'content.edit.own', 'content.edit.any')).toBe(false)
    expect(canOwnOrAny(editor, null, 'content.edit.own', 'content.edit.any')).toBe(true)
  })
  it('denies a contributor from publishing even their own row', () => {
    const contributor = pub('contributor', 'C')
    expect(canOwnOrAny(contributor, 'C', 'content.publish.own', 'content.publish.any')).toBe(false)
  })
})
