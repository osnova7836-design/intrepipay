const { launchBrowser } = require('../utils/browser');

const FRONTDOOR_URL = 'https://contractor.frontdoorhome.com';

async function collect({ daysBack = 30 } = {}) {
  const username = process.env.FRONTDOOR_USERNAME;
  const password = process.env.FRONTDOOR_PASSWORD;
  if (!username || !password) throw new Error('FRONTDOOR_USERNAME / FRONTDOOR_PASSWORD env vars not set');

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - daysBack);

  const ctx = await launchBrowser('frontdoor');
  try {
    const page = await ctx.newPage();
    await login(page, username, password);

    const dispatches = await scrapeSubmittedInvoices(page, daysBack);
    console.log(`[Frontdoor] ${dispatches.length} dispatches found`);

    const results = await collectPaymentDetails(page, dispatches, cutoff);
    console.log(`[Frontdoor] ${results.length} payments collected`);
    return results;
  } finally {
    await ctx.close();
  }
}

async function login(page, username, password) {
  await page.goto(FRONTDOOR_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  // Allow time for the SPA to check session and either render the portal or redirect to login
  await page.waitForTimeout(4000);

  // URL is the reliable indicator — the portal never stays at the login domain when logged in
  if (!page.url().includes('login.frontdoorhome.com')) {
    console.log('[Frontdoor] Already logged in (session active)');
    return;
  }

  console.log('[Frontdoor] Logging in...');
  await page.waitForSelector('#loginId', { timeout: 30000 });
  await page.fill('#loginId', username);
  await page.fill('#password', password);
  await page.locator('button:has-text("Log in"), button[type="submit"]').first().click();
  await page.waitForURL('**/contractor.frontdoorhome.com/**', { timeout: 30000 });
  await page.waitForTimeout(3000);
  console.log('[Frontdoor] Logged in');
}

async function selectCalendarDate(page, inputLocator, targetDate) {
  await inputLocator.click();
  await page.waitForTimeout(800);

  const cal = page.locator('.date-time-input-calendar');
  await cal.waitFor({ timeout: 5000 });

  const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const targetMonthName = `${MONTHS[targetDate.getMonth()]} ${targetDate.getFullYear()}`;
  const targetDay = String(targetDate.getDate());

  // Navigate left/right until the target month appears in one of the two columns
  for (let i = 0; i < 12; i++) {
    const titles = await cal.locator('.date-time-input-month-title').allTextContents();
    if (titles.map(t => t.trim()).includes(targetMonthName)) break;

    const firstTitle = (titles[0] || '').trim();
    const m = firstTitle.match(/(\w+)\s+(\d{4})/);
    if (!m) break;

    const curMonth = MONTHS.indexOf(m[1]);
    const curYear  = parseInt(m[2]);
    const goBack   = curYear > targetDate.getFullYear()
                  || (curYear === targetDate.getFullYear() && curMonth > targetDate.getMonth());

    // Back arrow is the first button overall; forward arrow is the last
    if (goBack) {
      await cal.locator('.date-time-input-month-header button').first().click();
    } else {
      await cal.locator('.date-time-input-month-header button').last().click();
    }
    await page.waitForTimeout(400);
  }

  // Find the month column showing targetMonthName and click the correct day button
  const monthDivs = cal.locator('.date-time-input-month');
  const monthCount = await monthDivs.count();
  for (let i = 0; i < monthCount; i++) {
    const title = (await monthDivs.nth(i).locator('.date-time-input-month-title').textContent()).trim();
    if (title !== targetMonthName) continue;

    const dayBtns = monthDivs.nth(i).locator('.date-time-input-day button');
    const btnCount = await dayBtns.count();
    for (let j = 0; j < btnCount; j++) {
      const label = (await dayBtns.nth(j).locator('.button-label-text').textContent().catch(() => '')).trim();
      if (label === targetDay) {
        await dayBtns.nth(j).click();
        break;
      }
    }
    break;
  }

  await page.waitForTimeout(500);
}

async function scrapeSubmittedInvoices(page, daysBack) {
  await page.click('a:has-text("Invoices")');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(1500);
  await page.click('button:has-text("Submitted Invoices"), a:has-text("Submitted Invoices")');
  await page.waitForTimeout(3000);

  // Set date filter by opening each calendar popup and clicking the target date.
  const today = new Date();
  const from  = new Date(); from.setDate(from.getDate() - daysBack);
  const dateInputs = page.locator('input[placeholder="mm/dd/yyyy"]');
  if (await dateInputs.count() >= 2) {
    await selectCalendarDate(page, dateInputs.nth(0), from);
    await selectCalendarDate(page, dateInputs.nth(1), today);
    await page.waitForTimeout(3000);
    const fromVal = await dateInputs.nth(0).inputValue().catch(() => '?');
    const toVal   = await dateInputs.nth(1).inputValue().catch(() => '?');
    console.log(`[Frontdoor] Date filter: ${fromVal} → ${toVal}`);
  }

  // List is sorted newest-first. Cap pages scanned based on daysBack so we don't
  // click through the entire history — 30 days ≈ 3-5 pages, 60 days ≈ 6-9 pages.
  const maxListPages = Math.ceil(daysBack / 6) + 3;

  const allDispatches = [];
  const seen = new Set();
  let pageNum = 1;

  while (true) {
    const rows = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-testid^="Invoices__DispatchLink__"]')).map(link => ({
        dispatchId: link.textContent.trim(),
        href: link.href,
      }))
    );

    if (!rows.length) break;

    for (const { dispatchId, href } of rows) {
      if (!dispatchId || !href || seen.has(dispatchId)) continue;
      seen.add(dispatchId);
      allDispatches.push({ dispatchId, href });
    }

    const nextBtn = page.locator('[aria-label="Next page"]:not(.pagination-arrow-button-hidden)').first();
    if (await nextBtn.count() === 0 || await nextBtn.isDisabled()) break;
    await nextBtn.click({ force: true });
    await page.waitForTimeout(1500);
    if (++pageNum > maxListPages) break;
  }

  console.log(`[Frontdoor] Scanned ${pageNum} list page(s) (max ${maxListPages} for ${daysBack}-day window)`);
  return allDispatches;
}

