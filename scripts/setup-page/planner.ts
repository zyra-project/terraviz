// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The `/setup` questionnaire: what the operator wants the node to do,
 * and whether they can run GitHub Actions, turned into a plan.
 *
 * ## Why
 *
 * The page used to open on one choice, a node tier, described by what
 * each tier gets. A tier does not say what its parts need, and the
 * line that actually divides a publisher node is GitHub Actions in a
 * repository the operator controls: video uploads, Zyra pipelines, the
 * feeds and the analytics history run there. An operator who cloned
 * upstream and deployed by Direct Upload picked Tier 2, followed the
 * page, and had half of it fail, most of it silently. These questions
 * come first so that the answer arrives before the install does.
 *
 * ## Why here and not in `render.ts`
 *
 * `render.ts` and `content.ts` are replaced by each design export (see
 * `shell.ts`). This module is not, so `applyShell` injects the section
 * and its runtime into the rendered page, and `shell.test.ts` fails if
 * the committed page lacks either. The runtime does not replace the
 * export's tier picker. It sets the tier by clicking the picker's own
 * button, so the export keeps owning which phases, bindings and
 * variables a tier shows, and the picker still works as an override.
 *
 * ## One plan, two languages
 *
 * `planNode` in `scripts/lib/setup/capabilities.ts` is the plan in
 * TypeScript, for `npm run setup` and the tests. The page has no
 * bundler, so `PLAN_LOGIC` restates it in plain JavaScript, and
 * `planner.test.ts` runs that source against `planNode` for every
 * selection and answer. They cannot drift without a red build.
 */

import {
  BASELINE,
  CAPABILITIES,
  REQUIREMENT_ORDER,
  REQUIREMENTS,
  SETUP_FEATURES,
  TIER_NAMES,
  type Capability,
} from '../lib/setup/capabilities'

/** Marks the injected section, and is what `applyPlanner` checks for. */
export const PLANNER_MARK = 'data-tv-planner'

/** Where the operator's answers live in the browser. */
export const PLANNER_STORAGE_KEY = 'terraviz-setup-planner-v1'

/**
 * Where the export's own runtime keeps its state, tier included. Read
 * only, to start the tier buttons' `aria-pressed` in step; a test
 * fails if the export stops using this key.
 */
export const EXPORT_STORAGE_KEY = 'terraviz-setup-console-v1'

const esc = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

const EYEBROW =
  'font:600 10.5px/1.35 var(--tv-font-sans);letter-spacing:.13em;text-transform:uppercase;color:var(--tv-text-dim)'
const CODE =
  'font:500 12px/1.4 var(--tv-font-mono);background:var(--tv-surface-code);padding:1px 5px;border-radius:3px'
const SR_ONLY =
  'position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0'
const LEGEND = 'font:600 14px/1.4 var(--tv-font-sans);color:var(--tv-text);padding:0;margin:0 0 6px'
const HELP = 'margin:0 0 12px;max-width:64ch;font-size:13px;color:var(--tv-text-muted);text-wrap:pretty'
const OPTION =
  'display:flex;gap:10px;align-items:flex-start;cursor:pointer;border-radius:8px;padding:12px 14px;' +
  'background:var(--tv-surface-3);border:1px solid var(--tv-border)'

/** The requirements a card shows; every capability here needs the backend. */
const badges = (cap: Capability): string =>
  cap.needs
    .filter(r => r !== 'backend')
    .map(r => REQUIREMENTS[r].short)
    .join(' · ')

function capabilityOption(cap: Capability): string {
  const id = `tvp-cap-${cap.id}`
  const needs = badges(cap)
  const describedBy = [`${id}-sum`, needs ? `${id}-needs` : '', `${id}-implied`, `${id}-blocked`]
    .filter(Boolean)
    .join(' ')
  return `<label for="${id}" style="${OPTION}">
      <input type="checkbox" id="${id}" data-tvp-cap="${cap.id}" aria-labelledby="${id}-title" aria-describedby="${describedBy}" style="margin:3px 0 0;flex:none;width:16px;height:16px;accent-color:var(--tv-accent)"/>
      <span style="display:block">
        <span id="${id}-title" style="display:block;font:600 13.5px/1.35 var(--tv-font-sans);color:var(--tv-text)">${esc(cap.title)}</span>
        <span id="${id}-sum" style="display:block;font-size:12.5px;line-height:1.5;color:var(--tv-text-muted);margin:3px 0 0;text-wrap:pretty">${esc(cap.summary)}</span>
        ${needs ? `<span id="${id}-needs" style="display:block;font:500 11px/1.5 var(--tv-font-mono);color:var(--tv-text-dim);margin:6px 0 0">Needs: ${esc(needs)}</span>` : ''}
        <span id="${id}-implied" data-tvp-implied="${cap.id}" style="display:block;font-size:12px;color:var(--tv-accent);margin:4px 0 0"></span>
        <span id="${id}-blocked" data-tvp-blocked="${cap.id}" style="display:block;font-size:12px;color:var(--tv-warn);margin:4px 0 0"></span>
      </span>
    </label>`
}

