// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The export-proof layer.
 *
 * `render.ts` and `content.ts` are replaced wholesale by each design
 * export, so a guard living in either of them protects nothing — it is
 * gone with the file that held it. This test is the one place the
 * export has never reached, which makes it the right home for the
 * assertions that must outlive it.
 *
 * Two exports in a row shipped a favicon and a globe SVG that do not
 * exist in `public/`, and no CSP. Both would have deployed silently.
 * These tests are what turn that into a red build.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  applyDocLinks,
  applyShell,
  docLinkRuntime,
  docLinkScript,
  costRuntime,
  resolveDocsUrl,
  assertSelfContained,
  assertValidatorsImplemented,
  CSP_META,
  FAVICON_LINK,
  GLOBE_MARK,
  repairSummary,
  TOKEN_ALIASES,
  actionLabel,
  docsLabel,
} from './shell'
import { MARKDOWN_URL, WORKSHEET } from './content'
import { estimateStorage, REFERENCE_NODE } from './pricing'

const PAGE = resolve(__dirname, '../../public/setup.html')
const html = (): string => readFileSync(PAGE, 'utf8')

const RAW_EXPORT_HEAD = [
  '<head>',
  '<meta charset="utf-8"/>',
  '<title>Terraviz — install console</title>',
  '<meta name="robots" content="noindex"/>',
  '<link rel="icon" href="/terraviz-favicon-32.png"/>',
  '</head><body>',
  '<img src="/terraviz-globe.svg" alt="" width="26" height="26"/>',
  '</body>',
].join('\n')

/**
 * Carries both injection triggers: an upstream doc link (which is what
 * applyDocLinks matches on) and the cost widget.
 */
const RAW_EXPORT_WITH_RUNTIMES = [
  '<head>',
  '<meta charset="utf-8"/>',
  '<title>Terraviz — install console</title>',
  '<meta name="robots" content="noindex"/>',
  '</head><body>',
  `<a href="${MARKDOWN_URL}#phase-2--create-the-cloudflare-resources">Phase 2</a>`,
  '<input data-cost-count value="120"/><span data-cost-out></span>',
  '<span data-cost-note></span>',
  '</body>',
].join('\n')

describe('applyShell', () => {
  it('repairs everything a raw export drops', () => {
    const { html: out, repairs } = applyShell(RAW_EXPORT_HEAD)
    expect(repairSummary(repairs).sort()).toEqual(['csp', 'favicon', 'globeMark'])
    expect(out).toContain(FAVICON_LINK)
    expect(out).toContain(CSP_META)
    expect(out).toContain(GLOBE_MARK)
    expect(out).not.toContain('terraviz-favicon')
    expect(out).not.toContain('terraviz-globe.svg')
  })

  // The repo keeps the same fixes inline in render.ts. If applying the
  // shell to an already-fixed page changed anything, the two sources
  // would fight and every build would differ from the last.
  it('is a no-op on a page that already has them', () => {
    const once = applyShell(RAW_EXPORT_HEAD).html
    const { html: twice, repairs } = applyShell(once)
    expect(twice).toBe(once)
    expect(repairSummary(repairs)).toEqual([])
  })

  // The test above passes vacuously for the injected runtimes:
  // RAW_EXPORT_HEAD has neither a doc link nor a cost widget, so
  // neither injection fires and re-running cannot duplicate them.
  //
  // The cost runtime guarded on `data-cost-count` — the markup that
  // *triggers* the injection, still present on a second pass — so it
  // was injected twice, giving the page duplicate input listeners and
  // repaint calls. This fixture carries both triggers so the guards
  // are actually exercised.
  it('does not re-inject its runtimes on a second pass', () => {
    const once = applyShell(RAW_EXPORT_WITH_RUNTIMES).html
    const twice = applyShell(once).html
    expect(twice).toBe(once)
    const scripts = (id: string): number =>
      (once.match(new RegExp(`data-tv-injected="${id}"`, 'g')) ?? []).length
    expect(scripts('doc-links')).toBe(1)
    expect(scripts('cost')).toBe(1)
  })

  it('refuses to guess where the CSP goes if the head is restructured', () => {
    expect(() => applyShell('<html><body>no head markers</body></html>')).toThrow(
      /Cannot place the CSP/,
    )
  })
})

