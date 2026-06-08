(function () {
  'use strict';

  if (document.getElementById('qbmt-panel')) document.getElementById('qbmt-panel').remove();

  const COMPANY_ID = '9130357925095736';
  const ACCOUNT_ID = '149';
  const BASE = `https://qbo.intuit.com/api/neo/v1/company/${COMPANY_ID}/olb/ng`;

  // ─── Transaction type detection ──────────────────────────────────────────────

  // 1st American sends an EFTPY code in QB that never matches their bank ACH ID.
  // Detect them so we skip ref matching and fall back to name-only.
  const IS_1ST_AMERICAN = /1ST\s*AME(?:RICAN)?|FIRST\s+AMERICAN/i;

  function parseDesc(orig, desc) {
    const raw = orig || desc || '';

    // ATM batch — multiple checks, no individual detail
    if (/BKOFAMERICA\s+ATM\s+/i.test(raw)) {
      return { type: 'ATM_BATCH', ref: null, name: null };
    }

    // Mobile deposit — single check, but BofA never sends the check number
    if (/BKOFAMERICA\s+MOBILE\s+/i.test(raw)) {
      return { type: 'MOBILE_CHECK', ref: null, name: null };
    }

    // Zelle — conf code and sender name are always in origDescription
    const zelle = raw.match(/Zelle payment from\s+(.+?)(?:\s+for\s+"[^"]*")?\s*;?\s*Conf#\s*([A-Z0-9]+)/i);
    if (zelle) {
      return { type: 'ZELLE', ref: zelle[2].toUpperCase(), name: zelle[1].trim() };
    }

    // Company ACH — look for "DES:KEYWORD ID:VALUE" pattern
    // The first ID after the DES tag is the payment ID that should match QB's refNum.
    // Exception: 1st American uses an EFTPY code in QB that never matches the bank ID.
    const desMatch = raw.match(/DES:\S+\s+ID:([A-Z0-9\-]+)/i);
    if (desMatch) {
      const companyMatch = raw.match(/^(.+?)\s+DES:/i);
      const company = companyMatch ? companyMatch[1].trim() : raw.substring(0, 40);
      const is1stAmerican = IS_1ST_AMERICAN.test(raw);
      return {
        type: 'COMPANY_ACH',
        ref: is1stAmerican ? null : desMatch[1],
        name: company,
        is1stAmerican,
      };
    }

    // Anything else (Rely wire, Old Republic batch, etc.) — name matching only
    return { type: 'COMPANY', ref: null, name: desc || raw.substring(0, 60) };
  }

  // ─── Matching ───────────────────────────────────────────────────────────────

  function normRef(s)  { return String(s || '').replace(/\W/g, '').toLowerCase(); }
  function normName(s) { return (s || '').toLowerCase().replace(/[^a-z\s]/g, '').trim(); }

  function nameMatch(qbName, parsedName) {
    const qb    = normName(qbName);
    const words = normName(parsedName).split(/\s+/).filter(w => w.length > 2);
    return words.some(w => qb.includes(w));
  }

  function findMatch(txn, parsed) {
    const sug = txn.suggestedMatches?.matchedTxns || [];

    if (parsed.type === 'ATM_BATCH')    return { s: null, conf: 'ATM_BATCH' };

    // Mobile check — no check number, show single suggestion for review
    if (parsed.type === 'MOBILE_CHECK') {
      if (sug.length === 0) return { s: null, conf: 'NOT_IN_JOBBER' };
      if (sug.length === 1) return { s: sug[0], conf: 'SINGLE_REVIEW' };
      return { s: sug[0], conf: 'MULTI_REVIEW' };
    }

    // Zelle — exact: conf code = refNum AND sender name matches customer name
    if (parsed.type === 'ZELLE') {
      if (sug.length === 0) return { s: null, conf: 'NOT_IN_JOBBER' };
      for (const s of sug) {
        if (normRef(s.refNum) === normRef(parsed.ref) && nameMatch(s.name, parsed.name))
          return { s, conf: 'EXACT' };
      }
      for (const s of sug) {
        if (normRef(s.refNum) === normRef(parsed.ref))
          return { s, conf: 'REF_ONLY' }; // ref matches but name off — flag it
      }
      return { s: null, conf: 'REF_MISSING' }; // conf code not in QB → TB Plumbing data issue
    }

    // Company ACH with a parseable payment ID — exact: ID = refNum AND name agrees
    if (parsed.type === 'COMPANY_ACH' && parsed.ref) {
      if (sug.length === 0) return { s: null, conf: 'NOT_IN_JOBBER' };
      for (const s of sug) {
        if (normRef(s.refNum) === normRef(parsed.ref) && nameMatch(s.name, parsed.name))
          return { s, conf: 'EXACT' };
      }
      for (const s of sug) {
        if (normRef(s.refNum) === normRef(parsed.ref))
          return { s, conf: 'REF_ONLY' };
      }
      // ID not found in suggestions — fall back to name match
      for (const s of sug) {
        if (nameMatch(s.name, parsed.name))
          return { s, conf: 'SINGLE_REVIEW' };
      }
      return { s: null, conf: 'REF_MISSING' };
    }

    // Company ACH without ref (1st American EFTPY mismatch, or Rely/OldRepublic wire)
    // Trust QB's suggestion if it exists — it came from Jobber
    if (parsed.type === 'COMPANY_ACH' || parsed.type === 'COMPANY') {
      if (sug.length === 0) return { s: null, conf: 'NOT_IN_JOBBER' };
      for (const s of sug) {
        if (nameMatch(s.name, parsed.name) || nameMatch(parsed.name, s.name))
          return { s, conf: parsed.is1stAmerican ? 'FIRST_AMERICAN' : 'COMPANY_MATCH' };
      }
      if (sug.length === 1) return { s: sug[0], conf: 'SINGLE_REVIEW' };
      return { s: sug[0], conf: 'MULTI_REVIEW' };
    }

    return { s: null, conf: 'NO_MATCH' };
  }

  const CONF = {
    EXACT:          { label: 'Exact Match',        color: '#15803d', bg: '#dcfce7', auto: true  },
    COMPANY_MATCH:  { label: 'Jobber Match',        color: '#15803d', bg: '#dcfce7', auto: true  },
    FIRST_AMERICAN: { label: '1st American ⚠',     color: '#b45309', bg: '#fef3c7', auto: false },
    REF_ONLY:       { label: 'Name Mismatch',       color: '#b45309', bg: '#fef3c7', auto: false },
    SINGLE_REVIEW:  { label: 'Review',              color: '#0369a1', bg: '#dbeafe', auto: false },
    MULTI_REVIEW:   { label: 'Multiple Options',    color: '#7c3aed', bg: '#ede9fe', auto: false },
    REF_MISSING:    { label: 'Wrong Ref in QB',     color: '#b91c1c', bg: '#fee2e2', auto: false },
    NOT_IN_JOBBER:  { label: 'Not in Jobber',       color: '#b91c1c', bg: '#fee2e2', auto: false },
    ATM_BATCH:      { label: 'ATM Batch',           color: '#78716c', bg: '#f5f5f4', auto: false },
    NO_MATCH:       { label: 'No Match',            color: '#78716c', bg: '#f5f5f4', auto: false },
  };

  // ─── API ─────────────────────────────────────────────────────────────────────

  let _authHeaders = null;

  // Intercept QB's own next API call to capture its auth headers, then restore fetch.
  function captureAuthHeaders() {
    return new Promise((resolve, reject) => {
      const orig = window.fetch;
      const timeout = setTimeout(() => {
        window.fetch = orig;
        reject(new Error('Timed out — try changing a date filter in QB Banking to trigger a refresh.'));
      }, 30000);
      window.fetch = function (url, opts) {
        if (!_authHeaders && String(url).includes('/olb/ng/') && opts?.headers?.authorization) {
          _authHeaders = { ...opts.headers };
          delete _authHeaders['x-range'];
          clearTimeout(timeout);
          window.fetch = orig;
          resolve();
        }
        return orig.apply(this, arguments);
      };
    });
  }

  function qbHeaders(range) {
    const tid = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : Math.random().toString(36).slice(2);
    const h = { ...(_authHeaders || {}), intuit_tid: tid };
    if (range) h['x-range'] = range;
    return h;
  }

  async function fetchPending() {
    const r = await fetch(
      `${BASE}/getTransactions?sort=-txnDate&reviewState=PENDING&ignoreMatching=false&accountId=${ACCOUNT_ID}`,
      { credentials: 'include', headers: qbHeaders('items=0-499') }
    );
    if (!r.ok) throw new Error(`getTransactions HTTP ${r.status}`);
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
          qboTxnId:      s.qboTxnId,
          txnTypeId:     s.txnTypeId,
          qboTxnSeqId:   s.qboTxnSeqId  || '0',
          txnSyncToken:  s.txnSyncToken || '0',
          paymentAmount: Number(s.amount || txn.amount).toFixed(2),
        }],
        addAdjQboTxn: null,
        addAsQboTxn:  null,
      },
    };
    const r = await fetch(`${BASE}/acceptTransactions`, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...qbHeaders() },
      body: JSON.stringify(body),
    });
    return { ok: r.ok, status: r.status, text: r.ok ? null : await r.text() };
  }

  // ─── UI ──────────────────────────────────────────────────────────────────────

  const $   = id => document.getElementById(id);
  const esc = s  => String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const fmt = n  => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const CSS = `
    #qbmt-panel *{box-sizing:border-box;margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
    #qbmt-panel{position:fixed;top:20px;right:20px;width:900px;max-width:calc(100vw - 40px);
      max-height:90vh;background:#fff;border:1px solid #d1d5db;border-radius:12px;
      box-shadow:0 20px 60px rgba(0,0,0,.22);z-index:99999;display:flex;flex-direction:column;overflow:hidden}
    #qbmt-head{background:#1c1917;color:#fff;padding:14px 18px;display:flex;align-items:center;
      justify-content:space-between;flex-shrink:0}
    #qbmt-head h2{font-size:15px;font-weight:600}
    #qbmt-head button{background:rgba(255,255,255,.15);border:none;color:#fff;width:28px;height:28px;
      border-radius:6px;cursor:pointer;font-size:16px;line-height:1}
    #qbmt-stats{padding:10px 18px;background:#f9fafb;border-bottom:1px solid #e5e7eb;
      flex-shrink:0;display:flex;gap:8px;flex-wrap:wrap;align-items:center}
    .qbmt-chip{font-size:11px;padding:3px 10px;border-radius:20px;font-weight:500;white-space:nowrap}
    #qbmt-body{overflow-y:auto;flex:1}
    #qbmt-table{width:100%;border-collapse:collapse;font-size:12px}
    #qbmt-table th{background:#f3f4f6;font-size:10px;font-weight:600;text-transform:uppercase;
      letter-spacing:.06em;color:#6b7280;padding:8px 10px;text-align:left;
      border-bottom:1px solid #e5e7eb;position:sticky;top:0;z-index:1}
    #qbmt-table td{padding:8px 10px;border-bottom:1px solid #f3f4f6;vertical-align:top}
    #qbmt-table tr:hover td{background:#fafafa}
    #qbmt-table tr.qbmt-exact td{background:#f0fdf4}
    #qbmt-table tr.qbmt-warn td{background:#fffbeb}
    #qbmt-table tr.qbmt-err td{background:#fef2f2}
    #qbmt-table tr.qbmt-dim td{opacity:.4}
    .qbmt-badge{display:inline-block;font-size:9px;font-weight:600;padding:2px 7px;
      border-radius:10px;text-transform:uppercase;letter-spacing:.04em;white-space:nowrap}
    .qbmt-main{font-weight:500;font-size:12px}
    .qbmt-sub{font-size:10px;color:#9ca3af;margin-top:2px;font-family:monospace}
    .qbmt-note{font-size:11px;margin-top:3px}
    #qbmt-foot{padding:12px 18px;border-top:1px solid #e5e7eb;display:flex;
      align-items:center;gap:10px;flex-shrink:0;background:#fff}
    .qbmt-btn{padding:8px 16px;border-radius:7px;font-size:12px;font-weight:500;cursor:pointer;border:none}
    .qbmt-btn-primary{background:#007a63;color:#fff}
    .qbmt-btn-primary:hover{background:#006652}
    .qbmt-btn-primary:disabled{opacity:.4;cursor:default}
    .qbmt-btn-ghost{background:none;border:1px solid #d1d5db;color:#374151}
    .qbmt-btn-ghost:hover{border-color:#9ca3af}
    #qbmt-log{font-family:monospace;font-size:10px;color:#6b7280;padding:8px 18px;
      background:#f9fafb;border-top:1px solid #e5e7eb;max-height:80px;overflow-y:auto;
      display:none;flex-shrink:0}
    #qbmt-setup{padding:20px 24px 16px}
    #qbmt-setup p{font-size:13px;font-weight:600;margin-bottom:10px;color:#111827}
    #qbmt-setup ol{font-size:12px;color:#374151;line-height:2;padding-left:18px}
    #qbmt-setup code{background:#f3f4f6;padding:1px 5px;border-radius:4px;font-family:monospace}
    #qbmt-setup-paste{width:100%;height:90px;font-family:monospace;font-size:11px;
      padding:8px;border:1px solid #d1d5db;border-radius:6px;resize:vertical;
      margin:10px 0 8px;display:block}
  `;

  function buildPanel() {
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);
    const panel = document.createElement('div');
    panel.id = 'qbmt-panel';
    panel.innerHTML = `
      <div id="qbmt-head">
        <h2>QB Match Tool &nbsp;<span id="qbmt-count" style="font-weight:400;opacity:.6;font-size:13px"></span></h2>
        <button onclick="document.getElementById('qbmt-panel').remove()" title="Close">✕</button>
      </div>
      <div id="qbmt-setup">
        <p>Quick setup — do this once each session:</p>
        <ol>
          <li>Open the <strong>Network</strong> tab (F12 → Network)</li>
          <li>In the filter box type <code>getTransactions</code></li>
          <li>Find any request with <strong style="color:#15803d">200</strong> status and right-click it</li>
          <li>Choose <strong>Copy → Copy as fetch</strong></li>
          <li>Paste it below and click <strong>Go</strong></li>
        </ol>
        <textarea id="qbmt-setup-paste" placeholder="Paste Copy as fetch here…"></textarea>
        <div style="display:flex;gap:8px;align-items:center">
          <button class="qbmt-btn qbmt-btn-primary" onclick="qbmtAuthorize()">Go →</button>
          <span id="qbmt-setup-err" style="font-size:11px;color:#b91c1c"></span>
        </div>
      </div>
      <div id="qbmt-main" style="display:none;flex-direction:column;flex:1;overflow:hidden">
        <div id="qbmt-stats"></div>
        <div id="qbmt-body">
          <table id="qbmt-table">
            <thead><tr>
              <th style="width:32px"><input type="checkbox" id="qbmt-all" onchange="qbmtToggleAll(this)"></th>
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
          <button class="qbmt-btn qbmt-btn-primary" id="qbmt-confirm" onclick="qbmtConfirm()" disabled>Confirm Selected</button>
          <button class="qbmt-btn qbmt-btn-ghost" onclick="qbmtSelectAuto()">Select Auto-Matches</button>
          <span id="qbmt-sel-lbl" style="font-size:11px;color:#6b7280;margin-left:auto"></span>
        </div>
      </div>
      <div id="qbmt-log"></div>
    `;
    document.body.appendChild(panel);
  }

  let rows = [];

  function renderRows() {
    const auto    = rows.filter(r => CONF[r.conf]?.auto).length;
    const review  = rows.filter(r => ['SINGLE_REVIEW','MULTI_REVIEW','REF_ONLY','FIRST_AMERICAN'].includes(r.conf)).length;
    const flagged = rows.filter(r => ['REF_MISSING','NOT_IN_JOBBER'].includes(r.conf)).length;
    const manual  = rows.filter(r => r.conf === 'ATM_BATCH').length;

    $('qbmt-count').textContent = `— ${rows.length} pending`;
    $('qbmt-stats').innerHTML = [
      `<span class="qbmt-chip" style="background:#dcfce7;color:#15803d">✅ ${auto} Auto-match</span>`,
      review  ? `<span class="qbmt-chip" style="background:#dbeafe;color:#0369a1">👁 ${review} Review</span>` : '',
      flagged ? `<span class="qbmt-chip" style="background:#fee2e2;color:#b91c1c">⚠️ ${flagged} Flagged</span>` : '',
      manual  ? `<span class="qbmt-chip" style="background:#f3f4f6;color:#6b7280">⊘ ${manual} ATM Batch</span>` : '',
    ].join('');

    const tbody = $('qbmt-tbody');
    tbody.innerHTML = '';

    rows.forEach((row, i) => {
      const cfg = CONF[row.conf] || CONF.NO_MATCH;
      const rowCls =
        cfg.auto                                             ? 'qbmt-exact' :
        ['REF_MISSING','NOT_IN_JOBBER'].includes(row.conf)  ? 'qbmt-err'   :
        ['REF_ONLY','MULTI_REVIEW','FIRST_AMERICAN'].includes(row.conf) ? 'qbmt-warn' :
        ['ATM_BATCH','NO_MATCH'].includes(row.conf)         ? 'qbmt-dim'   : '';

      const date = (row.txn.olbTxnDate || '').substring(0, 10);

      // Bank description cell
      let bankHtml = `<div class="qbmt-main">${esc(row.txn.description || row.txn.origDescription || '')}</div>`;
      if (row.parsed.type === 'ZELLE' && row.parsed.ref) {
        bankHtml += `<div class="qbmt-sub">Conf# ${esc(row.parsed.ref)} · from ${esc(row.parsed.name)}</div>`;
      } else if (row.parsed.type === 'COMPANY_ACH' && row.parsed.ref) {
        bankHtml += `<div class="qbmt-sub">Bank ID: ${esc(row.parsed.ref)}</div>`;
      } else if (row.parsed.type === 'ATM_BATCH') {
        bankHtml += `<div class="qbmt-note" style="color:#b45309">Multiple checks — match manually in QB</div>`;
      } else if (row.parsed.type === 'MOBILE_CHECK') {
        bankHtml += `<div class="qbmt-sub" style="color:#9ca3af">Mobile deposit — no check # available</div>`;
      }

      // Matched payment cell
      let matchHtml = '';
      if (row.s) {
        matchHtml = `
          <div class="qbmt-main">${esc(row.s.name || '—')}</div>
          <div class="qbmt-sub">Ref: ${esc(row.s.refNum || '—')} &nbsp;·&nbsp; ${fmt(row.s.amount)}</div>
        `;
        if (row.conf === 'FIRST_AMERICAN') {
          matchHtml += `<div class="qbmt-note" style="color:#b45309">1st American EFTPY mismatch — verify manually</div>`;
        } else if (row.conf === 'MULTI_REVIEW') {
          const n = row.txn.suggestedMatches?.matchedTxns?.length || 0;
          matchHtml += `<div class="qbmt-note" style="color:#7c3aed">${n} options — showing best guess, verify before confirming</div>`;
        }
      } else if (row.conf === 'REF_MISSING') {
        const label = row.parsed.type === 'ZELLE' ? `Conf# ${esc(row.parsed.ref)}` : `ID ${esc(row.parsed.ref)}`;
        matchHtml = `<div class="qbmt-note" style="color:#b91c1c">${label} not found in QB suggestions<br>TB Plumbing needs to correct the payment reference in Jobber</div>`;
      } else if (row.conf === 'NOT_IN_JOBBER') {
        matchHtml = `<div class="qbmt-note" style="color:#b91c1c">No payment found — not yet recorded in Jobber</div>`;
      } else {
        matchHtml = `<span style="color:#9ca3af;font-size:11px">—</span>`;
      }

      const canSelect = row.s != null;
      const tr = document.createElement('tr');
      tr.className = rowCls;
      tr.dataset.index = i;
      tr.innerHTML = `
        <td><input type="checkbox" class="qbmt-cb" data-i="${i}"
          ${canSelect ? '' : 'disabled'} ${cfg.auto ? 'checked' : ''}
          onchange="qbmtUpdateBtn()"></td>
        <td style="white-space:nowrap;font-family:monospace;font-size:11px;color:#6b7280">${date}</td>
        <td>${bankHtml}</td>
        <td style="font-family:monospace;font-weight:600;white-space:nowrap">${fmt(row.txn.amount)}</td>
        <td>${matchHtml}</td>
        <td><span class="qbmt-badge" style="background:${cfg.bg};color:${cfg.color}">${cfg.label}</span></td>
      `;
      tbody.appendChild(tr);
    });

    qbmtUpdateBtn();
  }

  function qbmtLog(msg) {
    const el = $('qbmt-log');
    el.style.display = '';
    el.innerHTML += `<div>${msg}</div>`;
    el.scrollTop = el.scrollHeight;
  }

  window.qbmtToggleAll = cb => {
    document.querySelectorAll('.qbmt-cb:not(:disabled)').forEach(c => c.checked = cb.checked);
    qbmtUpdateBtn();
  };

  window.qbmtSelectAuto = () => {
    document.querySelectorAll('.qbmt-cb').forEach(c => {
      c.checked = !c.disabled && !!CONF[rows[+c.dataset.i]?.conf]?.auto;
    });
    qbmtUpdateBtn();
  };

  window.qbmtUpdateBtn = () => {
    const n = document.querySelectorAll('.qbmt-cb:checked').length;
    $('qbmt-confirm').disabled = n === 0;
    $('qbmt-confirm').textContent = n > 0 ? `Confirm ${n} Selected` : 'Confirm Selected';
    $('qbmt-sel-lbl').textContent = n > 0 ? `${n} selected` : '';
  };

  window.qbmtConfirm = async () => {
    const idxs = [...document.querySelectorAll('.qbmt-cb:checked')].map(c => +c.dataset.i);
    if (!idxs.length) return;
    $('qbmt-confirm').disabled = true;
    $('qbmt-confirm').textContent = 'Confirming…';

    let ok = 0, fail = 0;
    for (const i of idxs) {
      const { txn, s } = rows[i];
      if (!s) { fail++; continue; }
      const res = await acceptTxn(txn, s);
      if (res.ok) {
        ok++;
        qbmtLog(`✅ ${txn.description || txn.id} ${fmt(txn.amount)}`);
        const tr = document.querySelector(`tr[data-index="${i}"]`);
        if (tr) { tr.style.opacity = '.3'; tr.querySelector('.qbmt-cb').disabled = true; }
      } else {
        fail++;
        qbmtLog(`❌ ${txn.description || txn.id} — HTTP ${res.status}: ${res.text}`);
      }
      await new Promise(r => setTimeout(r, 350));
    }

    $('qbmt-confirm').textContent = `Done — ${ok} confirmed${fail ? `, ${fail} failed` : ''}`;
    qbmtLog(`Finished: ${ok} confirmed, ${fail} failed.`);
  };

  window.qbmtAuthorize = function () {
    const code  = document.getElementById('qbmt-setup-paste').value.trim();
    const errEl = document.getElementById('qbmt-setup-err');
    if (!code) { errEl.textContent = 'Paste the Copy as fetch code first.'; return; }

    let headers = null;
    try {
      (new Function('fetch', code))(function (url, opts) {
        headers = { ...(opts?.headers || {}) };
        return Promise.resolve(new Response('null'));
      });
    } catch (e) { /* ignore */ }

    if (!headers?.authorization) {
      errEl.textContent = 'Could not read auth — make sure it\'s from a getTransactions request.';
      return;
    }

    _authHeaders = headers;
    delete _authHeaders['x-range'];

    document.getElementById('qbmt-setup').style.display = 'none';
    const main = document.getElementById('qbmt-main');
    main.style.display = 'flex';

    $('qbmt-stats').innerHTML = '<span style="font-size:12px;color:#6b7280">Loading transactions…</span>';

    fetchPending().then(items => {
      rows = items.map(txn => {
        const parsed = parseDesc(txn.origDescription, txn.description);
        const { s, conf } = findMatch(txn, parsed);
        return { txn, parsed, s, conf };
      });
      renderRows();
    }).catch(err => {
      $('qbmt-stats').innerHTML = `<span style="color:#b91c1c;font-size:13px">Error: ${esc(err.message)}</span>`;
    });
  };

  // ─── Main ────────────────────────────────────────────────────────────────────

  buildPanel();

})();
