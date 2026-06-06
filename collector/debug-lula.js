require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { launchBrowser } = require('./utils/browser');

(async () => {
  const ctx = await launchBrowser();
  const page = await ctx.newPage();

  await page.goto('https://provider.lula.io', { waitUntil: 'load' });
  // Only login if we're on the login page
  if (page.url().toString().includes('/login')) {
    await page.waitForSelector('input', { timeout: 20000 });
    await page.locator('input[name="email"]').fill(process.env.LULA_USERNAME);
    await page.getByText('Use Password Instead').click();
    await page.waitForSelector('input[name="password"]', { timeout: 10000 });
    await page.locator('input[name="password"]').fill(process.env.LULA_PASSWORD);
    await page.getByRole('button', { name: 'Login' }).click();
    await page.waitForURL(url => !url.toString().includes('/login'), { timeout: 30000 });
  }
  console.log('Logged in, URL:', page.url());

  // Navigate to Payouts
  await page.goto('https://provider.lula.io/payouts', { waitUntil: 'load' });
  await page.waitForTimeout(3000);

  // Filter by Paid status — react-select component
  await page.locator('.selectbox__control').first().click();
  await page.waitForTimeout(1000);
  await page.screenshot({ path: 'lula-status-dropdown.png', fullPage: true });

  const opts = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[class*="option"]')).map(el => el.textContent?.trim()).filter(Boolean)
  );
  console.log('Dropdown options:', opts);

  const paidOption = page.locator('[class*="option"]', { hasText: /^paid$/i });
  if (await paidOption.count() > 0) {
    await paidOption.first().click();
    await page.waitForTimeout(1500);
    console.log('Filtered to Paid');
  }

  const fs = require('fs');
  const path = require('path');
  const DOWNLOAD_DIR = path.join(__dirname, '../.collector-downloads');
  if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

  // Click Export
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: /export/i }).click(),
  ]);
  const filePath = path.join(DOWNLOAD_DIR, `lula-export-${Date.now()}${path.extname(download.suggestedFilename()) || '.csv'}`);
  await download.saveAs(filePath);
  console.log('Downloaded to:', filePath);

  // Parse the xlsx
  const XLSX = require('xlsx');
  const wb = XLSX.readFile(filePath);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
  console.log('Columns:', Object.keys(rows[0] || {}));
  console.log('First 3 rows:', JSON.stringify(rows.slice(0, 3), null, 2));
  await ctx.close();
})();
