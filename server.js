require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');
const { EventEmitter } = require('events');
const { applyJobberPayment } = require('./scripts/jobber-payment');

let playwrightRunning = false;

// ── Local-worker job queue ────────────────────────────────────────────────────
const jobQueue = new Map();   // id → job
const jobEvents = new EventEmitter();
let jobIdSeq = 0;
let lastJobResult = null;     // { id, success, error, finishedAt } — survives SSE disconnect

function createJob(params) {
  const id = String(++jobIdSeq);
  jobQueue.set(id, { id, params, status: 'pending' });
  return id;
}

const WORKER_SECRET = process.env.WORKER_SECRET;
function workerAuth(req, res, next) {
  if (!WORKER_SECRET || req.headers['x-worker-secret'] !== WORKER_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), { etag: false, lastModified: false, setHeaders: (res, filePath) => { if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-store'); } }));

const {
  JOBBER_CLIENT_ID,
  JOBBER_CLIENT_SECRET,
  QUICKBOOKS_CLIENT_ID,
  QUICKBOOKS_CLIENT_SECRET,
  APP_URL = 'https://intrepipay.com'
} = process.env;

const REDIRECT_URI = `${APP_URL}/auth/jobber/callback`;
const TOKEN_URL = 'https://api.getjobber.com/api/oauth/token';
const GRAPHQL_URL = 'https://api.getjobber.com/api/graphql';

// ── QuickBooks constants ──────────────────────────────────────────────────────
const QB_REDIRECT_URI   = `${APP_URL}/auth/quickbooks/callback`;
const QB_TOKEN_URL      = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const QB_AUTH_URL       = 'https://appcenter.intuit.com/connect/oauth2';
const QB_SCOPES         = 'com.intuit.quickbooks.accounting';
const QB_API_BASE       = process.env.QB_SANDBOX === 'false'
  ? 'https://quickbooks.api.intuit.com'
  : 'https://sandbox-quickbooks.api.intuit.com';

// ── Persistent token storage ──────────────────────────────────────────────────
const TOKEN_FILE = path.join(__dirname, 'tokens.json');

function loadTokens() {
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
    }
  } catch (e) { console.error('Token load error:', e.message); }
  return { access_token: null, refresh_token: null, expires_at: null };
}

function saveTokens(tokens) {
  try {
    fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens));
  } catch (e) { console.error('Token save error:', e.message); }
}

let tokenStore = loadTokens();

// ── Step 1: Send user to Jobber to authorize ──────────────────────────────────
app.get('/auth/jobber', (req, res) => {
  const url = `https://api.getjobber.com/api/oauth/authorize?` +
    `response_type=code` +
    `&client_id=${JOBBER_CLIENT_ID}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`;
  res.redirect(url);
});

// ── Step 2: Jobber sends user back with auth code ─────────────────────────────
app.get('/auth/jobber/callback', async (req, res) => {
  const { code, error } = req.query;

  if (error || !code) {
    return res.send('Authorization failed: ' + (error || 'no code received'));
  }

  try {
    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: JOBBER_CLIENT_ID,
        client_secret: JOBBER_CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
        code
      })
    });

    const data = await response.json();

    if (!data.access_token) {
      return res.send('Token exchange failed: ' + JSON.stringify(data));
    }

    tokenStore = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Date.now() + ((data.expires_in || 3600) * 1000)
    };
    saveTokens(tokenStore);
    console.log('Jobber connected successfully');
    res.redirect('/?connected=true');

  } catch (err) {
    console.error('OAuth error:', err);
    res.send('OAuth error: ' + err.message);
  }
});

// ── Token refresh ─────────────────────────────────────────────────────────────
async function getValidToken() {
  if (!tokenStore.access_token) throw new Error('Not connected to Jobber');

  if (Date.now() > tokenStore.expires_at - 60000) {
    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: JOBBER_CLIENT_ID,
        client_secret: JOBBER_CLIENT_SECRET,
        refresh_token: tokenStore.refresh_token
      })
    });
    let data;
    try { data = await response.json(); } catch (e) { data = {}; }
    if (!data.access_token) {
      tokenStore = { access_token: null, refresh_token: null, expires_at: null };
      saveTokens(tokenStore);
      throw new Error('Not connected to Jobber');
    }
    tokenStore = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Date.now() + ((data.expires_in || 3600) * 1000)
    };
    saveTokens(tokenStore);
  }

  return tokenStore.access_token;
}

// ── QuickBooks OAuth ──────────────────────────────────────────────────────────
const QB_TOKEN_FILE = path.join(__dirname, 'qb-tokens.json');

