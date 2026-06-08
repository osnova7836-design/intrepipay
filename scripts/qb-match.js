const { chromium } = require('playwright');
const readline = require('readline');

const QB_ORIGIN = 'https://app.qbo.intuit.com';
const QB_BANKING_URL = `${QB_ORIGIN}/app/banking`;
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PROFILE_DIR = 'D:\\chrome-qb-profile';

function waitForEnter(prompt = 'Press Enter to continue...') {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, () => { rl.close(); resolve(); });
  });
}

async function launchStealthContext() {
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    executablePath: CHROME_PATH,
    args: ['--disable-blink-features=AutomationControlled', '--disable-gpu'],
    ignoreDefaultArgs: ['--enable-automation', '--no-sandbox'],
  });
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  return ctx;
}

const AUTH_FILE = path.join(__dirname, '..', 'qb-auth.json');

async function ensureLoggedIn(ctx) {
  const page = await ctx.newPage();
  await page.goto(QB_BANKING_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

  const onLoginPage = () => !page.url().includes('qbo.intuit.com/app') || page.url().includes('accounts.intuit.com');

  if (onLoginPage()) {
    console.log('QB session expired — browser is open, log in then press Enter.');
    await waitForEnter('After you see the QB Banking page, press Enter here... ');
    if (onLoginPage()) throw new Error('QB login not completed.');
    console.log('Login confirmed.');
  }

  // Save cookies so next run skips login
  const cookies = await ctx.cookies();
  require('fs').writeFileSync(AUTH_FILE, JSON.stringify(cookies));

  await page.close();
}

async function restoreAuth(ctx) {
  const fs = require('fs');
  if (!fs.existsSync(AUTH_FILE)) return false;
  try {
    const cookies = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
    await ctx.addCookies(cookies);
    return true;
  } catch { return false; }
}

// Navigate to QB Banking "For Review", find the bank transaction matching the
// given amount (±$0.02), click it, search "Find other matches" by ref#,
// verify the name appears in the results, then confirm the match.
async function matchInQbBanking({ ref, name, amount, date }) {
  console.log(`QB match: ref="${ref}" name="${name}" amount=${amount} date=${date}`);

  const ctx = await launchStealthContext();
  try {
    await restoreAuth(ctx);
    await ensureLoggedIn(ctx);
    const page = await ctx.newPage();
    try {
      await page.goto(QB_BANKING_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(2000);

      // Wait for QB's SPA to finish loading transaction data (not just nav shell)
      console.log('Waiting for QB transaction list to load...');
      await page.waitForFunction(
        () => document.body.innerText.length > 1000,
        { timeout: 30000 }
      ).catch(() => console.log('Warning: page content still minimal after 30s'));
      console.log(`Page loaded — content length: ${(await page.evaluate(() => document.body.innerText.length)).toString()}`);

      // Ensure "For Review" tab is active
      const forReviewTab = page.getByRole('tab', { name: /for review/i });
      if (await forReviewTab.count() > 0) {
        await forReviewTab.first().click();
        await page.waitForTimeout(2000);
        await page.waitForFunction(
          () => document.body.innerText.length > 1000,
          { timeout: 15000 }
        ).catch(() => {});
      }

      // Find the bank transaction row matching this amount
      console.log(`Looking for bank transaction: $${amount}`);
      const txnRow = await findBankTxnByAmount(page, amount);
      if (!txnRow) throw new Error(`No unmatched bank transaction found for $${amount}. It may already be matched or not yet cleared.`);

      console.log(`Found transaction row — clicking to expand`);
      await txnRow.click();
      await page.waitForTimeout(1000);

      // Click "Find other matches" or "Find match" link
      const findMatchLink = page.getByText(/find other match|find match/i).first();
      if (await findMatchLink.count() === 0) throw new Error('"Find other matches" link not found — QB may have changed its UI.');
      await findMatchLink.click();
      await page.waitForTimeout(1500);

      // Type the reference number into the search box
      console.log(`Searching by reference: ${ref}`);
      const searchBox = page.getByPlaceholder(/search|filter|find/i).first()
        .or(page.locator('input[type="text"]').last());
      await searchBox.fill(ref);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(2000);

      // Verify the name appears in the results
      console.log(`Verifying name: ${name}`);
      const resultsText = await page.evaluate(() => document.body.innerText);
      const nameLower = name.toLowerCase();
      if (!resultsText.toLowerCase().includes(nameLower)) {
        throw new Error(`No QB match found for ref "${ref}" / "${name}" — this payment may not have been applied in Jobber yet, or was applied with a different reference number.`);
      }
      console.log(`✓ Name "${name}" confirmed in results`);

      // Select all result rows under this reference (handles batches >50 invoices)
      const resultCheckboxes = page.locator('input[type="checkbox"]').filter({ visible: true });
      const cbCount = await resultCheckboxes.count();
      console.log(`Found ${cbCount} result(s) to select`);

      for (let i = 0; i < cbCount; i++) {
        const cb = resultCheckboxes.nth(i);
        if (!await cb.isChecked()) await cb.check();
      }
      await page.waitForTimeout(500);

      // Verify the selected total matches the bank deposit amount
      const selectedTotal = await page.evaluate(() => {
        const el = document.querySelector('[class*="total"], [class*="amount"][class*="selected"], [data-testid*="total"]');
        if (!el) return null;
        const match = el.innerText?.match(/[\d,]+\.\d{2}/);
        return match ? parseFloat(match[0].replace(/,/g, '')) : null;
      });

      if (selectedTotal !== null && Math.abs(selectedTotal - amount) > 0.02) {
        throw new Error(`Amount mismatch: selected total $${selectedTotal} ≠ bank deposit $${amount}. QB may be missing some payments — check that all invoices are recorded in QB before matching.`);
      }

      // Confirm the match
      const confirmBtn = page.getByRole('button', { name: /^match$/i }).last();
      if (await confirmBtn.count() === 0) throw new Error('"Match" confirm button not found after selecting records.');
      if (!await confirmBtn.isEnabled()) throw new Error('Match button is disabled — selected total likely does not equal bank deposit amount.');

      await confirmBtn.click();
      await page.waitForTimeout(2000);
      console.log(`✓ Matched: ref=${ref} name=${name} amount=$${amount}`);

    } finally {
      await page.close();
    }
  } finally {
    await ctx.close();
  }
}

async function findBankTxnByAmount(page, amount) {
  const amtStr = amount.toFixed(2);

  // Wait for transactions to actually render
  await page.waitForTimeout(3000);

  const pageText = await page.evaluate(() => document.body.innerText).catch(() => '');
  console.log(`Page URL: ${page.url()}`);
  console.log(`Page text length: ${pageText.length}`);
  console.log(`Contains $${amtStr}: ${pageText.includes(amtStr)}`);
  console.log(`Page sample: ${pageText.replace(/\s+/g, ' ').trim().substring(0, 300)}`);

  if (!pageText.includes(amtStr)) return null;

  // QB uses dynamic classes — find any element whose text contains exactly this amount
  const handle = await page.evaluateHandle((amt) => {
    const amtStr = parseFloat(amt).toFixed(2);
    const all = Array.from(document.querySelectorAll('*'));
    for (const el of all) {
      const own = Array.from(el.childNodes)
        .filter(n => n.nodeType === 3)
        .map(n => n.textContent.trim())
        .join('');
      if (own.replace(/,/g, '') === amtStr || own.replace(/[$,]/g, '') === amtStr) {
        // Walk up to find the row container
        let p = el.parentElement;
        for (let i = 0; i < 8; i++) {
          if (!p || p === document.body) break;
          if (p.tagName === 'TR' || /row|transaction|item/i.test(p.className)) return p;
          p = p.parentElement;
        }
        return el.parentElement;
      }
    }
    return null;
  }, amtStr);

  if (!handle || handle.toString() === 'JSHandle:null') {
    console.log(`No element found containing exact amount ${amtStr}`);
    return null;
  }

  console.log(`Found element for $${amtStr}`);
  return page.locator('*').filter({ has: page.locator(`text=${amtStr}`) }).first();
}

// ── CLI (standalone dry-run / batch mode) ────────────────────────────────────

async function runDryRun() {
  const ctx = await launchStealthContext();
  try {
    await ensureLoggedIn(ctx);
    const page = await ctx.newPage();
    try {
      await page.goto(QB_BANKING_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(2000);

      const forReviewTab = page.getByRole('tab', { name: /for review/i });
      if (await forReviewTab.count() > 0) {
        await forReviewTab.first().click();
        await page.waitForTimeout(1500);
      }

      const rows = await page.evaluate(() => {
        const results = [];
        const allRows = Array.from(document.querySelectorAll('tr, [class*="transaction-row"]'));
        for (const row of allRows) {
          const text = row.innerText || '';
          if (!/\bmatch\b/i.test(text)) continue;
          const amounts = text.match(/\$([\d,]+\.\d{2})/g) || [];
          const amount = amounts[0] || '';
          results.push({ text: text.replace(/\s+/g, ' ').trim().substring(0, 100), amount });
        }
        return results;
      });

      console.log(`\nFor Review transactions with suggested matches: ${rows.length}\n`);
      rows.forEach((r, i) => console.log(`  ${i + 1}. ${r.amount.padStart(10)}  ${r.text}`));
      console.log('\nUse "Match in QuickBooks" button in TrackPoint to match these one at a time.');
    } finally {
      await page.close();
    }
  } finally {
    await ctx.close();
  }
}

if (require.main === module) {
  runDryRun().catch(err => { console.error('FAILED:', err.message); process.exit(1); });
}

module.exports = { matchInQbBanking };
