const express = require('express');
const fetch = require('node-fetch');
const path = require('path');

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

// In-memory token store (one tenant for now — multi-tenant comes later)
let tokenStore = {
  access_token: null,
  refresh_token: null,
  expires_at: null
};

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
  }

  return tokenStore.access_token;
}

// ── Step 3: Fetch invoices from Jobber ────────────────────────────────────────
app.get('/api/invoices', async (req, res) => {
  try {
    const token = await getValidToken();

    const query = `{
      invoices {
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
      return res.status(400).json({ error: data.errors });
    }

    res.json(data.data.invoices.nodes);

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