const ACTIONS_OPTIONS: Array<{ value: 'yes' | 'no' | 'unsure'; label: string; hint: string }> = [
  {
    value: 'yes',
    label: 'Yes',
    hint: 'A fork, or your own copy, that you can push to, with Actions turned on.',
  },
  {
    value: 'no',
    label: 'No',
    hint: 'A clone of upstream deployed straight to Cloudflare, or Actions are not allowed where you work.',
  },
  { value: 'unsure', label: 'Not sure yet', hint: 'The plan flags what depends on it.' },
]

/**
 * Rules inline styles cannot express. The page's own stylesheet sets
 * `input:focus{outline:none}` for its text fields, which leaves a
 * native checkbox or radio with no focus indicator at all (WCAG
 * 2.4.7), so focus is drawn on the control and on its card. An
 * implied capability is `aria-disabled` rather than `disabled`, so it
 * stays in the tab order with its "Included with" note; its card reads
 * as inactive here.
 */
const PLANNER_STYLE =
  `[${PLANNER_MARK}] input:focus-visible{outline:2px solid var(--tv-accent);outline-offset:2px}` +
  `[${PLANNER_MARK}] label:has(input:focus-visible){border-color:var(--tv-accent)!important}` +
  `[${PLANNER_MARK}] label:has(input[aria-disabled="true"]){opacity:.72;cursor:default}`

/** The static half: the questions, rendered at build time. */
export function plannerSection(): string {
  const actionsOptions = ACTIONS_OPTIONS.map(
    o => `<label for="tvp-actions-${o.value}" style="${OPTION}">
      <input type="radio" name="tvp-actions" id="tvp-actions-${o.value}" value="${o.value}" data-tvp-actions="1" aria-labelledby="tvp-actions-${o.value}-label" aria-describedby="tvp-actions-${o.value}-hint" style="margin:3px 0 0;flex:none;width:16px;height:16px;accent-color:var(--tv-accent)"/>
      <span style="display:block">
        <span id="tvp-actions-${o.value}-label" style="display:block;font:600 13.5px/1.35 var(--tv-font-sans);color:var(--tv-text)">${esc(o.label)}</span>
        <span id="tvp-actions-${o.value}-hint" style="display:block;font-size:12.5px;line-height:1.5;color:var(--tv-text-muted);margin:3px 0 0">${esc(o.hint)}</span>
      </span>
    </label>`,
  ).join('\n    ')

  return `<section ${PLANNER_MARK}="1" data-noprint="1" aria-labelledby="tvp-title" style="margin:0 0 44px">
  <style>${PLANNER_STYLE}</style>
  <div style="${EYEBROW};margin:0 0 12px">Step one · what this node will do</div>
  <h2 id="tvp-title" style="font:600 20px/1.3 var(--tv-font-sans);color:var(--tv-text);margin:0 0 10px">What do you want this node to do?</h2>
  <p style="${HELP}">Every node has ${esc(BASELINE.charAt(0).toLowerCase() + BASELINE.slice(1))} Tick what you want on top, and say whether you can run GitHub Actions. The page works out your node type and what you will have to set up, before you start rather than halfway through.</p>
  <fieldset style="border:none;margin:0 0 22px;padding:0;min-width:0">
    <legend style="${LEGEND}">On top of the globe, I want to…</legend>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,260px),1fr));gap:10px;margin:8px 0 0">
    ${CAPABILITIES.map(capabilityOption).join('\n    ')}
    </div>
  </fieldset>
  <fieldset aria-describedby="tvp-actions-help" style="border:none;margin:0 0 22px;padding:0;min-width:0">
    <legend style="${LEGEND}">Can you run GitHub Actions in a repository you control?</legend>
    <p id="tvp-actions-help" style="${HELP}">Video uploads, Zyra pipelines, the feeds, analytics history and desktop builds run as GitHub Actions workflows in your copy of the repository. A clone you cannot push to has nowhere to run them.</p>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,220px),1fr));gap:10px">
    ${actionsOptions}
    </div>
  </fieldset>
  <div role="region" aria-labelledby="tvp-plan-title" style="background:var(--tv-surface-2);border:1px solid var(--tv-border);border-radius:8px;padding:20px 22px">
    <h3 id="tvp-plan-title" style="font:600 15px/1.3 var(--tv-font-sans);color:var(--tv-text);margin:0 0 10px">Your plan</h3>
    <div data-tvp-plan="1"><p style="${HELP}">Tick what you want above to see your plan.</p></div>
  </div>
  <p data-tvp-status="1" aria-live="polite" style="${SR_ONLY}"></p>
</section>`
}

