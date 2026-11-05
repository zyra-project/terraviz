// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, expect, it } from 'vitest'
import { clientRateKey } from './client-rate-key'

describe('clientRateKey', () => {
  it('keys an IPv4 address as it is', () => {
    expect(clientRateKey('192.0.2.1')).toBe('192.0.2.1')
  })

  it('keys every address in one IPv6 /64 alike, whatever its spelling', () => {
    expect(clientRateKey('2001:db8::1')).toBe('2001:db8:0:0::/64')
    expect(clientRateKey('2001:0db8:0:0:abcd::1')).toBe('2001:db8:0:0::/64')
    expect(clientRateKey('2001:DB8:0:0:ffff:ffff:ffff:fffe')).toBe('2001:db8:0:0::/64')
  })

  it('keeps separate /64s apart', () => {
    expect(clientRateKey('2001:db8:0:1::1')).not.toBe(clientRateKey('2001:db8::1'))
  })

  // Every IPv4-mapped address shares the /64 `0:0:0:0`, so bucketing them
  // by prefix would put every such client in one bucket.
  it('keys an IPv4-mapped address as the IPv4 address it carries', () => {
    expect(clientRateKey('::ffff:192.0.2.1')).toBe('192.0.2.1')
    expect(clientRateKey('::ffff:c000:201')).toBe('192.0.2.1')
    // Only the IPv4-mapped prefix: an IPv6 host choosing `ffff` in its own
    // interface id stays in its /64.
    expect(clientRateKey('2001:db8::ffff:c000:201')).toBe('2001:db8:0:0::/64')
    // Nor is an address that merely starts with zeros: `::1` is not 0.0.0.1.
    expect(clientRateKey('::1')).toBe('0:0:0:0::/64')
  })

  it('puts an address that will not parse in one shared bucket', () => {
    expect(clientRateKey('not:an:address::zz')).toBe('unknown')
    expect(clientRateKey('1:2:3:4:5:6:7:8:9')).toBe('unknown')
  })
})
