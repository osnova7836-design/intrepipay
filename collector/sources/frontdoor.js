const { launchBrowser } = require('../utils/browser');

const FRONTDOOR_URL = 'https://contractor.frontdoorhome.com';

async function collect({ daysBack = 30 } = {}) {
  const username = process.env.FRONTDOOR_USERNAME;
  const password = process.env.FRONTDOOR_PASSWORD;
  if (!username || !password) throw new Error('FRONTDOOR_USERNAME / FRONTDOOR_PASSWORD env vars not set');

  const ctx = await launchBrowser('frontdoor');
  try {
    const page = await ctx.newPage();
    await login(page, username, password);

    const dispatches = await scrapeSubmittedInvoices(page, daysBack);
    console.log(`[Frontdoor] ${dispatches.length} dispatches to process`);

    const results = await collectPaymentDetails(page, dispatches);
    console.log(`[Frontdoor] ${results.length} payments collected`);
    return results;
  } finally {
    await ctx.close();
  }
}

async function login(page, username, password) {
  await page.goto(FRONTDOOR_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2000);

  if (!page.url().includes('login.frontdoorhome.com')) {
    console.log('[Frontdoor] Already logged in (session active)');
    return;
  }

  console.log('[Frontdoor] Logging in...');
  await page.fill('#loginId', username);
  await page.fill('#password', password);
  await page.locator('button:has-text("Log in"), button[type="submit"]').first().click();
  await page.waitForURL('**/contractor.frontdoorhome.com/**', { timeout: 20000 });
  await page.waitForTimeout(2000);
  console.log('[Frontdoor] Logged in');
}

async function scrapeSubmittedInvoices(page, daysBack) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - daysBack);

  await page.click('a:has-text("Invoices")');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(1500);
  await page.click('button:has-text("Submitted Invoices"), a:has-text("Submitted Invoices")');
  await page.waitForTimeout(3000);

  const allDispatches = [];
  const seen = new Set();
  let pageNum = 1;
  let hitCutoff = false;

  while (!hitCutoff) {
    // Extract dispatch links and full row text from each list row
    const rows = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('[data-testid^="Invoices__DispatchLink__"]')).map(link => {
        // Walk up to the table row and grab all cell text in order
        let el = link;
        while (el && el.tagName !== 'TR' && el.tagName !== 'LI' && !el.getAttribute('role')?.includes('row')) {
          el = el.parentElement;
        }
        const cells = el ? Array.from(el.querySelectorAll('td, [role="cell"], [class*="cell"]')).map(td => td.innerText.trim()) : [];
        // Also grab full row text as fallback for date/amount parsing
        const rowText = el ? el.innerText : '';
        return { dispatchId: link.textContent.trim(), href: link.href, cells, rowText };
      });
    });

    if (!rows.length) break;

    for (const { dispatchId, href, cells, rowText } of rows) {
      if (!dispatchId || !href || seen.has(dispatchId)) continue;

      // Parse invoice submitted date — try cells[3] first, then scan rowText
      let invoiceDate = null;
      const dateStr = cells[3] || (rowText.match(/(\d{2}\/\d{2}\/\d{4})/) || [])[1] || '';
      if (dateStr) invoiceDate = new Date(dateStr);

      // Parse paid total — try cells[7]/cells[6] first, then scan rowText for last dollar amount
      let paidTotal = parseFloat((cells[7] || cells[6] || '').replace(/[$,]/g, '')) || 0;
      if (!paidTotal) {
        const amts = rowText.match(/\$([\d,]+\.\d{2})/g);
        if (amts) paidTotal = parseFloat(amts[amts.length - 1].replace(/[$,]/g, '')) || 0;
      }

      if (invoiceDate && !isNaN(invoiceDate) && invoiceDate < cutoff) { hitCutoff = true; continue; }
      if (paidTotal <= 0) continue;

      seen.add(dispatchId);
      allDispatches.push({ dispatchId, href, paidTotal });
    }

    // Next page — skip the hidden variant (pagination-arrow-button-hidden)
    const nextBtn = page.locator('[aria-label="Next page"]:not(.pagination-arrow-button-hidden)').first();
    if (await nextBtn.count() === 0 || await nextBtn.isDisabled()) break;
    await nextBtn.click({ force: true });
    await page.waitForTimeout(1500);
    if (++pageNum > 30) break;
  }

  return allDispatches;
}

async function collectPaymentDetails(page, dispatches) {
  const paymentMap = {};

  for (const { dispatchId, href, paidTotal, invoiceId } of dispatches) {
    try {
      await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 20000 });
      // Wait for the invoice section to render (Payment # is in the submitted invoice block)
      await page.waitForFunction(
        () => document.body.innerText.includes('Payment #') || document.body.innerText.includes('No invoice'),
        { timeout: 15000 }
      ).catch(() => {});
      await page.waitForTimeout(500);

      const text = await page.evaluate(() => document.body.innerText);

      const payNumMatch  = text.match(/Payment\s+#\s*[\n\r\s]+(E-\d+)/i)
                        || text.match(/Payment\s+#\s*[\n\r\s]+(\d{6,})/i);
      const payDateMatch = text.match(/Payment\s+Details\s*[\n\r\s]+(\d{2}\/\d{2}\/\d{4})/i);

      if (!payNumMatch) {
        console.warn(`[Frontdoor] No Payment # found for dispatch ${dispatchId}`);
        continue;
      }

      const paymentRef = payNumMatch[1];
      const payDate = payDateMatch ? normalizeDate(payDateMatch[1]) : '';

      if (!paymentMap[paymentRef]) {
        paymentMap[paymentRef] = {
          company: 'Frontdoor',
          paymentRef,
          paymentDate: payDate,
          amount: 0,
          workOrders: [],
        };
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