/**
 * `planNode`, in the plain JavaScript the page can run. Ids rather
 * than capability objects, which is the only difference the parity
 * test allows for.
 */
export const PLAN_LOGIC = `
function tvpPlan(D, selected, actions) {
  var byId = {};
  D.caps.forEach(function (c) { byId[c.id] = c; });
  var wanted = {};
  function add(id) {
    if (wanted[id] || !byId[id]) return;
    wanted[id] = true;
    byId[id].implies.forEach(add);
  }
  selected.forEach(add);
  var plan = { tier: 1, have: [], blocked: [], atRisk: [], requirements: [], workflows: [], features: [] };
  var reqs = {}, feats = {};
  D.caps.forEach(function (c) {
    if (!wanted[c.id]) return;
    var needsActions = c.needs.indexOf('github-actions') !== -1;
    if (needsActions && actions === 'no') { plan.blocked.push(c.id); return; }
    if (needsActions && actions === 'unsure') plan.atRisk.push(c.id); else plan.have.push(c.id);
    c.needs.forEach(function (r) { reqs[r] = true; });
    c.workflows.forEach(function (w) {
      if (!plan.workflows.some(function (x) { return x.file === w.file; })) plan.workflows.push(w);
    });
    if (c.feature) feats[c.feature] = true;
    if (c.tier > plan.tier) plan.tier = c.tier;
  });
  plan.requirements = D.requirementOrder.filter(function (r) { return reqs[r]; });
  plan.features = D.features.filter(function (f) { return feats[f]; });
  return plan;
}
function tvpCommand(features) {
  return features.length === 0
    ? 'npm run setup -- --interactive'
    : 'npm run setup -- --interactive --with=' + features.join(',');
}
`

/** What the runtime needs from the manifest, and nothing else. */
export function plannerData(): unknown {
  return {
    caps: CAPABILITIES.map(c => ({
      id: c.id,
      title: c.title,
      needs: c.needs,
      implies: c.implies,
      workflows: c.workflows,
      feature: c.feature ?? null,
      tier: c.tier,
      withoutActions: c.withoutActions ?? null,
      byHand: c.byHand ?? null,
    })),
    requirements: REQUIREMENTS,
    requirementOrder: REQUIREMENT_ORDER,
    features: SETUP_FEATURES,
    tiers: TIER_NAMES,
    baseline: BASELINE,
  }
}

/** JSON safe to put inside a `<script>`. */
const LINE_SEPARATOR = String.fromCharCode(0x2028)
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029)
const scriptJson = (value: unknown): string =>
  JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .split(LINE_SEPARATOR)
    .join('\\u2028')
    .split(PARAGRAPH_SEPARATOR)
    .join('\\u2029')

