// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The parts of `/setup` that the design export does not own.
 *
 * ## Why this file exists
 *
 * `render.ts` and `content.ts` are regenerated wholesale by the design
 * tool and dropped into the repo as replacements. That is the intended
 * workflow — the prose and layout are authored there, and hand-merging
 * them would defeat the point. But it means **any repo-side edit to
 * those two files is lost on the next export**, silently, and the
 * first two exports proved it: both arrived referencing a favicon and
 * a globe SVG that do not exist in `public/`, and with no CSP.
 *
 * Losing an edit is only dangerous when nothing notices. So the fixes
 * are sorted by what happens when they go missing:
 *
 * | Concern | If an export drops it |
 * |---|---|
 * | Backticks escaped in template literals | esbuild fails — cannot ship |
 * | `TRUST` worksheet field | `crossCheck` 2 fails — cannot ship |
 * | Favicon / sidebar mark / CSP / tokens | **ships, quietly broken** |
 *
 * The first two already refuse to build, so they need nothing from us.
 * The third row is what this file owns: it is applied to the rendered
 * HTML at build time, from a module the export has never contained and
 * therefore cannot overwrite.
 *
 * ## Idempotent on purpose
 *
 * Every transform below checks before it writes, so this works against
 * a raw export (applies the fix) and against the current tree, where
 * `render.ts` still carries the same fixes inline (leaves them alone).
 * That matters because it means the repo does not have to be reverted
 * to a deliberately-broken state to keep this honest.
 *
 * ## And then it verifies
 *
 * Applying a fix and checking the result are different jobs.
 * `assertSelfContained` re-reads the finished HTML and fails the build
 * on any subresource that is not inline — which catches a *new*
 * external reference an export introduces that no transform here knows
 * about yet.
 */

import { MARKDOWN_URL, type WorksheetField } from './content'
import { GB_PER_VIDEO_DATASET, R2_PRICING } from './pricing'

// ── Fork-friendly documentation links ─────────────────────────────

/**
 * Where the page's "full detail in SELF_HOSTING.md" links point.
 *
 * The generated page carries 17 of them, one per phase, all built from
 * `MARKDOWN_URL` — which names the upstream repo on `main`. That is
 * correct for this repo and wrong for every fork: a fork deploys its
 * own node, and its `/setup` sends readers to upstream's guide, which
 * describes upstream's code.
 *
 * Two audiences need different answers, so there are two layers.
 *
 * **Build time, this function.** `TERRAVIZ_DOCS_URL` overrides the
 * base for the whole page, matching the `TERRAVIZ_HOSTNAME` /
 * `TERRAVIZ_SERVER` convention the setup tool already uses. A fork
 * sets it once in their Pages build config and every link retargets —
 * including for a visitor who never touches the worksheet. Unset, it
 * resolves to `MARKDOWN_URL` and nothing changes, so the build stays
 * deterministic for this repo and `--check` is unaffected.
 *
 * **Runtime, `docLinkRuntime()`.** The worksheet already asks for the
 * git remote as `W3`. Once it is filled the links retarget to that
 * repo without any configuration at all.
 *
 * Deriving this from `git remote get-url origin` was the other
 * candidate and is deliberately not done: it would make the build
 * environment-dependent, so a fresh fork's committed `setup.html`
 * would not match a build in their own CI, and `check:setup-page`
 * would fail on their first push. Red CI on day one of a fork is the
 * exact friction this whole PR exists to remove.
 */
export function resolveDocsUrl(env: Record<string, string | undefined>): string {
  const configured = env.TERRAVIZ_DOCS_URL?.trim()
  return configured ? configured.replace(/\/+$/, '') : MARKDOWN_URL
}

/**
 * Point every documentation link at `docsUrl`, and tag it with the
 * anchor it wants so the runtime can retarget it again later.
 *
 * The rewritten `href` is a complete, working URL on its own — the
 * runtime layer is an enhancement, not a dependency. With JavaScript
 * off, or if a future export drops the runtime script, the links still
 * resolve to whatever the build was configured with.
 */
export function applyDocLinks(
  html: string,
  docsUrl: string,
): { html: string; count: number } {
  let count = 0
  const escaped = MARKDOWN_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const out = html.replace(
    new RegExp(`<a href="${escaped}(#[a-z0-9-]*)?"`, 'g'),
    (_match, anchor: string | undefined) => {
      count += 1
      const frag = anchor ?? ''
      return `<a data-doc="${frag}" href="${docsUrl}${frag}"`
    },
  )
  return { html: out, count }
}

