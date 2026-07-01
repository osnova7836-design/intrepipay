const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');
const { launchBrowser, DOWNLOAD_DIR } = require('../utils/browser');

const LESSEN_SA_URL = 'https://affiliate-one.lessen.com';

async function collect({ daysBack = 30 } = {}) {
  const username = process.env.LESSEN_USERNAME;
  const password = process.env.LESSEN_PASSWORD;
  if (!username || !password) throw new Error('LESSEN_USERNAME / LESSEN_PASSWORD env vars not set');

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - daysBack);

  const ctx = await launchBrowser('lessen');
  try {
    const page = await ctx.newPage();
    await login(page, username, password);
    await goToPayments(page);

    const results = await collectAllChecks(page, cutoff);
    await page.close();
    console.log(`[Lessen SMS Assist] Collected ${results.length} payments`);
    return results;
  } finally {
    await ctx.close();
  }
}

async function login(page, username, password) {
  await page.goto(`${LESSEN_SA_URL}/login`, { waitUntil: 'networkidle' });
  if (page.url().includes('/login') || page.url().includes('/Account/Login')) {
    // No <label>/aria-label on these fields — target by name attribute instead
    await page.locator('input[name="UserName"]').fill(username);
    await page.locator('input[name="Password"]').fill(password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.waitForURL(url => !url.toString().includes('/login') && !url.toString().includes('/Account/Login'), { timeout: 30000 });
  }
  console.log('[Lessen SMS Assist] Logged in');
}

// Invoicing (top nav) → Billing (dropdown link) → Payments (sub-tab) — all confirmed
// against the live portal. There is no date-range filter on this page; we paginate
// and stop once a row's date is older than the cutoff.
async function goToPayments(page) {
  await page.getByText('Invoicing', { exact: true }).click();
  await page.waitForTimeout(500);
  await page.getByRole('link', { name: 'Billing', exact: true }).click();
  await page.waitForLoadState('networkidle');
  await page.getByRole('link', { name: 'Payments', exact: true }).click();
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1000);
}

async function collectAllChecks(page, cutoff) {
  if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

  const allResults = [];
  let hitCutoff = false;

  while (!hitCutoff) {
    const rows = await page.evaluate(() =>
      Array.from(document.querySelectorAll('tbody tr')).map(tr => {
        const checkCell = tr.querySelector('[data-one-uiautomation="paymentsTableCheckNum"]');
        const dateCell = tr.querySelector('[data-one-uiautomation="paymentsTableIssueDate"]');
        const amtCell = tr.querySelector('[data-one-uiautomation="paymentsTableTotalAmount"]');
        if (!checkCell || !dateCell || !amtCell) return null;
        return {
          checkLabel: checkCell.textContent.trim(),
          date: dateCell.textContent.trim(),
          amount: amtCell.textContent.trim(),
        };
      }).filter(Boolean)
    );

    for (const row of rows) {
      const mdy = row.date.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
      const d = mdy ? new Date(`${mdy[3]}-${mdy[1]}-${mdy[2]}`) : new Date(row.date);
      if (isNaN(d) || d < cutoff) { hitCutoff = true; break; }

      const checkNum = (row.checkLabel.match(/#(\d+)/) || [])[1] || row.checkLabel;

      // Open the detail view for this check
      const detailBtn = page.locator('[data-one-uiautomation="viewPaymentDetailsButton"]', { hasText: row.checkLabel });
      await detailBtn.scrollIntoViewIfNeeded();
      await detailBtn.click({ force: true });
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(500);

      const exportBtn = page.getByRole('button', { name: 'Export table' });
      if (await exportBtn.count() === 0) {
        console.warn(`[Lessen SMS Assist] No export button for check ${checkNum}`);
      } else {
        const [download] = await Promise.all([
          page.waitForEvent('download'),
          exportBtn.click(),
        ]);
        const filePath = path.join(DOWNLOAD_DIR, `lessen-sa-${checkNum}-${Date.now()}.xlsx`);
        await download.saveAs(filePath);
        allResults.push(...parseExport(filePath, checkNum, row.date, row.amount));
        console.log(`[Lessen SMS Assist] Downloaded details for check ${checkNum}`);
      }

      // Back to the payments list for the next row — the top-nav "Payments" link is a
      // no-op here since the SPA route (#/payments) doesn't change; use the in-page
      // back button on the detail card instead.
      await page.locator('[data-one-uiautomation="payment-detail-card-back-button"]').click();
      await page.waitForLoadState('networkidle');
      await page.waitForSelector('[data-one-uiautomation="paymentsTableCheckNum"]', { timeout: 15000 });
      await page.waitForTimeout(500);
    }

    if (hitCutoff) break;

    const nextLi = page.locator('li[title="Next Page"]');
    const isDisabled = await nextLi.evaluate(el => el.classList.contains('haven-pagination-disabled')).catch(() => true);
    if (isDisabled) break;

    await nextLi.click();
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(500);
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
    company: 'Lessen',
    paymentRef: checkNum,
    paymentDate: normalizeDate(date),
    amount: parseFloat(String(totalAmt).replace(/[$,]/g, '')) || 0,
    workOrders,
  }];
}

function normalizeDate(val) {
  const mdy = String(val).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (mdy) return `${mdy[3]}-${mdy[1].padStart(2, '0')}-${mdy[2].padStart(2, '0')}`;
  const d = new Date(val);
  if (!isNaN(d)) return d.toISOString().slice(0, 10);
  return String(val);
}

module.exports = { collect };
