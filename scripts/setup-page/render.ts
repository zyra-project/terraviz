/**
 * Renders `public/setup.html` from the setup tool's own modules plus
 * the editorial content in `content.ts`.
 *
 * ## The invariant
 *
 * Everything factual on the page is derived from the same exports
 * `npm run setup` and `npm run check:pages-bindings` use. The page
 * cannot claim a binding the audit does not check, cannot omit one it
 * does, and cannot describe a prerequisite the tool has since learned
 * to detect. `crossCheck()` turns each of those into a build failure
 * rather than a documentation bug.
 *
 * Agreeing with `SELF_HOSTING.md` would be the weaker guarantee. The
 * failure operators actually hit is "the guide says one thing, the
 * tool does another", and only this direction rules it out.
 *
 * ## No stylesheet dependency
 *
 * Design tokens are inlined at build time from `src/styles/tokens.css`
 * rather than linked. A setup page is what someone reads *while the
 * deploy is broken* — it has to render when the SPA bundle does not.
 * Inlining tracks the palette and keeps the page self-contained; the
 * privacy page makes the same trade for the same reason.
 */

import { EXPECTED_BINDINGS, type ExpectedBinding } from '../lib/expected-bindings'
import { QUESTIONS, MANUAL_STEPS, type ManualStep } from '../lib/setup/interview'
import { DEFAULT_NAMES } from '../lib/setup/state'
import { STAFF_POLICY_NAME, AUTOMATION_POLICY_NAME } from '../lib/setup/access'
import { UPSTREAM_PINNED_IDS } from '../lib/setup/wrangler-toml'
import { NODE_DOWNLOAD_URL, requiredNodeLabel } from '../lib/node-version'
import { CHECKED_ON, D1_PRICING, freeVideoDatasets, GITHUB_ACTIONS, R2_PRICING, REFERENCE_NODE } from './pricing'
import { headerFor } from '../check-license-headers'
import { actionLabel, docsLabel } from './shell'
import {
  PHASES,
  WORKSHEET,
  ORIGIN_LABELS,
  ADDONS,
  TROUBLESHOOTING,
  WEEK_ONE,
  MAP_READINGS,
  TIERS,
  MARKDOWN_URL,
  type Phase,
  type Callout,
  type CodeBlock,
  type WorksheetField,
  type ValidatorName,
} from './content'

/**
 * The sidebar mark, inlined rather than linked.
 *
 * This page's whole premise is that it still works when the deploy
 * does not — read off a laptop, off a checkout, off a broken
 * preview. An `<img src="/...">` breaks under `file://` and under any
 * host that does not serve the SPA root, which is precisely the
 * situation someone is in when they open it.
 *
 * Gradient and clip-path ids are prefixed `tvg-` because SVG ids
 * share the document namespace once inlined.
 */
const GLOBE_MARK = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="26" height="26" aria-hidden="true" focusable="false" style="display:block;flex:none"><defs><radialGradient id="tvg-sphere" cx="40%" cy="35%" r="50%"><stop offset="0%" stop-color="#4FC3F7"></stop><stop offset="60%" stop-color="#1565C0"></stop><stop offset="100%" stop-color="#0D2137"></stop></radialGradient><radialGradient id="tvg-shine" cx="35%" cy="30%" r="45%"><stop offset="0%" stop-color="white" stop-opacity="0.3"></stop><stop offset="100%" stop-color="white" stop-opacity="0"></stop></radialGradient><clipPath id="tvg-clip"><circle cx="16" cy="16" r="14.08"></circle></clipPath></defs><circle cx="16" cy="16" r="14.72" fill="#0a1628"></circle><circle cx="16" cy="16" r="14.08" fill="url(#tvg-sphere)"></circle><g clip-path="url(#tvg-clip)" fill="none" stroke="rgba(255,255,255,0.15)" stroke-width="1"><ellipse cx="16" cy="16" rx="14.08" ry="1.92"></ellipse><ellipse cx="16" cy="10.56" rx="11.2" ry="1.6"></ellipse><ellipse cx="16" cy="21.44" rx="11.2" ry="1.6"></ellipse><ellipse cx="16" cy="16" rx="1.92" ry="14.08"></ellipse><ellipse cx="11.84" cy="16" rx="1.28" ry="13.44"></ellipse><ellipse cx="20.16" cy="16" rx="1.28" ry="13.44"></ellipse></g><g clip-path="url(#tvg-clip)" fill="rgba(76,175,80,0.5)" stroke="none"><path d="M12.16 7.04 Q13.44 8 12.8 10.24 Q11.52 11.52 12.16 12.8 Q13.44 15.36 12.16 17.6 Q11.2 19.84 11.84 22.4 Q11.2 20.8 10.56 18.56 Q10.24 16 10.88 13.44 Q10.56 11.2 11.2 8.96 Z"></path><path d="M16.64 8 Q17.92 8.96 18.56 10.88 Q19.2 12.8 18.24 15.36 Q17.6 17.6 17.92 19.84 Q17.28 18.56 16.96 16 Q16.64 13.44 17.28 10.88 Q16.64 9.6 16 8.64 Z"></path></g><circle cx="16" cy="16" r="14.08" fill="url(#tvg-shine)"></circle><circle cx="16" cy="16" r="14.08" fill="none" stroke="rgba(255,255,255,0.12)" stroke-width="1"></circle></svg>`

/**
 * The validators `runtime()` defines on its inline `V` object. Kept
 * beside the checks rather than derived from the generated string:
 * parsing our own output to find out what we emitted would be a
 * fragile way to learn something we already know.
 */
const INLINE_VALIDATORS: ReadonlySet<ValidatorName> = new Set([
  'accountId',
  'aud',
  'hostname',
  'emailDomain',
  'emailDomainList',
  'url',
  'repoSlug',
  'projectName',
])

// ── Cross-checks ──────────────────────────────────────────────────

export class ContentDriftError extends Error {
  constructor(problems: string[]) {
    super(
      'The /setup page content has drifted from the setup tool:\n\n' +
        problems.map(p => `  • ${p}`).join('\n') +
        '\n\nFix scripts/setup-page/content.ts, then re-run `npm run build:setup-page`.\n',
    )
    this.name = 'ContentDriftError'
  }
}

/**
 * Every check here encodes a way the page could quietly become wrong.
 * They run on every build, so a change to the tool that the page has
 * not caught up with fails CI instead of shipping.
 */
export function crossCheck(): void {
  const problems: string[] = []

  // 1. Every binding the audit checks must be presentable. The page
  //    renders EXPECTED_BINDINGS directly, so this only catches a
  //    binding whose name no worksheet field or phase explains.
  const explained = new Set<string>([
    ...WORKSHEET.map(w => w.label),
    ...WORKSHEET.map(w => w.id),
  ])
  const unexplained = EXPECTED_BINDINGS.filter(
    b => !explained.has(b.name) && !b.hint,
  ).map(b => b.name)
  if (unexplained.length) {
    problems.push(
      `bindings with neither a hint nor a worksheet entry: ${unexplained.join(', ')}`,
    )
  }

  // 2. Every value the interview asks for must appear on the
  //    worksheet, or the page understates what an operator supplies.
  const asked = new Set(QUESTIONS.map(q => q.key))
  const mapped = new Set(WORKSHEET.filter(w => w.fromTool).map(w => w.fromTool!))
  for (const key of asked) {
    if (!mapped.has(key)) {
      problems.push(`interview asks for "${key}" but no worksheet field claims it`)
    }
  }
  for (const key of mapped) {
    if (!asked.has(key)) {
      problems.push(
        `worksheet maps a field to "${key}", which the interview no longer asks for`,
      )
    }
  }

  // 3. Secret worksheet fields must never be persisted. This mirrors
  //    the rule SetupState enforces on the tool side.
  const persisted = WORKSHEET.filter(w => w.secret && w.origin === 'default')
  if (persisted.length) {
    problems.push(
      `secret fields cannot have origin "default": ${persisted.map(w => w.id).join(', ')}`,
    )
  }

  // 4. The dependency map's ordering invariant — the whole reason the
  //    phases are numbered as they are. A value may not be consumed
  //    before the phase that produces it.
  for (const w of WORKSHEET) {
    const early = w.consumedBy.filter(n => n < w.phase)
    if (early.length) {
      problems.push(
        `${w.id} is produced in phase ${w.phase} but consumed in ${early.join(', ')}`,
      )
    }
  }

  // 5. Phase numbering must be dense and ordered, or the nav and the
  //    map disagree about what "later" means.
  PHASES.forEach((p, i) => {
    if (p.n !== i) problems.push(`phase at index ${i} is numbered ${p.n}`)
  })

  // 6. Manual steps the tool can now detect should not be presented
  //    as operator self-certification.
  //
  //    Stated as a majority rather than a fixed count, which is what
  //    the message always claimed. The old threshold was 3, calibrated
  //    when there were 7 steps; at 10 it would have capped the list
  //    rather than caught a drift in its character, and a guard that
  //    fires on growth teaches people to bump the number.
  const selfCertified = MANUAL_STEPS.filter(s => s.verification === 'self')
  if (selfCertified.length * 2 >= MANUAL_STEPS.length) {
    problems.push(
      `${selfCertified.length} of ${MANUAL_STEPS.length} manual steps are self-certified — ` +
        "the page's pre-flight sheet assumes most are detected; re-read the copy " +
        'before shipping',
    )
  }

  // 7. Every validator a worksheet field names must exist in the
  //    page's inline script. Behaviour still cannot be compared across
  //    the module boundary, but a field pointing at a validator the
  //    browser does not have would silently accept anything — the one
  //    failure mode of this seam that costs nothing to close.
  const missingValidators = [
    ...new Set(
      WORKSHEET.map(w => w.validator).filter(
        (v): v is NonNullable<typeof v> => Boolean(v),
      ),
    ),
  ].filter(v => !INLINE_VALIDATORS.has(v))
  if (missingValidators.length) {
    problems.push(
      `worksheet fields name validators the inline script does not implement: ` +
        `${missingValidators.join(', ')} (add them to V in runtime(), and to INLINE_VALIDATORS)`,
    )
  }

  if (problems.length) throw new ContentDriftError(problems)
}

// ── Escaping and small helpers ────────────────────────────────────

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/**
 * `**bold**`, `*italic*`, `` `code` ``, `[text](href)` → HTML,
 * escaped first. Inputs are ours.
 *
 * Links are part of the vocabulary because they have to be: without
 * them, an author writing `<a href="#cost">` gets it escaped and the
 * reader sees the raw tag. That shipped twice — in the Workers AI card
 * and in the install sheet's "see what it costs" — and neither was a
 * broken link so much as markup printed at the reader.
 *
 * The href allowlist is `#anchor` and `https://` only. This content is
 * ours rather than user input, so it is belt-and-braces, but an
 * unconstrained href built by string replacement is precisely the sink
 * CodeQL flagged elsewhere on this page and it costs nothing to shut.
 */
