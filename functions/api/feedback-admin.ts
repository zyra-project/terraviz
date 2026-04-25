/**
 * Cloudflare Pages Function — /api/feedback-admin
 *
 * Self-contained admin dashboard for viewing feedback. Auth
 * happens at the Cloudflare Access edge — by the time any
 * request reaches this function, the staff member is already
 * signed in via SSO.
 *
 * The single `/api/feedback-admin` path is the only Access
 * destination needed: this function also dispatches all data
 * operations via an `?action=` query parameter, so every admin
 * operation inherits the same Access gate. The legacy
 * stand-alone endpoints (`/api/feedback-dashboard`, `/api/feedback-export`,
 * `/api/general-feedback-{dashboard,export,screenshot}`) still
 * exist for direct scripting under the bearer-token fallback,
 * but the dashboard UI no longer touches them.
 *
 *   GET /api/feedback-admin                            → HTML
 *   GET /api/feedback-admin?action=ai-dashboard        → JSON
 *   GET /api/feedback-admin?action=general-dashboard   → JSON
 *   GET /api/feedback-admin?action=ai-export           → JSONL
 *   GET /api/feedback-admin?action=general-export      → CSV
 *   GET /api/feedback-admin?action=screenshot&id=N     → JSON
 */

import { isInternalRequest } from './ingest'
import {
  fetchAiDashboard,
  fetchGeneralDashboard,
  fetchScreenshot,
  streamAiExport,
  streamGeneralExport,
} from './_feedback-helpers'

interface Env {
  FEEDBACK_DB?: D1Database
  FEEDBACK_ADMIN_TOKEN?: string
}

function authenticate(request: Request, token?: string): boolean {
  if (isInternalRequest(request)) return true
  if (!token) return false
  const auth = request.headers.get('Authorization')
  if (!auth) return false
  const bearer = auth.replace(/^Bearer\s+/i, '')
  return bearer === token
}

