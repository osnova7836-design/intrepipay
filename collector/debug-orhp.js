require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { launchBrowser } = require('./utils/browser');

(async () => {
  const ctx = await launchBrowser();
  const page = await ctx.newPage();

  await page.goto('https://contractor.orhp.com', { waitUntil: 'load' });
  await page.waitForTimeout(2000);

  // Dismiss cookie banner
  const acceptBtn = page.locator('#truste-consent-button');
  if (await acceptBtn.count() > 0) await acceptBtn.click();

  // Login
  await page.locator('input[name="theU"]').fill(process.env.ORHP_USERNAME);
  await page.locator('input[name="theP"]').fill(process.env.ORHP_PASSWORD);
  await page.locator('#btnLogin').click();
  await page.waitForLoadState('load');
  await page.waitForTimeout(2000);
  console.log('After login URL:', page.url());
  await page.screenshot({ path: 'orhp-dashboard.png', fullPage: true });

  // Go to Payment History
  await page.goto('https://contractor.orhp.com/index.cfm/invoicing/history', { waitUntil: 'load' });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: 'orhp-history.png', fullPage: true });

  const fields = await page.evaluate(() =>
    Array.from(document.querySelectorAll('input, select, button, th, td')).map(el => ({
      tag: el.tagName, type: el.type, name: el.name, id: el.id,
      text: el.textContent?.trim().slice(0, 80) || el.value,
      options: el.tagName === 'SELECT' ? Array.from(el.options).map(o => o.text) : undefined,
    })).filter(el => el.text)
  );
  console.log('History page fields:', JSON.stringify(fields, null, 2));
  await ctx.close();
})();
