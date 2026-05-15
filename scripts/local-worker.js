// Polls the Render server for pending payment jobs and executes them locally
// using your real Chrome profile (bypassing Cloudflare bot detection).
//
// Keep this running on your Windows machine whenever you're processing payments.
// Usage: node scripts/local-worker.js

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { applyJobberPayment } = require('./jobber-payment');

const RENDER_URL  = (process.env.RENDER_APP_URL || '').replace(/\/$/, '');
const WORKER_SECRET = process.env.WORKER_SECRET;
const POLL_INTERVAL = 2000;

if (!RENDER_URL)      { console.error('RENDER_APP_URL not set in .env'); process.exit(1); }
if (!WORKER_SECRET)   { console.error('WORKER_SECRET not set in .env');  process.exit(1); }

const headers = {
  'Content-Type': 'application/json',
  'x-worker-secret': WORKER_SECRET,
};

async function post(path, body) {
  const fetch = require('node-fetch');
  await fetch(`${RENDER_URL}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
}

async function log(jobId, text) {
  console.log(`[job ${jobId}] ${text}`);
  await post(`/api/jobs/${jobId}/log`, { text });
}

async function runJob(job) {
  const { id, params } = job;
  const { clientId, invoiceIds, type, ref, date } = params;

  await log(id, `Starting: client ${clientId}, ${invoiceIds.length} invoice(s)`);

  try {
    await applyJobberPayment({
      clientId,
      invoiceIds,
      type,
      ref,
      date,
      submit: true,
      onLog: text => log(id, text),
    });
    await post(`/api/jobs/${id}/done`, { success: true });
    console.log(`[job ${id}] Done ✓`);
  } catch (err) {
    await log(id, `Error: ${err.message}`);
    await post(`/api/jobs/${id}/done`, { success: false, error: err.message });
    console.error(`[job ${id}] Failed:`, err.message);
  }
}

async function poll() {
  const fetch = require('node-fetch');
  try {
    const res = await fetch(`${RENDER_URL}/api/jobs/next`, { headers });
    if (!res.ok) { console.error('Worker auth failed — check WORKER_SECRET'); return; }
    const job = await res.json();
    if (job) await runJob(job);
  } catch (err) {
    console.error('Poll error:', err.message);
  }
}

console.log(`Local worker started. Polling ${RENDER_URL} every ${POLL_INTERVAL / 1000}s...`);
console.log('Press Ctrl+C to stop.\n');

setInterval(poll, POLL_INTERVAL);
poll(); // immediate first check