function loadQbTokens() {
  try {
    if (fs.existsSync(QB_TOKEN_FILE)) return JSON.parse(fs.readFileSync(QB_TOKEN_FILE, 'utf8'));
  } catch (e) { console.error('QB token load error:', e.message); }
  return { access_token: null, refresh_token: null, expires_at: null, realm_id: null };
}

function saveQbTokens(tokens) {
  try { fs.writeFileSync(QB_TOKEN_FILE, JSON.stringify(tokens)); }
  catch (e) { console.error('QB token save error:', e.message); }
}

let qbTokenStore = loadQbTokens();

app.get('/auth/quickbooks', (req, res) => {
  if (!QUICKBOOKS_CLIENT_ID) return res.send('QUICKBOOKS_CLIENT_ID not configured');
  const url = `${QB_AUTH_URL}?` +
    `client_id=${QUICKBOOKS_CLIENT_ID}` +
    `&response_type=code` +
    `&scope=${encodeURIComponent(QB_SCOPES)}` +
    `&redirect_uri=${encodeURIComponent(QB_REDIRECT_URI)}` +
    `&state=trackpoint`;
  res.redirect(url);
});

app.get('/auth/quickbooks/callback', async (req, res) => {
  const { code, realmId, error } = req.query;
  if (error || !code) return res.send('QB authorization failed: ' + (error || 'no code'));
  try {
    const credentials = Buffer.from(`${QUICKBOOKS_CLIENT_ID}:${QUICKBOOKS_CLIENT_SECRET}`).toString('base64');
    const response = await fetch(QB_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${credentials}`
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: QB_REDIRECT_URI
      })
    });
    const data = await response.json();
    if (!data.access_token) return res.send('QB token exchange failed: ' + JSON.stringify(data));
    qbTokenStore = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Date.now() + ((data.expires_in || 3600) * 1000),
      realm_id: realmId
    };
    saveQbTokens(qbTokenStore);
    console.log(`QuickBooks connected — realmId: ${realmId}`);
    res.redirect('/?qb_connected=true');
  } catch (err) {
    console.error('QB OAuth error:', err);
    res.send('QB OAuth error: ' + err.message);
  }
});

async function getValidQbToken() {
  if (!qbTokenStore.access_token) throw new Error('Not connected to QuickBooks');
  if (Date.now() > qbTokenStore.expires_at - 60000) {
    const credentials = Buffer.from(`${QUICKBOOKS_CLIENT_ID}:${QUICKBOOKS_CLIENT_SECRET}`).toString('base64');
    const response = await fetch(QB_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${credentials}`
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: qbTokenStore.refresh_token
      })
    });
    let data;
    try { data = await response.json(); } catch (e) { data = {}; }
    if (!data.access_token) {
      qbTokenStore = { access_token: null, refresh_token: null, expires_at: null, realm_id: qbTokenStore.realm_id };
      saveQbTokens(qbTokenStore);
      throw new Error('Not connected to QuickBooks');
    }
    qbTokenStore = {
      access_token: data.access_token,
      refresh_token: data.refresh_token || qbTokenStore.refresh_token,
      expires_at: Date.now() + ((data.expires_in || 3600) * 1000),
      realm_id: qbTokenStore.realm_id
    };
    saveQbTokens(qbTokenStore);
  }
  return { token: qbTokenStore.access_token, realmId: qbTokenStore.realm_id };
}

app.get('/api/qb/status', (req, res) => {
  res.json({
    connected: !!qbTokenStore.access_token,
    realmId: qbTokenStore.realm_id,
    expires_at: qbTokenStore.expires_at
  });
});