function inline(s: string): string {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code style="font-family:var(--tv-font-mono);font-size:.92em;background:var(--tv-surface-3);padding:1px 5px;border-radius:3px">$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b style="font-weight:600;color:var(--tv-text)">$1</b>')
    .replace(/\*([^*]+)\*/g, '<i>$1</i>')
    .replace(/\[([^\]]+)\]\((#[\w-]+|https:\/\/[^)\s"']+)\)/g, (_m, text: string, href: string) =>
      `<a href="${href}">${text}</a>`,
    )
}

/** Substitution tokens survive escaping and are replaced at runtime. */
function withSlots(s: string): string {
  return inline(s).replace(/\{\{(\w+)\}\}/g, (_, id) => slot(id))
}

function slot(id: string): string {
  return `<span data-slot="${esc(id)}" data-w="${esc(id)}" style="cursor:pointer;padding:1px 5px;border-radius:3px"></span>`
}

const CODE_WRAP =
  'position:relative;margin:0 0 14px'
const PRE =
  'margin:0;background:var(--tv-surface-code);border:1px solid var(--tv-border);color:var(--tv-text-muted);font:400 12.5px/1.8 var(--tv-font-mono);padding:36px 16px 15px;border-radius:6px;overflow-x:auto'
const COPY_BTN =
  "position:absolute;top:7px;right:8px;background:rgba(255,255,255,.07);color:var(--tv-text-dim);border:1px solid var(--tv-border-strong);border-radius:3px;font:500 10px/1 var(--tv-font-sans);letter-spacing:.08em;text-transform:uppercase;padding:5px 8px;cursor:pointer"

/** Renders a code block, dimming `#` comments and wiring slots. */
function code(block: CodeBlock): string {
  const lines = block.code.split('\n').map(line => {
    const m = /^(.*?)(\s*#.*)$/.exec(line)
    const body = m ? m[1] : line
    const comment = m ? m[2] : ''
    return (
      withSlots(body) +
      (comment ? `<span style="color:var(--tv-text-dim)">${esc(comment)}</span>` : '')
    )
  })
  return `<div style="${CODE_WRAP}">
  <pre style="${PRE}">${lines.join('\n')}</pre>
  <button data-copy="1" style="${COPY_BTN}">Copy</button>
</div>`
}

const CALLOUT_STYLE: Record<Callout['kind'], { bg: string; border: string; accent: string }> = {
  trap: { bg: 'var(--tv-error-bg)', border: 'var(--tv-error-border)', accent: 'var(--tv-error)' },
  note: { bg: 'var(--tv-warn-bg)', border: 'var(--tv-warn-border)', accent: 'var(--tv-warn)' },
  gate: { bg: 'var(--tv-accent-bg)', border: 'var(--tv-accent-border)', accent: 'var(--tv-accent)' },
}

const CALLOUT_LABEL: Record<Callout['kind'], string> = {
  trap: 'Trap',
  note: 'Worth knowing',
  gate: 'How it works',
}

function callout(c: Callout): string {
  const s = CALLOUT_STYLE[c.kind]
  return `<div style="background:${s.bg};border:1px solid ${s.border};border-left:3px solid ${s.accent};border-radius:6px;padding:15px 17px;margin:0 0 16px">
  <div style="font:600 10.5px/1.35 var(--tv-font-sans);letter-spacing:.13em;text-transform:uppercase;color:${s.accent};margin:0 0 8px">${esc(CALLOUT_LABEL[c.kind])} · ${esc(c.title)}</div>
  ${c.body.map(p => `<p style="margin:0 0 10px;font-size:13.5px;line-height:1.55;color:var(--tv-text-muted);text-wrap:pretty">${withSlots(p)}</p>`).join('\n  ')}
  ${c.code ? code(c.code) : ''}
</div>`
}

function isCallout(x: unknown): x is Callout {
  return typeof x === 'object' && x !== null && 'kind' in x
}
function isCode(x: unknown): x is CodeBlock {
  return typeof x === 'object' && x !== null && 'code' in x && !('kind' in x)
}

// ── Sections ──────────────────────────────────────────────────────

const CARD =
  'background:var(--tv-surface-2);border:1px solid var(--tv-border);border-radius:8px'
const EYEBROW =
  'font:600 10.5px/1.35 var(--tv-font-sans);letter-spacing:.13em;text-transform:uppercase;color:var(--tv-text-dim)'

/**
 * The cost panel.
 *
 * `MANUAL_STEPS` presents Workers Paid as a flat prerequisite, which is
 * how the tool needs to treat it — but it is the one prerequisite an
 * operator can decline, and both things they lose were deliberately
 * built to fail soft. For a small museum a recurring card charge can
 * be more friction than a day of staff time, so the free path is named
 * here rather than left implicit.
 */
/**
 * The compute, which is not Cloudflare's at all.
 *
 * A reader totting up Cloudflare line items will conclude the node is
 * nearly free and be right — while missing that transcoding video and
 * running Zyra pipelines is real CPU work happening somewhere else
 * entirely, on GitHub's runners. Worth naming, both because the
 * subsidy is real and because it comes with a condition.
 */
function computePanel(): string {
  return `<div style="background:var(--tv-surface-2);border:1px solid var(--tv-border);border-radius:8px;padding:22px 24px;margin:0 0 22px">
  <div style="${EYEBROW};margin:0 0 10px">Compute · not on your Cloudflare bill</div>
  <p style="margin:0 0 14px;max-width:68ch;font-size:13.5px;line-height:1.6;color:var(--tv-text-muted);text-wrap:pretty">Transcoding a video into its HLS ladder, and running a Zyra pipeline to build a data-encoded dataset, are the heaviest things your node does — and Cloudflare never sees them. They run as GitHub Actions in <em>your</em> repository, fired by the publisher API: <code style="font-family:var(--tv-font-mono);font-size:.92em">transcode-hls</code>, <code style="font-family:var(--tv-font-mono);font-size:.92em">zyra-run</code>, and the scheduled feed, analytics and refresh jobs.</p>

  <p style="margin:0 0 14px;padding:12px 14px;background:rgba(34,197,94,.07);border:1px solid rgba(34,197,94,.24);border-left:3px solid var(--tv-success);border-radius:6px;max-width:68ch;font-size:13px;line-height:1.6;color:var(--tv-text-muted);text-wrap:pretty"><strong style="color:var(--tv-text)">Keep your fork public and that compute is free.</strong> GitHub's billing docs put it plainly: <em>"GitHub Actions usage is free for self-hosted runners and for public repositories that use standard GitHub-hosted runners."</em> An open-source node pays nothing for transcode. A <strong>private</strong> fork draws on your account's monthly Actions minutes instead, which is the one configuration where this stops being free.</p>

  <p style="margin:0 0 14px;max-width:68ch;font-size:13px;line-height:1.6;color:var(--tv-text-muted);text-wrap:pretty"><strong style="color:var(--tv-text)">Within reason, though.</strong> GitHub's terms limit Actions to work connected to the repository it runs in — excluding <em>"any other activity unrelated to the production, testing, deployment, or publication of the software project associated with the repository."</em> Building and publishing your own node's datasets sits inside that. Pointing the runners at unrelated batch compute does not, and GitHub monitors for it. Jobs also stop hard at ${GITHUB_ACTIONS.jobLimitDays} days, and a free account runs at most ${GITHUB_ACTIONS.concurrentJobsFree} standard jobs at once.</p>

  <p style="margin:0;font-size:11.5px;line-height:1.5;color:var(--tv-text-dim)">If your pipelines outgrow that — or you would rather not lean on it — self-hosted runners are free too, and you supply the hardware. Read on ${esc(CHECKED_ON)}: <a href="${GITHUB_ACTIONS.billingDocs}">billing</a> · <a href="${GITHUB_ACTIONS.limitsDocs}">limits</a> · <a href="${GITHUB_ACTIONS.termsDocs}">terms</a>.</p>
</div>`
}

/**
 * Storage, which both plans are billed for identically.
 *
 * The cost panel used to file "storage is billed on top" under Workers
 * Paid, which left the free column reading as an unqualified $0. R2 is
 * charged the same either way, so a free-plan operator publishing a
 * few hundred hours of video had no idea a bill was coming. Its own
 * section, outside the two columns, is the only honest place for it.
 */
function storagePanel(): string {
  const usd = (n: number): string => (n < 10 ? n.toFixed(2) : Math.round(n).toString())
  const row = (label: string, free: string, beyond: string): string =>
    `<div style="display:contents"><div style="padding:9px 0;border-top:1px solid var(--tv-border);font:500 13px/1.4 var(--tv-font-sans);color:var(--tv-text)">${label}</div><div style="padding:9px 0;border-top:1px solid var(--tv-border);font-size:12.5px;color:var(--tv-text-muted)">${inline(free)}</div><div style="padding:9px 0;border-top:1px solid var(--tv-border);font-size:12.5px;color:var(--tv-text-muted)">${inline(beyond)}</div></div>`

  return `<div style="background:var(--tv-surface-2);border:1px solid var(--tv-border);border-radius:8px;padding:22px 24px;margin:0 0 22px">
  <div style="${EYEBROW};margin:0 0 10px">Storage · the same on both plans</div>
  <p style="margin:0 0 16px;max-width:66ch;font-size:13.5px;line-height:1.6;color:var(--tv-text-muted);text-wrap:pretty">This is the part that is easy to miss: R2 and D1 bill identically whether or not you pay the $5. Both have a free allowance, and for most nodes that allowance is the whole story — a catalog of metadata, images and tours does not come close to it. Publishing your own <em>video</em> is the only thing that moves it. The free ${R2_PRICING.freeStorageGb} GB holds roughly <strong>${freeVideoDatasets()} video datasets</strong>; past that it is still cents rather than a budget line.</p>

  <p style="margin:0 0 16px;padding:12px 14px;background:var(--tv-accent-bg);border:1px solid var(--tv-accent-border);border-radius:6px;max-width:70ch;font-size:13px;line-height:1.6;color:var(--tv-text-muted);text-wrap:pretty"><strong style="color:var(--tv-text)">A real number, not a model.</strong> This project's own node publishes ${REFERENCE_NODE.datasets} datasets, ${REFERENCE_NODE.videoDatasets} of them video, and stores ${REFERENCE_NODE.storedGb} GB in R2. Its Cloudflare bill for that storage is <strong style="color:var(--tv-text)">$${REFERENCE_NODE.monthlyUsd} a month</strong> — ${REFERENCE_NODE.billedGbMonth} GB-month after the free ${R2_PRICING.freeStorageGb} GB. Every operations line on the same invoice was $0.00. The estimate below is that measurement scaled, not a formula.</p>

  <div style="display:grid;grid-template-columns:minmax(0,1.1fr) minmax(0,1fr) minmax(0,1.2fr);gap:0 20px;margin:0 0 18px">
    <div style="${EYEBROW};font-size:9px;padding-bottom:7px">What</div>
    <div style="${EYEBROW};font-size:9px;padding-bottom:7px">Free every month</div>
    <div style="${EYEBROW};font-size:9px;padding-bottom:7px">Past that</div>
    ${row('R2 — video, images, tours', `${R2_PRICING.freeStorageGb} GB stored`, `$${R2_PRICING.storagePerGbMonth}/GB per month`)}
    ${row('R2 — serving it to visitors', 'unmetered', '**egress is free** — no per-GB charge, ever')}
    ${row('R2 — requests', `${R2_PRICING.freeClassB / 1_000_000}M reads, ${R2_PRICING.freeClassA / 1_000_000}M writes`, `$${R2_PRICING.classBPerMillion}/M reads`)}
    ${row('D1 — catalog metadata', `${D1_PRICING.freePlanStorageGb} GB`, `$${D1_PRICING.paidStoragePerGbMonth}/GB per month (paid plan only)`)}
  </div>

  <div style="background:var(--tv-surface-code);border:1px solid var(--tv-border);border-radius:6px;padding:16px 18px">
    <label for="cost-count" style="display:block;font:500 13px/1.4 var(--tv-font-sans);color:var(--tv-text);margin:0 0 10px">How many <strong>video</strong> datasets do you expect to publish?</label>
    <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin:0 0 10px">
      <input id="cost-count" data-cost-count type="range" min="0" max="1000" step="10" value="${REFERENCE_NODE.videoDatasets}" style="flex:1 1 220px;accent-color:var(--tv-accent)"/>
    </div>
    <output data-cost-out style="display:block;font:600 14px/1.5 var(--tv-font-mono);color:var(--tv-accent)"></output>
    <p data-cost-note style="margin:8px 0 0;font-size:12.5px;line-height:1.55;color:var(--tv-text-dim);text-wrap:pretty"></p>
    <p style="margin:10px 0 0;font-size:11.5px;line-height:1.5;color:var(--tv-text-dim)">Storage only, and an order of magnitude rather than a quote — real transcode output swings with resolution and motion. Scaled from a measured node at ${(REFERENCE_NODE.storedGb / REFERENCE_NODE.videoDatasets).toFixed(2)} GB per video dataset — yours will differ with clip length and resolution. Requests are left out because the reference node runs at 2% of the free Class A allowance and 4% of Class B. Rates read from Cloudflare on ${esc(CHECKED_ON)}: <a href="https://developers.cloudflare.com/r2/pricing/">R2</a> · <a href="https://developers.cloudflare.com/d1/platform/pricing/">D1</a>. They change; those pages are authoritative, this one is a copy.</p>
  </div>
</div>`
}

function costPanel(): string {
  const col = (
    plan: 'free' | 'paid',
    label: string,
    price: string,
    accent: string,
    items: Array<[string, string]>,
  ): string => `<button data-plan="${plan}" style="text-align:left;cursor:pointer;border-radius:6px;padding:20px 22px;font-family:var(--tv-font-sans)">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;margin:0 0 16px">
        <span style="display:flex;align-items:center;gap:9px">
          <span data-plan-tick="${plan}" style="flex:none;width:16px;height:16px;border-radius:50%;border:1.5px solid;display:flex;align-items:center;justify-content:center;font:600 9px/1 var(--tv-font-sans)"></span>
          <span style="font:600 10.5px/1.35 var(--tv-font-sans);letter-spacing:.13em;text-transform:uppercase;color:${accent}">${esc(label)}</span>
        </span>
        <span style="font:500 12px/1 var(--tv-font-mono);color:var(--tv-text-dim)">${esc(price)}</span>
      </div>
      ${items
        .map(
          ([t, b], i) => `<div style="margin:0 0 ${i === items.length - 1 ? '0' : '14px'}">
        <div style="font:600 13.5px/1.4 var(--tv-font-sans);color:var(--tv-text);margin:0 0 5px">${esc(t)}</div>
        <p style="margin:0;font-size:13px;line-height:1.55;color:var(--tv-text-muted);text-wrap:pretty">${inline(b)}</p>
      </div>`,
        )
        .join('\n      ')}
    </button>`

  /**
   * `inline()` escapes its input, so plan-conditional markup passed
   * inside the body string was rendered to the reader as literal
   * `<span data-when="free">…` text — and never toggled, because an
   * escaped tag is not an element. Taking the two variants as data and
   * building the spans here keeps the escaping honest for the prose
   * while letting the markup be markup.
   */
  const aiCard = (
    id: 'workers' | 'local',
    title: string,
    body: string,
    perPlan?: { free: string; paid: string },
  ): string => `<button data-ai="${id}" style="text-align:left;cursor:pointer;border-radius:6px;padding:18px 20px;font-family:var(--tv-font-sans)">
      <div style="font:600 14px/1.3 var(--tv-font-sans);color:var(--tv-text);margin:0 0 6px">${esc(title)}</div>
      <p style="margin:0;font-size:13px;line-height:1.55;color:var(--tv-text-muted);text-wrap:pretty">${inline(body)}${
        perPlan
          ? ` <span data-when="free">${inline(perPlan.free)}</span><span data-when="paid">${inline(perPlan.paid)}</span>`
          : ''
      }</p>
    </button>`

  return `<section id="cost" data-noprint="1" style="${CARD};padding:28px 30px;margin:0 0 44px;scroll-margin-top:20px">
  <div style="${EYEBROW};margin:0 0 12px">What it costs</div>
  <h2 style="font:700 27px/1.2 var(--tv-font-sans);letter-spacing:-.01em;color:var(--tv-text);margin:0 0 12px">You can run this on the free plan</h2>
  <p style="margin:0 0 22px;max-width:64ch;color:var(--tv-text-muted);text-wrap:pretty">Nothing in the install requires a paid Cloudflare account, and nothing is switched off without one. What you get on the free plan is a smaller daily allowance of each thing. Orbit is the one that runs out first. Pick the plan you are on and the rest of the page adjusts to it.</p>
  <div style="display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:16px;margin:0 0 16px">
    ${col('free', 'Free plan', '$0', 'var(--tv-warn)', [
      [
        'Orbit throttles after ~200 conversations a day',
        'Workers AI gives you 10,000 Neurons daily and a docent turn costs about 50. Past that the chat panel shows a "Reduced functionality" badge and the quota resets overnight. This is the one ceiling you cannot buy past without upgrading.',
      ],
      [
        'Telemetry and search have room, but a lower ceiling',
        'Analytics Engine allows 100,000 data points a day, Vectorize 5 million stored vector dimensions — roughly 6,500 datasets. Both are generous at node scale. D1 stops at 5 GB, and on the free plan that is a hard cap rather than an overage.',
      ],
    ])}
    ${col('paid', 'Workers Paid', '$5/mo', 'var(--tv-accent)', [
      [
        'Orbit answers all day',
        'The Neuron allocation stops being a ceiling and becomes an allowance you pay past, at $0.011 per 1,000. The daily throttle goes away.',
      ],
      [
        'Nothing else changes',
        'Same install, same features, same catalog. Storage is billed the same way on both plans — see below.',
      ],
    ])}
  </div>

  <div style="${EYEBROW};margin:0 0 10px">Who runs Orbit's language model</div>
  <div style="display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:16px;margin:0 0 16px">
    ${aiCard('workers', 'Cloudflare Workers AI', 'Nothing to run or maintain — the \`AI\` binding is all it needs.', {
      free: 'Throttles after roughly 200 conversations a day on the free plan.',
      paid: 'Included in your $5.',
    })}
    ${aiCard('local', 'A model you run yourself', 'Ollama, LM Studio, or anything OpenAI-compatible on your own network. No throttle and no per-turn cost, whichever plan you are on — and visitor questions never leave your building.')}
  </div>

  <div data-when="local" style="background:rgba(34,197,94,.07);border:1px solid rgba(34,197,94,.24);border-left:3px solid var(--tv-success);border-radius:6px;padding:16px 18px;margin:0 0 18px">
    <div style="font:600 10.5px/1.35 var(--tv-font-sans);letter-spacing:.13em;text-transform:uppercase;color:var(--tv-success);margin:0 0 8px">You will need one extra thing</div>
    <p style="margin:0;font-size:13.5px;line-height:1.55;color:var(--tv-text-muted);text-wrap:pretty">Your model has to be reachable from Cloudflare's network, so a laptop on the museum wifi will not do — it needs a stable address. Phase 8 shows the variables to set, and the \`AI\` binding stays wired either way, because embeddings still use it.</p>
  </div>

  <div data-when="free" style="background:var(--tv-warn-bg);border:1px solid var(--tv-warn-border);border-left:3px solid var(--tv-warn);border-radius:6px;padding:16px 18px;margin:0 0 18px">
    <div style="font:600 10.5px/1.35 var(--tv-font-sans);letter-spacing:.13em;text-transform:uppercase;color:var(--tv-warn);margin:0 0 8px">Free plan · what changed on this page</div>
    <p style="margin:0;font-size:13.5px;line-height:1.55;color:var(--tv-text-muted);text-wrap:pretty">Nothing has been removed. Every product this node binds has a free allocation, so you install the same node and create the same resources — you just have less headroom on each. The one that runs out first is Orbit.</p>
  </div>
  ${storagePanel()}
  ${computePanel()}

  <p style="margin:0;max-width:64ch;font-size:13.5px;color:var(--tv-text-dim);text-wrap:pretty">For a gallery kiosk, a pilot, or a node you are still making your mind up about, free is a perfectly respectable place to run. Pay the $5 when you need to report on reach, or when Orbit is going to carry a busy public floor.</p>
</section>`
}

function tierPicker(): string {
  return `<section data-noprint="1" style="margin:0 0 44px">
  <div style="${EYEBROW};margin:0 0 12px">Step one · pick your node type</div>
  <p style="margin:0 0 16px;max-width:62ch;color:var(--tv-text-muted);text-wrap:pretty">This is the only decision that changes the shape of the install. Pick one and the rest of the page shows you only the phases, bindings and variables that node type needs.</p>
  <div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px">
    ${TIERS.map(
      t => `<button data-tier="${t.n}" style="text-align:left;cursor:pointer;border-radius:8px;padding:18px;font-family:var(--tv-font-sans)">
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin:0 0 8px">
        <span style="font:600 13px/1 var(--tv-font-sans);letter-spacing:.04em">Tier ${t.n}</span>
        <span style="font:500 11px/1 var(--tv-font-mono);opacity:.7">${esc(t.duration)}</span>
      </div>
      <div style="font:600 16px/1.3 var(--tv-font-sans);margin:0 0 8px">${esc(t.name)}</div>
      <div style="font:400 12.5px/1.5;opacity:.78;text-wrap:pretty">${esc(t.body)}</div>
    </button>`,
    ).join('\n    ')}
  </div>
</section>`
}

/**
 * The pre-flight sheet, built from `MANUAL_STEPS`.
 *
 * The tool distinguishes prerequisites it will detect from ones only
 * the operator can confirm. That distinction is the most useful thing
 * on this sheet and it exists nowhere in the prose, so it is rendered
 * as a badge rather than flattened into a checkbox list.
 */
function preflight(): string {
  /**
   * The click path, from the same `MANUAL_STEPS` entry the CLI prints.
   *
   * The sheet used to render `title` and `why` and drop `steps` and
   * `url` on the floor — so "Mint a Cloudflare API token · Everything
   * this tool does runs through it" was the whole of the guidance,
   * with the ten-line permission table sitting unused in the data.
   * Fine if you know Cloudflare; a dead end if you do not, and the
   * people who need this page most are the ones who do not.
   *
   * Collapsed, because the sheet is meant to print on one page. A
   * closed <details> prints as its summary line, so the checklist
   * stays a checklist and the detail is one tap away on screen.
   */
  const howTo = (s: ManualStep): string => {
    if (!s.steps.length && !s.url) return ''
    // Prose in a monospace pre-wrap box reads as terminal output, and
    // re-wraps the author's terminal-width line breaks at whatever the
    // card happens to be — which is how "needs no IdP / setup;" got in
    // front of a reader. Actions are a list, notes are prose, and the
    // monospace box is kept for what is actually literal.
    const body = s.steps.length
      ? `<div style="margin:8px 0 0">${s.steps
          .map(line => {
            if (typeof line === 'string') {
              return `<div style="display:flex;gap:8px;margin:0 0 6px"><span aria-hidden="true" style="flex:none;color:var(--tv-accent)">→</span><span style="font:400 13px/1.55 var(--tv-font-sans);color:var(--tv-text-muted);text-wrap:pretty">${withSlots(line)}</span></div>`
            }
            if ('note' in line) {
              return `<p style="margin:0 0 6px;padding-inline-start:20px;font:400 12.5px/1.55 var(--tv-font-sans);color:var(--tv-text-dim);text-wrap:pretty">${inline(line.note)}</p>`
            }
            return `<div style="white-space:pre;margin:0 0 8px;margin-inline-start:20px;padding:9px 11px;background:var(--tv-surface-code);border:1px solid var(--tv-border);border-radius:5px;font:400 11.5px/1.6 var(--tv-font-mono);color:var(--tv-text-muted);overflow-x:auto">${esc(line.code).replace(/\{\{(\w+)\}\}/g, (_m, id: string) => slot(id))}</div>`
          })
          .join('')}</div>`
      : ''
    // The action link says *where*; the docs link says *what the thing
    // is*. Someone new to the platform needs the second before the
    // first is any use.
    //
    // Both labels are derived from the host rather than written, because
    // both used to say "Cloudflare" unconditionally — which the fork
    // step made wrong, since it points at GitHub. Naming the wrong
    // product is a small lie in the one place someone new is trusting
    // this page, and hardcoding it means the next non-Cloudflare step
    // reintroduces the bug silently.
    const links = [
      s.url ? `<a href="${esc(s.url)}">${esc(actionLabel(s.url))} ↗</a>` : '',
      s.docsUrl ? `<a href="${esc(s.docsUrl)}">${esc(docsLabel(s.docsUrl))} ↗</a>` : '',
    ].filter(Boolean)
    const link = links.length
      ? `<div style="display:flex;flex-wrap:wrap;gap:14px;margin:8px 0 0;font:500 12px/1.4 var(--tv-font-sans)">${links.join('')}</div>`
      : ''
    return `<details style="margin:5px 0 0">
      <summary style="cursor:pointer;font:500 12px/1.4 var(--tv-font-sans);color:var(--tv-accent);list-style:none">How to do this ▸</summary>
      ${body}
      ${link}
    </details>`
  }

  const step = (s: ManualStep, i: number): string => {
    const detected = s.verification === 'detected'
    const badge = detected
      ? `<span title="If you skip this, the setup tool will tell you." style="flex:none;background:var(--tv-accent-bg);color:var(--tv-accent);border:1px solid var(--tv-accent-border);border-radius:999px;padding:2px 8px;font:600 9px/1.5 var(--tv-font-sans);letter-spacing:.07em;text-transform:uppercase">setup will catch this</span>`
      : `<span title="Nothing will warn you if you skip this one." style="flex:none;background:var(--tv-warn-bg);color:var(--tv-warn);border:1px solid var(--tv-warn-border);border-radius:999px;padding:2px 8px;font:600 9px/1.5 var(--tv-font-sans);letter-spacing:.07em;text-transform:uppercase">on you</span>`
    return `<div style="display:flex;gap:10px;align-items:flex-start">
    <button data-toggle="pf-${esc(s.id)}" data-check="1" style="flex:none;margin-top:2px"></button>
    <div style="min-width:0">
      <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:0 0 3px">
        <span style="font:600 13.5px/1.4 var(--tv-font-sans);color:var(--tv-text)">${i + 1}. ${esc(s.title)}</span>
        ${badge}
      </div>
      <div style="font-size:13px;line-height:1.5;color:var(--tv-text-muted);text-wrap:pretty">${inline(s.why)}</div>
      ${howTo(s)}
    </div>
  </div>`
  }

  const gates = PHASES.map(
    p => `<div data-phase-row="${p.n}" style="display:flex;gap:10px;align-items:flex-start">
    <button data-toggle="p${p.n}" data-check="1" style="flex:none;margin-top:1px"></button>
    <div style="flex:none;width:22px;font:500 11.5px/1.5 var(--tv-font-mono);color:var(--tv-text-dim)">${String(p.n).padStart(2, '0')}</div>
    <div style="font-size:13.5px;line-height:1.5;color:var(--tv-text-muted);text-wrap:pretty">${inline(p.gateShort)}</div>
  </div>`,
  ).join('\n  ')

  /**
   * Workers Paid is the one prerequisite the plan chooser lets an
   * operator decline, so the sheet cannot state it unconditionally.
   * Choosing *Free* and then being told to "Enable Workers Paid
   * ($5/month)" as task one is a straight contradiction of the choice
   * the page just offered.
   *
   * Both variants render; `data-when` shows exactly one, so the row
   * count and the numbering stay put either way. On free it stops
   * being a task and becomes the record of a decision — with what it
   * costs you spelled out, and a way back.
   */
  const declined = (s: ManualStep, i: number): string => `<div style="display:flex;gap:10px;align-items:flex-start">
    <span aria-hidden="true" style="flex:none;margin-top:2px;width:15px;height:15px;display:inline-flex;align-items:center;justify-content:center;border:1px dashed var(--tv-border-strong);border-radius:4px;color:var(--tv-text-dim);font:600 10px/1 var(--tv-font-sans)">—</span>
    <div style="min-width:0">
      <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:0 0 3px">
        <span style="font:600 13.5px/1.4 var(--tv-font-sans);color:var(--tv-text-dim)">${i + 1}. ${esc(s.title.replace(/^Enable /, ''))} — you chose the free plan</span>
        <span style="flex:none;background:var(--tv-surface-3);color:var(--tv-text-dim);border:1px solid var(--tv-border);border-radius:999px;padding:2px 8px;font:600 9px/1.5 var(--tv-font-sans);letter-spacing:.07em;text-transform:uppercase">your choice</span>
      </div>
      <div style="font-size:13px;line-height:1.5;color:var(--tv-text-dim);text-wrap:pretty">Nothing to do. Every resource in this install still gets created — you just have a smaller daily allowance of each. Orbit throttles after roughly 200 conversations a day, and that is the ceiling you cannot buy past. <a href="#cost">Change plan</a></div>
    </div>
  </div>`

  const stepCell = (s: ManualStep, i: number): string =>
    s.id !== 'workers-paid'
      ? step(s, i)
      : `<div data-when="paid">${step(s, i)}</div>\n  <div data-when="free">${declined(s, i)}</div>`

  const sectionHead = (label: string, aside: string, blurb: string): string =>
    `<div style="display:flex;justify-content:space-between;align-items:baseline;gap:16px;margin:0 0 6px">
      <div style="${EYEBROW}">${esc(label)}</div>
      <div style="font:400 12px/1.35 var(--tv-font-sans);color:var(--tv-text-dim)">${esc(aside)}</div>
    </div>
    <p style="margin:0 0 16px;padding-bottom:14px;border-bottom:1px solid var(--tv-border);font-size:13px;color:var(--tv-text-dim);max-width:66ch;text-wrap:pretty">${inline(blurb)}</p>`

  return `<section id="preflight" data-sheet="1" style="${CARD};padding:28px 30px;margin:0 0 44px;scroll-margin-top:20px">
  <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:20px;margin:0 0 6px">
    <h2 style="font:700 27px/1.2 var(--tv-font-sans);letter-spacing:-.01em;color:var(--tv-text);margin:0">Your install sheet</h2>
    <button data-act="print" data-noprint="1" style="flex:none;cursor:pointer;background:var(--tv-surface-3);border:1px solid var(--tv-border-strong);border-radius:6px;padding:7px 12px;font:500 12px/1 var(--tv-font-sans);color:var(--tv-text-muted)">Print this page</button>
  </div>
  <p style="margin:0 0 10px;max-width:62ch;color:var(--tv-text-muted);text-wrap:pretty">One page to print and keep next to the keyboard. Two lists, in the order you need them: first the things only you can do, then every phase of the install with what finished looks like.</p>
  <p style="margin:0 0 28px;max-width:62ch;color:var(--tv-text-muted);text-wrap:pretty"><b style="font-weight:600;color:var(--tv-text)">This sheet is the map, not the instructions.</b> The steps themselves are below it, one section per phase, with the commands and the click paths. Work the prerequisites here, then keep scrolling — the page is already in order.</p>
  <div>
    <div style="margin:0 0 32px">
      ${sectionHead(
        'Before you start · only you can do these',
        `${MANUAL_STEPS.length} things, about 20 minutes`,
        'An account, a domain, a login — the things no script can do on your behalf. Most the setup tool will notice if you skip; the ones marked *on you* it cannot, so those are the ones to be sure about. **Have a password manager open before you start**: four of these produce a secret shown exactly once. Workers Paid is a choice rather than a task — see [what it costs](#cost).',
      )}
      <div style="display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:13px 28px">${MANUAL_STEPS.map(stepCell).join('\n  ')}</div>
    </div>
    <div>
      ${sectionHead(
        'The install itself · what finished looks like',
        'tick as you go',
        'Every step in order, with the one thing you should see once it has landed. Not extra work — it is the same check that sits at the foot of each step below, gathered here so the printed sheet stands on its own.',
      )}
      <div style="display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:9px 28px">${gates}</div>
    </div>
    <div data-noprint="1" style="background:var(--tv-accent-bg);border:1px solid var(--tv-accent-border);border-radius:8px;padding:16px 18px;margin:4px 0 0">
      <p style="margin:0;font-size:13.5px;line-height:1.6;color:var(--tv-text-muted);text-wrap:pretty">That is the whole install on one page — but only the summary. <a href="#p0">Start Phase 0 below</a>, which is where the actual commands are. Each phase ends by asking for whatever it produced, so the values fill themselves into every later command as you go.</p>
    </div>
  </div>
</section>`
}

/** The dependency map — a span chart, one row per worksheet value. */
function dependencyMap(): string {
  const rows = WORKSHEET.map(w => {
    const cells = PHASES.map(
      p => `<div data-cell="${p.n}" style="height:27px;display:flex;align-items:center;justify-content:center"><span data-mark="1"></span></div>`,
    ).join('')
    return `<div data-map-row="${esc(w.id)}" data-w="${esc(w.id)}" data-produced="${w.phase}" data-consumed="${w.consumedBy.join(',')}" data-tier="${w.minTier}" style="display:grid;grid-template-columns:224px repeat(${PHASES.length},minmax(0,1fr));align-items:center;cursor:pointer;border-radius:4px">
    <div style="display:flex;align-items:baseline;gap:7px;padding:0 6px 0 4px;min-width:0">
      <span data-map-id="1" style="flex:none;font:500 10.5px/1 var(--tv-font-mono)">${esc(w.id)}</span>
      <span style="font-size:11.5px;color:var(--tv-text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(w.label)}</span>
    </div>${cells}
  </div>`
  }).join('\n  ')

  const heads = PHASES.map(
    p => `<a href="#p${p.n}" data-col="${p.n}" style="justify-self:center;border:none;font:500 11px/1 var(--tv-font-mono);color:var(--tv-text-dim);padding:3px 2px">${String(p.n).padStart(2, '0')}</a>`,
  ).join('')

  return `<section id="map" data-sheet="1" data-map="1" style="background:var(--tv-surface-2);border:1px solid var(--tv-border);border-radius:8px;padding:28px 30px;margin:0 0 44px;scroll-margin-top:20px">
  <h2 style="font:700 27px/1.2 var(--tv-font-sans);letter-spacing:-.01em;color:var(--tv-text);margin:0 0 10px">Where every value comes from</h2>
  <p style="margin:0 0 6px;max-width:64ch;color:var(--tv-text-muted);text-wrap:pretty">A filled dot is where a value is <b style="font-weight:600;color:var(--tv-text)">born</b>; the rings are every later phase that <b style="font-weight:600;color:var(--tv-text)">needs</b> it. Read the shape, not the rows: nothing ever reaches backwards.</p>
  <p style="margin:0 0 22px;max-width:64ch;font-size:13.5px;color:var(--tv-text-dim);text-wrap:pretty">Dots turn blue as you fill each value in, so this doubles as a resume view. Click a row to edit it; click a phase number to jump there.</p>
  <div data-map-head="1" style="display:grid;grid-template-columns:224px repeat(${PHASES.length},minmax(0,1fr));align-items:center;margin:0 0 6px;padding-bottom:8px;border-bottom:1px solid var(--tv-border)">
    <div style="${EYEBROW}">Value</div>${heads}
  </div>
  ${rows}
  <div style="display:flex;flex-wrap:wrap;gap:22px;align-items:center;margin:18px 0 0;padding-top:14px;border-top:1px solid var(--tv-border)">
    <span style="display:inline-flex;align-items:center;gap:7px;font-size:12px;color:var(--tv-text-dim)"><span style="width:9px;height:9px;border-radius:50%;background:var(--tv-accent)"></span>produced here</span>
    <span style="display:inline-flex;align-items:center;gap:7px;font-size:12px;color:var(--tv-text-dim)"><span style="width:7px;height:7px;border-radius:50%;border:1.5px solid var(--tv-accent)"></span>needed here</span>
    <span style="display:inline-flex;align-items:center;gap:7px;font-size:12px;color:var(--tv-text-dim)"><span style="width:9px;height:9px;border-radius:50%;background:var(--tv-warn)"></span>not filled in yet</span>
  </div>
  <div data-noprint="1" style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin:20px 0 0">
    ${MAP_READINGS.map(
      r => `<div style="background:var(--tv-surface-3);border:1px solid var(--tv-border);border-radius:6px;padding:14px 16px">
      <div style="font:600 12.5px/1.3 var(--tv-font-sans);color:var(--tv-text);margin:0 0 5px">${esc(r.title)}</div>
      <p style="margin:0;font-size:12.5px;line-height:1.5;color:var(--tv-text-dim);text-wrap:pretty">${esc(r.body)}</p>
    </div>`,
    ).join('\n    ')}
  </div>
</section>`
}

/**
 * The bindings table — rendered straight from `EXPECTED_BINDINGS`.
 *
 * Nineteen rows, not the nine a hand-written table tends to carry.
 * Every hint is the operator-facing text the audit itself prints when
 * the binding is missing, so the page and the failure message agree
 * word for word.
 */
function bindingsTable(): string {
  const tierOf = (b: ExpectedBinding): number =>
    /^(CATALOG_(DB|KV|R2|VECTORIZE)|ACCESS_|NODE_ID|PREVIEW_SIGNING)/.test(b.name) ? 2 : 1
  const row = (b: ExpectedBinding): string =>
    `<div data-binding-row="1" data-tier="${tierOf(b)}" style="display:contents">
    <div style="background:var(--tv-surface-2);padding:10px 12px;font-family:var(--tv-font-mono);overflow-wrap:anywhere">${esc(b.name)}</div>
    <div style="background:var(--tv-surface-2);padding:10px 12px;color:var(--tv-text-dim)">${esc(b.type)}</div>
    <div style="background:var(--tv-surface-2);padding:10px 12px;color:var(--tv-text-dim)">${b.environments.length === 2 ? 'both' : esc(b.environments.join(', '))}</div>
    <div style="background:var(--tv-surface-2);padding:10px 12px;color:var(--tv-text-muted)">${b.hint ? inline(b.hint) : ''}</div>
  </div>`
  const head = ['Name', 'Type', 'Envs', 'What the audit says when it is missing']
    .map(
      h =>
        `<div style="background:var(--tv-surface-3);padding:9px 12px;${EYEBROW}">${esc(h)}</div>`,
    )
    .join('')
  return `<div style="display:grid;grid-template-columns:minmax(0,1.3fr) minmax(0,.6fr) minmax(0,.45fr) minmax(0,2.4fr);gap:1px;background:var(--tv-border);border:1px solid var(--tv-border);border-radius:6px;overflow:hidden;font-size:12.5px;margin:0 0 18px">
  ${head}
  ${EXPECTED_BINDINGS.map(row).join('\n  ')}
</div>`
}

/**
 * The three variables Orbit needs when it talks to a model the operator
 * runs. Unlike everything else on this page these names come from the
 * provider docs rather than from a module `crossCheck` can verify, so the
 * block says so rather than implying the same guarantee.
 */
function localModelVars(): string {
  const rows: Array<[string, string, string]> = [
    [
      'ORBIT_LLM_BASE_URL',
      'plaintext',
      "Your endpoint, reachable from the public internet. Ollama\u2019s default path ends <code style=\"font-family:var(--tv-font-mono)\">/v1</code>.",
    ],
    ['ORBIT_LLM_MODEL', 'plaintext', 'The model name as your server reports it.'],
    [
      'ORBIT_LLM_API_KEY',
      'secret',
      'Whatever your server expects. Set something even if it ignores it, so the endpoint is not open to anyone who finds it.',
    ],
  ]
  const head = ['Name', 'Kind', 'Value']
    .map(x => `<div style="background:var(--tv-surface-3);padding:9px 12px;${EYEBROW}">${esc(x)}</div>`)
    .join('')
  return `<div data-when="local">
  <div style="${EYEBROW};margin:0 0 10px">Your own model \u2014 three more variables</div>
  <p style="margin:0 0 14px;max-width:64ch;font-size:13.5px;color:var(--tv-text-muted);text-wrap:pretty">Set these alongside the bindings above, on both environments. Keep the <code style="font-family:var(--tv-font-mono);font-size:.92em">AI</code> binding wired even so \u2014 Orbit\u2019s chat will use your model, but dataset embeddings still run through Workers AI.</p>
  <div style="display:grid;grid-template-columns:minmax(0,1.35fr) minmax(0,.85fr) minmax(0,2.7fr);gap:1px;background:var(--tv-border);border:1px solid var(--tv-border);border-radius:6px;overflow:hidden;font-size:12.5px;margin:0 0 18px">
    ${head}
    ${rows
      .map(
        ([n, k, v]) =>
          `<div style="background:var(--tv-surface-2);padding:10px 12px;font-family:var(--tv-font-mono);overflow-wrap:anywhere">${esc(n)}</div><div style="background:var(--tv-surface-2);padding:10px 12px;color:${k === 'secret' ? 'var(--tv-error)' : 'var(--tv-text-dim)'}">${esc(k)}</div><div style="background:var(--tv-surface-2);padding:10px 12px;color:var(--tv-text-muted)">${v}</div>`,
      )
      .join('\\n    ')}
  </div>
  <div style="background:var(--tv-warn-bg);border:1px solid var(--tv-warn-border);border-left:3px solid var(--tv-warn);border-radius:6px;padding:14px 16px;margin:0 0 18px">
    <div style="font:600 10.5px/1.35 var(--tv-font-sans);letter-spacing:.13em;text-transform:uppercase;color:var(--tv-warn);margin:0 0 7px">Check the names against the repo</div>
    <p style="margin:0;font-size:13.5px;line-height:1.55;color:var(--tv-text-muted);text-wrap:pretty">These three come from the Orbit provider docs rather than from the bindings audit, so nothing verifies them at build time the way the rows above are verified. Confirm them in <code style="font-family:var(--tv-font-mono);font-size:.92em">.dev.vars.example</code> before you rely on them.</p>
  </div>
</div>`
}

function phaseSection(p: Phase): string {
  const parts: string[] = []

  if (p.produces?.length) {
    parts.push(
      `<div style="display:flex;flex-wrap:wrap;gap:6px;margin:0 0 20px;align-items:center">
      <span style="${EYEBROW};margin-right:3px">Produces <span style="text-transform:none;letter-spacing:0;font-weight:400;color:var(--tv-text-dim)">— tap one to record it</span></span>
      ${p.produces
        .map(id => {
          const w = WORKSHEET.find(x => x.id === id)
          return `<span data-w="${esc(id)}" style="cursor:pointer;background:var(--tv-surface-3);border:1px solid var(--tv-border-strong);border-radius:3px;padding:4px 8px;font:500 11px/1.2 var(--tv-font-mono);color:var(--tv-text-muted)">${esc(id)} ${esc(w ? w.label.toLowerCase() : '')}</span>`
        })
        .join('\n      ')}
    </div>`,
    )
  }

  if (p.automated) {
    parts.push(code(p.automated))
  }
  for (const para of p.automatedNote ?? []) {
    parts.push(
      `<p style="margin:0 0 16px;max-width:64ch;font-size:13.5px;color:var(--tv-text-muted);text-wrap:pretty">${withSlots(para)}</p>`,
    )
  }

  for (const item of p.body ?? []) {
    if (isCallout(item)) parts.push(callout(item))
    else if (isCode(item)) parts.push(code(item))
  }

  // Capture, where the values actually are.
  //
  // The worksheet lived behind a floating button, and someone working
  // through the install did not notice it existed — so the amber
  // placeholders in every later command never got filled, and the
  // Copy buttons handed out commands with `‹account-id›` still in
  // them. The chips at the top of the phase announce what is coming;
  // this asks for it at the point you have it on screen, without
  // needing to find the drawer at all.
  //
  // The inputs are the drawer's own control, so both stay in step.
  if (p.produces?.length) {
    const fields = p.produces
      .map(id => WORKSHEET.find(w => w.id === id))
      .filter((w): w is WorksheetField => Boolean(w))
    if (fields.length) {
      parts.push(
        `<div data-noprint="1" style="background:var(--tv-surface-2);border:1px solid var(--tv-border-strong);border-radius:8px;padding:18px 20px;margin:22px 0 0">
      <div style="${EYEBROW};margin:0 0 4px">Write these down before you move on</div>
      <p style="margin:0 0 14px;max-width:62ch;font-size:13px;line-height:1.55;color:var(--tv-text-muted);text-wrap:pretty">You should have ${fields.length === 1 ? 'this value' : `these ${fields.length} values`} now. Typing ${fields.length === 1 ? 'it' : 'them'} here fills ${fields.length === 1 ? 'it' : 'them'} into every command further down the page, so what you copy is ready to run.</p>
      ${fields.map(worksheetField).join('\n      ')}
    </div>`,
      )
    }
  }

  if (p.n === 3) {
    // The pinned ID, derived rather than written, beside the step that
    // rewrites it. It used to sit in a homeless paragraph between the
    // setup panel and the phases, stapled to an unrelated count of
    // Access paths — a statistic rather than something a reader could
    // act on. Here it is a thing you can check your own file against.
    parts.push(
      `<p style="margin:0 0 16px;max-width:64ch;font-size:13.5px;line-height:1.6;color:var(--tv-text-muted);text-wrap:pretty">To recognise an unedited file: the two <code style="font-family:var(--tv-font-mono);font-size:.92em">database_id</code> lines both read <code style="font-family:var(--tv-font-mono);font-size:.92em">${esc(UPSTREAM_PINNED_IDS.d1.slice(0, 8))}…</code>, which is upstream's database, not yours.</p>`,
    )
  }
  if (p.n === 8) {
    parts.push(bindingsTable())
    parts.push(localModelVars())
  }
  if (p.n === 13) {
    parts.push(
      `<div style="display:flex;flex-direction:column;gap:10px;margin:0 0 16px">${ADDONS.map(
        a => `<div style="border:1px solid var(--tv-border);border-radius:6px;padding:15px 17px">
        <div style="display:flex;justify-content:space-between;align-items:baseline;gap:12px;margin:0 0 6px">
          <div style="font:500 15px/1.3 var(--tv-font-sans);color:var(--tv-text)">${esc(a.id)} · ${esc(a.title)}</div>
          <span style="flex:none;font:500 11px/1 var(--tv-font-mono);color:var(--tv-accent)">${esc(a.flag)}</span>
        </div>
        <p style="margin:0;font-size:13.5px;line-height:1.55;color:var(--tv-text-muted);text-wrap:pretty">${inline(a.body)}</p>
        ${a.extra ? `<p style="margin:8px 0 0;font-size:13.5px;line-height:1.55;color:var(--tv-text-muted);text-wrap:pretty">${inline(a.extra)}</p>` : ''}
      </div>`,
      ).join('\n    ')}</div>`,
    )
  }

  if (p.manual) {
    const body = p.manual.body
      .map(item => {
        if (isCallout(item)) return callout(item)
        if (isCode(item)) return code(item)
        return `<p style="margin:0 0 10px;font-size:13.5px;line-height:1.55;color:var(--tv-text-muted);max-width:64ch;text-wrap:pretty">${(item as { html: string }).html}</p>`
      })
      .join('\n    ')
    parts.push(`<details style="border-top:1px solid var(--tv-border);padding-top:13px;margin:0 0 14px">
    <summary style="display:block;cursor:pointer;font:500 13px/1.4 var(--tv-font-sans);color:var(--tv-accent);list-style:none">+ ${esc(p.manual.summary)}</summary>
    <div style="padding-top:14px">${body}</div>
  </details>`)
  }

  parts.push(`<div style="background:var(--tv-accent-bg);border:1px solid var(--tv-accent-border);border-left:3px solid var(--tv-accent);border-radius:6px;padding:14px 16px;margin:0 0 14px">
    <div style="font:600 10.5px/1.35 var(--tv-font-sans);letter-spacing:.13em;text-transform:uppercase;color:var(--tv-accent);margin:0 0 7px">Gate</div>
    <p style="margin:0;font-size:13.5px;line-height:1.55;color:var(--tv-text-muted);text-wrap:pretty">${withSlots(p.gate)}</p>
  </div>`)

  return `<section id="p${p.n}" data-phase="${p.n}" data-min-tier="${p.minTier}"${p.tierExact ? ` data-exact-tier="${p.tierExact}"` : ''} style="${CARD};padding:26px 30px;margin:0 0 16px;scroll-margin-top:20px">
  <div style="display:flex;align-items:flex-start;gap:15px;margin:0 0 18px">
    <button data-toggle="p${p.n}" data-check="lg" style="flex:none;margin-top:5px"></button>
    <div style="flex:1;min-width:0">
      <div style="display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;margin:0 0 4px">
        <span style="font:500 11.5px/1 var(--tv-font-mono);color:var(--tv-text-dim);letter-spacing:.06em">PHASE ${String(p.n).padStart(2, '0')}</span>
        <span style="font:400 11.5px/1.4 var(--tv-font-sans);color:var(--tv-text-dim)">${esc(p.duration)}${p.aside ? ' · ' + esc(p.aside) : ''}</span>
      </div>
      <h2 style="font:700 24px/1.25 var(--tv-font-sans);letter-spacing:-.01em;color:var(--tv-text);margin:0">${esc(p.title)}</h2>
    </div>
  </div>
  ${p.intro.map(t => `<p style="margin:0 0 16px;max-width:64ch;color:var(--tv-text-muted);text-wrap:pretty">${withSlots(t)}</p>`).join('\n  ')}
  ${parts.join('\n  ')}
  <p style="margin:0;font-size:12.5px;color:var(--tv-text-dim)"><a href="${MARKDOWN_URL}#${esc(p.anchor)}">${esc(p.linkText ?? 'Full detail in SELF_HOSTING.md')} ↗</a></p>
</section>`
}

/**
 * One worksheet input.
 *
 * Shared by the drawer and by the capture block at the end of each
 * phase, so the two are the same control rather than two spellings of
 * it — same validator, same error slot, same note.
 */
function worksheetField(w: WorksheetField): string {
    const o = ORIGIN_LABELS[w.origin]
    return `<div data-field-row="${esc(w.id)}" data-tier="${w.minTier}" style="margin:0 0 14px">
    <div style="display:flex;align-items:center;gap:7px;margin:0 0 5px;flex-wrap:wrap">
      <label style="font:500 11.5px/1.3 var(--tv-font-mono);color:var(--tv-text-muted)">${esc(w.id)}</label>
      <span style="font:400 12.5px/1.3 var(--tv-font-sans);color:var(--tv-text)">${esc(w.label)}</span>
      <span title="${esc(o.hint)}" style="background:var(--tv-surface-3);border:1px solid var(--tv-border-strong);border-radius:999px;padding:1px 7px;font:600 9px/1.6 var(--tv-font-sans);letter-spacing:.06em;text-transform:uppercase;color:var(--tv-text-dim)">${esc(o.label)}</span>
      ${w.secret ? '<span style="background:var(--tv-error-bg);color:var(--tv-error);border:1px solid var(--tv-error-border);border-radius:999px;padding:1px 7px;font:600 9px/1.6 var(--tv-font-sans);letter-spacing:.06em;text-transform:uppercase">secret</span>' : ''}
    </div>
    <input data-field="${esc(w.id)}"${w.validator ? ` data-validate="${esc(w.validator)}"` : ''} placeholder="${esc(w.placeholder)}" spellcheck="false" autocomplete="off" style="width:100%;background:var(--tv-surface-3);border:1px solid var(--tv-border-strong);border-radius:6px;padding:8px 10px;font:400 13px/1.4 var(--tv-font-mono);color:var(--tv-text)"/>
    <div data-error="${esc(w.id)}" style="display:none;font:400 11.5px/1.5 var(--tv-font-sans);color:var(--tv-error);margin-top:4px"></div>
    ${w.note ? `<div style="font:400 11.5px/1.5 var(--tv-font-sans);color:var(--tv-text-dim);margin-top:4px">${esc(w.note)}</div>` : ''}
  </div>`
}

function worksheetDrawer(): string {
  const field = worksheetField

  const askedCount = QUESTIONS.length
  return `<div data-drawer="1" data-noprint="1" style="display:none;position:fixed;inset:0;z-index:50;justify-content:flex-end">
  <div data-act="close" style="position:absolute;inset:0;background:rgba(0,0,0,.62)"></div>
  <div style="position:relative;width:460px;max-width:92vw;height:100%;background:var(--tv-surface);border-left:1px solid var(--tv-border);overflow-y:auto;box-shadow:-14px 0 40px rgba(0,0,0,.5)">
    <div style="position:sticky;top:0;background:var(--tv-surface);border-bottom:1px solid var(--tv-border);padding:22px 24px 16px;z-index:2">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:14px;margin:0 0 10px">
        <div>
          <div style="font:700 19px/1.25 var(--tv-font-sans);color:var(--tv-text)">Your values</div>
          <div style="font:400 12.5px/1.5;color:var(--tv-text-dim);margin-top:3px">Fill these in once. Every command on the page updates.</div>
        </div>
        <button data-act="close" style="flex:none;cursor:pointer;background:none;border:1px solid var(--tv-border-strong);border-radius:6px;width:28px;height:28px;font:400 15px/1 var(--tv-font-sans);color:var(--tv-text-muted)">×</button>
      </div>
      <div style="display:flex;align-items:center;gap:10px">
        <div style="flex:1;height:4px;background:var(--tv-surface-3);border-radius:3px;overflow:hidden"><div data-fill-bar="1" style="height:100%;background:var(--tv-accent);width:0%"></div></div>
        <span data-fill-count="1" style="font:500 11.5px/1 var(--tv-font-mono);color:var(--tv-accent)"></span>
      </div>
    </div>
    <div style="padding:18px 24px 40px">
      <div style="background:var(--tv-accent-bg);border:1px solid var(--tv-accent-border);border-radius:6px;padding:11px 13px;margin:0 0 16px;font-size:12.5px;line-height:1.55;color:var(--tv-text-muted);text-wrap:pretty">Of these, <b style="font-weight:600;color:var(--tv-text)">${askedCount}</b> are things the setup interview actually asks you for. The rest Cloudflare assigns, a local command generates, or a dialog shows once — you are recording them here, not inventing them.</div>
      <div style="background:var(--tv-surface-3);border:1px solid var(--tv-border);border-radius:6px;padding:11px 13px;margin:0 0 20px;font-size:12.5px;line-height:1.55;color:var(--tv-text-dim);text-wrap:pretty">Plain values are kept in this browser only. Anything marked <span style="color:var(--tv-error)">SECRET</span> is held for this session only and never written to storage. Nothing leaves your machine either way.</div>
      ${WORKSHEET.map(field).join('\n      ')}
      <button data-act="clear" style="margin-top:8px;cursor:pointer;background:none;border:1px solid var(--tv-border-strong);border-radius:6px;padding:8px 12px;font:500 12px/1 var(--tv-font-sans);color:var(--tv-error)">Clear everything on this page</button>
    </div>
  </div>
</div>`
}

function troubleshooting(): string {
  return `<section id="stuck" data-noprint="1" style="margin:44px 0 0;scroll-margin-top:20px">
  <div style="${EYEBROW};margin:0 0 12px">If you are stuck right now</div>
  <h2 style="font:700 28px/1.2 var(--tv-font-sans);letter-spacing:-.01em;color:var(--tv-text);margin:0 0 14px">The ten symptoms people actually hit</h2>
  <p style="margin:0 0 22px;max-width:62ch;color:var(--tv-text-muted);text-wrap:pretty">Find your symptom, not your phase. Most of these exist because someone hit the snag and it was worth writing down — if yours is not here, that is worth an issue.</p>
  <div style="display:flex;flex-direction:column;gap:2px">
    ${TROUBLESHOOTING.map(
      t => `<div style="${CARD};padding:16px 18px">
      <div style="font:500 14px/1.4 var(--tv-font-mono);color:var(--tv-error);margin:0 0 6px">${esc(t.symptom)}</div>
      <p style="margin:0;font-size:13.5px;line-height:1.55;color:var(--tv-text-muted);text-wrap:pretty">${inline(t.fix)}</p>
    </div>`,
    ).join('\n    ')}
  </div>
  <p style="margin:16px 0 0;font-size:12.5px;color:var(--tv-text-dim)"><a href="${MARKDOWN_URL}#reference-e--troubleshooting">All sixteen symptoms in SELF_HOSTING.md ↗</a></p>
</section>`
}

function weekOne(): string {
  return `<section data-noprint="1" style="margin:44px 0 0">
  <div style="${EYEBROW};margin:0 0 12px">After a successful launch</div>
  <h2 style="font:700 28px/1.2 var(--tv-font-sans);letter-spacing:-.01em;color:var(--tv-text);margin:0 0 20px">Five things worth doing in week one</h2>
  <div style="display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:12px">
    ${WEEK_ONE.map(
      w => `<div style="${CARD};padding:16px 18px${w.wide ? ';grid-column:1 / -1' : ''}">
      <div style="font:500 14px/1.3 var(--tv-font-sans);color:var(--tv-text);margin:0 0 6px">${esc(w.title)}</div>
      <p style="margin:0;font-size:13.5px;line-height:1.55;color:var(--tv-text-muted);text-wrap:pretty">${esc(w.body)}</p>
    </div>`,
    ).join('\n    ')}
  </div>
</section>`
}

function sidebar(): string {
  const links = PHASES.map(
    p => `<a href="#p${p.n}" data-nav="${p.n}" style="display:flex;align-items:center;gap:9px;padding:5px 7px;border-radius:4px;border:none;font:400 13px/1.3 var(--tv-font-sans);color:var(--tv-text-muted)">
    <span data-nav-dot="1" style="flex:0 0 15px;height:15px;border-radius:50%;border:1.5px solid var(--tv-border-strong);display:flex;align-items:center;justify-content:center;font:600 9px/1 var(--tv-font-sans);color:transparent"></span>
    <span style="flex:0 0 17px;font:500 11px/1 var(--tv-font-mono);color:var(--tv-text-dim)">${String(p.n).padStart(2, '0')}</span>
    <span>${esc(p.label)}</span>
  </a>`,
  ).join('\n  ')

  return `<aside data-noprint="1" style="position:sticky;top:0;align-self:start;height:100vh;overflow-y:auto;border-right:1px solid var(--tv-border);background:var(--tv-surface);padding:26px 20px 40px">
  <div style="display:flex;align-items:center;gap:9px;margin:0 0 18px">
    ${GLOBE_MARK}
    <div>
      <div style="font:600 9.5px/1.3 var(--tv-font-sans);letter-spacing:.16em;text-transform:uppercase;color:var(--tv-text-dim)">Terraviz</div>
      <div style="font:700 15px/1.25 var(--tv-font-sans);color:var(--tv-text)">Install console</div>
    </div>
  </div>
  <div style="background:var(--tv-surface-3);border:1px solid var(--tv-border);border-radius:6px;padding:11px 12px;margin:0 0 18px">
    <div style="display:flex;justify-content:space-between;align-items:baseline;margin:0 0 7px">
      <span style="${EYEBROW}">Progress</span>
      <span data-progress="1" style="font:500 12px/1 var(--tv-font-mono);color:var(--tv-accent)"></span>
    </div>
    <div style="height:5px;background:var(--tv-surface-3);border-radius:3px;overflow:hidden">
      <div data-progress-bar="1" style="height:100%;background:var(--tv-accent);border-radius:3px;transition:width .3s ease;width:0%"></div>
    </div>
  </div>
  <div style="display:flex;flex-direction:column;gap:1px;margin:0 0 18px">
    <div style="${GROUP_HEAD}">Before you begin</div>
    <a href="#cost" style="${SIDE_LINK}">What it costs</a>
    <a href="#preflight" style="${SIDE_LINK}">Your install sheet</a>
    <a href="#map" style="${SIDE_LINK}">Where values come from</a>
  </div>

  <div style="${GROUP_HEAD}">The install</div>
  <nav style="display:flex;flex-direction:column;gap:1px;margin:0 0 20px">${links}</nav>

  <div style="display:flex;flex-direction:column;gap:1px;border-top:1px solid var(--tv-border);padding-top:12px">
    <div style="${GROUP_HEAD}">Reference</div>
    <a href="#stuck" style="${SIDE_LINK}">When it goes wrong</a>
    <a href="#trust" style="${SIDE_LINK}">What we actually tested</a>
  </div>
</aside>`
}

const SIDE_LINK = 'padding:5px 7px;border-radius:4px;border:none;font:400 13px/1.3 var(--tv-font-sans);color:var(--tv-text-muted)'
const GROUP_HEAD = 'font:600 9.5px/1.35 var(--tv-font-sans);letter-spacing:.14em;text-transform:uppercase;color:var(--tv-text-dim);padding:0 7px;margin:0 0 7px'

// ── Runtime ───────────────────────────────────────────────────────

/**
 * Client script. Vanilla and inline — the page must work with the SPA
 * bundle broken, which is exactly when someone reads it.
 *
 * Validators are re-declared here rather than imported: this string
 * runs in the browser with no module loader. `crossCheck` cannot
 * catch a drift between the two, so the shapes are kept trivial and
 * the authoritative check stays in the tool.
 */
function runtime(fields: WorksheetField[]): string {
  const meta = fields.map(f => ({
    id: f.id,
    token: f.token,
    secret: Boolean(f.secret),
    tier: f.minTier,
    validator: f.validator ?? null,
  }))
  return `
const KEY = 'terraviz-setup-console-v1';
const FIELDS = ${JSON.stringify(meta)};
const PHASE_COUNT = ${PHASES.length};
const V = {
  accountId: v => /^[0-9a-f]{32}$/i.test(v) ? null : 'expected 32 hex characters',
  aud: v => /^[0-9a-f]{64}$/i.test(v) ? null : 'expected 64 hex characters',
  hostname: v => /^https?:\\/\\//i.test(v) ? 'drop the https:// — just the hostname'
    : v.includes('/') ? 'drop the path — just the hostname'
    : /^[a-z0-9-]+(\\.[a-z0-9-]+)+$/i.test(v) ? null : 'expected something like terraviz.your-org.org',
  emailDomain: v => v.replace(/^@/, '').includes('@') ? 'a domain, not an address'
    : /^[a-z0-9-]+(\\.[a-z0-9-]+)+$/i.test(v.replace(/^@/, '')) ? null : 'expected something like your-org.org',
  emailDomainList: v => { for (const part of v.split(',')) { const e = V.emailDomain(part); if (e) return '"' + part.trim() + '": ' + e; } return null; },
  url: v => { try { const u = new URL(v); return (u.protocol === 'https:' || u.protocol === 'http:') ? null : 'expected an http(s) URL'; } catch { return 'expected a full URL'; } },
  repoSlug: v => /^[\\w.-]+\\/[\\w.-]+$/.test(v) ? null : 'expected owner/repo',
  projectName: v => /^[a-z0-9][a-z0-9-]{0,57}[a-z0-9]$/.test(v) ? null : 'lowercase letters, digits and dashes only'
};

let state = { tier: 2, plan: 'paid', ai: 'workers', vals: {}, done: {} };
try {
  const raw = localStorage.getItem(KEY);
  if (raw) {
    const s = JSON.parse(raw);
    state.tier = s.tier || 2; state.plan = s.plan || 'paid'; state.ai = s.ai || 'workers';
    state.vals = s.vals || {}; state.done = s.done || {};
  }
} catch (e) {}

const SECRET = new Set(FIELDS.filter(f => f.secret).map(f => f.id));
function persist() {
  try {
    const vals = {};
    for (const k in state.vals) if (!SECRET.has(k)) vals[k] = state.vals[k];
    localStorage.setItem(KEY, JSON.stringify({ tier: state.tier, plan: state.plan, ai: state.ai, vals: vals, done: state.done }));
  } catch (e) {}
}

const q = (s, r) => Array.from((r || document).querySelectorAll(s));
const visiblePhase = n => {
  const el = document.querySelector('[data-phase="' + n + '"]');
  if (!el) return false;
  const exact = el.getAttribute('data-exact-tier');
  if (exact) return state.tier === Number(exact);
  if (state.tier === 1) return [0,1,2,3,4,5,8,10].indexOf(n) !== -1;
  return true;
};

function paintChecks() {
  q('[data-check]').forEach(b => {
    const id = b.getAttribute('data-toggle');
    const on = !!state.done[id];
    const lg = b.getAttribute('data-check') === 'lg';
    const sz = lg ? 22 : 17;
    b.style.cssText = 'flex:none;width:' + sz + 'px;height:' + sz + 'px;border-radius:' + (lg ? 4 : 3) + 'px;border:1.5px solid;cursor:pointer;display:flex;align-items:center;justify-content:center;font:600 ' + (lg ? 13 : 11) + 'px/1 var(--tv-font-sans);' + b.style.cssText.replace(/(flex|width|height|border[^;]*|cursor|display|align-items|justify-content|font):[^;]*;?/g, '') +
      (on ? 'background:var(--tv-accent);border-color:var(--tv-accent);color:var(--tv-bg)' : 'background:var(--tv-surface-3);border-color:var(--tv-border-strong);color:transparent');
    b.textContent = on ? '✓' : '';
  });
}

function paintSlots() {
  q('[data-slot]').forEach(s => {
    const id = s.getAttribute('data-slot');
    const f = FIELDS.find(x => x.id === id);
    const val = (state.vals[id] || '').trim();
    s.textContent = val || (f ? f.token : id);
    s.style.cssText = 'cursor:pointer;padding:1px 5px;border-radius:3px;' + (val
      ? 'background:rgba(77,166,255,.14);color:var(--tv-accent);border-bottom:1px solid rgba(77,166,255,.45)'
      : 'background:rgba(255,204,102,.10);color:var(--tv-warn);border-bottom:1px dotted rgba(255,204,102,.55)');
  });
}

function paintTier() {
  q('[data-phase]').forEach(el => {
    el.style.display = visiblePhase(Number(el.getAttribute('data-phase'))) ? '' : 'none';
  });
  q('[data-nav]').forEach(el => {
    el.style.display = visiblePhase(Number(el.getAttribute('data-nav'))) ? 'flex' : 'none';
  });
  q('[data-phase-row]').forEach(el => {
    el.style.display = visiblePhase(Number(el.getAttribute('data-phase-row'))) ? 'flex' : 'none';
  });
  // Nothing is hidden by plan. Every product this node binds has a
  // free allocation, so the free-plan operator creates exactly the
  // same resources — the plan only changes wording, via data-when.
  const free = state.plan === 'free';
  q('[data-field-row]').forEach(el => {
    el.style.display = Number(el.getAttribute('data-tier')) <= state.tier ? '' : 'none';
  });
  q('[data-binding-row]').forEach(el => {
    el.style.display = Number(el.getAttribute('data-tier')) <= state.tier ? 'contents' : 'none';
  });
  q('[data-map-row]').forEach(el => {
    el.style.display = Number(el.getAttribute('data-tier')) <= state.tier ? 'grid' : 'none';
  });
  q('[data-when]').forEach(el => {
    const w = el.getAttribute('data-when');
    const on = w === 'free' ? free : w === 'paid' ? !free : state.ai === w;
    el.style.display = on ? '' : 'none';
  });
  q('[data-plan]').forEach(b => {
    const on = b.getAttribute('data-plan') === state.plan;
    const hue = b.getAttribute('data-plan') === 'free' ? '255,204,102' : '77,166,255';
    b.style.cssText = b.style.cssText.replace(/(background|border|box-shadow):[^;]*;?/g, '') +
      (on ? ';background:rgba(' + hue + ',.1);border:1px solid rgb(' + hue + ');box-shadow:0 0 0 1px rgba(' + hue + ',.2)'
          : ';background:var(--tv-surface-2);border:1px solid var(--tv-border)');
    const tick = b.querySelector('[data-plan-tick]');
    if (tick) {
      tick.textContent = on ? '\u2713' : '';
      tick.style.background = on ? 'rgb(' + hue + ')' : 'transparent';
      tick.style.borderColor = on ? 'rgb(' + hue + ')' : 'var(--tv-border-strong)';
      tick.style.color = on ? 'var(--tv-bg)' : 'transparent';
    }
  });
  q('[data-ai]').forEach(b => {
    const on = b.getAttribute('data-ai') === state.ai;
    const hue = b.getAttribute('data-ai') === 'local' ? '34,197,94' : '77,166,255';
    b.style.cssText = b.style.cssText.replace(/(background|border):[^;]*;?/g, '') +
      (on ? ';background:rgba(' + hue + ',.1);border:1px solid rgb(' + hue + ')'
          : ';background:var(--tv-surface-2);border:1px solid var(--tv-border)');
  });
  q('[data-tier]').forEach(b => {
    if (b.tagName !== 'BUTTON') return;
    const on = Number(b.getAttribute('data-tier')) === state.tier;
    b.style.cssText = b.style.cssText.replace(/(background|border|color|box-shadow):[^;]*;?/g, '') +
      (on ? ';background:var(--tv-accent-bg);border:1px solid var(--tv-accent);color:var(--tv-text);box-shadow:0 0 0 1px rgba(77,166,255,.2)'
          : ';background:var(--tv-surface-3);border:1px solid var(--tv-border);color:var(--tv-text-muted)');
  });
  paintMap();
  paintProgress();
}

function paintProgress() {
  let shown = 0, done = 0;
  for (let n = 0; n < PHASE_COUNT; n++) { if (visiblePhase(n)) { shown++; if (state.done['p' + n]) done++; } }
  const pct = shown ? Math.round(done / shown * 100) : 0;
  const p = document.querySelector('[data-progress]');
  if (p) p.textContent = done + ' / ' + shown;
  const bar = document.querySelector('[data-progress-bar]');
  if (bar) bar.style.width = pct + '%';
  q('[data-nav-dot]').forEach(d => {
    const n = d.parentElement.getAttribute('data-nav');
    const on = !!state.done['p' + n];
    d.style.background = on ? 'var(--tv-accent)' : 'transparent';
    d.style.borderColor = on ? 'var(--tv-accent)' : 'var(--tv-border-strong)';
    d.style.color = on ? 'var(--tv-bg)' : 'transparent';
    d.textContent = on ? '✓' : '';
  });
  const relevant = FIELDS.filter(f => f.tier <= state.tier);
  const filled = relevant.filter(f => (state.vals[f.id] || '').trim()).length;
  const fc = document.querySelector('[data-fill-count]');
  if (fc) fc.textContent = filled + ' / ' + relevant.length;
  const fb = document.querySelector('[data-fill-bar]');
  if (fb) fb.style.width = relevant.length ? Math.round(filled / relevant.length * 100) + '%' : '0%';
  const badge = document.querySelector('[data-drawer-count]');
  if (badge) badge.textContent = filled + ' / ' + relevant.length;
}

function paintMap() {
  const cols = [];
  for (let n = 0; n < PHASE_COUNT; n++) if (visiblePhase(n)) cols.push(n);
  const tpl = '224px repeat(' + cols.length + ',minmax(0,1fr))';
  const head = document.querySelector('[data-map-head]');
  if (head) {
    head.style.gridTemplateColumns = tpl;
    q('[data-col]', head).forEach(a => {
      a.style.display = cols.indexOf(Number(a.getAttribute('data-col'))) === -1 ? 'none' : '';
    });
  }
  q('[data-map-row]').forEach(row => {
    row.style.gridTemplateColumns = tpl;
    const id = row.getAttribute('data-w');
    const produced = Number(row.getAttribute('data-produced'));
    const consumed = (row.getAttribute('data-consumed') || '').split(',').filter(Boolean).map(Number);
    const filled = !!(state.vals[id] || '').trim();
    const hue = filled ? 'var(--tv-accent)' : 'var(--tv-warn)';
    const idEl = row.querySelector('[data-map-id]');
    if (idEl) idEl.style.color = hue;
    const live = consumed.filter(n => cols.indexOf(n) !== -1 && n !== produced);
    const start = cols.indexOf(produced);
    const last = live.length ? Math.max.apply(null, live.map(n => cols.indexOf(n))) : start;
    q('[data-cell]', row).forEach(cell => {
      const n = Number(cell.getAttribute('data-cell'));
      const i = cols.indexOf(n);
      cell.style.display = i === -1 ? 'none' : 'flex';
      cell.style.backgroundImage = '';
      if (i !== -1 && last > start && i >= start && i <= last) {
        const size = (i === start || i === last) ? '50% 1px' : '100% 1px';
        const pos = i === start ? 'right center' : (i === last ? 'left center' : 'center');
        cell.style.backgroundImage = 'linear-gradient(var(--tv-border-strong),var(--tv-border-strong))';
        cell.style.backgroundSize = size;
        cell.style.backgroundPosition = pos;
        cell.style.backgroundRepeat = 'no-repeat';
      }
      const mark = cell.querySelector('[data-mark]');
      if (!mark) return;
      if (n === produced) mark.style.cssText = 'display:block;width:9px;height:9px;border-radius:50%;background:' + hue + ';box-shadow:0 0 0 3px var(--tv-surface-2)';
      else if (consumed.indexOf(n) !== -1) mark.style.cssText = 'display:block;width:7px;height:7px;border-radius:50%;border:1.5px solid ' + hue + ';background:var(--tv-surface-2);box-shadow:0 0 0 3px var(--tv-surface-2)';
      else mark.style.cssText = 'display:none';
    });
  });
}

function paintInputs() {
  // querySelectorAll, not querySelector: each value now has an input in
  // the drawer AND one at the end of the phase that produces it, and
  // typing in either has to show up in the other.
  FIELDS.forEach(f => {
    q('[data-field="' + f.id + '"]').forEach(el => {
      if (el !== document.activeElement) el.value = state.vals[f.id] || '';
    });
  });
}

function validate(id, value) {
  const f = FIELDS.find(x => x.id === id);
  const err = document.querySelector('[data-error="' + id + '"]');
  if (!err) return;
  const fn = f && f.validator ? V[f.validator] : null;
  const msg = (value.trim() && fn) ? fn(value.trim()) : null;
  err.textContent = msg || '';
  err.style.display = msg ? 'block' : 'none';
}

function repaint() { paintChecks(); paintSlots(); paintTier(); paintInputs(); }

document.addEventListener('input', e => {
  const el = e.target.closest('[data-field]');
  if (!el) return;
  const id = el.getAttribute('data-field');
  state.vals[id] = el.value;
  validate(id, el.value);
  persist(); paintSlots(); paintMap(); paintProgress(); paintInputs();
});

document.addEventListener('click', e => {
  const el = e.target.closest('[data-toggle],[data-w],[data-copy],[data-tier],[data-plan],[data-ai],[data-act]');
  if (!el) return;
  if (el.hasAttribute('data-copy')) {
    const pre = el.parentElement.querySelector('pre');
    if (!pre) return;
    const done = () => { el.textContent = 'Copied'; setTimeout(() => { el.textContent = 'Copy'; }, 1300); };
    if (navigator.clipboard) navigator.clipboard.writeText(pre.innerText).then(done, done); else done();
    return;
  }
  if (el.tagName === 'BUTTON' && el.hasAttribute('data-tier')) {
    state.tier = Number(el.getAttribute('data-tier')); persist(); repaint(); return;
  }
  if (el.hasAttribute('data-plan')) { state.plan = el.getAttribute('data-plan'); persist(); repaint(); return; }
  if (el.hasAttribute('data-ai')) { state.ai = el.getAttribute('data-ai'); persist(); repaint(); return; }
  const tog = el.getAttribute('data-toggle');
  if (tog) { state.done[tog] = !state.done[tog]; persist(); paintChecks(); paintProgress(); return; }
  const act = el.getAttribute('data-act');
  if (act === 'drawer') { document.querySelector('[data-drawer]').style.display = 'flex'; return; }
  if (act === 'close') { document.querySelector('[data-drawer]').style.display = 'none'; return; }
  if (act === 'print') { window.print(); return; }
  if (act === 'clear') { state.vals = {}; state.done = {}; persist(); repaint(); return; }
  const w = el.getAttribute('data-w');
  if (w) {
    document.querySelector('[data-drawer]').style.display = 'flex';
    const input = document.querySelector('[data-field="' + w + '"]');
    if (input) { input.focus(); input.select(); }
  }
});

repaint();
`
}

// ── Document ──────────────────────────────────────────────────────

export interface RenderOptions {
  /** Contents of `src/styles/tokens.css`, inlined verbatim. */
  tokensCss: string
  /** ISO date stamped into the header comment. */
  generatedAt: string
}

export function renderSetupPage(opts: RenderOptions): string {
  crossCheck()

  const head = `<!doctype html>
${headerFor('setup.html').join('\n')}
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Terraviz — install console</title>
<meta name="description" content="Guided, resumable checklist for standing up a self-hosted Terraviz node."/>
<meta name="robots" content="noindex"/>
<!--
  Same posture as public/privacy.html, relaxed by exactly one
  directive. That page can afford script-src 'none' because it has no
  script; this one carries its checklist logic inline, so it needs
  'unsafe-inline' there. Everything else stays shut: default-src
  'none' means the page cannot fetch, connect or embed anything, which
  is both a real restriction and a standing check on the claim that
  this page is self-contained. If a future change needs a network
  origin here, that is the signal to reconsider the change, not the
  policy.

  This also blocks the analytics beacon Cloudflare Pages injects into
  every deployed HTML file. privacy.html already blocks the same
  beacon via script-src 'none'; matching it keeps a third-party
  script off an operator-facing page on a privacy-first project.

  No frame-ancestors: browsers ignore it when it arrives in a
  <meta> element, and say so in the console. privacy.html carries it
  anyway and takes the console error for a directive that was never
  in force. Framing control belongs in public/_headers, which is
  where to add it if this page ever needs it.
-->
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self' data:; font-src 'self'; base-uri 'none'; form-action 'none'"/>
<link rel="icon" href="/favicon.ico" sizes="48x48"/>
<style>
${opts.tokensCss}
html,body{margin:0;padding:0}
body{background:var(--tv-bg);color:var(--tv-text);font:400 15px/1.65 var(--tv-font-sans);-webkit-font-smoothing:antialiased}
*{box-sizing:border-box}
a{color:var(--tv-accent);text-decoration:none;border-bottom:1px solid rgba(77,166,255,.3)}
a:hover{color:var(--tv-accent-hover);border-bottom-color:var(--tv-accent-hover)}
nav a,aside a{border-bottom:none}
nav a:hover,aside a:hover{background:var(--tv-surface-3)}
summary::-webkit-details-marker{display:none}
input:focus{outline:none;border-color:rgba(77,166,255,.5)!important;background:rgba(255,255,255,.08)!important}
::selection{background:rgba(77,166,255,.3)}
code{overflow-wrap:anywhere}
/* The values FAB is fixed to the viewport but the text column is not, so
   below ~1100px it lands on top of the copy. A half-screen window on a
   1920 monitor is 960px — squarely in that band, and this page is meant
   to be read beside a terminal. Shrink it to a puck. */
@media (max-width:1100px){
  [data-fab] [data-fab-label]{display:none}
  [data-fab]{padding:12px 14px!important;gap:0!important}
  /* Shrinking it is not enough — the text column has to give up the band
     the puck occupies (26px offset + 87px puck + breathing room). */
  [data-main]{padding-right:130px!important}
}
@media print{
  body{background:#fff}
  [data-noprint]{display:none!important}
  [data-shell]{display:block!important}
  [data-main]{padding:0!important;max-width:none!important}
  [data-sheet]{border:none!important;box-shadow:none!important;padding:0!important;margin:0 0 24px!important;background:none!important}
  [data-sheet],[data-sheet] *{color:#111!important}
  [data-sheet] [data-check]{border-color:#666!important;background:#fff!important}
  [data-map]{break-before:page;print-color-adjust:exact;-webkit-print-color-adjust:exact}
  [data-map] [data-cell]{background-image:linear-gradient(#bbb,#bbb)!important}
  [data-map] [data-mark]{box-shadow:0 0 0 3px #fff!important}
}
</style>
</head>
<body>
<!--
  GENERATED FILE — do not edit.

  Produced by scripts/build-setup-page.ts on ${opts.generatedAt}.
  Prose lives in scripts/setup-page/content.ts; every binding,
  prerequisite and validator is imported from the modules the setup
  tool itself uses, so this page cannot disagree with \`npm run setup\`.

  Regenerate:  npm run build:setup-page
  Verify:      npm run build:setup-page -- --check
-->`

  const hero = `<section data-noprint="1" style="margin:0 0 44px">
  <div style="${EYEBROW};margin:0 0 14px">Self-hosting a Terraviz node</div>
  <h1 style="font:300 46px/1.12 var(--tv-font-sans);letter-spacing:-.005em;color:var(--tv-text);margin:0 0 18px;max-width:17ch;text-wrap:pretty">You can have your own node running this afternoon.</h1>
  <p style="margin:0 0 14px;max-width:60ch;font-size:17px;color:var(--tv-text-muted);text-wrap:pretty">By the end, the globe is running at your own address, showing your own datasets, and only your team can publish to it. Getting there means setting up a handful of Cloudflare services, pointing your copy of the code at them, and putting your first data in.</p>
  <p style="margin:0 0 22px;max-width:60ch;font-size:17px;color:var(--tv-text-muted);text-wrap:pretty">Work straight down the page. Nothing asks you for something an earlier step has not already handed you, so you will not get halfway and discover you needed to do something else first. Fill in your details once and every command below fills itself in. Tick off each step as you finish it — this page remembers where you stopped, so you can walk away and come back.</p>
  <div style="display:flex;flex-wrap:wrap;gap:9px;margin:0 0 24px">
    ${['≈2–3 h for a publisher node', 'A domain already on Cloudflare DNS']
      .map(
        t =>
          `<span style="background:var(--tv-surface-3);border:1px solid var(--tv-border-strong);border-radius:3px;padding:5px 10px;font:500 12px/1.2 var(--tv-font-sans);color:var(--tv-text-muted)">${esc(t)}</span>`,
      )
      .join('\n    ')}
    <a href="#cost" style="background:var(--tv-surface-3);border:1px solid var(--tv-border-strong);border-bottom:1px solid var(--tv-border-strong);border-radius:3px;padding:5px 10px;font:500 12px/1.2 var(--tv-font-sans);color:var(--tv-text-muted)">Free plan works — $5/mo buys back analytics</a>
  </div>
  <p style="margin:0;font-size:13.5px;color:var(--tv-text-dim)">This page is a front door. The canonical text — every click path, every caveat — is <a href="${MARKDOWN_URL}">SELF_HOSTING.md</a>, and each phase links straight into it.</p>
</section>`

  const setupPanel = `<section data-noprint="1" style="background:var(--tv-accent-bg);border:1px solid var(--tv-accent-border);border-radius:8px;padding:28px 30px;margin:0 0 40px">
  <div style="${EYEBROW};color:var(--tv-accent);margin:0 0 12px">Start here</div>
  <h2 style="font:700 27px/1.2 var(--tv-font-sans);letter-spacing:-.01em;color:var(--tv-text);margin:0 0 14px">Let the tool do the mechanical parts</h2>
  <p style="margin:0 0 18px;max-width:62ch;color:var(--tv-text-muted);text-wrap:pretty">Most of what follows is dashboard clicking that a script can do faster and without typos. <code style="font-family:var(--tv-font-mono);font-size:.92em">npm run setup</code> provisions the resources, rewrites the config, and applies the migrations in the order that works. It creates the Access application (<code style="font-family:var(--tv-font-mono);font-size:.92em">${esc(DEFAULT_NAMES.accessApp)}</code>) with its <code style="font-family:var(--tv-font-mono);font-size:.92em">${esc(STAFF_POLICY_NAME)}</code> and <code style="font-family:var(--tv-font-mono);font-size:.92em">${esc(AUTOMATION_POLICY_NAME)}</code> policies, then writes every binding to <i>both</i> environments.</p>
  <p style="margin:0 0 12px;max-width:62ch;color:var(--tv-text-muted);text-wrap:pretty">Four ways to run it. <b style="font-weight:600;color:var(--tv-text)">These are alternatives, not a sequence</b> — one block, one command, so whatever you copy is the whole of what you meant to run.</p>
  ${[
    ['npm run setup -- --manual', 'What only a human can do, with click paths. Prints and exits.'],
    [
      'npm run setup -- --interactive',
      `Asks the ${QUESTIONS.length} questions only you can answer, validating each at the prompt.`,
    ],
    ['npm run setup', 'Plan. Says what it would do and writes nothing — this is the default.'],
    ['npm run setup -- --apply', 'Provisions the resources and wires them up. The one that changes things.'],
  ]
    .map(
      ([cmd, why]) => `<div style="margin:0 0 12px">
    ${code({ code: cmd })}
    <p style="margin:5px 0 0;font-size:12.5px;line-height:1.5;color:var(--tv-text-dim);text-wrap:pretty">${esc(why)}</p>
  </div>`,
    )
    .join('\n  ')}
  <p style="margin:0 0 18px;max-width:62ch;color:var(--tv-text-muted);text-wrap:pretty">Every phase below leads with the tool. Where a human is genuinely required — billing, an OAuth handshake, the first SSO sign-in — it says so and shows you the clicks. Where you would rather do it yourself anyway, open <b style="font-weight:600;color:var(--tv-text)">Do it by hand</b>.</p>
  <div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px">
    ${[
      ['Plan by default', 'A bare run prints what it would do and exits. No network calls.'],
      ['Idempotent', 'Re-running adopts what exists rather than making a second one.'],
      ['Resumable', 'IDs land in .terraviz-setup.json as they are found. Never secrets.'],
    ]
      .map(
        ([t, b]) => `<div style="background:var(--tv-surface-3);border:1px solid var(--tv-border);border-radius:6px;padding:14px 16px">
      <div style="font:500 12px/1.3 var(--tv-font-sans);color:var(--tv-accent);margin:0 0 4px">${esc(t)}</div>
      <div style="font:400 12px/1.5;color:var(--tv-text-dim)">${esc(b)}</div>
    </div>`,
      )
      .join('\n    ')}
  </div>
</section>`

  return `${head}
<div data-shell="1" style="display:grid;grid-template-columns:262px minmax(0,1fr)">
${sidebar()}
<main data-main="1" style="padding:54px 52px 140px;max-width:940px">
${hero}
${tierPicker()}
${costPanel()}
${preflight()}
${dependencyMap()}
${setupPanel}
${PHASES.map(phaseSection).join('\n')}
${troubleshooting()}
${weekOne()}
<footer data-noprint="1" style="margin:52px 0 0;padding-top:24px;border-top:1px solid var(--tv-border);display:flex;flex-wrap:wrap;gap:22px;align-items:baseline">
  <p style="margin:0;font-size:13.5px;color:var(--tv-text-dim);flex:1;min-width:280px;text-wrap:pretty">If something here is wrong or under-documented, open an issue. Most of this exists because someone hit a snag and it was worth writing down.</p>
  <a href="${MARKDOWN_URL}" style="font-size:13.5px">SELF_HOSTING.md ↗</a>
  <a href="${MARKDOWN_URL}#reference-a--complete-variable-inventory" style="font-size:13.5px">Variable inventory ↗</a>
</footer>
</main>
</div>
<button data-act="drawer" data-fab="1" data-noprint="1" title="Your values" style="position:fixed;right:26px;bottom:26px;z-index:40;display:flex;align-items:center;gap:10px;background:var(--tv-accent-strong);color:#fff;border:none;border-radius:6px;padding:13px 18px;font:500 13.5px/1 var(--tv-font-sans);cursor:pointer;box-shadow:0 6px 22px rgba(0,0,0,.45)">
  <span data-fab-label="1">Your values</span>
  <span data-drawer-count="1" style="font:500 12px/1 var(--tv-font-mono);background:rgba(255,255,255,.16);padding:4px 7px;border-radius:3px"></span>
</button>
${worksheetDrawer()}
<script>${runtime(WORKSHEET)}</script>
</body>
</html>
`
}
