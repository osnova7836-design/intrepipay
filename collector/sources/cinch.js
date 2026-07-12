const { launchBrowser } = require('../utils/browser');

const BASE_URL = 'https://secure.paymode.com';
const HOME_URL = BASE_URL;
const LIST_URL = `${BASE_URL}/px/payments/incoming/received`;

// Keep browser context alive between collect() calls — avoids re-login on every run
let _ctx = null;
let _page = null;

async function getPage(username, password) {
  if (_ctx && _page) {
    try {
      const url = _page.url();
      if (url.startsWith('https://secure.paymode.com/')) return _page;
    } catch {}
    _ctx = null;
    _page = null;
  }

  _ctx = await launchBrowser('cinch');
  _page = await _ctx.newPage();
  await login(_page, username, password);
  return _page;
}

async function collect({ daysBack = 30 } = {}) {
  const username = process.env.CINCH_USERNAME;
  const password = process.env.CINCH_PASSWORD;
  if (!username || !password) throw new Error('CINCH_USERNAME / CINCH_PASSWORD env vars not set');

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - daysBack);

  const page = await getPage(username, password);

  const payments = await searchAndList(page, daysBack);
  console.log(`[Cinch] ${payments.length} payments in window (before date cutoff)`);

  const results = [];
  for (const { dpa, paymentNumber } of payments.filter(p => new Date(p.paymentDate) >= cutoff)) {
    try {
      // The site is an Angular SPA — deep-linking straight to a detail URL renders blank
      // (it depends on in-memory state from client-side navigation). So we click the row
      // from a live search-results page instead of reconstructing/goto-ing the URL.
      await searchAndList(page, daysBack);
      const workOrders = await openDetailAndScrape(page, dpa);
      if (!workOrders.length) {
        console.warn(`[Cinch] No remittance rows for DPA ${dpa}`);
        continue;
      }
      const paymentDate = payments.find(p => p.dpa === dpa).paymentDate;
      const total = Math.round(workOrders.reduce((s, w) => s + w.amount, 0) * 100) / 100;
      results.push({
        company: 'Cinch Home Services',
        paymentRef: paymentNumber,
        paymentDate,
        amount: total,
        workOrders,
      });
      console.log(`[Cinch] ${paymentNumber} → ${workOrders.length} WOs $${total.toFixed(2)}`);
    } catch (err) {
      console.warn(`[Cinch] Failed DPA ${dpa}: ${err.message}`);
    }
  }
  return results;
}

async function login(page, username, password) {
  // Always start at the plain home URL, not a deep link — Paymode's own security banner
  // tells users to do this, and deep-linking while unauthenticated is what produces the
  // "Timeout=true" SSO redirect flag that seems to correlate with a broken session state.
  await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(4000);

  if (!page.url().startsWith('https://sso.paymode.com/')) {
    console.log('[Cinch] Already logged in (session active)');
    return;
  }

  // Pre-fill credentials and submit — Paymode remembers this device most of the time,
  // in which case login completes without any MFA prompt at all.
  await page.waitForSelector('input[name="username"], input[id="username"]', { timeout: 15000 });
  await page.fill('input[name="username"]', username);
  await page.fill('input[name="password"]', password);
  await page.locator('button:has-text("Log in"), button:has-text("Log In")').first().click();
  await page.waitForTimeout(3000);

  if (page.url().startsWith('https://sso.paymode.com/')) {
    console.log('[Cinch] *** ACTION REQUIRED: Complete MFA in the browser window ***');
    console.log('[Cinch] Waiting up to 10 minutes for you to complete it...');
    await page.waitForURL(/^https:\/\/secure\.paymode\.com\//, { timeout: 600000 });
  }

  console.log('[Cinch] Logged in, now at:', page.url());
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(2000);
}

// Navigate to the search form, set the date range, click Search, wait for real results.
// Re-runs the search fresh each time it's called — the app doesn't reliably preserve
// results after a detail-page visit, so callers just re-search rather than trying to
// "go back" to a stale results view.
async function searchAndList(page, daysBack) {
  await page.goto(LIST_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });

  const searchBtn = page.locator('button:has-text("Search")').first();
  await searchBtn.waitFor({ state: 'visible', timeout: 30000 });

  await setDateRange(page, daysBack);

  await searchBtn.click();
  await page.waitForSelector('a[href*="/detail/"], .ag-overlay-no-rows-center', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1000);

  return await page.evaluate(() => {
    const results = [];
    document.querySelectorAll('a[href*="/detail/"]').forEach(link => {
      const m = link.href.match(/\/detail\/(\d+)\/paymentDate=([^/?&]+)/);
      if (!m) return;
      const dpa = m[1];
      const paymentDate = m[2];
      const row = link.closest('.ag-row');
      if (!row) return;
      const cells = Array.from(row.querySelectorAll('.ag-cell'));
      // Column order is: --, DPA, payer name, payment number, receiver ID, payer ID, method.
      // Both DPA and payment number are 8-12 digit numbers, so exclude the known DPA value
      // (already captured from the link href) to avoid picking it twice.
      const paymentNumber = cells.map(c => c.textContent.trim()).find(t => /^\d{8,12}$/.test(t) && t !== dpa) || dpa;
      results.push({ dpa, paymentDate, paymentNumber });
    });
    return results;
  });
}