async function collectPaymentDetails(page, dispatches, cutoff) {
  const paymentMap = {};
  // Payment refs confirmed older than cutoff — skip their remaining dispatches immediately
  const oldPayments = new Set();
  // Stop once we've seen several consecutive dispatches all belonging to old payments
  let consecutiveOld = 0;

  for (const { dispatchId, href } of dispatches) {
    try {
      await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForFunction(
        () => document.body.innerText.includes('Payment #') || document.body.innerText.includes('No invoice'),
        { timeout: 15000 }
      ).catch(() => {});
      await page.waitForTimeout(500);

      const text = await page.evaluate(() => document.body.innerText);

      const payNumMatch  = text.match(/Payment\s+#\s*[\n\r\s]+(E-\d+)/i)
                        || text.match(/Payment\s+#\s*[\n\r\s]+(\d{6,})/i);
      const payDateMatch = text.match(/Payment\s+Details\s*[\n\r\s]+(\d{2}\/\d{2}\/\d{4})/i);
      const paidMatch    = text.match(/Payment\s+Amount\s*[\n\r]+\s*\$?([\d,]+\.\d{2})/i)
                        || text.match(/Paid\s+Total[:\s]*[\n\r]*\s*\$?([\d,]+\.\d{2})/i);

      if (!payNumMatch) {
        console.warn(`[Frontdoor] No Payment # found for dispatch ${dispatchId}`);
        consecutiveOld++;
        if (consecutiveOld >= 3) { console.log('[Frontdoor] Early stop: too many unpayable dispatches'); break; }
        continue;
      }

      const paymentRef = payNumMatch[1];

      // If we already know this payment is old, skip immediately
      if (oldPayments.has(paymentRef)) {
        consecutiveOld++;
        if (consecutiveOld >= 3 && Object.keys(paymentMap).length > 0) {
          console.log('[Frontdoor] Early stop: past date window');
          break;
        }
        continue;
      }

      const payDate   = payDateMatch ? new Date(payDateMatch[1]) : null;
      const paidTotal = paidMatch ? parseFloat(paidMatch[1].replace(/,/g, '')) : 0;

      if (payDate && payDate < cutoff) {
        oldPayments.add(paymentRef);
        consecutiveOld++;
        if (consecutiveOld >= 3 && Object.keys(paymentMap).length > 0) {
          console.log('[Frontdoor] Early stop: past date window');
          break;
        }
        continue;
      }

      if (paidTotal <= 0) continue;

      consecutiveOld = 0;

      if (!paymentMap[paymentRef]) {
        const payDate_ = payDateMatch ? normalizeDate(payDateMatch[1]) : '';
        paymentMap[paymentRef] = { company: 'Frontdoor', paymentRef, paymentDate: payDate_, amount: 0, workOrders: [] };
      }

      if (paymentMap[paymentRef].workOrders.some(w => w.workOrder === dispatchId)) continue;
      paymentMap[paymentRef].amount = Math.round((paymentMap[paymentRef].amount + paidTotal) * 100) / 100;
      paymentMap[paymentRef].workOrders.push({ workOrder: dispatchId, amount: paidTotal });
      console.log(`[Frontdoor] dispatch ${dispatchId} → payment ${paymentRef} $${paidTotal}`);
    } catch (err) {
      console.warn(`[Frontdoor] Failed for dispatch ${dispatchId}: ${err.message}`);
    }
  }

  return Object.values(paymentMap);
}

function normalizeDate(val) {
  if (!val) return '';
  const d = new Date(val);
  if (!isNaN(d)) return d.toISOString().slice(0, 10);
  return String(val);
}

module.exports = { collect };
