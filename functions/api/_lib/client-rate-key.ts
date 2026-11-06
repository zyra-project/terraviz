// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The key an in-memory per-caller rate limiter should count by, from a
 * `CF-Connecting-IP` value.
 *
 * Keyed on the raw address, a limit does nothing against an IPv6 client:
 * a home line or a VPS is handed a whole /64 and can send every request
 * from a new address in it. So an IPv6 address is keyed by its /64,
 * whatever its spelling. An IPv4-mapped address (`::ffff:a.b.c.d`) is one
 * IPv4 client, and every such address shares the /64 `0:0:0:0`, so it is
 * keyed as the IPv4 address it carries rather than putting all of them in
 * one bucket. An IPv4 address is keyed as it is. Anything that will not
 * parse is `unknown`, one shared bucket, which fails toward limiting.
 *
 * Written for the federation feed's limiter and moved here when the voice
 * routes needed it too, so the two cannot drift.
 */
export function clientRateKey(address: string): string {
  if (!address.includes(':')) return address
  try {
    const host = new URL(`http://[${address}]/`).hostname.slice(1, -1)
    const [left, right = ''] = host.split('::')
    const prefix = left ? left.split(':') : []
    const suffix = right ? right.split(':') : []
    const groups = host.includes('::') ? [...prefix, ...Array(8 - prefix.length - suffix.length).fill('0'), ...suffix] : prefix
    if (groups.length !== 8) return 'unknown'
    const words = groups.map(group => parseInt(group, 16))
    if (words.slice(0, 5).every(word => word === 0) && words[5] === 0xffff) {
      return [words[6] >> 8, words[6] & 0xff, words[7] >> 8, words[7] & 0xff].join('.')
    }
    return words.slice(0, 4).map(word => word.toString(16)).join(':') + '::/64'
  } catch { return 'unknown' }
}