/**
 * Retarget the documentation links from the worksheet's `W3`.
 *
 * Deliberately self-contained: it reads the `W3` input and the
 * persisted state directly rather than reaching into `render.ts`'s
 * script scope. That script is regenerated by every design export, so
 * anything coupled to its internals would break silently. The only
 * contracts relied on here are the `data-field="W3"` attribute and the
 * storage key — both stable, and both asserted in `shell.test.ts`.
 *
 * Reads the live input before falling back to storage, because the
 * page persists on a debounce and an `input` event can arrive first.
 */
export function docLinkScript(fallback: string): string {
  return `
(function () {
  var KEY = 'terraviz-setup-console-v1';
  var FALLBACK = ${JSON.stringify(fallback)};
  var SLUG = /^([\\w.-]+)\\/([\\w.-]+)$/;
  var FRAG = /^#([\\w-]*)$/;
  function remote() {
    var el = document.querySelector('[data-field="W3"]');
    if (el && el.value && el.value.trim()) return el.value.trim();
    try {
      var s = JSON.parse(localStorage.getItem(KEY) || '{}');
      return ((s.vals || {}).W3 || '').trim();
    } catch (e) { return ''; }
  }
  // Each half goes through encodeURIComponent and lands as exactly one
  // path segment, so the origin is literally github.com whatever was
  // typed — the guarantee comes from the construction, not from
  // reading the pattern carefully. '..' is rejected rather than
  // encoded, because encodeURIComponent leaves dots alone.
  function docBase() {
    var m = SLUG.exec(remote());
    if (!m || m[1] === '..' || m[2] === '..') return FALLBACK;
    return 'https://github.com/' + encodeURIComponent(m[1]) + '/' +
      encodeURIComponent(m[2]) + '/blob/main/docs/SELF_HOSTING.md';
  }
  function paint() {
    var base = docBase();
    var links = document.querySelectorAll('[data-doc]');
    for (var i = 0; i < links.length; i++) {
      // data-doc is written by applyDocLinks and is only ever
      // '#a-z0-9-', but it is DOM text on the way into an href, and an
      // href is a scheme-bearing sink. So: match an anchored
      // allowlist, take the capture rather than the original string,
      // and set it through URL.hash — the scheme and origin then come
      // structurally from base, not from anything concatenated.
      var m = FRAG.exec(links[i].getAttribute('data-doc') || '');
      var u = new URL(base);
      u.hash = m ? m[1] : '';
      links[i].setAttribute('href', u.href);
    }
  }
  document.addEventListener('input', function (e) {
    var t = e.target;
    if (t && t.getAttribute && t.getAttribute('data-field') === 'W3') paint();
  });
  paint();
})();
`
}

/**
 * The same script wrapped for injection.
 *
 * Split from `docLinkScript` so tests can execute the body directly.
 * The previous shape returned the wrapper and the test stripped the
 * tags with a regex — which CodeQL correctly flagged as a bad HTML
 * filter (it would not have matched `<SCRIPT>`). Harmless in a test
 * over our own output, but a regex that pretends to parse HTML is
 * worth not having at all.
 */
export function docLinkRuntime(fallback: string): string {
  return `<script ${INJECTED_MARK}="doc-links">\n${docLinkScript(fallback)}</script>\n`
}

/**
 * Marks a script `applyShell` injected, so a second pass can tell it
 * apart from the page's own markup and skip it.
 *
 * The cost runtime guarded on `data-cost-count`, which `render.ts`
 * emits. That is the trigger for the injection, not evidence of it:
 * it is still on the page afterwards, so a second `applyShell` added
 * the script again — duplicate `input` listeners and repaint calls,
 * contradicting this module's own idempotency contract.
 *
 * The doc-link runtime did not have the bug, because `applyDocLinks`
 * rewrites `<a href="…">` to `<a data-doc="…" href="…">` and its
 * regex no longer matches, so `count` is 0 on a second pass. That is
 * emergent rather than stated, and it would quietly stop holding if
 * the rewrite's output shape changed. Both injections are marked, so
 * idempotency is a property of this function rather than of another
 * one's output.
 *
 * The existing idempotency test missed all of this: its fixture has
 * neither a doc link nor a cost widget, so neither injection fired.
 */
const INJECTED_MARK = 'data-tv-injected'

