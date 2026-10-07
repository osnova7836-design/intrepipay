// Ycheten — cross-references QBO's undeposited Check AND Cash payments
// against Jobber's own Payments tab, which tracks a real "Manually
// deposited" status per payment for BOTH methods (confirmed live
// 2026-10-07 — not just checks). Os has been marking every check/cash
// payment deposited in Jobber since July 2026 (no guarantee before that)
// — this proves which of QBO's pending payments are confirmed already at
// the bank (safe to group into a real Deposit) vs genuinely unaccounted
// for, without needing the Tech Cash Tracker's database at all.
//
// This status has NO GraphQL API field (confirmed live via full schema
// introspection of CheckPaymentRecord/CashPaymentRecord) — it's UI-only,
// so this drives the actual Jobber web page with Playwright, same pattern
// as qb-sync-errors-scan.js. Read-only: only scrolls and reads, clicks
// nothing, changes nothing.
//
// Matches by Jobber invoice number, which QBO's own Payment record already
// carries (LineEx "txnReferenceNumber") -- a clean, exact join, no fuzzy
// matching. A single Jobber payment can cover many invoices (a big
// warranty-company batch check); any one of its invoice numbers matching
// counts.
//
// Usage: node scripts/qb-manual-deposit-crossref.js

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PROFILE_DIR = 'D:\\chrome-qb-profile';
const PAYMENTS_URL = 'https://secure.getjobber.com/payments?nav_label=Payments&nav_source=sidebar&payoutOrder=DESCENDING&payoutSort=ARRIVAL_DATE&order=DESCENDING&sort=ORDER_BY_PAYMENT_DATE';
const QB_AGENT_DIR = path.join(__dirname, '..', '.qb-agent');

// QBO PaymentMethodRef.value -> { label, jobberFilterText }
const METHODS = {
  '2': { label: 'Check', jobberFilterText: 'Check' },
  '1': { label: 'Cash', jobberFilterText: 'Cash' },
};

