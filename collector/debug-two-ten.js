require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { launchBrowser } = require('./utils/browser');

(async () => {
  const ctx = await launchBrowser();
  const page = await ctx.newPage();

  await page.goto('https://secure.2-10.com/ContractorOnline/', { waitUntil: 'load' });
  await page.waitForTimeout(2000);

  // Dismiss any popup (Work Order Alert)
  const okBtn = page.locator('button', { hasText: 'Ok' });
  if (await okBtn.count() > 0) { await okBtn.click(); await page.waitForTimeout(500); }

  // Login
  await page.locator('#ctl00_primaryContent_SiteLogin_UserName').fill(process.env.TWO_TEN_USERNAME);
  await page.locator('#ctl00_primaryContent_SiteLogin_Password').fill(process.env.TWO_TEN_PASSWORD);
  await page.locator('#ctl00_primaryContent_SiteLogin_LoginButton').click();
  await page.waitForLoadState('load');
  await page.waitForTimeout(2000);
  console.log('After login URL:', page.url());
  await page.screenshot({ path: 'two-ten-dashboard.png', fullPage: true });

  await page.goto('https://secure.2-10.com/ContractorOnline/secure/admin/MyStatement.aspx', { waitUntil: 'load' });
  await page.waitForTimeout(2000);

  // Set date range — need to update both visible text input and hidden inputs
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 30);
  const fromStr = cutoff.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });
  const toStr   = new Date().toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });
  const fromP   = `${cutoff.getFullYear()}-${cutoff.getMonth()+1}-${cutoff.getDate()}-0-0-0-0`;
  const toNow   = new Date();
  const toP     = `${toNow.getFullYear()}-${toNow.getMonth()+1}-${toNow.getDate()}-0-0-0-0`;

  // Click into field, select all, type new value — triggers Infragistics internal state
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
  await page.waitForTimeout(2000);
  await page.screenshot({ path: 'two-ten-results.png', fullPage: true });

  const rows = await page.evaluate(() =>
    Array.from(document.querySelectorAll('table tr')).map(tr =>
      Array.from(tr.querySelectorAll('td')).map(td => td.textContent.trim())
    ).filter(r => r.length >= 3 && r[0])
  );
  console.log('Table rows:', JSON.stringify(rows, null, 2));
  await ctx.close();
})();