/**
 * The storage estimate's runtime.
 *
 * Rates are interpolated from `pricing.ts` rather than written into
 * the script, so the constants block stays the single place a price
 * lives. Same arithmetic as `estimateStorage()`, which is unit-tested;
 * this is the browser copy of it and the two are pinned together by a
 * test that runs this script and compares.
 *
 * Lives here rather than in `render.ts` for the usual reason — the
 * design export replaces that file wholesale.
 */
/**
 * Name the destination of a manual step's links from its host.
 *
 * Both labels on the install sheet used to say "Cloudflare"
 * unconditionally — "Open in the Cloudflare dashboard", "Cloudflare's
 * docs for this". That was true of every step until the fork step,
 * which points at GitHub, and a label naming the wrong product is a
 * small lie in the one place someone new to the platform is trusting
 * this page.
 *
 * Derived rather than written, so the next non-Cloudflare step cannot
 * reintroduce it silently. Unknown hosts get neutral wording instead
 * of a guess.
 *
 * Lives here rather than in `render.ts` for the usual reason: the
 * design export replaces that file wholesale, and this is the kind of
 * string an export would happily rewrite back.
 */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
}

/**
 * Exactly this domain, or a subdomain of it.
 *
 * `endsWith('github.com')` is the obvious spelling and the wrong one:
 * it also matches `evilgithub.com`, because the suffix test has no
 * idea where a label boundary is. CodeQL flags it as incomplete URL
 * substring sanitization and is right to — nothing here is
 * attacker-reachable today, since every URL is a constant in
 * `MANUAL_STEPS`, but a predicate that answers "is this GitHub?"
 * wrongly is worth not keeping just because its current callers are
 * safe.
 */
