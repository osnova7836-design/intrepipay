const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');
const { launchBrowser, DOWNLOAD_DIR } = require('../utils/browser');

const LULA_URL = 'https://provider.lula.io';

async function collect({ daysBack = 30 } = {}) {
  const username = process.env.LULA_USERNAME;
  const password = process.env.LULA_PASSWORD;
  if (!username || !password) throw new Error('LULA_USERNAME / LULA_PASSWORD env vars not set');

  const ctx = await launchBrowser('lula');
  try {
    const page = await ctx.newPage();
    await login(page, username, password);

    await page.goto(`${LULA_URL}/payouts`, { waitUntil: 'load' });
    await page.waitForTimeout(2000);

    // Filter to Paid status
    await page.locator('.selectbox__control').first().click();
    await page.waitForTimeout(800);
    await page.locator('[class*="option"]', { hasText: /^paid$/i }).first().click();
    await page.waitForTimeout(1000);
    console.log('[Lula] Filtered to Paid');

    // Set date range to last daysBack days
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - daysBack);
    const fromStr = cutoff.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });
    const toStr = new Date().toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });

    const dateBtn = page.locator('button', { hasText: /all time/i })
      .or(page.locator('[aria-label*="date" i]').first());
    if (await dateBtn.count() > 0) {
      await dateBtn.first().click();
      await page.waitForTimeout(800);
      // Try to fill start/end date inputs in the date picker
      const startInput = page.locator('input[placeholder*="start" i], input[placeholder*="from" i]').first();
      const endInput   = page.locator('input[placeholder*="end" i], input[placeholder*="to" i]').first();
      if (await startInput.count() > 0) {
        await startInput.fill(fromStr);
        await endInput.fill(toStr);
        const applyBtn = page.locator('button', { hasText: /apply|done|ok/i });
        if (await applyBtn.count() > 0) await applyBtn.first().click();
        await page.waitForTimeout(1000);
        console.log(`[Lula] Date filtered: ${fromStr} → ${toStr}`);
      }
    }

    if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

    // Export now opens in a new tab (which navigates to a signed export_url and
    // triggers the actual file download there) instead of downloading directly on
    // this page — confirmed live 2026-10-09. The download event fires at the
    // context level for that new tab, not on this page, so page.waitForEvent
    // ('download') never saw it and just timed out after 30s.
    const [download] = await Promise.all([
      ctx.waitForEvent('download'),
      page.getByRole('button', { name: /export/i }).click(),
    ]);

    const filePath = path.join(DOWNLOAD_DIR, `lula-${Date.now()}.xlsx`);
    await download.saveAs(filePath);
    console.log(`[Lula] Downloaded export → ${filePath}`);

    await page.close();
    return parseExport(filePath, daysBack);
  } finally {
    await ctx.close();
  }
}

async function login(page, username, password) {
  await page.goto(`${LULA_URL}/login`, { waitUntil: 'load' });
  await page.waitForTimeout(2000);

  if (!page.url().toString().includes('/login')) return;

  await page.waitForSelector('input[name="email"]', { timeout: 15000 });
  await page.locator('input[name="email"]').fill(username);
  await page.waitForTimeout(800); // wait for React to stabilize after fill
  await page.getByText('Use Password Instead').click();
  await page.waitForSelector('input[name="password"]', { timeout: 10000 });
  await page.locator('input[name="password"]').fill(password);
  await page.getByRole('button', { name: 'Login' }).click();
  await page.waitForURL(url => !url.toString().includes('/login'), { timeout: 30000 });
  console.log('[Lula] Logged in');
}

function parseExport(filePath, daysBack) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - daysBack);

  const wb = XLSX.readFile(filePath);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });

  // Group rows by PAYOUT ID (a payout may cover multiple jobs)
  const payoutMap = {};

  // Lula's export has the content of these two columns swapped relative to
  // their own headers — and relative to what the portal's on-screen Payouts
  // table shows for the same row. Confirmed live 2026-10-09 against a real
  // payout (2519AB2 / WO 6A8CE3, $75 job value, $50 no-show-fee deduction,
  // $25 actual bank deposit — Dr. Caldwell confirmed $25 is what came in):
  // the file's "JOBS TOTAL" column holds the real net payout ($25 here), and
  // "TOTAL PAYOUT" holds the real gross job value before any deduction ($75).
  // Matters because a deduction can belong to a DIFFERENT work order than the
  // one on this row (a no-show fee elsewhere, not tied to this job) — so the
  // per-job amount used for Jobber matching must stay at the job's own gross
  // value, not have an unrelated deduction baked into it.
  for (const row of rows) {
    const payoutId  = String(row['PAYOUT ID'] || '').trim();
    const jobId     = String(row['RELATED JOBS'] || '').trim();
    const netPayout = parseAmount(row['JOBS TOTAL']);   // mislabeled: actual bank-deposit amount
    const grossJobs = parseAmount(row['TOTAL PAYOUT']); // mislabeled: actual job(s) value pre-deduction
    const dateStr   = String(row['PAYOUT DATE'] || '').trim();
    const date      = new Date(dateStr);

    if (!payoutId || isNaN(date) || date < cutoff) continue;

    if (!payoutMap[payoutId]) {
      payoutMap[payoutId] = {
        company: 'Lula',
        paymentRef: payoutId,
        paymentDate: date.toISOString().slice(0, 10),
        amount: netPayout,
        workOrders: [],
      };
    }

    if (jobId) {
      payoutMap[payoutId].workOrders.push({ workOrder: jobId, amount: grossJobs });
    }
  }

  const results = Object.values(payoutMap);
  console.log(`[Lula] Parsed ${results.length} payments`);
  return results;
}

function parseAmount(val) {
  return parseFloat(String(val).replace(/[$,]/g, '')) || 0;
}

module.exports = { collect };
