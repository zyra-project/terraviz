/**
 * Cloudflare Pages Function — /api/feedback-admin
 *
 * Self-contained admin dashboard page for viewing feedback.
 * Prompts for the admin token, then fetches and renders dashboard data.
 * No build step — serves inline HTML.
 */

export const onRequestGet: PagesFunction = async (context) => {
  const baseUrl = new URL(context.request.url).origin

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Orbit Feedback Dashboard</title>
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
  </style>
</head>
<body>
  <div class="login-overlay" id="login">
    <div class="login-box">
      <h1>Orbit Feedback</h1>
      <p>Enter the admin token to view the dashboard</p>
      <input type="password" id="token-input" placeholder="Admin token" autocomplete="off">
      <button id="login-btn">Sign in</button>
      <div class="login-error" id="login-error"></div>
    </div>
  </div>

  <div class="dashboard hidden" id="dashboard">
    <div class="dash-header">
      <h1>Orbit Feedback Dashboard</h1>
      <div class="dash-actions">
        <button id="refresh-btn">Refresh</button>
        <button id="export-btn">Export JSONL</button>
        <button id="logout-btn">Logout</button>
      </div>
    </div>
    <div id="content"><div class="loading">Loading...</div></div>
  </div>

  <script>
    const BASE = ${JSON.stringify(baseUrl)};
    let token = sessionStorage.getItem('feedback-token') || '';

    // Auto-login if token is stored
    if (token) { tryLogin(token); }

    document.getElementById('login-btn').addEventListener('click', () => {
      const t = document.getElementById('token-input').value.trim();
      if (t) tryLogin(t);
    });
    document.getElementById('token-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') document.getElementById('login-btn').click();
    });
    document.getElementById('refresh-btn').addEventListener('click', () => loadDashboard());
    document.getElementById('logout-btn').addEventListener('click', () => {
      token = '';
      sessionStorage.removeItem('feedback-token');
      document.getElementById('login').classList.remove('hidden');
      document.getElementById('dashboard').classList.add('hidden');
    });
    document.getElementById('export-btn').addEventListener('click', async () => {
      try {
        const res = await fetch(BASE + '/api/feedback-export?include_prompt=true', {
          headers: { 'Authorization': 'Bearer ' + token }
        });
        if (!res.ok) throw new Error('Export failed');
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'feedback-export-' + new Date().toISOString().slice(0,10) + '.jsonl';
        a.click();
        URL.revokeObjectURL(url);
      } catch (err) { alert(err.message); }
    });

    async function tryLogin(t) {
      const err = document.getElementById('login-error');
      try {
        const res = await fetch(BASE + '/api/feedback-dashboard', {
          headers: { 'Authorization': 'Bearer ' + t }
        });
        if (res.status === 401) { err.textContent = 'Invalid token'; return; }
        if (!res.ok) { err.textContent = 'Server error: ' + res.status; return; }
        token = t;
        sessionStorage.setItem('feedback-token', t);
        document.getElementById('login').classList.add('hidden');
        document.getElementById('dashboard').classList.remove('hidden');
        const data = await res.json();
        renderDashboard(data);
      } catch (e) { err.textContent = 'Connection failed'; }
    }

    async function loadDashboard() {
      document.getElementById('content').innerHTML = '<div class="loading">Loading...</div>';
      try {
        const res = await fetch(BASE + '/api/feedback-dashboard?days=30&recent=100', {
          headers: { 'Authorization': 'Bearer ' + token }
        });
        const data = await res.json();
        renderDashboard(data);
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
    function escAttr(s) { return s.replace(/"/g, '&quot;').replace(/</g, '&lt;'); }
  </script>
</body>
</html>`;

  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  })
}
