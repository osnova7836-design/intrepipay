const { launchBrowser } = require('../utils/browser');

const TWO_TEN_URL = 'https://secure.2-10.com/ContractorOnline';

async function collect({ daysBack = 30 } = {}) {
  const username = process.env.TWO_TEN_USERNAME;
  const password = process.env.TWO_TEN_PASSWORD;
  if (!username || !password) throw new Error('TWO_TEN_USERNAME / TWO_TEN_PASSWORD env vars not set');

  const ctx = await launchBrowser('two-ten');
  try {
    const page = await ctx.newPage();
    await login(page, username, password);

    await page.goto(`${TWO_TEN_URL}/secure/admin/MyStatement.aspx`, { waitUntil: 'load' });
    await page.waitForTimeout(1500);

    // Set date range by typing into the Infragistics date fields
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - daysBack);
    const fromStr = cutoff.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });
    const toStr   = new Date().toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });

    const fromField = page.locator('#igtxtctl00_primaryContent_FromDate');
    await fromField.click({ clickCount: 3 });
    await fromField.type(fromStr);
    await page.keyboard.press('Tab');
    await page.waitForTimeout(300);

    const toField = page.locator('#igtxtctl00_primaryContent_ToDate');
    await toField.click({ clickCount: 3 });
    await toField.type(toStr);
    await page.keyboard.press('Tab');
    await page.waitForTimeout(300);

    await page.locator('#ctl00_primaryContent_LookupButton').click();
    await page.waitForLoadState('load');
    await page.waitForTimeout(1500);

    const rows = await scrapeTable(page);
    await page.close();

    const results = parseRows(rows);
    console.log(`[2-10] ${results.length} checks collected`);
    return results;
  } finally {
    await ctx.close();
  }
}

async function login(page, username, password) {
  await page.goto(`${TWO_TEN_URL}/`, { waitUntil: 'load' });
  await page.waitForTimeout(1500);

  // Dismiss popup if present
  const okBtn = page.locator('button', { hasText: 'Ok' });
  if (await okBtn.count() > 0) { await okBtn.click(); await page.waitForTimeout(500); }

  // Already logged in if past the login page
  if (page.url().includes('MyHome') || page.url().includes('secure/')) {
    console.log('[2-10] Session still active');
    return;
  }

  await page.locator('#ctl00_primaryContent_SiteLogin_UserName').fill(username);
  await page.locator('#ctl00_primaryContent_SiteLogin_Password').fill(password);
  await page.locator('#ctl00_primaryContent_SiteLogin_LoginButton').click();
  await page.waitForLoadState('load');
  await page.waitForTimeout(1000);
  console.log('[2-10] Logged in');
}

async function scrapeTable(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('table tr')).map(tr =>
      Array.from(tr.querySelectorAll('td')).map(td => td.textContent.trim())
    ).filter(r => r.length >= 4 && /^\d{2}\/\d{2}\/\d{4}$/.test(r[0]))
  );
}

function parseRows(rows) {
  return rows.map(cells => {
    const date     = cells[0];
    const checkNum = cells[1];
    const amount   = parseFloat(cells[2].replace(/[$,]/g, '')) || 0;
    const woRaw    = cells[3] || '';

    const workOrders = woRaw.split(',').map(pair => {
      const [wo, amtStr] = pair.split('/');
      return {
        workOrder: wo?.trim(),
        amount: parseFloat((amtStr || '0').replace(/[$,]/g, '')) || 0,
      };
    }).filter(r => r.workOrder);

    return {
      company: '2-10',
      paymentRef: checkNum,
      paymentDate: normalizeDate(date),
      amount,
      workOrders,
    };
  });
}

function normalizeDate(val) {
  if (!val) return '';
  const d = new Date(val);
  if (!isNaN(d)) return d.toISOString().slice(0, 10);
  return String(val);
}

module.exports = { collect };
