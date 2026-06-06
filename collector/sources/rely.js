const path = require('path');
const fs = require('fs');
const { launchBrowser, DOWNLOAD_DIR } = require('../utils/browser');
const { solveRecaptcha } = require('../utils/captcha');

const RELY_URL = 'https://relyhome.com';

async function collect({ daysBack = 30 } = {}) {
  const username = process.env.RELY_USERNAME;
  const password = process.env.RELY_PASSWORD;
  if (!username || !password) throw new Error('RELY_USERNAME / RELY_PASSWORD env vars not set');

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - daysBack);

  const ctx = await launchBrowser('rely');
  try {
    const page = await ctx.newPage();
    await login(page, username, password);

    const checks = await scrapePaymentsList(page, cutoff);
    console.log(`[Rely] Found ${checks.length} checks within last ${daysBack} days`);

    const results = [];
    for (const check of checks) {
      const workOrders = await getCheckDetails(page, check);
      results.push({ ...check, workOrders });
    }

    await page.close();
    console.log(`[Rely] Done — ${results.length} payments collected`);
    return results;
  } finally {
    await ctx.close();
  }
}

async function login(page, username, password) {
  await page.goto(`${RELY_URL}/login/`, { waitUntil: 'networkidle' });
  if (!page.url().toString().includes('/login')) return;

  await page.locator('#login-email').fill(username);
  await page.locator('#login-password').fill(password);

  const hasCaptcha = await page.locator('[data-sitekey], iframe[src*="recaptcha"]').count() > 0;
  if (hasCaptcha) {
    console.log('[Rely] Solving reCAPTCHA via 2captcha...');
    await solveRecaptcha(page);
    await page.waitForTimeout(1000);
  }

  await page.locator('button[type="submit"]').click();
  await page.waitForURL(url => !url.toString().includes('/login'), { timeout: 30000 });
  console.log('[Rely] Logged in');
}

// Scrapes the payments list, paginating until all checks within cutoff are collected
async function dismissChatbot(page) {
  await page.evaluate(() => {
    const chatbot = document.getElementById('rely-chatbot-root');
    if (chatbot) chatbot.style.display = 'none';
  });
}

async function scrapePaymentsList(page, cutoff) {
  await page.goto(`${RELY_URL}/payments/`, { waitUntil: 'networkidle' });
  await dismissChatbot(page);

  const checks = [];
  let pageNum = 1;

  while (true) {
    const rows = await page.evaluate(() =>
      Array.from(document.querySelectorAll('table tbody tr')).map(tr => {
        const cells = Array.from(tr.querySelectorAll('td')).map(td => td.textContent.trim());
        return cells.length >= 5 ? {
          paymentDate: cells[0],
          paymentType: cells[1],
          paymentRef:  cells[2],
          amount:      cells[4],
        } : null;
      }).filter(Boolean)
    );

    let hitCutoff = false;
    for (const row of rows) {
      const d = new Date(row.paymentDate);
      if (isNaN(d) || d < cutoff) { hitCutoff = true; break; }
      checks.push({
        company: 'Rely',
        paymentRef: row.paymentRef,
        paymentDate: d.toISOString().slice(0, 10),
        amount: parseFloat(row.amount.replace(/[$,]/g, '')) || 0,
      });
    }

    if (hitCutoff) break;

    // Go to next page
    const nextBtn = page.locator('a', { hasText: 'Next' }).last();
    const isDisabled = await nextBtn.evaluate(el => el.classList.contains('disabled') || el.getAttribute('aria-disabled') === 'true').catch(() => true);
    if (isDisabled) break;

    await nextBtn.click();
    await page.waitForLoadState('networkidle');
    pageNum++;
    console.log(`[Rely] Scraping page ${pageNum}...`);
  }

  return checks;
}

// Clicks Check Details for a given check and downloads the CSV of claim line items
async function getCheckDetails(page, check) {
  // Go back to payments list and click the matching Check Details button
  await page.goto(`${RELY_URL}/payments/`, { waitUntil: 'networkidle' });

  // Find the row with this ref# and click its Check Details link
  const row = page.locator('tr', { hasText: check.paymentRef });
  const detailsLink = row.locator('text=Check Details');

  if (await detailsLink.count() === 0) {
    // Might be on a different page — search for it
    const found = await findCheckOnList(page, check.paymentRef);
    if (!found) {
      console.warn(`[Rely] Could not find Check Details for ref ${check.paymentRef}`);
      return [];
    }
  }

  await dismissChatbot(page);

  await page.locator('tr', { hasText: check.paymentRef }).locator('text=Check Details').click();
  await page.waitForLoadState('networkidle');

  if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

  // Click the CSV button in the Details (bottom) section
  // There are two CSV buttons — first is Payment Details, second is the claim line items
  const csvBtns = page.locator('a', { hasText: 'CSV' }).or(page.locator('button', { hasText: 'CSV' }));
  const count = await csvBtns.count();
  if (count < 2) {
    console.warn(`[Rely] Expected 2 CSV buttons for check ${check.paymentRef}, found ${count}`);
    return [];
  }

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    csvBtns.nth(1).click(), // second CSV = Details (claim line items)
  ]);

  const filePath = path.join(DOWNLOAD_DIR, `rely-${check.paymentRef}-${Date.now()}.csv`);
  await download.saveAs(filePath);
  console.log(`[Rely] Downloaded details for check ${check.paymentRef}`);

  return parseCsv(filePath, check.amount);
}

async function findCheckOnList(page, refNum) {
  // Paginate until we find the row
  while (true) {
    const found = await page.locator('tr', { hasText: refNum }).count() > 0;
    if (found) return true;

    const nextBtn = page.locator('a', { hasText: 'Next' }).last();
    const isDisabled = await nextBtn.evaluate(el => el.classList.contains('disabled')).catch(() => true);
    if (isDisabled) return false;

    await nextBtn.click();
    await page.waitForLoadState('networkidle');
  }
}

function parseCsv(filePath, totalAmount) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.trim().split('\n').filter(Boolean);
  if (lines.length < 2) return [];

  const header = lines[0].split(',').map(h => h.replace(/"/g, '').trim().toLowerCase());
  const claimIdx = header.findIndex(h => h.includes('claim'));
  const amtIdx = header.findIndex(h => h.includes('amount'));

  if (claimIdx < 0 || amtIdx < 0) {
    console.warn(`[Rely] Unexpected CSV header: ${lines[0]}`);
    return [];
  }

  return lines.slice(1).map(line => {
    const cols = line.split(',').map(c => c.replace(/"/g, '').trim());
    return {
      workOrder: cols[claimIdx] || '',
      amount: parseFloat((cols[amtIdx] || '0').replace(/[$,]/g, '')) || 0,
    };
  }).filter(r => r.workOrder);
}

module.exports = { collect };
