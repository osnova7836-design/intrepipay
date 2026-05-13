const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');

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

    while (hasNextPage && pageCount < 10) {
      const afterClause = cursor ? `(after: "${cursor}")` : '';
      const query = `{
        invoices${afterClause} {
          nodes {
            invoiceNumber
            subject
            total
            invoiceStatus
            client {
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

      console.log(`Page ${pageCount}: ${page.nodes.length} invoices, hasNextPage: ${hasNextPage}, total: ${allInvoices.length}`);
    }

    console.log(`Done. Total invoices fetched: ${allInvoices.length}`);
    res.json(allInvoices);

  } catch (err) {
    console.error('Invoice fetch error:', err);
    res.status(500).json({ error: err.message });
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