describe('fork-friendly doc links', () => {
  const doc = (anchor = '') => `<a href="${MARKDOWN_URL}${anchor}">d</a>`

  it('defaults to the upstream guide when nothing is configured', () => {
    expect(resolveDocsUrl({})).toBe(MARKDOWN_URL)
    expect(resolveDocsUrl({ TERRAVIZ_DOCS_URL: '   ' })).toBe(MARKDOWN_URL)
  })

  it('takes the configured base and drops a trailing slash', () => {
    expect(resolveDocsUrl({ TERRAVIZ_DOCS_URL: 'https://x.org/g.md/' })).toBe('https://x.org/g.md')
  })

  it('retargets every link and keeps each anchor', () => {
    const { html, count } = applyDocLinks(
      `${doc()}${doc('#phase-2--create-the-cloudflare-resources')}`,
      'https://github.com/fork/repo/blob/main/docs/SELF_HOSTING.md',
    )
    expect(count).toBe(2)
    expect(html).toContain('data-doc="#phase-2--create-the-cloudflare-resources"')
    expect(html).toContain(
      'href="https://github.com/fork/repo/blob/main/docs/SELF_HOSTING.md#phase-2--create-the-cloudflare-resources"',
    )
    expect(html).not.toContain(MARKDOWN_URL)
  })

  // The runtime layer is an enhancement. With JS off, or after an
  // export drops the script, the static href must still work.
  it('leaves a complete working href, not a fragment', () => {
    const { html } = applyDocLinks(doc('#x'), 'https://e.org/g.md')
    expect(html).toContain('href="https://e.org/g.md#x"')
  })

  it('is a no-op when the page has no doc links', () => {
    const { html, count } = applyDocLinks('<p>none</p>', 'https://e.org/g.md')
    expect(count).toBe(0)
    expect(html).toBe('<p>none</p>')
  })

  // Coupling to render.ts's script scope would break on the next
  // export; these two contracts are all the runtime may rely on.
  it('reads only the W3 field and the storage key', () => {
    const js = docLinkRuntime(MARKDOWN_URL)
    expect(js).toContain('data-field="W3"')
    expect(js).toContain('terraviz-setup-console-v1')
  })

  // The runtime writes a user-supplied value into an href. Reading the
  // regex and concluding "that looks fine" is not evidence, so this
  // runs the emitted script against hostile input and checks the
  // origin that actually comes out.
  describe('the emitted runtime, executed', () => {
    const run = (w3: string): string => {
      document.body.innerHTML =
        `<input data-field="W3" value="${w3.replace(/"/g, '&quot;')}"/>` +
        '<a data-doc="#phase-2" href="' + MARKDOWN_URL + '#phase-2"></a>'
      new Function(docLinkScript(MARKDOWN_URL))()
      return document.querySelector('[data-doc]')!.getAttribute('href')!
    }

    it('retargets a real owner/repo', () => {
      expect(run('museum/terraviz-fork')).toBe(
        'https://github.com/museum/terraviz-fork/blob/main/docs/SELF_HOSTING.md#phase-2',
      )
    })

    it.each([
      ['a scheme', 'javascript:alert(1)'],
      ['path traversal', '../..'],
      ['a protocol-relative host', '//evil.org/x'],
      ['userinfo confusion', 'evil.org%2f@x/y'],
      ['empty', ''],
    ])('falls back rather than trusting %s', (_label, w3) => {
      expect(run(w3)).toBe(`${MARKDOWN_URL}#phase-2`)
    })

    // data-doc is ours, but it reaches the href as DOM text. This is
    // the flow CodeQL flagged; the fragment must never carry a scheme.
    it('ignores a data-doc that is not a plain fragment', () => {
      document.body.innerHTML =
        '<input data-field="W3" value=""/>' +
        `<a data-doc="javascript:alert(1)" href="${MARKDOWN_URL}"></a>`
      new Function(docLinkScript(MARKDOWN_URL))()
      const href = document.querySelector('[data-doc]')!.getAttribute('href')!
      expect(href).toBe(MARKDOWN_URL)
      expect(new URL(href).protocol).toBe('https:')
    })

    // The construction, not the pattern, is what guarantees this.
    it('never leaves github.com', () => {
      for (const w3 of ['evil.com/x', 'a/b', '..-/x', '_/_']) {
        const url = run(w3)
        expect(new URL(url).origin, `${w3} escaped the origin`).toBe('https://github.com')
      }
    })
  })

  it('injects the runtime only when there are links to retarget', () => {
    expect(applyShell('<html><head><title>t</title></head><body></body></html>').html)
      .not.toContain('terraviz-setup-console-v1')
    const withLinks = applyShell(
      `<html><head><title>t</title></head><body>${doc('#a')}</body></html>`,
    )
    expect(withLinks.docLinks).toBe(1)
    expect(withLinks.html).toContain('terraviz-setup-console-v1')
  })
})

