import { describe, expect, it } from 'vitest'
import {
  CAPABILITIES,
  ROLES,
  ROLE_CAPABILITIES,
  type Capability,
  type Role,
  capabilitiesForRole,
  normalizeRole,
  roleCan,
} from './publisher-roles'

describe('publisher role → capability matrix', () => {
  // The full truth table, asserted exhaustively so any cell change is a
  // reviewed diff. `1` = granted. Legacy strings map via normalizeRole.
  const MATRIX: Record<Role, Record<Capability, 0 | 1>> = {
    admin: {
      'content.read': 1, 'content.create': 1, 'content.edit.own': 1, 'content.delete.own': 1,
      'content.publish.own': 1, 'content.edit.any': 1, 'content.delete.any': 1, 'content.publish.any': 1,
      'insights.read': 1, 'hero.read': 1, 'hero.manage': 1, 'workflows.manage': 1, 'operator.manage': 1, 'users.manage': 1,
    },
    service: {
      'content.read': 1, 'content.create': 1, 'content.edit.own': 1, 'content.delete.own': 1,
      'content.publish.own': 1, 'content.edit.any': 1, 'content.delete.any': 1, 'content.publish.any': 1,
      'insights.read': 1, 'hero.read': 1, 'hero.manage': 1, 'workflows.manage': 1, 'operator.manage': 1, 'users.manage': 0,
    },
    editor: {
      'content.read': 1, 'content.create': 1, 'content.edit.own': 1, 'content.delete.own': 1,
      'content.publish.own': 1, 'content.edit.any': 1, 'content.delete.any': 1, 'content.publish.any': 1,
      'insights.read': 1, 'hero.read': 1, 'hero.manage': 1, 'workflows.manage': 1, 'operator.manage': 0, 'users.manage': 0,
    },
    author: {
      'content.read': 1, 'content.create': 1, 'content.edit.own': 1, 'content.delete.own': 1,
      'content.publish.own': 1, 'content.edit.any': 0, 'content.delete.any': 0, 'content.publish.any': 0,
      'insights.read': 1, 'hero.read': 1, 'hero.manage': 0, 'workflows.manage': 0, 'operator.manage': 0, 'users.manage': 0,
    },
    contributor: {
      'content.read': 1, 'content.create': 1, 'content.edit.own': 1, 'content.delete.own': 1,
      'content.publish.own': 0, 'content.edit.any': 0, 'content.delete.any': 0, 'content.publish.any': 0,
      'insights.read': 1, 'hero.read': 1, 'hero.manage': 0, 'workflows.manage': 0, 'operator.manage': 0, 'users.manage': 0,
    },
    // Reviewer is a true read-only role: reads catalog/queues/insights,
    // authors nothing.
    reviewer: {
      'content.read': 1, 'content.create': 0, 'content.edit.own': 0, 'content.delete.own': 0,
      'content.publish.own': 0, 'content.edit.any': 0, 'content.delete.any': 0, 'content.publish.any': 0,
      'insights.read': 1, 'hero.read': 1, 'hero.manage': 0, 'workflows.manage': 0, 'operator.manage': 0, 'users.manage': 0,
    },
  }

  for (const role of ROLES) {
    for (const cap of CAPABILITIES) {
      it(`${role} ${MATRIX[role][cap] ? 'holds' : 'lacks'} ${cap}`, () => {
        expect(roleCan(role, cap)).toBe(MATRIX[role][cap] === 1)
      })
    }
  }

  it('ROLE_CAPABILITIES covers every role', () => {
    for (const role of ROLES) expect(ROLE_CAPABILITIES[role]).toBeInstanceOf(Set)
  })
})

describe('isPrivileged / isAdmin equivalence (behavior-preserving R1)', () => {
  it('operator.manage is held by exactly admin + service (the old isPrivileged set)', () => {
    const holders = ROLES.filter(r => roleCan(r, 'operator.manage'))
    expect(holders.sort()).toEqual(['admin', 'service'])
  })

  it('users.manage is held by admin only (the old isAdmin set — excludes service)', () => {
    const holders = ROLES.filter(r => roleCan(r, 'users.manage'))
    expect(holders).toEqual(['admin'])
  })
})

describe('normalizeRole', () => {
  it('maps legacy strings to canonical roles', () => {
    expect(normalizeRole('publisher')).toBe('author')
    expect(normalizeRole('readonly')).toBe('reviewer')
  })
  it('passes canonical roles through', () => {
    for (const r of ROLES) expect(normalizeRole(r)).toBe(r)
  })
  it('fails closed: unknown / null → reviewer (least privilege)', () => {
    expect(normalizeRole('wizard')).toBe('reviewer')
    expect(normalizeRole(null)).toBe('reviewer')
    expect(normalizeRole(undefined)).toBe('reviewer')
  })
})

describe('capabilitiesForRole', () => {
  it('returns the granted capabilities, honoring legacy aliases', () => {
    expect(capabilitiesForRole('publisher')).toEqual(capabilitiesForRole('author'))
    expect(capabilitiesForRole('admin')).toEqual([...CAPABILITIES])
    expect(capabilitiesForRole('contributor')).not.toContain('content.publish.own')
  })
})