// Fetch QB Payment records in a date range
app.get('/api/qb/payments', async (req, res) => {
  try {
    const { token, realmId } = await getValidQbToken();
    const today = new Date().toISOString().slice(0, 10);
    const minDate = req.query.minDate || new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const maxDate = req.query.maxDate || today;
    const query = `SELECT * FROM Payment WHERE TxnDate >= '${minDate}' AND TxnDate <= '${maxDate}' MAXRESULTS 100`;
    const url = `${QB_API_BASE}/v3/company/${realmId}/query?query=${encodeURIComponent(query)}&minorversion=65`;
    const resp = await fetch(url, { headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' } });
    const data = await resp.json();
    if (!resp.ok) return res.status(resp.status).json({ error: data });
    const payments = (data.QueryResponse?.Payment || []).map(p => ({
      id: p.Id,
      txnDate: p.TxnDate,
      amount: p.TotalAmt,
      customer: p.CustomerRef?.name || '',
      refNum: p.PaymentRefNum || '',
      note: p.PrivateNote || '',
    }));
    res.json({ payments });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Fetch unmatched bank transactions from QB bank feed
app.get('/api/qb/bank-transactions', async (req, res) => {
  try {
    const { token, realmId } = await getValidQbToken();
    // BankTransaction is not a queryable entity — use the dedicated REST endpoint
    const url = `${QB_API_BASE}/v3/company/${realmId}/banktransactions?minorversion=65`;
    const resp = await fetch(url, { headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' } });
    const data = await resp.json();
    if (!resp.ok) return res.status(resp.status).json({ error: data });
    // Return raw so we can inspect the actual QB response shape on first call
    const rawList = data.BankTransactions || data.BankTransaction || data.QueryResponse?.BankTransaction || [];
    const transactions = rawList
      .filter(t => !t.TxnStatus || t.TxnStatus === 'PENDING')
      .map(t => ({
        id: t.Id,
        txnDate: t.TxnDate,
        amount: t.Amount,
        description: t.Description || '',
        entityRef: t.EntityRef?.name || '',
        accountName: t.BankAccountRef?.name || '',
        suggestedMatches: (t.SuggestedMatchList || []).map(m => ({
          txnType: m.TxnType,
          txnId: m.Txn?.Id || '',
          entityName: m.Txn?.EntityRef?.name || '',
          txnDate: m.Txn?.TxnDate || '',
          amount: m.Txn?.Amount || 0,
        })),
      }));
    res.json({ transactions, _raw: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Match a QB bank transaction to a QB Payment
app.post('/api/qb/match', async (req, res) => {
  try {
    const { token, realmId } = await getValidQbToken();
    const { bankTxnId, paymentId } = req.body;
    if (!bankTxnId || !paymentId) return res.status(400).json({ error: 'bankTxnId and paymentId required' });
    const url = `${QB_API_BASE}/v3/company/${realmId}/banktransactions/batchmatch?minorversion=65`;
    const body = [{ BankTransactionId: bankTxnId, RecognizedTransaction: [{ TxnType: 'Payment', Txn: { Id: paymentId } }] }];
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await resp.json();
    if (!resp.ok) return res.status(resp.status).json({ error: data });
    res.json({ ok: true, result: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Cross-reference bank PDF deposits with QB "For Review" feed — returns match candidates without confirming
app.post('/api/qb/match-preview', async (req, res) => {
  try {
    const { token, realmId } = await getValidQbToken();
    const bankTxns = req.body.bankTxns || [];

    const url = `${QB_API_BASE}/v3/company/${realmId}/banktransactions?minorversion=65`;
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
    const data = await resp.json();
    if (!resp.ok) return res.status(resp.status).json({ error: data });

    const rawList = data.BankTransactions || data.BankTransaction || data.QueryResponse?.BankTransaction || [];
    const qbTxns = rawList
      .filter(t => !t.TxnStatus || t.TxnStatus === 'PENDING')
      .map(t => ({
        id: t.Id,
        txnDate: t.TxnDate,
        amount: parseFloat(t.Amount) || 0,
        description: t.Description || '',
        suggestedMatches: (t.SuggestedMatchList || []).map(m => ({
          txnType: m.TxnType,
          txnId: m.Txn?.Id || '',
          entityName: m.Txn?.EntityRef?.name || '',
          txnDate: m.Txn?.TxnDate || '',
          amount: parseFloat(m.Txn?.Amount) || 0,
        })),
      }));

    const results = bankTxns.map(btxn => {
      let qbMatch = null;
      let matchMethod = '';

      // ACH: match by payment ID embedded in bank description
      if (btxn.paymentId) {
        qbMatch = qbTxns.find(q => q.description.includes(btxn.paymentId));
        if (qbMatch) matchMethod = 'payment-id';
      }

      // Check/mobile deposit: match by last 5 of trace number
      if (!qbMatch) {
        const traceM = String(btxn.desc || '').match(/^(\d{7,12})/);
        if (traceM) {
          const last5 = traceM[1].slice(-5);
          qbMatch = qbTxns.find(q => {
            const d = q.description.toUpperCase();
            return d.includes('XXXXX' + last5) || new RegExp(`\\b${last5}\\b`).test(d);
          });
          if (qbMatch) matchMethod = 'trace-' + last5;
        }
      }

      // Fallback for company payments with no extractable ID: amount + date proximity (±3 days)
      if (!qbMatch && btxn.co) {
        const bankDate = new Date(btxn.date);
        qbMatch = qbTxns.find(q => {
          if (Math.abs(q.amount - (parseFloat(btxn.amount) || 0)) > 0.02) return false;
          return Math.abs(new Date(q.txnDate) - bankDate) / 86400000 <= 3;
        });
        if (qbMatch) matchMethod = 'amount+date';
      }

      let status;
      if (!qbMatch) status = 'not-found';
      else if (qbMatch.suggestedMatches.length === 0) status = 'add';
      else if (qbMatch.suggestedMatches.length === 1) status = 'ready';
      else status = 'ambiguous';

      return {
        bankTxn: btxn,
        qbTxnId: qbMatch?.id || null,
        qbDescription: qbMatch?.description || null,
        qbAmount: qbMatch?.amount || null,
        qbDate: qbMatch?.txnDate || null,
        suggestedMatches: qbMatch?.suggestedMatches || [],
        matchMethod,
        status,
      };
    });

    // For 'add' rows (QB has the deposit but no suggested match): search QB payments by amount+date
    // This catches cases where the check number wasn't entered as a payment reference in Jobber
    const addIndices = results.reduce((acc, r, i) => r.status === 'add' ? [...acc, i] : acc, []);
    if (addIndices.length > 0) {
      const addDates = addIndices.map(i => results[i].bankTxn.date).filter(Boolean);
      const minD = new Date(addDates.reduce((a, b) => a < b ? a : b)); minD.setDate(minD.getDate() - 7);
      const maxD = new Date(addDates.reduce((a, b) => a > b ? a : b)); maxD.setDate(maxD.getDate() + 7);
      const pQuery = `SELECT * FROM Payment WHERE TxnDate >= '${minD.toISOString().slice(0,10)}' AND TxnDate <= '${maxD.toISOString().slice(0,10)}' MAXRESULTS 200`;
      const pUrl = `${QB_API_BASE}/v3/company/${realmId}/query?query=${encodeURIComponent(pQuery)}&minorversion=65`;
      const pResp = await fetch(pUrl, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
      if (pResp.ok) {
        const pData = await pResp.json();
        const qbPayments = (pData.QueryResponse?.Payment || []).map(p => ({
          txnId: p.Id, txnDate: p.TxnDate,
          amount: parseFloat(p.TotalAmt) || 0,
          entityName: p.CustomerRef?.name || '',
        }));
        for (const idx of addIndices) {
          const r = results[idx];
          const amt = parseFloat(r.bankTxn.amount) || 0;
          const bankDate = new Date(r.bankTxn.date);
          const matched = qbPayments.filter(p =>
            Math.abs(p.amount - amt) < 0.02 &&
            Math.abs(new Date(p.txnDate) - bankDate) / 86400000 <= 7
          );
          if (matched.length === 1) { r.status = 'ready'; r.suggestedMatches = matched.map(p => ({ ...p, txnType: 'Payment' })); }
          else if (matched.length > 1) { r.status = 'ambiguous'; r.suggestedMatches = matched.map(p => ({ ...p, txnType: 'Payment' })); }
        }
      }
    }

    res.json({ results, qbTxnCount: qbTxns.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Step 3: Fetch invoices from Jobber ────────────────────────────────────────
app.get('/api/invoices', async (req, res) => {
  try {
    const token = await getValidToken();

    let allInvoices = [];
    let hasNextPage = true;
    let cursor = null;
    let pageCount = 0;

    while (hasNextPage && pageCount < 50) {
      const afterClause = cursor ? `(first: 250, after: "${cursor}")` : `(first: 250)`;
      const query = `{
        invoices${afterClause} {
          nodes {
            id
            invoiceNumber
            subject
            total
            invoiceStatus
            client {
              id
              name
            }
            jobberWebUri
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }`;

      const response = await fetch(GRAPHQL_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
          'X-JOBBER-GRAPHQL-VERSION': '2025-04-16'
        },
        body: JSON.stringify({ query })
      });

      const data = await response.json();

      if (data.errors) {
        const isThrottled = data.errors.some(e => e.extensions?.code === 'THROTTLED');
        if (isThrottled) {
          console.warn(`Throttled on page ${pageCount + 1} — waiting 15s then retrying`);
          await new Promise(r => setTimeout(r, 15000));
          continue;
        }
        const isUnauth = data.errors.some(e =>
          e.extensions?.code === 'UNAUTHENTICATED' || /unauthori[sz]ed/i.test(e.message||'')
        );
        if (isUnauth) {
          return res.status(401).json({ error: 'Jobber session expired — click Connect Jobber to re-authenticate' });
        }
        console.error('GraphQL errors:', JSON.stringify(data.errors));
        return res.status(400).json({ error: data.errors.map(e => e.message).join(', ') });
      }

      if (!data.data?.invoices) {
        console.error('Unexpected Jobber response:', JSON.stringify(data).substring(0, 500));
        return res.status(401).json({ error: 'Jobber session expired — click Connect Jobber to re-authenticate' });
      }

      const page = data.data.invoices;
      allInvoices.push(...page.nodes);
      hasNextPage = page.pageInfo.hasNextPage;
      cursor = page.pageInfo.endCursor;
      pageCount++;

      const lastInv = page.nodes[page.nodes.length - 1];

      if (hasNextPage) await new Promise(r => setTimeout(r, 1000));

      console.log(`Page ${pageCount}: ${page.nodes.length} invoices, hasNextPage: ${hasNextPage}, total: ${allInvoices.length}, lastInv#: ${lastInv?.invoiceNumber}`);
    }

    console.log(`Done. Total invoices fetched: ${allInvoices.length}`);
    res.json(allInvoices);

  } catch (err) {
    console.error('Invoice fetch error:', err);
    const status = err.message === 'Not connected to Jobber' ? 401 : 500;
    res.status(status).json({ error: err.message });
  }
});

// ── Check payments — raw discovery (inspect schema) ──────────────────────────
app.get('/api/check-payments-raw', async (req, res) => {
  try {
    const token = await getValidToken();
    const query = `{
      __type(name: "Invoice") {
        fields {
          name
          type { name kind ofType { name } }
        }
      }
    }`;
    const response = await fetch(GRAPHQL_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'X-JOBBER-GRAPHQL-VERSION': '2025-04-16'
      },
      body: JSON.stringify({ query })
    });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Add a line item to a Jobber invoice ──────────────────────────────────────
app.post('/api/add-line-item', async (req, res) => {
  try {
    const token = await getValidToken();
    const { invoiceId, name, unitPrice, description } = req.body;

    if (!invoiceId || unitPrice === undefined) {
      return res.status(400).json({ error: 'invoiceId and unitPrice required' });
    }

    const safeName = (name || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const safeDesc = (description || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const mutation = `mutation {
      invoiceEdit(invoiceId: "${invoiceId}", input: {
        lineItems: [
          {
            name: "${safeName}"
            ${safeDesc ? `description: "${safeDesc}"` : ''}
            quantity: 1
            unitPrice: ${parseFloat(unitPrice)}
          }
        ]
      }) {
        invoice { id }
        userErrors { message path }
      }
    }`;

    const mutResp = await fetch(GRAPHQL_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'X-JOBBER-GRAPHQL-VERSION': '2025-04-16'
      },
      body: JSON.stringify({ query: mutation })
    });

    const mutData = await mutResp.json();
    if (mutData.errors) {
      // Auto-introspect InvoiceEditInput so we know valid field names
      let fields = [];
      try {
        const ir = await fetch(GRAPHQL_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}`, 'X-JOBBER-GRAPHQL-VERSION': '2025-04-16' },
          body: JSON.stringify({ query: `{ __schema { mutationType { fields { name } } } }` })
        });
        const id = await ir.json();
        fields = (id.data?.__schema?.mutationType?.fields?.map(f => f.name) || [])
          .filter(n => /line|item|invoice/i.test(n));
      } catch (_) {}
      return res.status(400).json({ error: mutData.errors.map(e => e.message).join(', '), invoiceEditInputFields: fields });
    }

    const userErrors = mutData.data?.invoiceEdit?.userErrors;
    if (userErrors?.length > 0) return res.status(400).json({ error: userErrors.map(e => e.message).join(', ') });

    console.log(`Line item added: Invoice ${invoiceId} · "${name}" · $${unitPrice}`);
    res.json({ success: true, invoiceId });

  } catch (err) {
    console.error('Add line item error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Apply payment to invoice in Jobber ────────────────────────────────────────
app.post('/api/apply-payment', async (req, res) => {
  try {
    const token = await getValidToken();
    const { invoiceNumber, jobberGqlId, amount, paymentRef, paymentDate } = req.body;

    if (!invoiceNumber || !amount) {
      return res.status(400).json({ error: 'invoiceNumber and amount required' });
    }

    if (!jobberGqlId) {
      return res.status(400).json({ error: 'jobberGqlId is required — reconnect Jobber to refresh invoice data' });
    }

    // Apply payment via mutation
    const mutation = `mutation {
      invoicePaymentCreate(input: {
        invoiceId: "${jobberGqlId}"
        amount: ${amount}
        paidAt: "${paymentDate}T00:00:00Z"
      }) {
        invoicePayment {
          id
          amount
        }
        userErrors {
          message
          path
        }
      }
    }`;

    const mutResp = await fetch(GRAPHQL_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'X-JOBBER-GRAPHQL-VERSION': '2024-11-15'
      },
      body: JSON.stringify({ query: mutation })
    });

    const mutData = await mutResp.json();
    console.log(`invoicePaymentCreate raw response:`, JSON.stringify(mutData).substring(0, 500));

    if (mutData.errors) {
      return res.status(400).json({ error: mutData.errors });
    }

    const userErrors = mutData.data?.invoicePaymentCreate?.userErrors;
    if (userErrors?.length > 0) {
      return res.status(400).json({ error: userErrors.map(e => e.message).join(', ') });
    }

    const createdPayment = mutData.data?.invoicePaymentCreate?.invoicePayment;
    if (!createdPayment?.id) {
      console.error(`invoicePaymentCreate returned no payment — full response:`, JSON.stringify(mutData));
      return res.status(400).json({ error: 'Jobber accepted the request but did not create a payment record. Check Render logs.' });
    }

    console.log(`Payment applied: Invoice #${invoiceNumber} · $${amount} · Ref: ${paymentRef} · Date: ${paymentDate} · Payment ID: ${createdPayment.id}`);
    res.json({ success: true, invoiceNumber, amount });

  } catch (err) {
    console.error('Apply payment error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Apply all payments in a check ─────────────────────────────────────────────
app.post('/api/apply-all-payments', async (req, res) => {
  try {
    const { lineItems, paymentRef, paymentDate } = req.body;

    if (!lineItems || lineItems.length === 0) {
      return res.status(400).json({ error: 'No line items provided' });
    }

    const results = [];
    for (const item of lineItems) {
      try {
        const resp = await fetch(`http://localhost:${process.env.PORT || 3000}/api/apply-payment`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            invoiceNumber: item.invoiceNumber,
            jobberGqlId: item.jobberGqlId,
            amount: item.amount,
            paymentRef,
            paymentDate
          })
        });
        const data = await resp.json();
        results.push({ invoiceNumber: item.invoiceNumber, ...data });
        // Small delay to avoid rate limiting
        await new Promise(r => setTimeout(r, 300));
      } catch (e) {
        results.push({ invoiceNumber: item.invoiceNumber, error: e.message });
      }
    }

    const succeeded = results.filter(r => r.success).length;
    const failed = results.filter(r => r.error).length;
    results.filter(r => r.error).forEach(r =>
      console.error(`  ✗ Invoice #${r.invoiceNumber}: ${JSON.stringify(r.error)}`)
    );
    console.log(`Apply all complete: ${succeeded} succeeded, ${failed} failed`);
    res.json({ results, succeeded, failed });

  } catch (err) {
    console.error('Apply all error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Playwright payment automation (SSE) ──────────────────────────────────────
app.get('/api/playwright-payment', async (req, res) => {
  if (playwrightRunning) {
    // Use SSE format so the browser can read the error message instead of just "Connection lost"
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.flushHeaders();
    res.write(`data: ${JSON.stringify({ type: 'done', success: false, error: 'A payment is already in progress — wait for it to finish, or visit /api/queue-status to check.' })}\n\n`);
    res.end();
    return;
  }
  const { clientId, invoiceIds, type, ref, date, amount } = req.query;
  if (!clientId || !invoiceIds || !type || !date) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.flushHeaders();
    res.write(`data: ${JSON.stringify({ type: 'done', success: false, error: `Missing required parameters. Got: clientId=${clientId} invoiceIds=${invoiceIds} type=${type} ref=${ref} date=${date}` })}\n\n`);
    res.end();
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = obj => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 15000);
  playwrightRunning = true;

  // On Render: queue for local worker. Locally: run Playwright directly.
  if (process.env.RENDER) {
    const ids = invoiceIds.split(',').map(s => s.trim()).filter(Boolean);
    const jobId = createJob({ clientId, invoiceIds: ids, type, ref, date, amount: amount ? parseFloat(amount) : null });
    send({ type: 'log', text: `Job ${jobId} queued — waiting for local worker to pick up...` });
    console.log(`Job ${jobId} queued: clientId=${clientId} invoiceIds=${ids.join(',')} date=${date}`);

    const onLog  = text => { if (!res.writableEnded) send({ type: 'log', text }); };
    const onDone = ({ success, error }) => {
      playwrightRunning = false;
      clearInterval(keepAlive);
      sseCleanup();
      if (!res.writableEnded) {
        send({ type: 'done', success, error });
        res.end();
      }
    };

    const sseCleanup = () => {
      jobEvents.off(`${jobId}:log`,  onLog);
      jobEvents.off(`${jobId}:done`, onDone);
    };

    jobEvents.on(`${jobId}:log`,  onLog);
    jobEvents.on(`${jobId}:done`, onDone);

    // If browser disconnects before job finishes: stop keep-alive and remove SSE listeners,
    // but leave playwrightRunning=true so a reconnecting EventSource doesn't queue a duplicate job.
    // The onDone handler above will reset it when the worker finishes.
    res.on('close', () => { clearInterval(keepAlive); sseCleanup(); });
    return;
  }

  // Local path — run Playwright directly.
  const origLog = console.log;
  const origError = console.error;
  console.log = (...args) => {
    origLog.apply(console, args);
    send({ type: 'log', text: args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ') });
  };
  console.error = (...args) => {
    origError.apply(console, args);
    send({ type: 'log', text: '⚠ ' + args.map(String).join(' ') });
  };

  try {
    const ids = invoiceIds.split(',').map(s => s.trim()).filter(Boolean);
    const batchCount = Math.ceil(ids.length / 50);
    if (batchCount > 1) {
      send({ type: 'log', text: `${ids.length} invoices → ${batchCount} batches of up to 50 (Jobber limit).` });
    }
    await applyJobberPayment({ clientId, invoiceIds: ids, type, ref, date, amount: amount ? parseFloat(amount) : null, submit: true });
    send({ type: 'done', success: true });
  } catch (err) {
    send({ type: 'done', success: false, error: err.message });
  } finally {
    clearInterval(keepAlive);
    playwrightRunning = false;
    console.log = origLog;
    console.error = origError;
    res.end();
  }
});

// ── Jobber schema probe ───────────────────────────────────────────────────────
app.get('/api/jobber-schema', async (req, res) => {
  try {
    const token = await getValidToken();
    const mutationQuery = `{ mutations: __schema { mutationType { fields { name } } } }`;

    // Probe multiple API versions to find which have invoicePaymentCreate
    const versionsToProbe = ['2025-04-16','2024-09-30','2024-08-01','2024-04-05','2023-11-15','2023-08-23'];
    const versionResults = {};
    for (const v of versionsToProbe) {
      const r = await fetch(GRAPHQL_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}`, 'X-JOBBER-GRAPHQL-VERSION': v },
        body: JSON.stringify({ query: mutationQuery })
      });
      const d = await r.json();
      if (d.message) { versionResults[v] = `invalid: ${d.message}`; continue; }
      const names = d.data?.mutations?.mutationType?.fields?.map(f => f.name) || [];
      versionResults[v] = names.filter(n => /pay/i.test(n));
    }

    // Also introspect InvoiceEditInput on current version
    const query = `{
      invoiceEditInput: __type(name: "InvoiceEditInput") {
        inputFields { name type { name kind ofType { name kind } } }
      }
      mutations: __schema { mutationType { fields { name } } }
    }`;
    const response = await fetch(GRAPHQL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}`, 'X-JOBBER-GRAPHQL-VERSION': '2025-04-16' },
      body: JSON.stringify({ query })
    });
    const data = await response.json();
    const inputFields = data.data?.invoiceEditInput?.inputFields?.map(f => f.name) || [];
    const allMutations = data.data?.mutations?.mutationType?.fields?.map(f => f.name) || [];
    const lineItemMutations = allMutations.filter(n => /line|item|invoice/i.test(n));
    const paymentMutations = allMutations.filter(n => /pay/i.test(n));
    res.json({ versionResults, invoiceEditInputFields: inputFields, lineItemMutations, paymentMutations });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Queue status / reset ──────────────────────────────────────────────────────
app.get('/api/queue-status', (req, res) => {
  res.json({
    playwrightRunning,
    jobQueueSize: jobQueue.size,
    jobs: [...jobQueue.values()].map(j => ({ id: j.id, status: j.status, params: j.params })),
    lastJobResult,
  });
});

app.post('/api/queue-reset', (req, res) => {
  jobQueue.clear();
  playwrightRunning = false;
  res.json({ ok: true, message: 'Queue cleared and playwrightRunning reset to false' });
});

// ── QB bank match via Playwright ─────────────────────────────────────────────
app.get('/api/playwright-qb-match', async (req, res) => {
  const { ref, name, amount, date } = req.query;
  if (!ref || !name) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.flushHeaders();
    res.write(`data: ${JSON.stringify({ type: 'done', success: false, error: 'ref and name are required' })}\n\n`);
    res.end();
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = obj => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 15000);

  const origLog   = console.log;
  const origError = console.error;
  console.log   = (...args) => { origLog.apply(console, args);   send({ type: 'log', text: args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ') }); };
  console.error = (...args) => { origError.apply(console, args); send({ type: 'log', text: '⚠ ' + args.map(String).join(' ') }); };

  try {
    const { matchInQbBanking } = require('./scripts/qb-match');
    await matchInQbBanking({ ref, name, amount: parseFloat(amount) || 0, date });
    send({ type: 'done', success: true });
  } catch (err) {
    send({ type: 'done', success: false, error: err.message });
  } finally {
    clearInterval(keepAlive);
    console.log   = origLog;
    console.error = origError;
    res.end();
  }
});

// ── Remittance collector (inline) ────────────────────────────────────────────
const collectorSources = (() => {
  try {
    return {
      rely:             require('./collector/sources/rely'),
      lula:             require('./collector/sources/lula'),
      orhp:             require('./collector/sources/orhp'),
      'two-ten':        require('./collector/sources/two-ten'),
      rheem:            require('./collector/sources/rheem'),
      'first-american': require('./collector/sources/first-american'),
      lessen:           require('./collector/sources/lessen'),
      frontdoor:        require('./collector/sources/frontdoor'),
    };
  } catch (e) {
    console.error('Collector sources failed to load:', e.message);
    console.error(e.stack);
    return null;
  }
})();

let collectAborted = false;

app.post('/api/collect/stop', (_req, res) => {
  collectAborted = true;
  res.json({ ok: true });
});

app.post('/api/collect', async (req, res) => {
  if (!collectorSources) {
    return res.status(503).json({ error: 'Collector sources not available on this server.' });
  }
  const { companies, daysBack = 30 } = req.body || {};
  const targets = companies?.length
    ? companies.filter(c => collectorSources[c])
    : Object.keys(collectorSources);

  collectAborted = false;
  console.log(`[collector] Running: ${targets.join(', ')} (daysBack=${daysBack})`);

  const allResults = [];
  const errors = {};

  for (const name of targets) {
    if (collectAborted) {
      console.log('[collector] Stopped by user');
      break;
    }
    console.log(`[collector] Starting ${name}...`);
    try {
      const results = await collectorSources[name].collect({ daysBack });
      allResults.push(...results);
      console.log(`[collector] ${name}: ${results.length} payments`);
    } catch (err) {
      console.error(`[collector] ${name} FAILED: ${err.message}`);
      errors[name] = err.message;
    }
  }

  console.log(`[collector] Done. Total: ${allResults.length}, errors: ${Object.keys(errors).length}`);
  res.json({ results: allResults, errors, total: allResults.length });
});

// ── Local worker endpoints ────────────────────────────────────────────────────

// Worker polls this to get the next pending job.
app.get('/api/jobs/next', workerAuth, (req, res) => {
  for (const [id, job] of jobQueue) {
    if (job.status === 'pending') {
      job.status = 'running';
      return res.json(job);
    }
  }
  res.json(null);
});

// Worker streams log lines back so they appear in the browser's SSE feed.
app.post('/api/jobs/:id/log', workerAuth, (req, res) => {
  const { text } = req.body;
  jobEvents.emit(`${req.params.id}:log`, text);
  res.json({ ok: true });
});

// Worker signals completion (success or failure).
app.post('/api/jobs/:id/done', workerAuth, (req, res) => {
  const { success, error } = req.body;
  const job = jobQueue.get(req.params.id);
  if (job) {
    job.status = success ? 'completed' : 'failed';
    jobQueue.delete(req.params.id);
  }
  lastJobResult = { id: req.params.id, success, error: error || null, finishedAt: new Date().toISOString() };
  jobEvents.emit(`${req.params.id}:done`, { success, error });
  res.json({ ok: true });
});

// Temporary: lets us verify WORKER_SECRET is loaded on Render without revealing it.
app.get('/api/worker-debug', (req, res) => {
  res.json({
    workerSecretSet: !!WORKER_SECRET,
    workerSecretLength: WORKER_SECRET ? WORKER_SECRET.length : 0,
    receivedSecret: req.headers['x-worker-secret'] || '(none)',
    match: req.headers['x-worker-secret'] === WORKER_SECRET,
  });
});

// ── Connection status ─────────────────────────────────────────────────────────
app.get('/api/status', (req, res) => {
  res.json({
    connected: !!tokenStore.access_token,
    expires_at: tokenStore.expires_at
  });
});

// ── Start server ──────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`TrackPoint_OS running on port ${PORT}`));