function findLatestUndepositedReport() {
  const files = fs.readdirSync(QB_AGENT_DIR)
    .filter((f) => /^undeposited-funds-\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort();
  if (!files.length) throw new Error('No undeposited-funds-*.json found -- run qb-undeposited-funds-scan.js first');
  return path.join(QB_AGENT_DIR, files[files.length - 1]);
}

function extractInvoiceNumber(payment) {
  for (const line of payment.Line || []) {
    for (const ex of line.LineEx?.any || []) {
      if (ex.value?.Name === 'txnReferenceNumber') return ex.value.Value;
    }
  }
  return null;
}

// Parses the Jobber Payments page's repeating 7-line block (confirmed live
// 2026-10-07): Client / "Invoice #X[ / Invoice #Y...]" / Date / "Succeeded"
// / method / deposit-status text / "$amount".
function parsePaymentRecords(bodyText, methodLabel) {
  const lines = bodyText.split('\n').map((l) => l.trim()).filter(Boolean);
  // The table header row is "Client" / "Payment date" / "Payment status" /
  // "Method" / "Payout date" / "Amount" (each its own line) -- data starts
  // right after "Amount".
  const headerIdx = lines.lastIndexOf('Amount');
  const startIdx = headerIdx >= 0 ? headerIdx + 1 : 0;
  const records = [];
  let i = startIdx;
  while (i < lines.length - 6) {
    if (!/^Invoice #/.test(lines[i + 1] || '')) { i++; continue; }
    const client = lines[i];
    const invoiceLine = lines[i + 1];
    const date = lines[i + 2];
    const status = lines[i + 3];
    const method = lines[i + 4];
    const depositStatus = lines[i + 5];
    const amountLine = lines[i + 6];
    if (method === methodLabel && /^\$/.test(amountLine)) {
      const invoiceNumbers = [...invoiceLine.matchAll(/#(\d+)/g)].map((m) => m[1]);
      records.push({ client, invoiceNumbers, date, status, depositStatus, amount: parseFloat(amountLine.replace(/[$,]/g, '')) });
      i += 7;
    } else {
      i++;
    }
  }
  return records;
}

function parseLooseDate(s) {
  // Handles both "Jun 03, 2026" (Jobber UI) and "2026-06-03" (QBO ISO).
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

async function scrapeJobberPayments(page, methodLabel, oldestDateNeeded) {
  console.log(`Filtering to Method = ${methodLabel}...`);
  await page.getByText('Method', { exact: false }).first().click({ timeout: 10000 });
  await page.waitForTimeout(1000);
  await page.evaluate((label) => {
    const els = Array.from(document.querySelectorAll('li, div, button, span'));
    const opt = els.find((el) => el.children.length === 0 && (el.textContent || '').trim() === label);
    if (opt) { opt.scrollIntoView(); opt.click(); }
  }, methodLabel);
  await page.waitForTimeout(2500);

  console.log(`Scrolling to load rows back through ${oldestDateNeeded.toDateString()}...`);
  await page.mouse.move(700, 500);
  let reachedTarget = false;
  let lastLength = 0;
  let stableCount = 0;
  for (let i = 0; i < 300 && !reachedTarget && stableCount < 5; i++) {
    await page.mouse.wheel(0, 800);
    await page.waitForTimeout(350);
    if (i % 10 === 0) {
      const text = await page.locator('body').innerText().catch(() => '');
      const records = parsePaymentRecords(text, methodLabel);
      const oldestSoFar = records.length ? parseLooseDate(records[records.length - 1].date) : null;
      if (oldestSoFar && oldestSoFar <= oldestDateNeeded) reachedTarget = true;
      if (text.length === lastLength) stableCount++; else stableCount = 0;
      lastLength = text.length;
    }
  }

  const finalText = await page.locator('body').innerText().catch(() => '');
  return parsePaymentRecords(finalText, methodLabel);
}

function crossReference(qboPayments, jobberPayments) {
  const byInvoice = {};
  for (const r of jobberPayments) for (const inv of r.invoiceNumbers) (byInvoice[inv] ||= []).push(r);

  const confirmedDeposited = [];
  const notFound = [];
  for (const p of qboPayments) {
    const invNum = extractInvoiceNumber(p);
    const matches = invNum ? byInvoice[invNum] : null;
    if (matches?.length) confirmedDeposited.push({ qbo: p, invNum, jobber: matches[0] });
    else notFound.push({ qbo: p, invNum });
  }
  return { confirmedDeposited, notFound };
}

function printResults(label, qboPayments, result) {
  console.log(`\n\n########## ${label} ##########`);
  console.log(`QBO undeposited ${label.toLowerCase()}: ${qboPayments.length}, $${qboPayments.reduce((s, p) => s + p.TotalAmt, 0).toFixed(2)}`);

  console.log(`\n=== Confirmed "Manually deposited" in Jobber: ${result.confirmedDeposited.length}, $${result.confirmedDeposited.reduce((s, r) => s + r.qbo.TotalAmt, 0).toFixed(2)} ===`);
  console.log('  Safe to group into a QBO Deposit -- money confirmed already at the bank.\n');
  for (const r of result.confirmedDeposited) {
    console.log(`  $${r.qbo.TotalAmt}  ${r.qbo.TxnDate}  ${r.qbo.CustomerRef?.name}  invoice#${r.invNum}`);
  }

  console.log(`\n=== NOT found in Jobber's ${label.toLowerCase()} list: ${result.notFound.length}, $${result.notFound.reduce((s, r) => s + r.qbo.TotalAmt, 0).toFixed(2)} ===`);
  console.log('  (either predates when this started getting marked consistently, or worth a closer look)\n');
  for (const r of result.notFound) {
    console.log(`  $${r.qbo.TotalAmt}  ${r.qbo.TxnDate}  ${r.qbo.CustomerRef?.name}  invoice#${r.invNum || '(none found)'}`);
  }
}

async function main() {
  const reportPath = findLatestUndepositedReport();
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  console.log(`Loaded ${reportPath}`);

  const byMethod = {};
  for (const [val, { label }] of Object.entries(METHODS)) {
    byMethod[val] = report.stillPending.filter((p) => p.PaymentMethodRef?.value === val);
  }

  const allNeeded = Object.values(byMethod).flat();
  if (!allNeeded.length) { console.log('No pending Check or Cash payments -- nothing to cross-reference.'); return; }

  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    executablePath: CHROME_PATH,
    args: ['--disable-blink-features=AutomationControlled', '--disable-gpu'],
    ignoreDefaultArgs: ['--enable-automation', '--no-sandbox'],
  });
  const page = ctx.pages()[0] || (await ctx.newPage());

  console.log('Navigating to Jobber Payments page...');
  await page.goto(PAYMENTS_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(3000);

  const allResults = {};
  for (const [val, { label, jobberFilterText }] of Object.entries(METHODS)) {
    const qboPayments = byMethod[val];
    if (!qboPayments.length) { console.log(`\nNo pending ${label} payments -- skipping.`); continue; }

    const oldestNeeded = qboPayments.reduce((min, p) => {
      const d = parseLooseDate(p.TxnDate);
      return d && d < min ? d : min;
    }, new Date());

    const jobberPayments = await scrapeJobberPayments(page, jobberFilterText, oldestNeeded);
    console.log(`Parsed ${jobberPayments.length} Jobber ${label} records (${jobberPayments[jobberPayments.length - 1]?.date} to ${jobberPayments[0]?.date})`);

    const result = crossReference(qboPayments, jobberPayments);
    printResults(label, qboPayments, result);
    allResults[label] = result;
  }

  await ctx.close();

  const outPath = path.join(QB_AGENT_DIR, `manual-deposit-crossref-${new Date().toISOString().slice(0, 10)}.json`);
  fs.writeFileSync(outPath, JSON.stringify(allResults, null, 2));
  console.log(`\n\nFull detail saved to ${outPath}`);
}

main().catch((err) => {
  console.error('FATAL', err.message);
  process.exit(1);
});
