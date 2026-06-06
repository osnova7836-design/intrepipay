require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { launchBrowser } = require('./utils/browser');

(async () => {
  const ctx = await launchBrowser();
  const page = await ctx.newPage();
  const username = process.env.RELY_USERNAME;
  const password = process.env.RELY_PASSWORD;
  const { solveRecaptcha } = require('./utils/captcha');

  await page.goto('https://relyhome.com/login/', { waitUntil: 'networkidle' });

  if (page.url().toString().includes('/login')) {
    await page.locator('#login-email').fill(username);
    await page.locator('#login-password').fill(password);
    const hasCaptcha = await page.locator('[data-sitekey], iframe[src*="recaptcha"]').count() > 0;
    if (hasCaptcha) {
      console.log('Solving captcha...');
      await solveRecaptcha(page);
      await page.waitForTimeout(1000);
    }
    await page.locator('button[type="submit"]').click();
    await page.waitForURL(url => !url.toString().includes('/login'), { timeout: 30000 });
  }

  console.log('Logged in, current URL:', page.url());

  // Go to payments page
  await page.goto('https://relyhome.com/payments/', { waitUntil: 'networkidle' });

  // Click the first "Check Details" button
  await page.locator('text=Check Details').first().click();
  await page.waitForLoadState('networkidle');
  console.log('After Check Details click, URL:', page.url());
  await page.screenshot({ path: 'rely-check-details.png', fullPage: true });

  // Dump table contents
  const rows = await page.evaluate(() =>
    Array.from(document.querySelectorAll('table tbody tr')).map(tr =>
      Array.from(tr.querySelectorAll('td')).map(td => td.textContent.trim())
    )
  );
  console.log('Check details rows:', JSON.stringify(rows, null, 2));
  await ctx.close();
})();
