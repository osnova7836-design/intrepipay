const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');
const { applyJobberPayment } = require('./scripts/jobber-payment');

let playwrightRunning = false;

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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
      expires_at: Date.now() + (data.expires_in * 1000)
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
    const data = await response.json();
    tokenStore = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Date.now() + (data.expires_in * 1000)
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
    let stopFetching = false;
    
    while (hasNextPage && pageCount < 50 && !stopFetching) {
      const afterClause = cursor
        ? `(first: 100, after: "${cursor}", filter: { createdAt: { after: "2025-12-31T23:59:59Z" } })`
        : `(first: 100, filter: { createdAt: { after: "2025-12-31T23:59:59Z" } })`;
      const query = `{
        invoices${afterClause} {
          nodes {
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
        console.error('GraphQL errors:', JSON.stringify(data.errors));
        return res.status(400).json({ error: data.errors });
      }

      const page = data.data.invoices;
      allInvoices = allInvoices.concat(page.nodes);
      hasNextPage = page.pageInfo.hasNextPage;
      cursor = page.pageInfo.endCursor;
      pageCount++;

      const lastInv = page.nodes[page.nodes.length - 1];
      if (lastInv && parseInt(lastInv.invoiceNumber) < 12000) stopFetching = true;

      // Avoid Jobber rate limiting
      await new Promise(r => setTimeout(r, 1000));

      console.log(`Page ${pageCount}: ${page.nodes.length} invoices, hasNextPage: ${hasNextPage}, total: ${allInvoices.length}`);
    }

    console.log(`Done. Total invoices fetched: ${allInvoices.length}`);
    res.json(allInvoices);

  } catch (err) {
    console.error('Invoice fetch error:', err);
    const status = err.message === 'Not connected to Jobber' ? 401 : 500;
    res.status(status).json({ error: err.message });
  }
});

// ── Apply payment to invoice in Jobber ────────────────────────────────────────
app.post('/api/apply-payment', async (req, res) => {
  try {
    const token = await getValidToken();
    const { invoiceNumber, amount, paymentRef, paymentDate } = req.body;

    if (!invoiceNumber || !amount) {
      return res.status(400).json({ error: 'invoiceNumber and amount required' });
    }

    // Look up invoice ID by invoice number
    const lookupQuery = `{
      invoices(filter: { invoiceNumber: { eq: ${invoiceNumber} } }) {
        nodes {
          id
          invoiceNumber
          total
          invoiceStatus
        }
      }
    }`;

    const lookupResp = await fetch(GRAPHQL_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'X-JOBBER-GRAPHQL-VERSION': '2025-04-16'
      },
      body: JSON.stringify({ query: lookupQuery })
    });

    const lookupData = await lookupResp.json();

    if (lookupData.errors) {
      return res.status(400).json({ error: lookupData.errors });
    }

    const invoice = lookupData.data?.invoices?.nodes?.[0];
    if (!invoice) {
      return res.status(404).json({ error: `Invoice #${invoiceNumber} not found` });
    }

    // Apply payment via mutation
    const mutation = `mutation {
      invoicePaymentCreate(input: {
        invoiceId: "${invoice.id}"
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
        'X-JOBBER-GRAPHQL-VERSION': '2025-04-16'
      },
      body: JSON.stringify({ query: mutation })
    });

    const mutData = await mutResp.json();

    if (mutData.errors) {
      return res.status(400).json({ error: mutData.errors });
    }

    const userErrors = mutData.data?.invoicePaymentCreate?.userErrors;
    if (userErrors?.length > 0) {
      return res.status(400).json({ error: userErrors.map(e => e.message).join(', ') });
    }

    console.log(`Payment applied: Invoice #${invoiceNumber} · $${amount} · Ref: ${paymentRef} · Date: ${paymentDate}`);
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
    res.status(409).json({ error: 'A payment is already in progress. Wait for it to finish.' });
    return;
  }
  const { clientId, invoiceIds, type, ref, date } = req.query;
  if (!clientId || !invoiceIds || !type || !ref || !date) {
    res.status(400).json({ error: 'Missing required parameters: clientId, invoiceIds, type, ref, date' });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = obj => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  playwrightRunning = true;

  // Patch console so Playwright's log lines stream to the browser in real time.
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
    await applyJobberPayment({
      clientId,
      invoiceIds: ids,
      type,
      ref,
      date,
      submit: true,
    });
    send({ type: 'done', success: true });
  } catch (err) {
    send({ type: 'done', success: false, error: err.message });
  } finally {
    playwrightRunning = false;
    console.log = origLog;
    console.error = origError;
    res.end();
  }
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
app.listen(PORT, () => console.log(`IntrepiPay running on port ${PORT}`));