/** The dynamic half: restores the answers, paints the plan, sets the tier. */
export function plannerRuntime(): string {
  return `
(function () {
  var root = document.querySelector('[${PLANNER_MARK}]');
  if (!root) return;
  var D = ${scriptJson(plannerData())};
  var KEY = ${JSON.stringify(PLANNER_STORAGE_KEY)};
${PLAN_LOGIC}
  var byId = {};
  D.caps.forEach(function (c) { byId[c.id] = c; });
  var saved = { caps: [], actions: null };
  try {
    var raw = localStorage.getItem(KEY);
    if (raw) {
      var s = JSON.parse(raw);
      if (Array.isArray(s.caps)) saved.caps = s.caps.filter(function (id) { return byId[id]; });
      if (s.actions === 'yes' || s.actions === 'no' || s.actions === 'unsure') saved.actions = s.actions;
    }
  } catch (e) {}
  function persist() { try { localStorage.setItem(KEY, JSON.stringify(saved)); } catch (e) {} }

  var boxes = Array.prototype.slice.call(root.querySelectorAll('[data-tvp-cap]'));
  var radios = Array.prototype.slice.call(root.querySelectorAll('[data-tvp-actions]'));
  var body = root.querySelector('[data-tvp-plan]');
  var status = root.querySelector('[data-tvp-status]');

  function el(tag, style, text) {
    var n = document.createElement(tag);
    if (style) n.style.cssText = style;
    if (text != null) n.textContent = text;
    return n;
  }
  // Backtick spans as <code>, the rest as text.
  function inline(parent, text) {
    String(text).split('\`').forEach(function (part, i) {
      if (i % 2 === 1) parent.appendChild(el('code', ${JSON.stringify(CODE)}, part));
      else if (part) parent.appendChild(document.createTextNode(part));
    });
    return parent;
  }
  var H = 'font:600 13px/1.4 var(--tv-font-sans);color:var(--tv-text);margin:16px 0 6px';
  var LIST = 'margin:0;padding-inline-start:20px;font-size:13px;line-height:1.55;color:var(--tv-text-muted)';
  var WARN = 'background:var(--tv-warn-bg);border:1px solid var(--tv-warn-border);border-radius:6px;padding:12px 14px;margin:14px 0 0';
  function list(items) {
    var ul = el('ul', LIST);
    items.forEach(function (fill) { var li = el('li', 'margin:0 0 4px'); fill(li); ul.appendChild(li); });
    return ul;
  }
  function closure(ids) {
    var out = {};
    function add(id) { if (out[id] || !byId[id]) return; out[id] = true; byId[id].implies.forEach(add); }
    ids.forEach(add);
    return out;
  }

  function paintPlan(plan) {
    body.textContent = '';
    // Untouched, the export's picker still shows its own default, so
    // claiming a tier here would contradict the page.
    if (untouched()) {
      body.appendChild(el('p', 'margin:0;font-size:13px;color:var(--tv-text-muted)',
        'Tick what you want above, and answer the GitHub Actions question, to see your plan.'));
      return;
    }
    var lead = el('p', 'margin:0;font-size:13.5px;color:var(--tv-text)');
    lead.appendChild(el('strong', '', 'Tier ' + plan.tier + ' \\u00b7 ' + D.tiers[plan.tier] + '. '));
    lead.appendChild(document.createTextNode('The node-type picker below follows your answers; pick another there to override it.'));
    body.appendChild(lead);
    if (!saved.actions) {
      body.appendChild(el('p', 'margin:8px 0 0;font-size:13px;color:var(--tv-warn)',
        'Answer the GitHub Actions question to see which of these will work.'));
    }

    body.appendChild(el('h4', H, 'You will have'));
    var have = [function (li) { li.textContent = D.baseline; }];
    plan.have.forEach(function (id) { have.push(function (li) { li.textContent = byId[id].title; }); });
    plan.atRisk.forEach(function (id) {
      have.push(function (li) { li.textContent = byId[id].title + ' (if you can run GitHub Actions)'; });
    });
    body.appendChild(list(have));

    if (plan.blocked.length) {
      var box = el('div', WARN);
      box.appendChild(el('h4', H.replace('margin:16px 0 6px', 'margin:0 0 6px'), 'Not possible without GitHub Actions'));
      box.appendChild(list(plan.blocked.map(function (id) {
        return function (li) {
          var c = byId[id];
          li.appendChild(el('strong', 'color:var(--tv-text)', c.title + ': '));
          inline(li, c.withoutActions || '');
          if (c.byHand) { li.appendChild(document.createTextNode(' By hand: ')); inline(li, c.byHand); }
        };
      })));
      box.appendChild(el('p', 'margin:8px 0 0;font-size:13px;color:var(--tv-text-muted)',
        'To have these, install from a fork or your own copy of the repository with Actions turned on (SELF_HOSTING.md \\u00a7 0.2). You can add them later; nothing here has to be redone.'));
      body.appendChild(box);
    }
    if (plan.atRisk.length) {
      var risk = el('div', WARN);
      risk.appendChild(el('h4', H.replace('margin:16px 0 6px', 'margin:0 0 6px'), 'Check before you start: these need GitHub Actions'));
      risk.appendChild(list(plan.atRisk.map(function (id) {
        return function (li) {
          var c = byId[id];
          li.appendChild(el('strong', 'color:var(--tv-text)', c.title + '. '));
          li.appendChild(document.createTextNode('Without Actions: '));
          inline(li, c.withoutActions || '');
        };
      })));
      body.appendChild(risk);
    }

    body.appendChild(el('h4', H, 'What you will set up'));
    if (!plan.requirements.length) {
      body.appendChild(el('p', 'margin:0;font-size:13px;color:var(--tv-text-muted)',
        'Nothing beyond a viewer node: Phases 0 to 5, the five Tier 1 bindings in Phase 8, the checks in Phase 10, and a CSP before you go public (Phase 13).'));
    } else {
      body.appendChild(list(plan.requirements.map(function (r) {
        return function (li) {
          var info = D.requirements[r];
          li.appendChild(el('strong', 'color:var(--tv-text)', info.label));
          li.appendChild(document.createTextNode(' (' + info.where + '). ' + info.detail));
        };
      })));
    }

    if (plan.workflows.length) {
      body.appendChild(el('h4', H, 'Workflows your plan uses'));
      body.appendChild(el('p', 'margin:0 0 6px;font-size:13px;color:var(--tv-text-muted)',
        'Turn Actions on for your repository, then enable each scheduled one in the Actions tab: a fork keeps them off until you do.'));
      var HOW = { schedule: 'scheduled: enable it', dispatch: 'starts by itself once Actions are on', manual: 'run it from Run workflow' };
      body.appendChild(list(plan.workflows.map(function (w) {
        return function (li) { inline(li, '\`' + w.file + '\` \\u2014 ' + w.when + ' (' + HOW[w.trigger] + ')'); };
      })));
    }

    body.appendChild(el('h4', H, 'Then run'));
    body.appendChild(el('pre', 'margin:0;padding:10px 12px;background:var(--tv-surface-code);border-radius:6px;white-space:pre-wrap;overflow-wrap:anywhere;font:500 12.5px/1.5 var(--tv-font-mono);color:var(--tv-text)',
      tvpCommand(plan.features)));
  }

  function paint(announce) {
    // \`announce\` is the debounced announcer, or null for the first paint.
    var effective = closure(saved.caps);
    boxes.forEach(function (box) {
      var id = box.getAttribute('data-tvp-cap');
      var by = saved.caps.filter(function (other) { return other !== id && closure([other])[id]; });
      box.checked = !!effective[id];
      // aria-disabled, not disabled: a disabled box leaves the tab
      // order and takes its "Included with" note with it.
      if (by.length) box.setAttribute('aria-disabled', 'true'); else box.removeAttribute('aria-disabled');
      var note = root.querySelector('[data-tvp-implied="' + id + '"]');
      if (note) note.textContent = by.length ? 'Included with: ' + by.map(function (o) { return byId[o].title; }).join(', ') : '';
      var blocked = root.querySelector('[data-tvp-blocked="' + id + '"]');
      var needsActions = byId[id].needs.indexOf('github-actions') !== -1;
      if (blocked) blocked.textContent = effective[id] && needsActions && saved.actions === 'no'
        ? 'Not possible without GitHub Actions. Your plan says why.' : '';
    });
    radios.forEach(function (r) { r.checked = r.value === saved.actions; });
    var plan = tvpPlan(D, saved.caps, saved.actions || 'unsure');
    paintPlan(plan);
    // Boxes ticked on the operator's behalf since the last paint: a
    // sighted operator sees them change, so the announcement says so.
    var added = Object.keys(effective).filter(function (id) {
      return !lastEffective[id] && saved.caps.indexOf(id) === -1;
    });
    lastEffective = effective;
    if (announce && status && untouched()) {
      announce('Plan cleared.');
    } else if (announce && status) {
      var msg = 'Plan updated: Tier ' + plan.tier + ', ' + D.tiers[plan.tier] + '.';
      if (added.length) msg += ' Also includes: ' + added.map(function (id) { return byId[id].title; }).join(', ') + '.';
      var n = plan.blocked.length || plan.atRisk.length;
      var choices = n === 1 ? '1 of your choices ' : n + ' of your choices ';
      if (plan.blocked.length) msg += ' ' + choices + (n === 1 ? 'needs' : 'need') + ' GitHub Actions you do not have.';
      else if (plan.atRisk.length) msg += ' ' + choices + (n === 1 ? 'depends' : 'depend') + ' on GitHub Actions.';
      announce(msg);
    }
    return plan;
  }

  // Arrowing through the radios changes the answer on every key, so
  // the summary waits for a pause and is not repeated word for word.
  var lastEffective = {};
  var lastSaid = '';
  var timer = null;
  function announce(msg) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(function () {
      timer = null;
      if (msg === lastSaid) return;
      lastSaid = msg;
      status.textContent = msg;
    }, 500);
  }

  // The tier picker is the export's: it shows the selected tier by
  // colour alone, and the plan tells people to use it as an override,
  // so its pressed state is kept here. The export stores its tier
  // under its own key; this reads it only to start in step.
  var tierButtons = Array.prototype.slice.call(document.querySelectorAll('button[data-tier]'));
  function pressTier(n) {
    tierButtons.forEach(function (b) {
      b.setAttribute('aria-pressed', String(Number(b.getAttribute('data-tier')) === n));
    });
  }
  var startTier = 2;
  try {
    var exported = JSON.parse(localStorage.getItem(${JSON.stringify(EXPORT_STORAGE_KEY)}) || '{}');
    if (exported.tier === 1 || exported.tier === 2 || exported.tier === 3) startTier = exported.tier;
  } catch (e) {}
  pressTier(startTier);
  tierButtons.forEach(function (b) {
    b.addEventListener('click', function () { pressTier(Number(b.getAttribute('data-tier'))); });
  });

  // An implied box stays focusable, so the toggle is refused here.
  root.addEventListener('click', function (e) {
    var t = e.target;
    if (t && t.matches && t.matches('[data-tvp-cap][aria-disabled="true"]')) e.preventDefault();
  });

  root.addEventListener('change', function (e) {
    var t = e.target;
    if (t.hasAttribute('data-tvp-cap')) {
      var id = t.getAttribute('data-tvp-cap');
      saved.caps = saved.caps.filter(function (x) { return x !== id; });
      if (t.checked) saved.caps.push(id);
    } else if (t.hasAttribute('data-tvp-actions')) {
      saved.actions = t.value;
    } else {
      return;
    }
    persist();
    var plan = paint(announce);
    // The export's own picker owns what a tier shows; drive it rather
    // than duplicate it. Only when the answers move the tier, so a tier
    // the operator picked by hand survives a change that does not, and
    // never for an untouched form, which claims no tier at all.
    var tier = untouched() ? null : plan.tier;
    if (tier !== null && tier !== lastTier) {
      var button = document.querySelector('button[data-tier="' + tier + '"]');
      if (button) button.click();
    }
    lastTier = tier;
  });

  function untouched() { return !saved.caps.length && !saved.actions; }
  var first = paint(null);
  var lastTier = untouched() ? null : first.tier;
})();
`
}

