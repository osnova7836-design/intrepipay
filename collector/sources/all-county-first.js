const { launchBrowser } = require('../utils/browser');

const LOGIN_URL = 'https://allcountyvendors.com/';
const TRANSACTIONS_URL = 'https://allcountyvendors.com/Dashboard/Transactions/';

// Portal shows one continuous transaction table (no server-side date filter/pagination seen).
// Each "Check" row is an ePay payment; the "Bill" row(s) immediately following it (until the
// next "Check" row) are the invoices it covers. Bill "Reference #" IS the Jobber invoice number.
// "ReversalCheck" rows void an earlier real (non-ePay) check — skip both sides of that pair.

async function collect({ daysBack = 30 } = {}) {
  const username = process.env.ALLCOUNTY_USERNAME;
  const password = process.env.ALLCOUNTY_PASSWORD;
  const location = process.env.ALLCOUNTY_LOCATION;
  if (!username || !password || !location) {
    throw new Error('ALLCOUNTY_USERNAME / ALLCOUNTY_PASSWORD / ALLCOUNTY_LOCATION env vars not set');
  }

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - daysBack);

  const ctx = await launchBrowser('allcounty');
  try {
    const page = await ctx.newPage();
    await login(page, username, password, location);

    await page.goto(TRANSACTIONS_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForSelector('table tbody tr', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1000);

    const rows = await page.evaluate(() =>
      Array.from(document.querySelectorAll('table tbody tr')).map(tr => {
        const cells = Array.from(tr.querySelectorAll('td')).map(td => td.textContent.trim());
        return { type: cells[0], date: cells[1], reference: cells[2], info: cells[3], memo: cells[4], amount: cells[5] };
      })
    );

    console.log(`[AllCountyFirst] ${rows.length} transaction rows found`);
    const results = parseRows(rows, cutoff);
    console.log(`[AllCountyFirst] ${results.length} payments collected`);
    return results;
  } finally {
    await ctx.close();
  }
}

async function login(page, username, password, location) {
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2000);

  if (page.url().includes('/Dashboard')) {
    console.log('[AllCountyFirst] Already logged in (session active)');
    return;
  }

  await page.waitForSelector('input[type="email"]', { timeout: 15000 });
  await page.locator('input[type="email"]').fill(username);
  await page.locator('input[type="password"]').fill(password);
  await page.locator('select').first().selectOption({ label: location });
  await page.locator('button:has-text("Log In"), button[type="submit"]').first().click();
  await page.waitForURL(url => url.toString().includes('/Dashboard'), { timeout: 30000 });
  console.log('[AllCountyFirst] Logged in');
}

function parseRows(rows, cutoff) {
  const voidedRefs = new Set(
    rows.filter(r => r.type === 'ReversalCheck').map(r => r.reference)
  );

  const payments = [];
  let current = null;
  let skipGroup = false;

  for (const row of rows) {
    if (row.type === 'ReversalCheck') { current = null; skipGroup = false; continue; }

    if (row.type === 'Check') {
      if (current && current.workOrders.length) payments.push(current);
      const date = normalizeDate(row.date);
      skipGroup = voidedRefs.has(row.reference);
      current = { company: 'All County First', paymentRef: row.reference === 'ePay' ? `AC-${date}-${row.amount}` : row.reference, paymentDate: date, amount: 0, workOrders: [] };
      continue;
    }

    if (row.type === 'Bill' && current && !skipGroup) {
      const amount = parseAmount(row.amount);
      if (!amount) continue;
      current.workOrders.push({ workOrder: row.reference, amount });
      current.amount = Math.round((current.amount + amount) * 100) / 100;
    }
  }
  if (current && current.workOrders.length) payments.push(current);

  return payments.filter(p => {
    const d = new Date(p.paymentDate);
    return !isNaN(d) && d >= cutoff;
  });
}

function parseAmount(val) {
  return parseFloat(String(val).replace(/[$,]/g, '')) || 0;
}

function normalizeDate(val) {
  if (!val) return '';
  const d = new Date(val);
  if (!isNaN(d)) return d.toISOString().slice(0, 10);
  return String(val);
}

module.exports = { collect };