const JSON_HEADERS = { 'Content-Type': 'application/json' }

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: JSON_HEADERS,
  })
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const url = new URL(context.request.url)
  const action = url.searchParams.get('action')

  if (action) {
    return handleAction(context, action, url)
  }

  const baseUrl = url.origin

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Feedback Dashboard</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0d0d12;
      color: #e8eaf0;
      min-height: 100vh;
    }
    .login-overlay {
      position: fixed; inset: 0; z-index: 100;
      background: #0d0d12;
      display: flex; align-items: center; justify-content: center;
    }
    .login-overlay.hidden { display: none; }
    .login-box {
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 12px;
      padding: 2rem;
      width: 90%; max-width: 360px;
      text-align: center;
    }
    .login-box h1 { font-size: 1.1rem; margin-bottom: 0.3rem; }
    .login-box p { font-size: 0.75rem; color: rgba(255,255,255,0.5); margin-bottom: 1.2rem; }
    .login-box input {
      width: 100%; padding: 0.6rem 0.8rem;
      background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.12);
      border-radius: 6px; color: #fff; font-size: 0.8rem; font-family: inherit;
    }
    .login-box input:focus { border-color: rgba(77,166,255,0.5); outline: none; }
    .login-box button {
      margin-top: 0.8rem; width: 100%; padding: 0.55rem;
      background: #0066cc; color: #fff; border: none; border-radius: 6px;
      font-size: 0.8rem; cursor: pointer; font-family: inherit;
    }
    .login-box button:hover { background: #0052a3; }
    .login-error { color: #ff8866; font-size: 0.7rem; margin-top: 0.5rem; min-height: 1rem; }

    .dashboard { padding: 1.5rem; max-width: 900px; margin: 0 auto; }
    .dashboard.hidden { display: none; }
    .dash-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1.5rem; flex-wrap: wrap; gap: 0.5rem; }
    .dash-header h1 { font-size: 1.2rem; }
    .dash-actions { display: flex; gap: 0.5rem; }
    .dash-actions button, .dash-actions a {
      padding: 0.4rem 0.8rem; font-size: 0.7rem; border-radius: 5px;
      border: 1px solid rgba(255,255,255,0.15); background: rgba(255,255,255,0.06);
      color: #ccc; cursor: pointer; text-decoration: none; font-family: inherit;
    }
    .dash-actions button:hover, .dash-actions a:hover { background: rgba(255,255,255,0.12); }

    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 0.75rem; margin-bottom: 1.5rem; }
    .stat-card {
      background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08);
      border-radius: 8px; padding: 0.8rem; text-align: center;
    }
    .stat-card .value { font-size: 1.6rem; font-weight: 700; color: #4da6ff; }
    .stat-card .label { font-size: 0.65rem; color: rgba(255,255,255,0.5); margin-top: 0.2rem; }
    .stat-card.positive .value { color: #64c864; }
    .stat-card.negative .value { color: #ff8866; }

    .section { margin-bottom: 1.5rem; }
    .section h2 { font-size: 0.85rem; margin-bottom: 0.6rem; color: rgba(255,255,255,0.7); }

    .tags-list { display: flex; flex-wrap: wrap; gap: 0.4rem; }
    .tag-chip {
      background: rgba(77,166,255,0.1); border: 1px solid rgba(77,166,255,0.25);
      border-radius: 12px; padding: 0.2rem 0.6rem; font-size: 0.65rem; color: #6ab8ff;
    }
    .tag-chip .count { color: rgba(255,255,255,0.4); margin-left: 0.3rem; }

    .chart-bars { display: flex; align-items: flex-end; gap: 2px; height: 100px; }
    .chart-bar-group { display: flex; flex-direction: column; align-items: center; flex: 1; min-width: 0; }
    .chart-bar-stack { display: flex; flex-direction: column-reverse; width: 100%; gap: 1px; }
    .chart-bar-up { background: #64c864; border-radius: 2px 2px 0 0; min-height: 0; }
    .chart-bar-down { background: #ff8866; border-radius: 0; min-height: 0; }
    .chart-label { font-size: 0.5rem; color: rgba(255,255,255,0.3); margin-top: 2px; writing-mode: vertical-lr; max-height: 40px; overflow: hidden; }

    table { width: 100%; border-collapse: collapse; font-size: 0.7rem; }
    th { text-align: left; padding: 0.4rem 0.5rem; color: rgba(255,255,255,0.5); border-bottom: 1px solid rgba(255,255,255,0.1); font-weight: 500; }
    td { padding: 0.4rem 0.5rem; border-bottom: 1px solid rgba(255,255,255,0.05); vertical-align: top; }
    tr.clickable { cursor: pointer; }
    tr.clickable:hover { background: rgba(255,255,255,0.03); }
    .rating-up { color: #64c864; }
    .rating-down { color: #ff8866; }
    .td-tags { display: flex; flex-wrap: wrap; gap: 0.2rem; }
    .td-tag { background: rgba(255,255,255,0.06); border-radius: 8px; padding: 0.1rem 0.35rem; font-size: 0.6rem; }
    .td-comment { max-width: 250px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .loading { text-align: center; padding: 3rem; color: rgba(255,255,255,0.4); }

    /* Detail panel */
    .detail-overlay {
      position: fixed; inset: 0; z-index: 200;
      background: rgba(0,0,0,0.6);
      display: flex; align-items: center; justify-content: center;
      padding: 1rem;
    }
    .detail-panel {
      background: #15151e; border: 1px solid rgba(255,255,255,0.1);
      border-radius: 10px; padding: 1.2rem; width: 100%; max-width: 600px;
      max-height: 85vh; overflow-y: auto;
    }
    .detail-panel h2 { font-size: 0.9rem; margin-bottom: 0.8rem; display: flex; justify-content: space-between; align-items: center; }
    .detail-close {
      background: none; border: none; color: rgba(255,255,255,0.5); font-size: 1.1rem;
      cursor: pointer; padding: 0.2rem 0.4rem;
    }
    .detail-close:hover { color: #fff; }
    .detail-field { margin-bottom: 0.6rem; }
    .detail-label { font-size: 0.6rem; color: rgba(255,255,255,0.4); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.15rem; }
    .detail-value { font-size: 0.75rem; line-height: 1.5; white-space: pre-wrap; word-break: break-word; }
    .detail-value.mono { font-family: 'SF Mono', Monaco, Consolas, monospace; font-size: 0.65rem; background: rgba(255,255,255,0.04); border-radius: 4px; padding: 0.4rem; max-height: 200px; overflow-y: auto; }
    .detail-row { display: flex; gap: 0.8rem; flex-wrap: wrap; }
    .detail-row .detail-field { flex: 1; min-width: 120px; }
    .detail-tags { display: flex; flex-wrap: wrap; gap: 0.3rem; }
    .detail-tag { background: rgba(77,166,255,0.1); border: 1px solid rgba(77,166,255,0.25); border-radius: 10px; padding: 0.15rem 0.5rem; font-size: 0.65rem; color: #6ab8ff; }
    .detail-screenshot { margin-top: 0.4rem; max-width: 100%; border-radius: 6px; border: 1px solid rgba(255,255,255,0.1); display: block; }

    /* Tab bar */
    .tab-bar { display: flex; gap: 0; margin-bottom: 1.5rem; border-bottom: 1px solid rgba(255,255,255,0.1); }
    .tab-btn {
      padding: 0.6rem 1rem; background: none; border: none;
      border-bottom: 2px solid transparent;
      color: rgba(255,255,255,0.5); font-size: 0.78rem; letter-spacing: 0.03em;
      text-transform: uppercase; cursor: pointer; font-family: inherit;
      transition: color 0.15s, border-color 0.15s;
    }
    .tab-btn:hover { color: rgba(255,255,255,0.8); }
    .tab-btn.active { color: #e8eaf0; border-bottom-color: #4da6ff; }

    /* General feedback specific */
    .stat-card.kind-bug .value { color: #ff8866; }
    .stat-card.kind-feature .value { color: #4da6ff; }
    .stat-card.kind-other .value { color: #c8a864; }
    .chart-bar-bug { background: #ff8866; border-radius: 2px 2px 0 0; min-height: 0; }
    .chart-bar-feature { background: #4da6ff; border-radius: 0; min-height: 0; }
    .chart-bar-other { background: #c8a864; border-radius: 0; min-height: 0; }
    .kind-pill {
      display: inline-block; padding: 0.1rem 0.45rem; border-radius: 10px;
      font-size: 0.6rem; text-transform: uppercase; letter-spacing: 0.04em;
    }
    .kind-pill.bug { background: rgba(255,136,102,0.15); color: #ff8866; border: 1px solid rgba(255,136,102,0.3); }
    .kind-pill.feature { background: rgba(77,166,255,0.15); color: #4da6ff; border: 1px solid rgba(77,166,255,0.3); }
    .kind-pill.other { background: rgba(200,168,100,0.15); color: #c8a864; border: 1px solid rgba(200,168,100,0.3); }
  </style>
</head>
<body>
  <div class="dashboard" id="dashboard">
    <div class="dash-header">
      <h1>Feedback Dashboard</h1>
      <div class="dash-actions">
        <button id="refresh-btn">Refresh</button>
        <button id="export-btn">Export JSONL</button>
        <button id="logout-btn">Sign out</button>
      </div>
    </div>
    <div class="tab-bar" role="tablist">
      <button class="tab-btn active" id="tab-ai" role="tab" data-tab="ai" aria-selected="true">AI Feedback</button>
      <button class="tab-btn" id="tab-general" role="tab" data-tab="general" aria-selected="false">General Feedback</button>
    </div>
    <div id="content"><div class="loading">Loading...</div></div>
  </div>

  <script>
    const BASE = ${JSON.stringify(baseUrl)};
    let activeTab = 'ai';

    // Auth happens at the Cloudflare Access edge — by the time
    // this script runs, the staff member is already signed in
    // and the Access session cookie travels with every fetch
    // automatically. No bearer token in code.
    loadDashboard();

    document.getElementById('refresh-btn').addEventListener('click', () => loadDashboard());
    document.getElementById('logout-btn').addEventListener('click', () => {
      // Cloudflare Access logout URL — invalidates the team-wide
      // session so visiting any gated app forces re-authentication.
      // The team subdomain is the same one Access redirected the
      // user to during sign-in, so a relative /cdn-cgi path works
      // from any application origin gated by the same team.
      window.location.href = '/cdn-cgi/access/logout';
    });
    document.getElementById('export-btn').addEventListener('click', exportActiveTab);

    // Tab switching
    document.getElementById('tab-ai').addEventListener('click', () => switchTab('ai'));
    document.getElementById('tab-general').addEventListener('click', () => switchTab('general'));

    function switchTab(tab) {
      if (activeTab === tab) return;
      activeTab = tab;
      document.querySelectorAll('.tab-btn').forEach(btn => {
        const selected = btn.dataset.tab === tab;
        btn.classList.toggle('active', selected);
        btn.setAttribute('aria-selected', String(selected));
      });
      // Update export button label to match the active tab's format
      document.getElementById('export-btn').textContent = tab === 'ai' ? 'Export JSONL' : 'Export CSV';
      loadDashboard();
    }

    async function exportActiveTab() {
      try {
        const endpoint = activeTab === 'ai'
          ? '/api/feedback-admin?action=ai-export&include_prompt=true'
          : '/api/feedback-admin?action=general-export';
        const res = await fetch(BASE + endpoint);
        if (!res.ok) throw new Error('Export failed');
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const ext = activeTab === 'ai' ? 'jsonl' : 'csv';
        const prefix = activeTab === 'ai' ? 'feedback-export' : 'general-feedback-export';
        a.download = prefix + '-' + new Date().toISOString().slice(0,10) + '.' + ext;
        a.click();
        URL.revokeObjectURL(url);
      } catch (err) { alert(err.message); }
    }

    async function loadDashboard() {
      document.getElementById('content').innerHTML = '<div class="loading">Loading...</div>';
      const endpoint = activeTab === 'ai'
        ? '/api/feedback-admin?action=ai-dashboard&days=30&recent=100'
        : '/api/feedback-admin?action=general-dashboard&days=30&recent=100';
      try {
        const res = await fetch(BASE + endpoint);
        if (!res.ok) {
          document.getElementById('content').innerHTML = '<div class="loading">Server error: ' + res.status + '</div>';
          return;
        }
        const data = await res.json();
        if (activeTab === 'ai') renderDashboard(data);
        else renderGeneralDashboard(data);
      } catch { document.getElementById('content').innerHTML = '<div class="loading">Failed to load</div>'; }
    }

    function renderDashboard(d) {
      const rate = d.totalCount > 0 ? Math.round(d.thumbsUpCount / d.totalCount * 100) : 0;
      let html = '<div class="stats">';
      html += statCard(d.totalCount, 'Total Ratings', '');
      html += statCard(d.thumbsUpCount, 'Positive', 'positive');
      html += statCard(d.thumbsDownCount, 'Negative', 'negative');
      html += statCard(rate + '%', 'Satisfaction', rate >= 50 ? 'positive' : 'negative');
      html += '</div>';

      // Chart
      if (d.byDay && d.byDay.length > 0) {
        const maxDay = Math.max(...d.byDay.map(r => r.up + r.down), 1);
        html += '<div class="section"><h2>Last 30 Days</h2><div class="chart-bars">';
        const days = [...d.byDay].reverse().slice(-30);
        for (const day of days) {
          const upH = Math.max((day.up / maxDay) * 90, day.up > 0 ? 2 : 0);
          const downH = Math.max((day.down / maxDay) * 90, day.down > 0 ? 2 : 0);
          html += '<div class="chart-bar-group"><div class="chart-bar-stack" style="height:90px">'
            + '<div class="chart-bar-up" style="height:' + upH + 'px"></div>'
            + '<div class="chart-bar-down" style="height:' + downH + 'px"></div>'
            + '</div><div class="chart-label">' + day.date.slice(5) + '</div></div>';
        }
        html += '</div></div>';
      }

      // Tags
      if (d.topTags && d.topTags.length > 0) {
        html += '<div class="section"><h2>Top Tags</h2><div class="tags-list">';
        for (const t of d.topTags) {
          html += '<span class="tag-chip">' + esc(t.tag) + '<span class="count">' + t.count + '</span></span>';
        }
        html += '</div></div>';
      }

      // Recent
      if (d.recentFeedback && d.recentFeedback.length > 0) {
        // Store for detail view
        window._feedbackRows = d.recentFeedback;
        html += '<div class="section"><h2>Recent Feedback</h2><table><thead><tr>';
        html += '<th>Rating</th><th>Tags</th><th>Comment</th><th>User Message</th><th>Dataset</th><th>Date</th>';
        html += '</tr></thead><tbody>';
        for (let i = 0; i < d.recentFeedback.length; i++) {
          const r = d.recentFeedback[i];
          const cls = r.rating === 'thumbs-up' ? 'rating-up' : 'rating-down';
          const icon = r.rating === 'thumbs-up' ? '\\u{1F44D}' : '\\u{1F44E}';
          const tags = (r.tags || []).map(t => '<span class="td-tag">' + esc(t) + '</span>').join('');
          const dt = formatDateTime(r.created_at);
          html += '<tr class="clickable" data-row-idx="' + i + '">'
            + '<td class="' + cls + '">' + icon + '</td>'
            + '<td><div class="td-tags">' + tags + '</div></td>'
            + '<td class="td-comment" title="' + escAttr(r.comment || '') + '">' + esc(r.comment || '-') + '</td>'
            + '<td class="td-comment" title="' + escAttr(r.user_message || '') + '">' + esc(r.user_message || '-') + '</td>'
            + '<td>' + esc(r.dataset_id || '-') + '</td>'
            + '<td style="white-space:nowrap">' + dt + '</td>'
            + '</tr>';
        }
        html += '</tbody></table></div>';
      }

      document.getElementById('content').innerHTML = html;

      // Wire row clicks
      document.querySelectorAll('tr.clickable').forEach(tr => {
        tr.addEventListener('click', () => {
          const idx = parseInt(tr.dataset.rowIdx);
          if (window._feedbackRows && window._feedbackRows[idx]) showDetail(window._feedbackRows[idx]);
        });
      });
    }

    function renderGeneralDashboard(d) {
      let html = '<div class="stats">';
      html += statCard(d.totalCount, 'Total', '');
      html += statCard(d.bugCount, 'Bugs', 'kind-bug');
      html += statCard(d.featureCount, 'Features', 'kind-feature');
      html += statCard(d.otherCount, 'Other', 'kind-other');
      html += '</div>';

      // Chart — stacked bars by kind
      if (d.byDay && d.byDay.length > 0) {
        const maxDay = Math.max(...d.byDay.map(r => r.bugs + r.features + r.other), 1);
        html += '<div class="section"><h2>Last 30 Days</h2><div class="chart-bars">';
        const days = [...d.byDay].reverse().slice(-30);
        for (const day of days) {
          const bH = Math.max((day.bugs / maxDay) * 90, day.bugs > 0 ? 2 : 0);
          const fH = Math.max((day.features / maxDay) * 90, day.features > 0 ? 2 : 0);
          const oH = Math.max((day.other / maxDay) * 90, day.other > 0 ? 2 : 0);
          html += '<div class="chart-bar-group"><div class="chart-bar-stack" style="height:90px">'
            + '<div class="chart-bar-bug" style="height:' + bH + 'px"></div>'
            + '<div class="chart-bar-feature" style="height:' + fH + 'px"></div>'
            + '<div class="chart-bar-other" style="height:' + oH + 'px"></div>'
            + '</div><div class="chart-label">' + day.date.slice(5) + '</div></div>';
        }
        html += '</div></div>';
      }

      // Recent
      if (d.recentFeedback && d.recentFeedback.length > 0) {
        window._generalRows = d.recentFeedback;
        html += '<div class="section"><h2>Recent Feedback</h2><table><thead><tr>';
        html += '<th>Kind</th><th>Message</th><th>Contact</th><th>Dataset</th><th>📷</th><th>Date</th>';
        html += '</tr></thead><tbody>';
        for (let i = 0; i < d.recentFeedback.length; i++) {
          const r = d.recentFeedback[i];
          const pill = '<span class="kind-pill ' + r.kind + '">' + r.kind + '</span>';
          const ss = r.hasScreenshot ? '📷' : '';
          const dt = formatDateTime(r.created_at);
          html += '<tr class="clickable" data-row-idx="' + i + '">'
            + '<td>' + pill + '</td>'
            + '<td class="td-comment" title="' + escAttr(r.message || '') + '">' + esc(r.message || '-') + '</td>'
            + '<td class="td-comment">' + esc(r.contact || '-') + '</td>'
            + '<td>' + esc(r.dataset_id || '-') + '</td>'
            + '<td>' + ss + '</td>'
            + '<td style="white-space:nowrap">' + dt + '</td>'
            + '</tr>';
        }
        html += '</tbody></table></div>';
      } else {
        html += '<div class="section"><div class="loading">No feedback yet.</div></div>';
      }

      document.getElementById('content').innerHTML = html;

      // Wire row clicks
      document.querySelectorAll('tr.clickable').forEach(tr => {
        tr.addEventListener('click', () => {
          const idx = parseInt(tr.dataset.rowIdx);
          if (window._generalRows && window._generalRows[idx]) showGeneralDetail(window._generalRows[idx]);
        });
      });
    }

    function showGeneralDetail(r) {
      document.getElementById('detail-overlay')?.remove();

      const overlay = document.createElement('div');
      overlay.className = 'detail-overlay';
      overlay.id = 'detail-overlay';

      const pill = '<span class="kind-pill ' + r.kind + '">' + r.kind + '</span>';

      let html = '<div class="detail-panel">';
      html += '<h2>' + pill + '<button class="detail-close" id="detail-close">&times;</button></h2>';

      html += '<div class="detail-row">';
      html += field('Date', formatDateTime(r.created_at));
      html += field('Platform', r.platform || '-');
      html += field('Dataset', r.dataset_id || '-');
      html += '</div>';

      html += '<div class="detail-field"><div class="detail-label">Message</div><div class="detail-value">' + esc(r.message || '') + '</div></div>';

      if (r.contact) html += field('Contact', r.contact);
      if (r.url) html += field('URL', r.url);
      if (r.app_version) html += field('App Version', r.app_version);
      if (r.user_agent) html += '<div class="detail-field"><div class="detail-label">User Agent</div><div class="detail-value mono">' + esc(r.user_agent) + '</div></div>';

      // Placeholder for the screenshot — populated asynchronously after
      // we fetch it from /api/general-feedback-screenshot. Dashboard
      // list responses no longer inline screenshot data URLs to keep
      // the payload small.
      if (r.hasScreenshot) {
        html += '<div class="detail-field" id="detail-screenshot-slot">'
          + '<div class="detail-label">Screenshot</div>'
          + '<div class="loading" id="detail-screenshot-loading">Loading screenshot\\u2026</div>'
          + '</div>';
      }

      html += '</div>';
      overlay.innerHTML = html;
      document.body.appendChild(overlay);

      document.getElementById('detail-close').addEventListener('click', closeDetail);
      overlay.addEventListener('click', (e) => { if (e.target === overlay) closeDetail(); });
      overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDetail(); });
      document.getElementById('detail-close').focus();

      // Lazy-fetch the screenshot
      if (r.hasScreenshot) {
        fetch(BASE + '/api/feedback-admin?action=screenshot&id=' + encodeURIComponent(r.id))
          .then(res => res.ok ? res.json() : Promise.reject(new Error('HTTP ' + res.status)))
          .then(data => {
            const slot = document.getElementById('detail-screenshot-slot');
            if (!slot || !data.screenshot) return;
            slot.innerHTML = '<div class="detail-label">Screenshot</div>'
              + '<img class="detail-screenshot" src="' + escAttr(data.screenshot) + '" alt="User-attached screenshot">';
          })
          .catch(() => {
            const loading = document.getElementById('detail-screenshot-loading');
            if (loading) loading.textContent = 'Failed to load screenshot';
          });
      }
    }

    function showDetail(r) {
      // Remove existing
      document.getElementById('detail-overlay')?.remove();

      const overlay = document.createElement('div');
      overlay.className = 'detail-overlay';
      overlay.id = 'detail-overlay';

      const ratingIcon = r.rating === 'thumbs-up' ? '\\u{1F44D} Positive' : '\\u{1F44E} Negative';
      const ratingCls = r.rating === 'thumbs-up' ? 'rating-up' : 'rating-down';
      const tags = (r.tags || []).map(t => '<span class="detail-tag">' + esc(t) + '</span>').join('');
      const model = r.modelConfig?.model || (typeof r.model_config === 'string' ? (() => { try { return JSON.parse(r.model_config).model } catch { return '' } })() : '') || '-';
      const readingLevel = r.modelConfig?.readingLevel || (typeof r.model_config === 'string' ? (() => { try { return JSON.parse(r.model_config).readingLevel } catch { return '' } })() : '') || '-';

      let html = '<div class="detail-panel">';
      html += '<h2><span class="' + ratingCls + '">' + ratingIcon + '</span><button class="detail-close" id="detail-close">&times;</button></h2>';

      // Top row: date, model, dataset
      html += '<div class="detail-row">';
      html += field('Date', formatDateTime(r.created_at));
      html += field('Model', model);
      html += field('Reading Level', readingLevel);
      html += '</div>';

      html += '<div class="detail-row">';
      html += field('Dataset', r.dataset_id || '-');
      html += field('Turn Index', r.turn_index != null ? r.turn_index : '-');
      html += field('Fallback', r.isFallback || r.is_fallback ? 'Yes (local engine)' : 'No (LLM)');
      html += '</div>';

      if (tags) {
        html += '<div class="detail-field"><div class="detail-label">Tags</div><div class="detail-tags">' + tags + '</div></div>';
      }

      if (r.comment) {
        html += field('Comment', r.comment);
      }

      html += field('User Message', r.user_message || '-');
      html += '<div class="detail-field"><div class="detail-label">Assistant Response</div><div class="detail-value mono">' + esc(r.assistant_message || '-') + '</div></div>';

      if (r.system_prompt) {
        html += '<div class="detail-field"><div class="detail-label">System Prompt</div><div class="detail-value mono">' + esc(r.system_prompt) + '</div></div>';
      }

      // Context summary
      const ctxParts = [];
      if (r.historyCompressed || r.history_compressed) ctxParts.push('History was compressed');
      const vision = r.modelConfig?.visionEnabled || (typeof r.model_config === 'string' ? (() => { try { return JSON.parse(r.model_config).visionEnabled } catch { return false } })() : false);
      if (vision) ctxParts.push('Vision mode active');
      if (ctxParts.length > 0) {
        html += field('Context Flags', ctxParts.join(' \\u{2022} '));
      }

      html += '</div>';
      overlay.innerHTML = html;
      document.body.appendChild(overlay);

      // Close handlers
      document.getElementById('detail-close').addEventListener('click', closeDetail);
      overlay.addEventListener('click', (e) => { if (e.target === overlay) closeDetail(); });
      overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDetail(); });
      document.getElementById('detail-close').focus();
    }

    function closeDetail() {
      document.getElementById('detail-overlay')?.remove();
    }

    function field(label, value) {
      return '<div class="detail-field"><div class="detail-label">' + esc(label) + '</div><div class="detail-value">' + esc(String(value)) + '</div></div>';
    }

    function formatDateTime(iso) {
      if (!iso) return '-';
      try {
        const d = new Date(iso);
        return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
          + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
      } catch { return iso.slice(0, 16).replace('T', ' '); }
    }

    function statCard(val, label, cls) {
      return '<div class="stat-card ' + cls + '"><div class="value">' + val + '</div><div class="label">' + label + '</div></div>';
    }
    function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
    function escAttr(s) { return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  </script>
</body>
</html>`;

  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  })
}

async function handleAction(
  context: EventContext<Env, string, unknown>,
  action: string,
  url: URL,
): Promise<Response> {
  if (!authenticate(context.request, context.env.FEEDBACK_ADMIN_TOKEN)) {
    return jsonError('Unauthorized', 401)
  }

  const db = context.env.FEEDBACK_DB
  if (!db) {
    return jsonError('Database not configured', 503)
  }

  try {
    switch (action) {
      case 'ai-dashboard': {
        const days = Math.min(Math.max(parseInt(url.searchParams.get('days') ?? '30') || 30, 1), 365)
        const recent = Math.min(Math.max(parseInt(url.searchParams.get('recent') ?? '50') || 50, 1), 200)
        const data = await fetchAiDashboard(db, days, recent)
        return new Response(JSON.stringify(data), { headers: JSON_HEADERS })
      }
      case 'general-dashboard': {
        const days = Math.min(Math.max(parseInt(url.searchParams.get('days') ?? '30') || 30, 1), 365)
        const recent = Math.min(Math.max(parseInt(url.searchParams.get('recent') ?? '100') || 100, 1), 200)
        const data = await fetchGeneralDashboard(db, days, recent)
        return new Response(JSON.stringify(data), { headers: JSON_HEADERS })
      }
      case 'ai-export': {
        const since = url.searchParams.get('since')
        const rating = url.searchParams.get('rating')
        const includePrompt = url.searchParams.get('include_prompt') === 'true'
        const limit = parseInt(url.searchParams.get('limit') ?? '1000') || 1000
        const stream = await streamAiExport(db, { since, rating, includePrompt, limit })
        return new Response(stream, {
          headers: {
            'Content-Type': 'application/jsonl',
            'Content-Disposition': `attachment; filename="feedback-export-${new Date().toISOString().slice(0, 10)}.jsonl"`,
          },
        })
      }
      case 'general-export': {
        const since = url.searchParams.get('since')
        const kind = url.searchParams.get('kind')
        const limit = parseInt(url.searchParams.get('limit') ?? '10000') || 10000
        const stream = await streamGeneralExport(db, { since, kind, limit })
        return new Response(stream, {
          headers: {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': `attachment; filename="general-feedback-export-${new Date().toISOString().slice(0, 10)}.csv"`,
          },
        })
      }
      case 'screenshot': {
        const idParam = url.searchParams.get('id')
        const id = idParam ? parseInt(idParam, 10) : NaN
        if (!Number.isFinite(id) || id <= 0) {
          return jsonError('Invalid id', 400)
        }
        const result = await fetchScreenshot(db, id)
        if (!result) return jsonError('Not found', 404)
        return new Response(JSON.stringify(result), { headers: JSON_HEADERS })
      }
      default:
        return jsonError('Unknown action', 400)
    }
  } catch (err) {
    console.error(`feedback-admin action=${action} failed:`, err)
    return jsonError('Query failed', 500)
  }
}
