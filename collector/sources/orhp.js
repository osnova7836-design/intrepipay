const { launchBrowser } = require('../utils/browser');

const ORHP_URL = 'https://contractor.orhp.com';

async function collect({ daysBack = 30 } = {}) {
  const username = process.env.ORHP_USERNAME;
  const password = process.env.ORHP_PASSWORD;
  if (!username || !password) throw new Error('ORHP_USERNAME / ORHP_PASSWORD env vars not set');

  const ctx = await launchBrowser('orhp');
  try {
    const page = await ctx.newPage();
    await login(page, username, password);

    await page.goto(`${ORHP_URL}/index.cfm/invoicing/history`, { waitUntil: 'load' });
    await page.waitForTimeout(1000);

    // Uncheck Pending — we only want Paid
    const pendingCb = page.locator('#isPending');
    if (await pendingCb.isChecked()) await pendingCb.uncheck();

    // Set date range
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - daysBack);
    const fromStr = cutoff.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', year: 'numeric' });
    const toStr   = new Date().toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', year: 'numeric' });

    await page.locator('#fromDate').fill(fromStr);
    await page.locator('#toDate').fill(toStr);

    // Click Refresh and wait for table to reload
    await page.locator('#refreshButton').click();
    await page.waitForLoadState('load');
    await page.waitForTimeout(1000);

    const rows = await scrapeTable(page);
    await page.close();

    const results = groupByCheck(rows);
    console.log(`[ORHP] ${results.length} checks, ${rows.length} work orders`);
    return results;
  } finally {
    await ctx.close();
  }
}

async function login(page, username, password) {
  await page.goto(ORHP_URL, { waitUntil: 'load' });
  await page.waitForTimeout(1000);

  // Dismiss cookie banner if present
  const acceptBtn = page.locator('#truste-consent-button');
  if (await acceptBtn.count() > 0) await acceptBtn.click();

  // Skip login if already in
  if (!page.url().toString().includes('workbench') && !page.url().toString().includes('contractor.orhp.com/index')) {
    await page.locator('input[name="theU"]').fill(username);
    await page.locator('input[name="theP"]').fill(password);
    await page.locator('#btnLogin').click();
    await page.waitForLoadState('load');
  }
  console.log('[ORHP] Logged in');
}

async function scrapeTable(page) {
  return page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('table tbody tr, table tr'));
    const results = [];
    for (const row of rows) {
      const cells = Array.from(row.querySelectorAll('td')).map(td => td.textContent.trim());
      if (cells.length < 7) continue;
      // Columns: Status(0), Submitted Date(1), Invoice#(2), Work Order#(3), Amount Paid(4), Check Number(5), Date Paid(6)
      const status      = cells[0];
      const workOrder   = cells[3];
      const amountStr   = cells[4];
      const checkNum    = cells[5];
      const datePaid    = cells[6];
      if (status !== 'Paid' || !checkNum || !workOrder) continue;
      results.push({ checkNum, datePaid, workOrder, amountStr });
    }
    return results;
  });
}

function groupByCheck(rows) {
  const map = {};
  for (const { checkNum, datePaid, workOrder, amountStr } of rows) {
    const amount = parseFloat(amountStr.replace(/[$,]/g, '')) || 0;
    if (!map[checkNum]) {
      map[checkNum] = {
        company: 'Old Republic',
        paymentRef: checkNum,
        paymentDate: normalizeDate(datePaid),
        amount: 0,
        workOrders: [],
      };
    }
    map[checkNum].amount += amount;
    map[checkNum].workOrders.push({ workOrder, amount });
  }
  return Object.values(map);
}

function normalizeDate(val) {
  if (!val) return '';
  const d = new Date(val);
  if (!isNaN(d)) return d.toISOString().slice(0, 10);
  return String(val);
}

module.exports = { collect };