function isHost(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`)
}

export function actionLabel(url: string): string {
  const h = hostOf(url)
  if (isHost(h, 'cloudflare.com')) return 'Open in the Cloudflare dashboard'
  if (isHost(h, 'github.com')) return 'Open on GitHub'
  return 'Open this page'
}

export function docsLabel(url: string): string {
  const h = hostOf(url)
  if (isHost(h, 'cloudflare.com')) return "Cloudflare's docs for this"
  if (isHost(h, 'github.com')) return "GitHub's docs for this"
  return 'Documentation for this'
}

export function costRuntime(): string {
  return `
(function () {
  var GB_EACH = ${GB_PER_VIDEO_DATASET};
  var FREE_GB = ${R2_PRICING.freeStorageGb};
  var PER_GB = ${R2_PRICING.storagePerGbMonth};
  var count = document.querySelector('[data-cost-count]');
  var out = document.querySelector('[data-cost-out]');
  var note = document.querySelector('[data-cost-note]');
  if (!count || !out || !note) return;
  var FREE_N = Math.floor(FREE_GB / GB_EACH);
  function money(n) {
    if (n === 0) return '$0';
    if (n < 1) return '~' + Math.round(n * 100) + ' cents';
    return '~$' + (n < 10 ? n.toFixed(2) : Math.round(n));
  }
  function paint() {
    var n = Number(count.value) || 0;
    var gb = n * GB_EACH;
    var billable = Math.max(0, gb - FREE_GB);
    out.textContent = n + ' video datasets  ·  ' + gb.toFixed(0) + ' GB  ·  ' +
      money(billable * PER_GB) + ' / month';
    note.textContent = n === 0
      ? 'Drag to size your catalog. Metadata, images and tours alone stay far inside the free allowance.'
      : billable === 0
        ? 'Free. About ' + FREE_N + ' video datasets fit inside R2\\u2019s ' + FREE_GB + ' GB, on either plan.'
        : 'The first ' + FREE_N + ' or so are free; past that it is ' + billable.toFixed(0) +
          ' GB at $' + PER_GB + '/GB-month. Serving them to visitors adds nothing \\u2014 R2 egress is free.';
  }
  count.addEventListener('input', paint);
  paint();
})();
`
}

// ── Design tokens ─────────────────────────────────────────────────

/**
 * Maps the page's `--tv-*` names onto the repo's design tokens.
 *
 * Verified against `src/styles/tokens.css` rather than guessed. Where
 * a repo token carries the same value the design asked for, the alias
 * points at it and the page tracks the palette. Where the repo has no
 * equivalent, the alias keeps its literal — pointing at a near-miss
 * token would be worse than not tracking, because it would drift
 * *away* from the design on the next palette change.
 *
 * Three cases are worth naming, since each looks like an oversight:
 *
 *   - `--tv-surface` / `--tv-surface-code` stay literal. The repo's
 *     `--color-surface` family is translucent white — glass meant to
 *     composite over the WebGL globe. This page is opaque document
 *     chrome with nested panels, and stacking translucency would make
 *     each nesting level progressively lighter.
 *   - `--tv-text-muted` maps to `--color-text-secondary`, not to
 *     `--color-text-muted`. The names invite the opposite pairing, but
 *     the values decide it: the design's #bbbbbb *is*
 *     `--color-text-secondary`; `--color-text-muted` is #999999.
 *   - `--tv-error` maps to `--color-error-soft` (#ff6b6b), the
 *     foreground red. `--color-error` (#ef4444) is the deeper red the
 *     `-bg` / `-border` literals are derived from.
 *
 * The repo has no font tokens at all, so both stacks stay literal.
 */
export const TOKEN_ALIASES = `
:root{
  --tv-bg:              var(--color-bg,                    #0d0d12);
  --tv-surface:         #121218;
  --tv-surface-2:       var(--color-surface-alt,           rgba(255,255,255,.04));
  --tv-surface-3:       var(--color-surface,               rgba(255,255,255,.06));
  --tv-surface-code:    #08080b;
  --tv-border:          var(--color-surface-border-subtle, rgba(255,255,255,.08));
  --tv-border-strong:   var(--color-surface-border,        rgba(255,255,255,.1));
  --tv-text:            var(--color-text,                  #e8eaf0);
  --tv-text-muted:      var(--color-text-secondary,        #bbbbbb);
  --tv-text-dim:        var(--color-text-dim,              #888888);
  --tv-accent:          var(--color-accent,                #4da6ff);
  --tv-accent-hover:    var(--color-accent-hover,          #6ab8ff);
  --tv-accent-strong:   var(--color-accent-dark,           #0066cc);
  --tv-accent-bg:       rgba(77,166,255,.07);
  --tv-accent-border:   rgba(77,166,255,.24);
  --tv-error:           var(--color-error-soft,            #ff6b6b);
  --tv-error-bg:        rgba(239,68,68,.08);
  --tv-error-border:    rgba(239,68,68,.22);
  --tv-warn:            var(--color-warning,               #ffcc66);
  --tv-warn-bg:         rgba(255,204,102,.07);
  --tv-warn-border:     rgba(255,204,102,.22);
  --tv-success:         var(--color-success,               #22c55e);
  --tv-font-sans:       -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
  --tv-font-mono:       ui-monospace,'SF Mono',Menlo,Consolas,monospace;
}
`

// ── Page-shell fragments ──────────────────────────────────────────

/** The favicon that actually exists in `public/`. */
export const FAVICON_LINK = '<link rel="icon" href="/favicon.ico" sizes="48x48"/>'

/**
 * Content-Security-Policy, delivered by `<meta>`.
 *
 * The same posture as `public/privacy.html`, relaxed by exactly one
 * directive: that page can afford `script-src 'none'` because it has
 * no script, and this one carries its checklist logic inline.
 * Everything else stays shut. `default-src 'none'` means the page
 * cannot fetch, connect or embed anything — a real restriction, and a
 * standing check on the claim that this page is self-contained.
 *
 * It also blocks the analytics beacon Cloudflare Pages injects into
 * every deployed HTML file. `privacy.html` already blocks the same
 * beacon via `script-src 'none'`; matching it keeps a third-party
 * script off an operator-facing page on a privacy-first project.
 *
 * No `frame-ancestors`: browsers ignore it in a `<meta>` element and
 * log an error saying so. Framing control belongs in `public/_headers`.
 */
export const CSP_META =
  '<meta http-equiv="Content-Security-Policy" content="' +
  "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; " +
  "img-src 'self' data:; font-src 'self'; base-uri 'none'; form-action 'none'\"/>"

/**
 * The sidebar mark, inline rather than linked.
 *
 * This page's premise is that it works when the deploy does not — read
 * off a laptop, a checkout, a broken preview. An `<img src="/…">`
 * fails under `file://` and under any host not serving the SPA root,
 * which is exactly the situation someone is in when they open it.
 *
 * Gradient and clip ids are prefixed `tvg-` because SVG ids join the
 * document namespace once inlined.
 */
export const GLOBE_MARK =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="26" height="26" aria-hidden="true" focusable="false" style="display:block;flex:none"><defs><radialGradient id="tvg-sphere" cx="40%" cy="35%" r="50%"><stop offset="0%" stop-color="#4FC3F7"></stop><stop offset="60%" stop-color="#1565C0"></stop><stop offset="100%" stop-color="#0D2137"></stop></radialGradient><radialGradient id="tvg-shine" cx="35%" cy="30%" r="45%"><stop offset="0%" stop-color="white" stop-opacity="0.3"></stop><stop offset="100%" stop-color="white" stop-opacity="0"></stop></radialGradient><clipPath id="tvg-clip"><circle cx="16" cy="16" r="14.08"></circle></clipPath></defs><circle cx="16" cy="16" r="14.72" fill="#0a1628"></circle><circle cx="16" cy="16" r="14.08" fill="url(#tvg-sphere)"></circle><g clip-path="url(#tvg-clip)" fill="none" stroke="rgba(255,255,255,0.15)" stroke-width="1"><ellipse cx="16" cy="16" rx="14.08" ry="1.92"></ellipse><ellipse cx="16" cy="10.56" rx="11.2" ry="1.6"></ellipse><ellipse cx="16" cy="21.44" rx="11.2" ry="1.6"></ellipse><ellipse cx="16" cy="16" rx="1.92" ry="14.08"></ellipse><ellipse cx="11.84" cy="16" rx="1.28" ry="13.44"></ellipse><ellipse cx="20.16" cy="16" rx="1.28" ry="13.44"></ellipse></g><g clip-path="url(#tvg-clip)" fill="rgba(76,175,80,0.5)" stroke="none"><path d="M12.16 7.04 Q13.44 8 12.8 10.24 Q11.52 11.52 12.16 12.8 Q13.44 15.36 12.16 17.6 Q11.2 19.84 11.84 22.4 Q11.2 20.8 10.56 18.56 Q10.24 16 10.88 13.44 Q10.56 11.2 11.2 8.96 Z"></path><path d="M16.64 8 Q17.92 8.96 18.56 10.88 Q19.2 12.8 18.24 15.36 Q17.6 17.6 17.92 19.84 Q17.28 18.56 16.96 16 Q16.64 13.44 17.28 10.88 Q16.64 9.6 16 8.64 Z"></path></g><circle cx="16" cy="16" r="14.08" fill="url(#tvg-shine)"></circle><circle cx="16" cy="16" r="14.08" fill="none" stroke="rgba(255,255,255,0.12)" stroke-width="1"></circle></svg>'

// ── Repair ────────────────────────────────────────────────────────

/** What `applyShell` had to put back, for the build to report. */
export interface ShellRepairs {
  favicon: boolean
  csp: boolean
  globeMark: boolean
}

export interface ShellOptions {
  /** Base for the SELF_HOSTING.md links. See `resolveDocsUrl`. */
  docsUrl?: string
}

export const repairSummary = (r: ShellRepairs): string[] =>
  Object.entries(r)
    .filter(([, applied]) => applied)
    .map(([name]) => name)

/**
 * Restore the shell concerns an export drops. Idempotent: each
 * transform is a no-op when the fix is already present.
 */
export function applyShell(
  html: string,
  opts: ShellOptions = {},
): { html: string; repairs: ShellRepairs; docLinks: number } {
  const repairs: ShellRepairs = { favicon: false, csp: false, globeMark: false }
  let out = html

  // Two exports in a row shipped this filename; it has never existed.
  const badFavicon = /<link rel="icon"[^>]*href="\/terraviz-favicon[^"]*"[^>]*\/?>/
  if (badFavicon.test(out)) {
    out = out.replace(badFavicon, FAVICON_LINK)
    repairs.favicon = true
  }

  // Same story — the globe SVG lives in the design bundle, not public/.
  const badMark = /<img[^>]*src="\/terraviz-globe\.svg"[^>]*\/?>/
  if (badMark.test(out)) {
    out = out.replace(badMark, GLOBE_MARK)
    repairs.globeMark = true
  }

  if (!/http-equiv="Content-Security-Policy"/i.test(out)) {
    // After <title> so the policy sits with the other head metadata
    // rather than ahead of the charset declaration.
    const anchor = /(<meta name="robots"[^>]*\/?>|<\/title>)/i
    if (!anchor.test(out)) {
      throw new Error(
        'Cannot place the CSP: no <meta name="robots"> or </title> in the rendered head.\n' +
          'The export changed the head structure — update applyShell() in ' +
          'scripts/setup-page/shell.ts.',
      )
    }
    out = out.replace(anchor, `$1\n${CSP_META}`)
    repairs.csp = true
  }

  // Doc links last, so the runtime script lands after render.ts's own
  // inline script and can read the inputs it has already populated.
  const docsUrl = opts.docsUrl ?? MARKDOWN_URL
  const linked = applyDocLinks(out, docsUrl)
  out = linked.html
  // Replacer *functions*, never replacement strings. `String.replace`
  // reads `$'` in a replacement as "everything after the match", and
  // both scripts below contain `'~$' + …` money formatting — which
  // silently spliced the tail of the document into the middle of a
  // string literal and broke the page. A function replacement is
  // taken literally.
  const before = (html: string, injected: string): string =>
    html.replace('</body>', () => `${injected}</body>`)

  // Guard on the injection marker, not on the page markup that
  // triggers it — see INJECTED_MARK.
  const alreadyInjected = (id: string): boolean =>
    out.includes(`${INJECTED_MARK}="${id}"`)

  if (linked.count > 0 && !alreadyInjected('doc-links')) {
    out = before(out, docLinkRuntime(docsUrl))
  }
  if (out.includes('data-cost-count') && !alreadyInjected('cost')) {
    out = before(out, `<script ${INJECTED_MARK}="cost">${costRuntime()}</script>\n`)
  }

  return { html: out, repairs, docLinks: linked.count }
}

// ── Verification ──────────────────────────────────────────────────

/** Subresources the page is allowed to reach for. Navigation is free. */
const ALLOWED_SUBRESOURCES = new Set(['/favicon.ico'])

/**
 * Fail the build on any subresource that is not inline.
 *
 * `applyShell` fixes the two external references we have seen. This
 * catches the third — a stylesheet, a font, an analytics tag, an image
 * a future export adds that no transform above knows to rewrite. The
 * page's whole value is being readable when the deploy is broken, and
 * that property cannot be maintained by fixing only the breakages that
 * have already happened.
 *
 * `<a href>` is deliberately not checked: links are navigation, not
 * subresources, and the page links into SELF_HOSTING.md on purpose.
 */
export function assertSelfContained(html: string): void {
  const offenders: string[] = []

  for (const [, url] of html.matchAll(/\ssrc="([^"]+)"/g)) {
    if (!url.startsWith('data:') && !ALLOWED_SUBRESOURCES.has(url)) {
      offenders.push(`src="${url}"`)
    }
  }
  for (const [, url] of html.matchAll(/<link\b[^>]*\bhref="([^"]+)"/g)) {
    if (!url.startsWith('data:') && !ALLOWED_SUBRESOURCES.has(url)) {
      offenders.push(`<link href="${url}">`)
    }
  }
  for (const [, url] of html.matchAll(/url\(\s*['"]?(?!data:)([^'")]+)['"]?\s*\)/g)) {
    if (!url.startsWith('#') && !ALLOWED_SUBRESOURCES.has(url)) {
      offenders.push(`url(${url})`)
    }
  }

  if (offenders.length) {
    throw new Error(
      'The /setup page must be self-contained — it is read while the deploy\n' +
        'is broken, so anything it fetches is a reference that will not resolve.\n\n' +
        `Non-inline subresources:\n${[...new Set(offenders)].map(o => `  • ${o}`).join('\n')}\n\n` +
        'Inline it (see GLOBE_MARK), or add it to ALLOWED_SUBRESOURCES in\n' +
        'scripts/setup-page/shell.ts if it genuinely must be fetched.',
    )
  }
}

/**
 * Every validator a worksheet field names must exist in the page's
 * inline script.
 *
 * `render.ts` re-declares the `prompt.ts` regexes for the browser, and
 * an export can drop one — as the second export dropped
 * `emailDomainList`. A field pointing at a validator the browser does
 * not have silently accepts any input, which is the one failure mode
 * of that seam worth closing. Checked here rather than in `render.ts`
 * so it survives the next export.
 */
export function assertValidatorsImplemented(
  worksheet: readonly WorksheetField[],
  html: string,
): void {
  const named = [...new Set(worksheet.map(w => w.validator).filter(Boolean))]
  const missing = named.filter(v => !new RegExp(`\\b${v}:\\s*v\\s*=>`).test(html))
  if (missing.length) {
    throw new Error(
      `Worksheet fields name validators the page's inline script does not implement: ` +
        `${missing.join(', ')}.\n` +
        "Add them to the `V` object in runtime() in scripts/setup-page/render.ts.",
    )
  }
}