// Set the DATE PERIOD field to cover the last `daysBack` days. The field opens a
// calendar picker on click; typing the formatted range directly into the text input
// is far more reliable than driving the calendar UI.
async function setDateRange(page, daysBack) {
  const from = new Date();
  from.setDate(from.getDate() - daysBack);
  const to = new Date();
  const fmt = (d) => d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }).replace(/ /g, '-');
  const rangeStr = `${fmt(from)} - ${fmt(to)}`;

  const dateInput = page.locator('input[name="modificationDatePeriod"]');
  if (await dateInput.count() === 0) {
    console.warn('[Cinch] Date range input not found — using page default range');
    return;
  }
  await dateInput.click({ clickCount: 3 });
  await page.keyboard.press('Control+a');
  await dateInput.fill(rangeStr);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);
  // Close any open calendar popup without losing the typed value
  await page.keyboard.press('Escape').catch(() => {});
  console.log(`[Cinch] Date range set: ${rangeStr}`);
}

// From a live results page, click the row for `dpa`, wait for the detail view to
// render, scrape its Remittance table, then navigate back.
async function openDetailAndScrape(page, dpa) {
  const linkLocator = page.locator('a', { hasText: dpa }).first();
  await linkLocator.scrollIntoViewIfNeeded();
  await linkLocator.click({ timeout: 15000 });

  await page.waitForFunction(
    () => !document.body.innerText.includes('Payment detail') || document.querySelector('.ag-root'),
    { timeout: 20000 }
  ).catch(() => {});
  await page.waitForSelector('.ag-row', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1000);

  return await page.evaluate(() => {
    const results = [];
    const grids = document.querySelectorAll('.ag-root');
    for (const grid of grids) {
      const headerCells = Array.from(grid.querySelectorAll('.ag-header-cell-text'));
      const headers = headerCells.map(h => h.textContent.trim().toLowerCase());
      const commentsIdx = headers.findIndex(h => h.includes('comment'));
      const paidAmtIdx  = headers.findIndex(h => h.includes('paid invoice'));
      if (commentsIdx < 0 || paidAmtIdx < 0) continue;

      for (const row of grid.querySelectorAll('.ag-row')) {
        const cells = Array.from(row.querySelectorAll('.ag-cell'));
        if (cells.length <= Math.max(commentsIdx, paidAmtIdx)) continue;
        const comment   = cells[commentsIdx].innerText.trim();
        const amountStr = cells[paidAmtIdx].innerText.trim();
        const sccvMatch = comment.match(/\b(SCCV[A-Z0-9]+-\d+)\b/i);
        const amount    = parseFloat(amountStr.replace(/[$,\s]|USD/g, ''));
        if (!sccvMatch || isNaN(amount) || amount <= 0) continue;
        results.push({ workOrder: sccvMatch[1].toUpperCase(), amount });
      }
      if (results.length) break;
    }
    return results;
  });
}

module.exports = { collect };
