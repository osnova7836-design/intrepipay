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

console.log(`RENDER_URL:    ${RENDER_URL}`);
console.log(`WORKER_SECRET: ${WORKER_SECRET.slice(0, 8)}... (${WORKER_SECRET.length} chars)`);
console.log(`CHROME_CDP_URL: ${process.env.CHROME_CDP_URL || '(not set)'}`);

const headers = {
  'Content-Type': 'application/json',
  'x-worker-secret': WORKER_SECRET,
};

let pollCount = 0;
let jobRunning = false;

async function post(path, body) {
  const fetch = require('node-fetch');
  try {
    const res = await fetch(`${RENDER_URL}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!res.ok) {
      const text = await res.text();
      console.error(`POST ${path} failed: ${res.status} — ${text.slice(0, 200)}`);
    }
  } catch (err) {
    console.error(`POST ${path} error: ${err.message}`);
  }
}

async function log(jobId, text) {
  console.log(`[job ${jobId}] ${text}`);
  await post(`/api/jobs/${jobId}/log`, { text });
}

async function runJob(job) {
  const { id, params } = job;
  const { clientId, invoiceIds, type, ref, date } = params;

  console.log(`\n=== Job ${id} received ===`);
  console.log(`  clientId:   ${clientId}`);
  console.log(`  invoiceIds: ${JSON.stringify(invoiceIds)}`);
  console.log(`  type:       ${type}`);
  console.log(`  ref:        ${ref}`);
  console.log(`  date:       ${date}`);

  await log(id, `Starting: client ${clientId}, ${invoiceIds.length} invoice(s), date ${date}`);

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
    console.log(`[job ${id}] Done ✓\n`);
  } catch (err) {
    console.error(`[job ${id}] FAILED: ${err.message}`);
    if (err.stack) console.error(err.stack);
    await log(id, `Error: ${err.message}`);
    await post(`/api/jobs/${id}/done`, { success: false, error: err.message });
  }
}

async function poll() {
  if (jobRunning) return; // don't overlap polls while a job is in progress
  const fetch = require('node-fetch');
  pollCount++;
  const tick = `[poll #${pollCount}]`;
  try {
    const res = await fetch(`${RENDER_URL}/api/jobs/next`, { headers });
    if (!res.ok) {
      const body = await res.text();
      console.error(`${tick} Auth failed — status ${res.status}: ${body.slice(0, 200)}`);
      return;
    }
    const job = await res.json();
    if (job) {
      console.log(`${tick} Got job ${job.id}`);
      jobRunning = true;
      try {
        await runJob(job);
      } finally {
        jobRunning = false;
      }
    } else if (pollCount % 30 === 0) {
      // Print a heartbeat every ~60 seconds so you know it's alive
      console.log(`${tick} Idle — waiting for jobs...`);
    }
  } catch (err) {
    console.error(`${tick} Poll error: ${err.message}`);
  }
}

console.log(`\nLocal worker started. Polling every ${POLL_INTERVAL / 1000}s...`);
console.log('Press Ctrl+C to stop.\n');

setInterval(poll, POLL_INTERVAL);
poll(); // immediate first check