describe('the cost estimate runtime', () => {
  // `String.replace` reads `$'` in a *replacement string* as
  // "everything after the match". Both injected scripts format money
  // with `'~$' + …`, so a string replacement spliced the tail of the
  // document into the middle of a string literal and broke the page
  // with "Invalid or unexpected token". Nothing but parsing the output
  // catches that.
  it('survives injection without the $-pattern eating the document', () => {
    const page = applyShell(
      '<html><head><title>t</title></head><body><input data-cost-count/><output data-cost-out></output><p data-cost-note></p></body>\n</html>',
    ).html
    expect(page).toContain('data-cost-count')
    expect(page).not.toMatch(/'~\n/)
    expect(() => new Function(costRuntime())).not.toThrow()
  })

  it('is injected only when the panel is on the page', () => {
    const without = applyShell('<html><head><title>t</title></head><body></body></html>').html
    expect(without).not.toContain('data-cost-out')
  })

  // The browser copy and the tested pure function must not drift.
  it('matches estimateStorage() at the same inputs', () => {
    document.body.innerHTML =
      `<input data-cost-count value="${REFERENCE_NODE.videoDatasets}"/>` +
      '<output data-cost-out></output><p data-cost-note></p>'
    new Function(costRuntime())()
    const shown = document.querySelector('[data-cost-out]')!.textContent!
    const e = estimateStorage(REFERENCE_NODE.videoDatasets)
    expect(shown).toContain(e.storageGb.toFixed(0))
    // The browser copy must land on the real invoice too.
    expect(shown).toContain(String(REFERENCE_NODE.monthlyUsd))
  })
})

describe('assertSelfContained', () => {
  it('accepts inline and data: subresources, and the favicon', () => {
    expect(() =>
      assertSelfContained(
        `${FAVICON_LINK}<img src="data:image/png;base64,AA"/><a href="https://example.org">x</a>`,
      ),
    ).not.toThrow()
  })

  // The transforms above only fix breakages we have already seen. This
  // is what catches the next one.
  it.each([
    ['a script', '<script src="https://cdn.example.org/a.js"></script>'],
    ['a stylesheet', '<link rel="stylesheet" href="/assets/app.css"/>'],
    ['an image', '<img src="/some-new-asset.svg"/>'],
    ['a CSS url()', '<style>body{background:url(/bg.png)}</style>'],
  ])('rejects %s the page would have to fetch', (_label, markup) => {
    expect(() => assertSelfContained(markup)).toThrow(/self-contained/)
  })

  it('does not mistake a link for a subresource', () => {
    expect(() =>
      assertSelfContained('<a href="https://github.com/x/y/blob/main/docs/SELF_HOSTING.md">d</a>'),
    ).not.toThrow()
  })
})

describe('assertValidatorsImplemented', () => {
  const field = (validator: string) =>
    [{ validator, id: 'X' }] as unknown as typeof WORKSHEET

  it('passes when the inline script defines the validator', () => {
    expect(() =>
      assertValidatorsImplemented(field('emailDomainList'), 'const V = { emailDomainList: v => null }'),
    ).not.toThrow()
  })

  // The second export dropped exactly this one. Unnoticed, the field
  // accepts any input at all.
  it('fails when it does not', () => {
    expect(() => assertValidatorsImplemented(field('emailDomainList'), 'const V = {}')).toThrow(
      /emailDomainList/,
    )
  })
})

describe('the committed public/setup.html', () => {
  it('is self-contained', () => {
    expect(() => assertSelfContained(html())).not.toThrow()
  })

  it('implements every validator its worksheet names', () => {
    expect(() => assertValidatorsImplemented(WORKSHEET, html())).not.toThrow()
  })

  it('tags every doc link so the runtime can retarget it', () => {
    const page = html()
    // 15 phases + the two standing references.
    expect((page.match(/data-doc="/g) ?? []).length).toBeGreaterThanOrEqual(17)
    expect(page).toContain('terraviz-setup-console-v1')
  })

  // The plan chooser offers Free as a supported choice, so the sheet
  // must not then list "Enable Workers Paid" as task one. Asserted on
  // the built page because the sheet lives in render.ts, which the
  // next design export replaces wholesale.
  it('offers a free-plan variant of the Workers Paid prerequisite', () => {
    const page = html()
    expect(page).toContain('data-when="paid"')
    expect(page).toContain('data-when="free"')
    // Both variants present means the row count is stable across plans.
    expect((page.match(/Workers Paid/g) ?? []).length).toBeGreaterThanOrEqual(2)
  })

  // The page used to drop the Analytics Engine dataset (W9) and the
  // ANALYTICS binding whenever the reader chose Free, believing
  // Analytics Engine to be paid-only. It is not — Workers Free
  // includes 100,000 data points a day, and every other product this
  // node binds has a free allocation too.
  //
  // An operator who skips a resource on that advice gets a node that
  // provisions clean and then fails at Phase 8 with a binding pointing
  // at nothing. Plan may change wording, which is what data-when is
  // for; it must never change which resources exist.
  it('hides nothing by plan', () => {
    expect(html()).not.toContain('data-paid-only')
  })

  /**
   * The two names the Cloudflare dialog asks for, on the built page.
   *
   * An operator hit `Failed to publish your Function. You need to
   * enable Analytics Engine.` at the Phase 8.8 deploy — a hard stop,
   * with nothing earlier in the install mentioning the product. The
   * dashboard then asks for a Dataset Name and a Dataset Binding, and
   * both are fixed by the code rather than free choices: `ingest.ts`
   * writes through `env.ANALYTICS`, and the Grafana dashboards and the
   * export pipeline read `terraviz_events`.
   *
   * Guessing either one produces a node that deploys and silently
   * drops every telemetry write, which is the failure the whole
   * bindings audit exists to prevent. Asserted on the built page
   * because the prerequisite renders through render.ts, and a name is
   * exactly the kind of literal a design export overwrites without
   * anyone noticing.
   */
  it('names the Analytics Engine dataset and binding the dialog asks for', () => {
    const page = html()
    expect(page).toContain('terraviz_events')
    expect(page).toContain('ANALYTICS')
    // Paired, not merely both present somewhere on a 380 KB page.
    expect(page).toMatch(/Dataset Name\s+terraviz_events\s*\n\s*Dataset Binding\s+ANALYTICS/)
  })

  // The specific wrong claim, in the words it shipped in.
  it('does not claim Analytics Engine is unavailable on the free plan', () => {
    const page = html()
    expect(page).not.toMatch(/Analytics Engine is not on the free plan/i)
    expect(page).not.toMatch(/no Analytics Engine (dataset )?to (point|write)/i)
    expect(page).not.toMatch(/give up Analytics Engine/i)
  })

  // A reader totting up Cloudflare line items concludes the node is
  // nearly free and is right — while missing that transcode is real
  // CPU work on GitHub's runners, free only while the fork is public.
  it('says where the compute happens and what it costs', () => {
    const page = html()
    expect(page).toContain('not on your Cloudflare bill')
    expect(page).toContain('transcode-hls')
    // Quoted, not paraphrased — it is someone else's policy.
    expect(page).toContain('free for self-hosted runners and for public repositories')
    expect(page).toContain('any other activity unrelated to the production')
  })

  // Markup passed through an escaping helper reaches the reader as
  // literal '<span data-when="free">…' text, and never toggles,
  // because an escaped tag is not an element. It shipped that way in
  // the Workers AI card and only surfaced when a readability scan
  // reported the tags as prose.
  it('never renders escaped markup as visible text', () => {
    const page = html()
    for (const leaked of ['&lt;span', '&lt;div', '&lt;a ', '&lt;p&gt;']) {
      expect(page, `${leaked} is being shown to the reader as text`).not.toContain(leaked)
    }
  })

  // The sheet's two link labels were hardcoded to "Cloudflare", which
  // was true of every manual step until the fork step, which points at
  // GitHub. Naming the wrong product is a small lie in the one place
  // someone new to the platform is trusting this page.
  it('never labels a GitHub link as Cloudflare', () => {
    const page = html()
    for (const m of page.matchAll(/<a href="(https:\/\/[^"]+)"[^>]*>([^<]*)<\/a>/g)) {
      const [, href, label] = m
      if (/^https:\/\/(www\.)?(github|docs\.github)\.com\//.test(href)) {
        expect(label, `${href} labelled "${label}"`).not.toMatch(/cloudflare/i)
      }
    }
  })

  it('labels the fork step by its actual destination', () => {
    const page = html()
    expect(page).toContain('Open on GitHub')
    expect(page).toContain("GitHub's docs for this")
    // The Cloudflare steps keep their own wording.
    expect(page).toContain('Open in the Cloudflare dashboard')
    expect(page).toContain("Cloudflare's docs for this")
  })

  // CodeQL flagged the first spelling of this (endsWith) as incomplete
  // URL substring sanitization. Not reachable — every URL here is a
  // constant — but a predicate that answers "is this GitHub?" wrongly
  // should not survive on the grounds that its callers happen to be
  // safe.
  it('matches a host by label boundary, not by suffix', () => {
    expect(actionLabel('https://github.com/x/y')).toBe('Open on GitHub')
    expect(actionLabel('https://docs.github.com/x')).toBe('Open on GitHub')
    expect(docsLabel('https://developers.cloudflare.com/x')).toBe(
      "Cloudflare's docs for this",
    )
    // The whole point: a lookalike host must not borrow the label.
    for (const bad of [
      'https://evilgithub.com/x',
      'https://notcloudflare.com/x',
      'https://github.com.attacker.example/x',
      'https://cloudflare.com.attacker.example/x',
    ]) {
      expect(actionLabel(bad), bad).toBe('Open this page')
      expect(docsLabel(bad), bad).toBe('Documentation for this')
    }
    // A value that is not a URL at all falls back rather than throwing.
    expect(actionLabel('not a url')).toBe('Open this page')
  })

  // Four values in this install are shown exactly once. The sheet
  // already said so at each field; what it did not do was say it
  // before the reader started, which is the only point at which
  // "have somewhere to put this" is actionable.
  it('warns about one-time secrets before the first step', () => {
    const page = html()
    const sheet = page.slice(page.indexOf('only you can do these'))
    expect(sheet.slice(0, 2000)).toMatch(/password manager/i)
  })

  // The worksheet lived behind a floating button and someone
  // installing did not notice it, so every later command kept its
  // amber placeholder and the Copy buttons handed out unrunnable
  // commands. Each produced value now also has an input at the end of
  // the phase that produces it.
  it('asks for each value where the phase produces it', () => {
    const page = html()
    expect(page).toContain('Write these down before you move on')
    // Two controls per produced value: the drawer, and the phase.
    for (const id of ['W4', 'W10', 'W12']) {
      expect(
        (page.match(new RegExp(`data-field="${id}"`, 'g')) ?? []).length,
        `${id} should have a drawer input and a phase input`,
      ).toBe(2)
    }
  })

  // Two inputs for one value are worse than one if they disagree.
  it('paints every input for a field, not just the first', () => {
    const page = html()
    expect(page).toContain(`q('[data-field="' + f.id + '"]').forEach`)
    expect(page).toMatch(/paintProgress\(\); paintInputs\(\);/)
  })

  // The sheet's blurb described "on the left... on the right" long
  // after the layout became two stacked lists, each internally two
  // columns — the `data-sheetgrid` wrapper it referred to had no CSS
  // rule anywhere, in print or on screen. A reader following that
  // description looks for a column that is not there.
  it('does not describe a left/right split it does not have', () => {
    const page = html()
    expect(page).not.toMatch(/On the left,[\s\S]{0,120}?On the right,/)
    expect(page).not.toContain('data-sheetgrid')
  })

  // Someone installing worked the checklist and stopped, because
  // nothing on the sheet said the real instructions were below it.
  it('hands the reader off to the phases', () => {
    const page = html()
    expect(page).toContain('This sheet is the map, not the instructions')
    expect(page).toContain('href="#p0"')
    expect(page).toContain('id="p0"')
  })

  // The four ways to invoke setup were one copyable block, which reads
  // as a script: Copy handed you all four, and pasting them runs
  // --manual, then blocks on --interactive, then plans, then applies.
  // They are alternatives. One command per block means whatever you
  // copy is the whole of what you meant to run.
  it('does not present the setup invocations as one runnable block', () => {
    const page = html()
    expect(page).toContain('These are alternatives, not a sequence')
    for (const pre of page.match(/<pre[^>]*>[\s\S]*?<\/pre>/g) ?? []) {
      const runs = (pre.match(/npm run setup/g) ?? []).length
      expect(runs, `a single block offers ${runs} setup invocations`).toBeLessThan(2)
    }
  })

  it('carries the CSP and the real favicon', () => {
    expect(html()).toContain(CSP_META)
    expect(html()).toContain(FAVICON_LINK)
  })

  // Losing this is how the page stops tracking the palette. The alias
  // names were verified against src/styles/tokens.css; a token that
  // does not exist there resolves to its literal forever, silently.
  it('inlines the token aliases', () => {
    expect(html()).toContain('--tv-accent:')
    for (const token of TOKEN_ALIASES.matchAll(/var\((--color-[a-z-]+),/g)) {
      expect(
        readFileSync(resolve(__dirname, '../../src/styles/tokens.css'), 'utf8'),
        `${token[1]} is aliased but not defined in tokens.css`,
      ).toContain(`${token[1]}:`)
    }
  })

  // The interview asks for it; without a worksheet field claiming it,
  // crossCheck 2 fails the build. Asserted on the output too, because
  // that check lives in a file the next export replaces.
  it('renders a field for every value the interview asks for', () => {
    expect(html()).toContain('data-field="TRUST"')
  })
})
