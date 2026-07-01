const { launchBrowser } = require('../utils/browser');

const BASE_URL = 'https://secure.paymode.com';
const LIST_URL = `${BASE_URL}/px/payments/incoming/received`;

// Keep browser context alive between collect() calls — avoids re-MFA on every run
let _ctx = null;
let _page = null;

async function getPage(username, password) {
  // Check if existing session is still good
  if (_ctx && _page) {
    try {
      const url = _page.url();
      if (url.startsWith('https://secure.paymode.com/')) {
        return _page;
      }
    } catch {}
    // Page is gone — reset
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

  const payments = await scrapeList(page, cutoff);
  console.log(`[Cinch] ${payments.length} payments in window`);

  const results = [];
  for (const { dpa, paymentNumber, paymentDate } of payments) {
    try {
      const workOrders = await scrapeDetail(page, dpa, paymentDate);
      if (!workOrders.length) {
        console.warn(`[Cinch] No remittance rows for DPA ${dpa}`);
        continue;
      }
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
  await page.goto(LIST_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

  // Wait up to 8s for the JS-based SSO redirect to kick in
  await page.waitForURL(/^https:\/\/sso\.paymode\.com\//, { timeout: 8000 }).catch(() => {});

  if (!page.url().startsWith('https://sso.paymode.com/')) {
    // Still on secure.paymode.com — wait for SPA to render
    await page.waitForSelector('button, table, nav', { timeout: 15000 }).catch(() => {});
    const hasContent = await page.locator('button, table, [class*="payment"]').count() > 0;
    if (hasContent) {
      console.log('[Cinch] Already logged in (session active)');
      return;
    }
    // No content rendered — wait for SSO redirect
    await page.waitForURL(/^https:\/\/sso\.paymode\.com\//, { timeout: 8000 }).catch(() => {});
  }

  if (!page.url().startsWith('https://sso.paymode.com/')) {
    throw new Error('Could not reach Paymode SSO login page');
  }

  // Pre-fill credentials but let the user complete MFA manually
  await page.waitForSelector('input[name="username"], input[id="username"]', { timeout: 15000 });
  await page.fill('input[name="username"]', username);
  await page.fill('input[name="password"]', password);

  console.log('[Cinch] *** ACTION REQUIRED: Click "Sign In" and complete MFA in the browser window ***');
  console.log('[Cinch] Waiting up to 10 minutes for you to complete login...');

  // Wait for the user to complete login — any secure.paymode.com page that isn't the OAuth callback
  await page.waitForURL(/^https:\/\/secure\.paymode\.com\/px\//, { timeout: 600000 });
  console.log('[Cinch] Logged in, now at:', page.url());

  // Let the landing page fully initialize the session before navigating
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(3000);
  console.log('[Cinch] Session ready, navigating to payments...');

  await page.goto(LIST_URL, { waitUntil: 'networkidle', timeout: 30000 });
  console.log('[Cinch] On payments page:', page.url());
}

async function scrapeList(page, cutoff) {
  // Ensure we're on the payments list
  if (!page.url().includes('/px/payments/incoming/received')) {
    await page.goto(LIST_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
  }

  // SPA renders async — wait for any interactive element to appear (up to 30s)
  console.log('[Cinch] Waiting for payments page to render...');
  await page.waitForSelector('button, a[href*="/detail/"], table', { timeout: 30000 });
  await page.waitForTimeout(1500);

  // Log what we find for debugging
  const pageInfo = await page.evaluate(() => ({
    buttons: Array.from(document.querySelectorAll('button')).map(b => b.textContent.trim().substring(0, 40)),
    links: Array.from(document.querySelectorAll('a[href*="/detail/"]')).map(a => a.href).slice(0, 3),
  }));
  console.log('[Cinch] Buttons found:', pageInfo.buttons.join(', ') || 'none');
  console.log('[Cinch] Detail links (first 3):', pageInfo.links.join(', ') || 'none');

  // If no detail links visible, try clicking Search
  if (pageInfo.links.length === 0) {
    const searchBtn = page.locator('button').filter({ hasText: /^search$/i }).first();
    if (await searchBtn.count() > 0) {
      console.log('[Cinch] Clicking Search...');
      await searchBtn.click();
      await page.waitForTimeout(4000);
    } else {
      console.log('[Cinch] No Search button found — using page as-is');
    }
  }

  // Extract rows
  const rows = await page.evaluate(() => {
    const results = [];
    document.querySelectorAll('a[href*="/detail/"]').forEach(link => {
      const m = link.href.match(/\/detail\/(\d+)\/paymentDate=([^/?&]+)/);
      if (!m) return;
      const dpa = m[1];
      const paymentDate = m[2];
      const row = link.closest('tr');
      if (!row) return;
      const cells = Array.from(row.querySelectorAll('td'));
      const paymentNumber = cells.map(c => c.textContent.trim()).find(t => /^\d{8,12}$/.test(t)) || dpa;
      results.push({ dpa, paymentDate, paymentNumber });
    });
    return results;
  });

  console.log(`[Cinch] Found ${rows.length} total rows before date filter`);
  return rows.filter(r => new Date(r.paymentDate) >= cutoff);
}

async function scrapeDetail(page, dpa, paymentDate) {
  const url = `${BASE_URL}/px/payments/incoming/received/detail/${dpa}/paymentDate=${paymentDate}/searchId=0`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(1500);
  await page.waitForSelector('table', { timeout: 10000 }).catch(() => {});

  return await page.evaluate(() => {
    const results = [];
    for (const table of document.querySelectorAll('table')) {
      const headers = Array.from(table.querySelectorAll('th')).map(h => h.textContent.trim().toLowerCase());
      const commentsIdx = headers.findIndex(h => h.includes('comment'));
      const paidAmtIdx  = headers.findIndex(h => h.includes('paid invoice') || h.includes('paid amount'));
      if (commentsIdx < 0 || paidAmtIdx < 0) continue;

      for (const row of table.querySelectorAll('tbody tr')) {
        const cells = Array.from(row.querySelectorAll('td'));
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
