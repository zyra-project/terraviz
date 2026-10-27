// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, expect, it } from 'vitest'
import { federationState, parseAbuseContact } from './federation-config'

describe('parseAbuseContact', () => {
  it.each([
    ['abuse@noaa.example', 'abuse@noaa.example'],
    ['  abuse@noaa.example\n', 'abuse@noaa.example'],
    ['first.last+tag@sub.node-1.example.org', 'first.last+tag@sub.node-1.example.org'],
  ])('accepts %j', (raw, expected) => {
    expect(parseAbuseContact(raw)).toBe(expected)
  })

  it.each([
    undefined,
    '',
    '   ',
    'abuse',
    'abuse@localhost',
    '@noaa.example',
    'abuse@',
    'abuse@@noaa.example',
    'a b@noaa.example',
    'mailto:abuse@noaa.example',
    'Abuse <abuse@noaa.example>',
    'abuse@noaa.example, ops@noaa.example',
    'abuse@noaa.example;x',
    '"abuse"@noaa.example',
    'abuse@[127.0.0.1]',
    'abuse@-noaa.example',
    'abuse@noaa-.example',
    'abuse@noaa..example',
    'abuse@noaa.example.',
    'abuse\u0000@noaa.example',
    `${'a'.repeat(250)}@x.io`,
  ])('refuses %j', raw => {
    expect(parseAbuseContact(raw)).toBeNull()
  })
})

describe('federationState', () => {
  it.each([undefined, '', 'false', 'TRUE', '1', 'true '])('is off when FEDERATION_ENABLED is %j', flag => {
    expect(federationState({ FEDERATION_ENABLED: flag, FEDERATION_ABUSE_CONTACT: 'abuse@noaa.example' }))
      .toEqual({ state: 'off' })
  })

  it('needs an abuse contact to go live', () => {
    expect(federationState({ FEDERATION_ENABLED: 'true' })).toEqual({ state: 'no_abuse_contact' })
    expect(federationState({ FEDERATION_ENABLED: 'true', FEDERATION_ABUSE_CONTACT: 'nope' }))
      .toEqual({ state: 'no_abuse_contact' })
  })

  it('is live with the switch and a usable address', () => {
    expect(federationState({ FEDERATION_ENABLED: 'true', FEDERATION_ABUSE_CONTACT: ' abuse@noaa.example ' }))
      .toEqual({ state: 'live', abuseContact: 'abuse@noaa.example' })
  })
})
