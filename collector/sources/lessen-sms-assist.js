const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');
const { launchBrowser, DOWNLOAD_DIR } = require('../utils/browser');

const LESSEN_SA_URL = 'https://affiliate-one.lessen.com';

async function collect({ daysBack = 30 } = {}) {
  const username = process.env.LESSEN_USERNAME;
  const password = process.env.LESSEN_PASSWORD;
  if (!username || !password) throw new Error('LESSEN_USERNAME / LESSEN_PASSWORD env vars not set');

  const ctx = await launchBrowser();
  try {
    const page = await ctx.newPage();

    await page.goto(`${LESSEN_SA_URL}/login`, { waitUntil: 'networkidle' });
    if (page.url().includes('/login')) {
      await page.getByLabel(/username|email/i).fill(username);
      await page.getByLabel(/password/i).fill(password);
      await page.getByRole('button', { name: /sign in|log in/i }).click();
      await page.waitForURL(url => !url.includes('/login'), { timeout: 30000 });
    }
    console.log('[Lessen SMS Assist] Logged in');

    // Invoicing → Billing → Payments → date range → Filter
    await page.getByRole('link', { name: /invoicing/i }).click();
    await page.waitForLoadState('networkidle');
    await page.getByRole('link', { name: /billing/i }).click();
    await page.waitForLoadState('networkidle');
    await page.getByRole('link', { name: /payments/i }).click();
    await page.waitForLoadState('networkidle');

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - daysBack);
    const fromStr = cutoff.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });
    const toStr = new Date().toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });

    const fromField = page.getByLabel(/from|start/i).first();
    const toField = page.getByLabel(/to|end/i).first();
    if (await fromField.count() > 0) {
      await fromField.fill(fromStr);
      await toField.fill(toStr);
    }

    await page.getByRole('button', { name: /filter|apply|search/i }).click();
    await page.waitForLoadState('networkidle');

    const results = await collectAllChecks(page);
    await page.close();
    console.log(`[Lessen SMS Assist] Collected ${results.length} payments`);
    return results;
  } finally {
    await ctx.close();
  }
}

async function collectAllChecks(page) {
  // IMPORTANT: Check # is NOT in the export file — capture it from the summary
  // table BEFORE clicking each check, then attach it to the downloaded data.
  const checkRows = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('table tbody tr'));
    return rows.map(row => {
      const cells = Array.from(row.querySelectorAll('td')).map(td => td.textContent.trim());
      // Adjust indices after first test run — expected: date, check#, amount, ...
      return { date: cells[0] || '', checkNum: cells[1] || '', amount: cells[2] || '' };
    }).filter(r => r.checkNum);
  });

  if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

  const allResults = [];

  for (const { date, checkNum, amount } of checkRows) {
    // Click the check number link to open detail
    await page.getByRole('link', { name: checkNum, exact: true })
      .or(page.locator(`td:has-text("${checkNum}")`).first())
      .click();
    await page.waitForLoadState('networkidle');

    // Export the detail for this check
    const exportBtn = page.getByRole('button', { name: /export/i });
    if (await exportBtn.count() === 0) {
      console.warn(`[Lessen SMS Assist] No export button for check ${checkNum}`);
      await page.goBack();
      await page.waitForLoadState('networkidle');
      continue;
    }

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      exportBtn.click(),
    ]);

    const filePath = path.join(DOWNLOAD_DIR, `lessen-sa-${checkNum}-${Date.now()}.xlsx`);
    await download.saveAs(filePath);

    const rows = parseExport(filePath, checkNum, date, amount);
    allResults.push(...rows);

    await page.goBack();
    await page.waitForLoadState('networkidle');
  }

  return allResults;
}

function parseExport(filePath, checkNum, date, totalAmt) {
  const wb = XLSX.readFile(filePath);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });

  const workOrders = [];
  for (const row of rows) {
    const norm = {};
    for (const [k, v] of Object.entries(row)) norm[k.toLowerCase().trim()] = v;
    const wo = String(norm['work order'] || norm['order id'] || norm['wo #'] || '').trim();
    const amt = parseFloat(String(norm['amount'] || norm['net'] || '0').replace(/[$,]/g, '')) || 0;
    if (wo) workOrders.push({ workOrder: wo, amount: amt });
  }

  return [{
    company: 'Lessen SMS Assist',
    paymentRef: checkNum,
    paymentDate: normalizeDate(date),
    amount: parseFloat(String(totalAmt).replace(/[$,]/g, '')) || 0,
    workOrders,
  }];
}

function normalizeDate(val) {
  if (!val) return '';
  const d = new Date(val);
  if (!isNaN(d)) return d.toISOString().slice(0, 10);
  return String(val);
}

module.exports = { collect };