/**
 * Put the questionnaire in front of the export's tier picker, and its
 * runtime before `</body>`. Idempotent, and a no-op on a page with no
 * tier picker (the fragments `shell.test.ts` feeds `applyShell`). The
 * build then calls `assertPlannerPresent`, so a real page that lost
 * its picker fails rather than shipping without its first question.
 */
export function applyPlanner(html: string, injectedMark: string): { html: string; applied: boolean } {
  if (html.includes(`${PLANNER_MARK}="1"`)) return { html, applied: false }
  const button = html.search(/<button[^>]*\bdata-tier="1"/)
  const section = button === -1 ? -1 : html.lastIndexOf('<section', button)
  if (section === -1) return { html, applied: false }
  let out = `${html.slice(0, section)}${plannerSection()}\n${html.slice(section)}`
  out = out.replace(
    '</body>',
    () => `<script ${injectedMark}="planner">${plannerRuntime()}</script>\n</body>`,
  )
  return { html: out, applied: true }
}

/** Fail the build on a page without the questions or their runtime. */
export function assertPlannerPresent(html: string): void {
  if (!html.includes(`${PLANNER_MARK}="1"`) || !html.includes('="planner">')) {
    throw new Error(
      'The capability questions are missing from the page: no <section> holding a\n' +
        '<button data-tier="1"> to put them in front of. The export changed the tier\n' +
        'picker — update applyPlanner() in scripts/setup-page/planner.ts.',
    )
  }
}
