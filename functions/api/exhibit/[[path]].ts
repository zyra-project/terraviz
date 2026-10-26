// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Cloudflare Pages Function — anything under /api/exhibit/ that no
 * other route there matches.
 *
 * A JSON 404, `no_such_route`, rather than the app's page, which is what
 * Pages answers an unknown path with. A Second Life script can't see a
 * reply's Content-Type, so a later script asking this node for a read it
 * lacks would otherwise take the app's HTML for an answer. As
 * `stac/[[path]].ts` does for its own paths. A real read asked with a
 * method other than GET or HEAD falls through to here, and is a 405
 * `method_not_allowed`; any other path is `no_such_route` for every
 * method, so a later script's POST to a read this node lacks is told so.
 */

import { exhibitError } from '../v1/_lib/exhibit-reads'

/** The reads this node has, as Pages matches them (case aside). */
const READS = /^\/api\/exhibit\/v1\/(datasets(\/[^/]+)?|tags)\/?$/i

export const onRequest: PagesFunction = async context => {
  // A real read asked with another method falls through to here too, and
  // isn't a read the node lacks. Any other path is, whatever the method.
  const method = context.request.method
  const real = READS.test(new URL(context.request.url).pathname)
  if (real && method !== 'GET' && method !== 'HEAD') {
    const res = exhibitError(405, 'method_not_allowed', 'The exhibit reads answer GET.')
    res.headers.set('Allow', 'GET, HEAD')
    return res
  }
  return exhibitError(404, 'no_such_route', 'This node has no such exhibit read.')
}
