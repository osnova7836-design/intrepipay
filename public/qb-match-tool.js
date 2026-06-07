(function () {
  'use strict';

  if (document.getElementById('qbmt-panel')) document.getElementById('qbmt-panel').remove();

  const COMPANY_ID = '9130357925095736';
  const ACCOUNT_ID = '149';
  const BASE = `https://qbo.intuit.com/api/neo/v1/company/${COMPANY_ID}/olb/ng`;

  // ─── Parsing ────────────────────────────────────────────────────────────────

  function parseDesc(orig, desc) {
    const raw = orig || desc || '';

    // ATM / Mobile batch deposit — cannot be individually matched
    if (/BKOFAMERICA\s+(ATM|MOBILE)\s+/i.test(raw)) {
      return { type: 'BATCH', ref: null, name: null };
    }

    // Zelle: "Zelle payment from NAME for "..."; Conf# CODE"
    const zelle = raw.match(/Zelle payment from\s+(.+?)(?:\s+for\s+"[^"]*")?\s*;?\s*Conf#\s*([A-Z0-9]+)/i);
    if (zelle) {
      return { type: 'ZELLE', ref: zelle[2].toUpperCase(), name: zelle[1].trim() };
    }

    // Individual check: leading number (check #) followed by a name
    const check = raw.match(/^(\d{1,6})\s+([A-Za-z][A-Za-z\s\-'.]{1,30})/);
    if (check) {
      return { type: 'CHECK', ref: check[1], name: check[2].trim() };
    }

    // Company ACH / everything else — match by name
    return { type: 'COMPANY', ref: null, name: desc || raw.substring(0, 50) };
  }

  function normRef(s) { return String(s || '').replace(/\W/g, '').toLowerCase(); }
  function normName(s) { return (s || '').toLowerCase().replace(/[^a-z\s]/g, '').trim(); }

  function nameMatch(qbName, parsedName) {
    const qb = normName(qbName);
    const words = normName(parsedName).split(/\s+/).filter(w => w.length > 2);
    return words.some(w => qb.includes(w));
  }

  // ─── Matching ───────────────────────────────────────────────────────────────

  function findMatch(txn, parsed) {
    const sug = txn.suggestedMatches?.matchedTxns || [];

    if (parsed.type === 'BATCH') return { s: null, conf: 'BATCH' };

    if (parsed.type === 'CHECK' || parsed.type === 'ZELLE') {
      // EXACT: ref AND name both agree
      for (const s of sug) {
        if (parsed.ref && normRef(s.refNum) === normRef(parsed.ref) && nameMatch(s.name, parsed.name))
          return { s, conf: 'EXACT' };
      }
      // Ref matches but name mismatch — suspicious, needs review
      for (const s of sug) {
        if (parsed.ref && normRef(s.refNum) === normRef(parsed.ref))
          return { s, conf: 'REF_ONLY' };
      }
      // Ref not found anywhere in suggestions — data entry problem in QB
      if (parsed.ref) return { s: null, conf: 'REF_MISSING' };
      // No ref at all — name + amount fallback
      for (const s of sug) {
        if (nameMatch(s.name, parsed.name) && Math.abs((s.amount || 0) - txn.amount) < 0.01)
          return { s, conf: 'NAME_AMOUNT' };
      }
      return { s: null, conf: 'NO_MATCH' };
    }

    if (parsed.type === 'COMPANY') {
      for (const s of sug) {
        if (nameMatch(s.name, parsed.name) || nameMatch(parsed.name, s.name))
          return { s, conf: 'COMPANY' };
      }
      if (sug.length === 1) return { s: sug[0], conf: 'SINGLE' };
      return { s: null, conf: 'NO_MATCH' };
    }

    return { s: null, conf: 'NO_MATCH' };
  }

  const CONF = {
    EXACT:       { label: 'Exact Match',   color: '#15803d', bg: '#dcfce7', auto: true  },
    REF_ONLY:    { label: 'Name Mismatch', color: '#b45309', bg: '#fef3c7', auto: false },
    NAME_AMOUNT: { label: 'Name + Amount', color: '#0369a1', bg: '#dbeafe', auto: false },
    COMPANY:     { label: 'Company',       color: '#0369a1', bg: '#dbeafe', auto: false },
    SINGLE:      { label: 'Only Option',   color: '#0369a1', bg: '#dbeafe', auto: false },
    REF_MISSING: { label: 'Ref Not in QB', color: '#b91c1c', bg: '#fee2e2', auto: false },
    NO_MATCH:    { label: 'No Match',      color: '#78716c', bg: '#f5f5f4', auto: false },
    BATCH:       { label: 'ATM Batch',     color: '#78716c', bg: '#f5f5f4', auto: false },
  };

  // ─── API ─────────────────────────────────────────────────────────────────────

  async function fetchPending() {
    const r = await fetch(
      `${BASE}/getTransactions?accountId=${ACCOUNT_ID}&sort=txnDate&reviewState=PENDING&ignoreMatching=false&txnFilter=MONEY_IN`,
      { credentials: 'include' }
    );
    if (!r.ok) throw new Error(`getTransactions ${r.status}`);
    const d = await r.json();
    return d.items || [];
  }

  async function acceptTxn(txn, s) {
    const body = {
      acceptType: 'MATCH',
      id: txn.id,
      olbTxnDate: new Date(txn.olbTxnDate).toISOString(),
      qboAccountId: txn.qboAccountId,
      selectedMatches: {
        matchedTxns: [{
          qboTxnId: s.qboTxnId,
          txnTypeId: s.txnTypeId,
          qboTxnSeqId: s.qboTxnSeqId || '0',
          txnSyncToken: s.txnSyncToken || '0',
          paymentAmount: Number(s.amount || txn.amount).toFixed(2),
        }],
        addAdjQboTxn: null,
        addAsQboTxn: null,
      },
    };
    const r = await fetch(`${BASE}/acceptTransactions`, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { ok: r.ok, status: r.status, body: r.ok ? null : await r.text() };
  }

  // ─── UI ──────────────────────────────────────────────────────────────────────

  const $ = id => document.getElementById(id);
  const fmt = n => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const CSS = `
    #qbmt-panel *{box-sizing:border-box;margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
    #qbmt-panel{position:fixed;top:20px;right:20px;width:860px;max-width:calc(100vw - 40px);max-height:90vh;
      background:#fff;border:1px solid #d1d5db;border-radius:12px;box-shadow:0 20px 60px rgba(0,0,0,.2);
      z-index:99999;display:flex;flex-direction:column;overflow:hidden}
    #qbmt-head{background:#1c1917;color:#fff;padding:14px 18px;display:flex;align-items:center;justify-content:space-between;flex-shrink:0}
    #qbmt-head h2{font-size:15px;font-weight:600;letter-spacing:.01em}
    #qbmt-head button{background:rgba(255,255,255,.15);border:none;color:#fff;width:28px;height:28px;
      border-radius:6px;cursor:pointer;font-size:16px;line-height:1}
    #qbmt-stats{padding:12px 18px;background:#f9fafb;border-bottom:1px solid #e5e7eb;flex-shrink:0;
      display:flex;gap:10px;flex-wrap:wrap}
    .qbmt-chip{font-size:11px;padding:4px 10px;border-radius:20px;font-weight:500;white-space:nowrap}
    #qbmt-body{overflow-y:auto;flex:1}
    #qbmt-table{width:100%;border-collapse:collapse;font-size:12px}
    #qbmt-table th{background:#f3f4f6;font-size:10px;font-weight:600;text-transform:uppercase;
      letter-spacing:.06em;color:#6b7280;padding:8px 10px;text-align:left;border-bottom:1px solid #e5e7eb;
      position:sticky;top:0}
    #qbmt-table td{padding:8px 10px;border-bottom:1px solid #f3f4f6;vertical-align:top}
    #qbmt-table tr:hover td{background:#fafafa}
    #qbmt-table tr.qbmt-exact td{background:#f0fdf4}
    #qbmt-table tr.qbmt-flag td{background:#fff7ed}
    #qbmt-table tr.qbmt-error td{background:#fef2f2}
    #qbmt-table tr.qbmt-dim td{opacity:.45}
    .qbmt-badge{display:inline-block;font-size:9px;font-weight:600;padding:2px 7px;border-radius:10px;
      text-transform:uppercase;letter-spacing:.04em;white-space:nowrap}
    .qbmt-ref{font-family:monospace;font-size:10px;color:#9ca3af;margin-top:2px}
    .qbmt-name{font-weight:500;font-size:12px}
    #qbmt-foot{padding:12px 18px;border-top:1px solid #e5e7eb;display:flex;align-items:center;
      gap:10px;flex-shrink:0;background:#fff}
    .qbmt-btn{padding:8px 16px;border-radius:7px;font-size:12px;font-weight:500;cursor:pointer;border:none}
    .qbmt-btn-primary{background:#007a63;color:#fff}
    .qbmt-btn-primary:hover{background:#006652}
    .qbmt-btn-primary:disabled{opacity:.4;cursor:default}
    .qbmt-btn-ghost{background:none;border:1px solid #d1d5db;color:#374151}
    .qbmt-btn-ghost:hover{border-color:#9ca3af}
    #qbmt-log{font-family:monospace;font-size:10px;color:#6b7280;padding:8px 18px;
      background:#f9fafb;border-top:1px solid #e5e7eb;max-height:80px;overflow-y:auto;display:none;flex-shrink:0}
  `;

  function buildPanel() {
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    const panel = document.createElement('div');
    panel.id = 'qbmt-panel';
    panel.innerHTML = `
      <div id="qbmt-head">
        <h2>QB Match Tool <span id="qbmt-title-count" style="font-weight:400;opacity:.7;font-size:13px"></span></h2>
        <button onclick="document.getElementById('qbmt-panel').remove()" title="Close">✕</button>
      </div>
      <div id="qbmt-stats"><span style="font-size:12px;color:#6b7280">Loading transactions…</span></div>
      <div id="qbmt-body">
        <table id="qbmt-table">
          <thead><tr>
            <th style="width:32px"><input type="checkbox" id="qbmt-sel-all" onchange="qbmtToggleAll(this)"></th>
            <th>Date</th>
            <th>Bank Description</th>
            <th>Amount</th>
            <th>Matched QB Payment</th>
            <th>Status</th>
          </tr></thead>
          <tbody id="qbmt-tbody"></tbody>
        </table>
      </div>
      <div id="qbmt-foot">
        <button class="qbmt-btn qbmt-btn-primary" id="qbmt-confirm-btn" onclick="qbmtConfirm()" disabled>Confirm Selected</button>
        <button class="qbmt-btn qbmt-btn-ghost" onclick="qbmtSelectExact()">Select All Exact</button>
        <span id="qbmt-sel-label" style="font-size:11px;color:#6b7280;margin-left:auto"></span>
      </div>
      <div id="qbmt-log"></div>
    `;
    document.body.appendChild(panel);
  }

  let rows = [];

  function renderRows() {
    const exact    = rows.filter(r => r.conf === 'EXACT').length;
    const review   = rows.filter(r => ['REF_ONLY','NAME_AMOUNT','COMPANY','SINGLE'].includes(r.conf)).length;
    const flagged  = rows.filter(r => r.conf === 'REF_MISSING').length;
    const batch    = rows.filter(r => r.conf === 'BATCH').length;
    const noMatch  = rows.filter(r => r.conf === 'NO_MATCH').length;

    $('qbmt-title-count').textContent = `— ${rows.length} transactions`;
    $('qbmt-stats').innerHTML = [
      `<span class="qbmt-chip" style="background:#dcfce7;color:#15803d">✅ ${exact} Exact</span>`,
      `<span class="qbmt-chip" style="background:#dbeafe;color:#0369a1">👁 ${review} Review</span>`,
      flagged  ? `<span class="qbmt-chip" style="background:#fee2e2;color:#b91c1c">⚠️ ${flagged} Ref Missing in QB</span>` : '',
      batch    ? `<span class="qbmt-chip" style="background:#f3f4f6;color:#6b7280">⊘ ${batch} ATM Batch</span>` : '',
      noMatch  ? `<span class="qbmt-chip" style="background:#f3f4f6;color:#6b7280">— ${noMatch} No Match</span>` : '',
    ].join('');

    const tbody = $('qbmt-tbody');
    tbody.innerHTML = '';

    rows.forEach((row, i) => {
      const cfg = CONF[row.conf] || CONF.NO_MATCH;
      const canSelect = row.s != null;
      const rowClass = row.conf === 'EXACT' ? 'qbmt-exact'
        : row.conf === 'REF_MISSING' ? 'qbmt-error'
        : ['REF_ONLY'].includes(row.conf) ? 'qbmt-flag'
        : ['BATCH','NO_MATCH'].includes(row.conf) ? 'qbmt-dim' : '';

      const date = (row.txn.olbTxnDate || '').substring(0, 10);

      const bankDesc = `
        <div class="qbmt-name">${esc(row.txn.description || '')}</div>
        <div class="qbmt-ref">${esc((row.txn.origDescription || '').substring(0, 70))}</div>
        ${row.parsed.ref ? `<div class="qbmt-ref" style="color:#007a63">Parsed ref: ${esc(row.parsed.ref)} · ${esc(row.parsed.name || '')}</div>` : ''}
      `;

      const matchInfo = row.s ? `
        <div class="qbmt-name">${esc(row.s.name || '—')}</div>
        <div class="qbmt-ref">Ref: ${esc(row.s.refNum || '—')} · ${fmt(row.s.amount)}</div>
      ` : row.conf === 'REF_MISSING' ? `
        <div style="font-size:11px;color:#b91c1c">Ref <b>${esc(row.parsed.ref)}</b> not found in QB suggestions<br>TB Plumbing needs to fix the payment reference</div>
      ` : `<span style="color:#9ca3af;font-size:11px">—</span>`;

      const tr = document.createElement('tr');
      tr.className = rowClass;
      tr.dataset.index = i;
      tr.innerHTML = `
        <td><input type="checkbox" class="qbmt-row-cb" data-i="${i}" ${canSelect ? '' : 'disabled'}
          ${cfg.auto ? 'checked' : ''} onchange="qbmtUpdateBtn()"></td>
        <td style="white-space:nowrap;font-family:monospace;font-size:11px;color:#6b7280">${date}</td>
        <td>${bankDesc}</td>
        <td style="font-family:monospace;font-weight:600;white-space:nowrap">${fmt(row.txn.amount)}</td>
        <td>${matchInfo}</td>
        <td><span class="qbmt-badge" style="background:${cfg.bg};color:${cfg.color}">${cfg.label}</span></td>
      `;
      tbody.appendChild(tr);
    });

    qbmtUpdateBtn();
  }

  function esc(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  function qbmtLog(msg) {
    const el = $('qbmt-log');
    el.style.display = '';
    el.innerHTML += `<div>${msg}</div>`;
    el.scrollTop = el.scrollHeight;
  }

  window.qbmtToggleAll = function(cb) {
    document.querySelectorAll('.qbmt-row-cb:not(:disabled)').forEach(c => c.checked = cb.checked);
    qbmtUpdateBtn();
  };

  window.qbmtSelectExact = function() {
    document.querySelectorAll('.qbmt-row-cb').forEach(c => {
      c.checked = !c.disabled && rows[+c.dataset.i]?.conf === 'EXACT';
    });
    qbmtUpdateBtn();
  };

  window.qbmtUpdateBtn = function() {
    const n = document.querySelectorAll('.qbmt-row-cb:checked').length;
    const btn = $('qbmt-confirm-btn');
    btn.disabled = n === 0;
    btn.textContent = n > 0 ? `Confirm ${n} Selected` : 'Confirm Selected';
    $('qbmt-sel-label').textContent = n > 0 ? `${n} selected` : '';
  };

  window.qbmtConfirm = async function() {
    const checked = [...document.querySelectorAll('.qbmt-row-cb:checked')].map(c => +c.dataset.i);
    if (!checked.length) return;

    $('qbmt-confirm-btn').disabled = true;
    $('qbmt-confirm-btn').textContent = 'Confirming…';

    let ok = 0, fail = 0;
    for (const i of checked) {
      const { txn, s } = rows[i];
      if (!s) { fail++; continue; }
      const result = await acceptTxn(txn, s);
      if (result.ok) {
        ok++;
        qbmtLog(`✅ ${txn.description} ${fmt(txn.amount)}`);
        const tr = document.querySelector(`tr[data-index="${i}"]`);
        if (tr) { tr.style.opacity = '.3'; tr.querySelector('.qbmt-row-cb').disabled = true; }
      } else {
        fail++;
        qbmtLog(`❌ ${txn.description} — HTTP ${result.status}: ${result.body}`);
      }
      await new Promise(r => setTimeout(r, 350));
    }

    $('qbmt-confirm-btn').textContent = `Done — ${ok} confirmed${fail ? `, ${fail} failed` : ''}`;
    qbmtLog(`Finished: ${ok} confirmed, ${fail} failed.`);
  };

  // ─── Main ────────────────────────────────────────────────────────────────────

  buildPanel();

  fetchPending().then(items => {
    rows = items.map(txn => {
      const parsed = parseDesc(txn.origDescription, txn.description);
      const { s, conf } = findMatch(txn, parsed);
      return { txn, parsed, s, conf };
    });
    renderRows();
  }).catch(err => {
    $('qbmt-stats').innerHTML = `<span style="color:#b91c1c">Error: ${esc(err.message)}</span>`;
  });

})();
