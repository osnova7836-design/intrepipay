// push-now.js — safely syncs .env to Render WITHOUT wiping existing vars
// Usage: node push-now.js
require('dotenv').config({ override: true });
const https = require('https');

const API_KEY    = process.env.RENDER_API_KEY;
const SERVICE_ID = process.env.RENDER_SERVICE_ID;

if (!API_KEY || !SERVICE_ID) {
  console.error('ERROR: Set RENDER_API_KEY and RENDER_SERVICE_ID in your .env first.');
  process.exit(1);
}

const LOCAL_VARS = {
  JOBBER_CLIENT_ID:     process.env.JOBBER_CLIENT_ID,
  JOBBER_CLIENT_SECRET: process.env.JOBBER_CLIENT_SECRET,
  WORKER_SECRET:        process.env.WORKER_SECRET,
  APP_URL:              process.env.RENDER_APP_URL,

  GMAIL_CLIENT_ID:      process.env.GMAIL_CLIENT_ID,
  GMAIL_CLIENT_SECRET:  process.env.GMAIL_CLIENT_SECRET,
  GMAIL_REDIRECT_URI:   process.env.GMAIL_REDIRECT_URI,
  GMAIL_REFRESH_TOKEN:  process.env.GMAIL_REFRESH_TOKEN,

  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID:   process.env.TELEGRAM_CHAT_ID,
  TELEGRAM_CHAT_ID_2: process.env.TELEGRAM_CHAT_ID_2,

  RELY_USERNAME:       process.env.RELY_USERNAME,
  RELY_PASSWORD:       process.env.RELY_PASSWORD,
  LULA_USERNAME:       process.env.LULA_USERNAME,
  LULA_PASSWORD:       process.env.LULA_PASSWORD,
  ORHP_USERNAME:       process.env.ORHP_USERNAME,
  ORHP_PASSWORD:       process.env.ORHP_PASSWORD,
  TWO_TEN_USERNAME:    process.env.TWO_TEN_USERNAME,
  TWO_TEN_PASSWORD:    process.env.TWO_TEN_PASSWORD,
  LESSEN_USERNAME:     process.env.LESSEN_USERNAME,
  LESSEN_PASSWORD:     process.env.LESSEN_PASSWORD,
  FRONTDOOR_USERNAME:  process.env.FRONTDOOR_USERNAME,
  FRONTDOOR_PASSWORD:  process.env.FRONTDOOR_PASSWORD,
  CINCH_USERNAME:      process.env.CINCH_USERNAME,
  CINCH_PASSWORD:      process.env.CINCH_PASSWORD,
};

function renderRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const options = {
      hostname: 'api.render.com',
      path,
      method,
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    };

    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });

    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function main() {
  console.log(`Fetching current env vars for service ${SERVICE_ID}...`);

  const existing = await renderRequest('GET', `/v1/services/${SERVICE_ID}/env-vars`);
  if (existing.status !== 200) {
    console.error('Failed to fetch existing vars:', existing.body);
    process.exit(1);
  }

  const merged = {};
  for (const { envVar } of existing.body) {
    merged[envVar.key] = envVar.value;
  }
  for (const [key, value] of Object.entries(LOCAL_VARS)) {
    if (value !== undefined && value !== '') {
      merged[key] = value;
    }
  }

  const payload = Object.entries(merged).map(([key, value]) => ({ key, value }));
  console.log(`Pushing ${payload.length} env vars...`);

  const result = await renderRequest('PUT', `/v1/services/${SERVICE_ID}/env-vars`, payload);
  if (result.status === 200 || result.status === 201) {
    console.log('Done. Trigger a manual deploy in Render dashboard to apply.');
  } else {
    console.error('Failed:', result.status, result.body);
    process.exit(1);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
