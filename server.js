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
  APP_URL = 'https://intrepipay.com'
} = process.env;

const REDIRECT_URI = `${APP_URL}/auth/jobber/callback`;
const TOKEN_URL = 'https://api.getjobber.com/api/oauth/token';
const GRAPHQL_URL = 'https://api.getjobber.com/api/graphql';

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
  const { clientId, invoiceIds, type, ref, date } = req.query;
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
    const jobId = createJob({ clientId, invoiceIds: ids, type, ref, date });
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
    await applyJobberPayment({ clientId, invoiceIds: ids, type, ref, date, submit: true });
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
    // Introspect InvoiceEditInput to find valid line-item field names
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
    res.json({ invoiceEditInputFields: inputFields, lineItemMutations, paymentMutations });
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

// ── Remittance collector proxy ────────────────────────────────────────────────
app.post('/api/collect', async (req, res) => {
  const collectorUrl = process.env.COLLECTOR_URL || 'http://localhost:3001';
  const { companies, daysBack } = req.body || {};
  try {
    const resp = await fetch(`${collectorUrl}/collect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ companies, daysBack }),
    });
    if (!resp.ok) throw new Error(`Collector responded ${resp.status}`);
    res.json(await resp.json());
  } catch (err) {
    res.status(502).json({ error: `Collector unreachable: ${err.message}` });
  }
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
