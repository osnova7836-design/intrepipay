const { chromium } = require('playwright');
const path = require('path');
const readline = require('readline');

const JOBBER_ORIGIN = 'https://secure.getjobber.com';
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PROFILE_DIR = 'D:\\chrome-debug-profile';

function buildPaymentUrl({ clientId, invoiceIds }) {
  const u = new URL('/payments/new', JOBBER_ORIGIN);
  u.searchParams.set('clientId', clientId);
  u.searchParams.set('invoiceId', invoiceIds[0]); // First ID pre-selects on load
  u.searchParams.set('order', 'ASCENDING');
  u.searchParams.set('sort', 'DUE_DATE');
  return u.toString();
}

function waitForEnter(prompt = 'Press Enter to continue...') {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, () => { rl.close(); resolve(); });
  });
}

// Launches real Chrome with the persistent profile and no CDP debug port.
// Cloudflare sees a normal Chrome process — no --remote-debugging-port, no
// --enable-automation, and navigator.webdriver is patched out via init script.
async function launchStealthContext(headless = false) {
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    executablePath: CHROME_PATH,
    headless,
    args: ['--disable-blink-features=AutomationControlled', '--disable-gpu'],
    ignoreDefaultArgs: ['--enable-automation'],
  });
  // Runs before any page script so webdriver is never observable.
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  return ctx;
}

// Checks whether the profile's cookies are still valid. If not, prompts the
// user to log in manually in the open browser window.
async function ensureLoggedIn(ctx) {
  const page = await ctx.newPage();
  await page.goto(JOBBER_ORIGIN + '/', { waitUntil: 'load' });

  if (/\/login|\/sign_in|\/users\/sign_in/.test(page.url())) {
    console.log('\n=== Jobber session expired or not found ===');
    console.log('A browser window is open. Log in to Jobber, then return here.');
    await waitForEnter('After you see your Jobber dashboard, press Enter here... ');

    if (/\/login|\/sign_in|\/users\/sign_in/.test(page.url())) {
      throw new Error('Still on login page — login was not completed.');
    }
    console.log('Login confirmed. Session is now stored in the Chrome profile.\n');
  }

  await page.close();
}

async function selectPaymentMethod(page, type) {
  // There is exactly one <select> on this page — the payment method dropdown.
  await page.locator('select').selectOption({ label: type });
}

async function fillReference(page, type, ref) {
  // Jobber uses floating labels (not placeholder attributes) for these fields.
  const pattern = type === 'ACH' ? /reference/i : /check/i;
  await page.getByLabel(pattern).fill(ref);
}

async function fillTransactionDate(page, date) {
  // Normalize to MM, DD, YYYY parts for keyboard entry
  let month, day, year;
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(date)) {
    [month, day, year] = date.split('/');
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    [year, month, day] = date.split('-');
  } else {
    throw new Error(`Unrecognised date format: ${date}`);
  }
  const iso = `${year}-${month}-${day}`;

  // This is input[type=text] controlled by a custom React date picker.
  // Setting the value directly is overridden on blur — must click the day in the calendar.
  const field = page.getByLabel('Transaction Date');
  await field.click(); // opens react-datepicker calendar
  await page.waitForTimeout(400);

  // react-datepicker day cells carry the class "react-datepicker__day".
  // Anchored regex prevents matching "18" or "28" when we want "8".
  const dayNum = parseInt(day, 10);
  const dayCell = page.locator('[class*="react-datepicker__day"]')
    .filter({ hasText: new RegExp(`^${dayNum}$`) });
  await dayCell.first().click();
  await page.waitForTimeout(300);
}

// Each invoice row has an <a href="/invoices/INVOICE_DB_ID"> link.
// We find the row by that link, then return its checkbox's position in the list.
// Jobber uses a virtual scroller so rows beyond the initial viewport aren't
// rendered until scrolled into view — strategy 2 handles that case.
async function findCheckboxIndexByDom(page, invoiceId) {
  const searchByHref = (id) => {
    const allCbs = Array.from(document.querySelectorAll('input[type="checkbox"]'));
    const link = document.querySelector(`a[href*="/invoices/${id}"]`);
    if (!link) return -1;
    let el = link;
    for (let i = 0; i < 10; i++) {
      const cb = el.querySelector('input[type="checkbox"]');
      if (cb) return allCbs.indexOf(cb);
      if (!el.parentElement) break;
      el = el.parentElement;
    }
    return -1;
  };

  // Strategy 1: row already rendered (visible rows)
  let idx = await page.evaluate(searchByHref, String(invoiceId));
  if (idx !== -1) return idx;

  // Strategy 2: scroll only the last row to trigger load-on-demand in batches.
  // Scrolling every row causes Jobber's SPA to navigate away at ~200 rows.
  console.log(`    (scrolling to load all rows for invoice ${invoiceId}...)`);
  let prevCount = 0;
  for (let pass = 0; pass < 20; pass++) {
    const count = await page.evaluate(() =>
      document.querySelectorAll('input[type="checkbox"]').length
    );
    if (count === prevCount) break;  // list fully loaded — invoice genuinely not present
    console.log(`    (${count} rows loaded — scrolling last into view...)`);
    prevCount = count;

    // Scroll only the last row to trigger the next batch without loading all rows at once.
    await page.evaluate(() => {
      const cbs = document.querySelectorAll('input[type="checkbox"]');
      cbs[cbs.length - 1].scrollIntoView({ behavior: 'instant', block: 'nearest' });
    });
    // Wait until new rows appear OR give up after 3 seconds.
    await page.waitForFunction(
      (prev) => document.querySelectorAll('input[type="checkbox"]').length > prev,
      prevCount,
      { timeout: 3000 }
    ).catch(() => {});

    const found = await page.evaluate(searchByHref, String(invoiceId));
    if (found !== -1) return found;
  }

  return -1;
}

// Dumps checkbox indices alongside any discoverable row text — used when DOM
// search returns -1 so we can understand the page structure.
async function dumpCheckboxRows(page) {
  // Scroll all rows into view so virtual-scroller renders their content
  await page.evaluate(async () => {
    const cbs = Array.from(document.querySelectorAll('input[type="checkbox"]'));
    for (const cb of cbs) {
      cb.scrollIntoView({ behavior: 'instant', block: 'nearest' });
      await new Promise((r) => setTimeout(r, 30));
    }
  });
  await page.waitForTimeout(500);

  const rows = await page.evaluate(() =>
    Array.from(document.querySelectorAll('input[type="checkbox"]')).map((cb, i) => {
      // Walk up to 10 levels to find any ancestor with meaningful text
      let text = '';
      let href = '';
      let el = cb;
      for (let lvl = 0; lvl < 10; lvl++) {
        el = el.parentElement;
        if (!el) break;
        if (!text) {
          const t = el.textContent?.replace(/\s+/g, ' ').trim();
          if (t && t.length > 3) text = t.slice(0, 140);
        }
        if (!href) {
          const a = el.querySelector('a[href]');
          if (a) href = a.href;
        }
        if (text && href) break;
      }
      return { index: i, checked: cb.checked, text, href };
    })
  );

  console.log(`\n--- CHECKBOX ROWS (${rows.length} total) ---`);
  for (const r of rows) {
    const mark = r.checked ? '✓' : ' ';
    const id = r.href ? r.href.split('/invoices/')[1] : '';
    console.log(`[${mark}] ${r.index}: ${id ? `(id:${id}) ` : ''}${r.text || '(no text)'}`);
  }
  console.log('-------------------------------------------\n');
}

async function ensureInvoicesChecked(page, invoiceIds) {
  const indices = {};

  for (const id of invoiceIds) {
    console.log(`  Searching DOM for invoice ${id}...`);
    const idx = await findCheckboxIndexByDom(page, id);
    if (idx !== -1) {
      console.log(`  Invoice ${id} → index ${idx} (found in DOM)`);
      indices[id] = idx;
    } else {
      console.log(`  Invoice ${id} → NOT found by DOM/href search`);
    }
  }

  const notFound = invoiceIds.filter((id) => indices[id] === undefined);
  if (notFound.length > 0) {
    // Check if Jobber pre-selected all of them via the multi-invoiceId URL.
    // Count checked checkboxes and match them to our list in order.
    const checkedIndices = await page.evaluate(() =>
      Array.from(document.querySelectorAll('input[type="checkbox"]'))
        .map((cb, i) => ({ i, checked: cb.checked }))
        .filter((r) => r.checked)
        .map((r) => r.i)
    );
    console.log(`  Pre-checked checkbox indices: ${checkedIndices.join(', ')}`);

    if (checkedIndices.length === invoiceIds.length) {
      // Jobber pre-selected exactly the right number — trust the order
      console.log('  Count matches — using pre-selected indices.');
      invoiceIds.forEach((id, i) => { indices[id] = checkedIndices[i]; });
    } else {
      console.log(`\n  DOM search missed: ${notFound.join(', ')}. Dumping rows for manual inspection:`);
      await dumpCheckboxRows(page);
      throw new Error(
        `Could not identify checkboxes for: ${notFound.join(', ')}.\n` +
        'See row dump above — match invoice numbers to database IDs.'
      );
    }
  }

  for (const [id, idx] of Object.entries(indices)) {
    const cb = page.locator('input[type="checkbox"]').nth(Number(idx));
    if (await cb.isChecked()) {
      console.log(`  Invoice ${id} (index ${idx}) already checked`);
    } else {
      await cb.check({ force: true });
      console.log(`  Invoice ${id} (index ${idx}) checked`);
    }
  }
}

async function clickSubmit(page) {
  // Exact match — there is also a "Save and Email Receipt" button next to this one.
  const button = page.getByRole('button', { name: 'Save', exact: true });
  await button.click();
  // Jobber's SPA keeps background connections open so networkidle never fires; 'load' is sufficient.
  await page.waitForLoadState('load');
}

async function applyJobberPayment({
  clientId,
  invoiceIds,  // array of one or more invoice IDs
  type,
  ref,
  date,
  submit = false,
  headless = false,
  navigateOnly = false,
}) {
  if (!clientId || !invoiceIds?.length) throw new Error('clientId and at least one invoiceId are required');
  if (!navigateOnly) {
    if (!['Check', 'ACH'].includes(type)) throw new Error('type must be "Check" or "ACH"');
    if (!ref) throw new Error('ref (reference/check number) is required');
    if (!date) throw new Error('date is required (e.g. "2026-05-13" or "05/13/2026")');
  }

  const ctx = await launchStealthContext(headless);
  try {
    await ensureLoggedIn(ctx);

    const page = await ctx.newPage();
    const url = buildPaymentUrl({ clientId, invoiceIds });
    console.log(`Navigating to ${url}`);
    await page.goto(url, { waitUntil: 'load' });
    // SPA may continue rendering after load — wait for the form's first interactive element.
    await page.waitForSelector('select, input[type="text"], input[type="date"]', { timeout: 30000 });
    // Wait for the sticky list header so checkbox indices are stable before we count them.
    await page.waitForSelector('[data-testid="ATL-DataList-stickyHeader"]', { timeout: 15000 })
      .catch(() => {});

    if (/\/login|\/sign_in|\/users\/sign_in/.test(page.url())) {
      throw new Error(`Redirected to login (${page.url()}) — ensureLoggedIn passed but session wasn't persisted.`);
    }

    if (navigateOnly) {
      console.log('\n--- NAVIGATE-ONLY ---');
      console.log('Page loaded. Inspect freely; no fields will be filled and nothing will be submitted.');
      await waitForEnter('Press Enter to close the browser... ');
      return;
    }

    console.log(`Setting payment method to "${type}"`);
    await selectPaymentMethod(page, type);

    console.log(`Filling reference number "${ref}"`);
    await fillReference(page, type, ref);

    // Check invoices first — scrolling 200+ rows triggers React re-renders that
    // reset the date field if it was filled earlier.
    console.log(`Ensuring invoices checked: ${invoiceIds.join(', ')}`);
    await ensureInvoicesChecked(page, invoiceIds);

    // Fill date last so React can't overwrite it.
    console.log(`Filling transaction date "${date}"`);
    await fillTransactionDate(page, date);

    if (submit) {
      console.log('Submitting payment...');
      await clickSubmit(page);
      console.log('Payment submitted.');
    } else {
      console.log('\n--- DRY RUN ---');
      console.log('Form is filled. The browser is left open for review.');
      console.log('Re-run with --submit to actually click submit.');
      await waitForEnter('Press Enter to close the browser... ');
    }
  } finally {
    await ctx.close();
  }
}

function parseArgs(argv) {
  const args = {};
  for (const raw of argv) {
    if (!raw.startsWith('--')) continue;
    const eq = raw.indexOf('=');
    if (eq >= 0) args[raw.slice(2, eq)] = raw.slice(eq + 1);
    else args[raw.slice(2)] = true;
  }
  return args;
}

function usage() {
  console.log(`Usage:
  node scripts/jobber-payment.js \\
    --clientId=CLIENT_ID \\
    --invoiceId=INVOICE_ID \\
    --type=Check|ACH \\
    --ref=CHECK_OR_REF_NUMBER \\
    --date=YYYY-MM-DD \\
    [--submit] [--headless]

  # Multiple invoices (one payment split across several):
  node scripts/jobber-payment.js \\
    --clientId=CLIENT_ID \\
    --invoiceId=ID1,ID2,ID3 \\
    --type=Check|ACH \\
    --ref=CHECK_OR_REF_NUMBER \\
    --date=YYYY-MM-DD \\
    [--submit] [--headless]

  # Or, to just verify auth + navigation without touching the form:
  node scripts/jobber-payment.js \\
    --clientId=CLIENT_ID --invoiceId=INVOICE_ID --navigate-only

Without --submit, the script fills the form and pauses with the browser open for review.`);
}

module.exports = { applyJobberPayment, buildPaymentUrl };

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  const navigateOnly = !!args['navigate-only'];

  // Accept --invoiceId=X (single) or --invoiceIds=X,Y,Z (multiple)
  const rawIds = args.invoiceIds || args.invoiceId || '';
  const invoiceIds = rawIds.split(',').map(s => s.trim()).filter(Boolean);

  const missingFormArgs = !navigateOnly && (!args.type || !args.ref || !args.date);
  if (args.help || !args.clientId || !invoiceIds.length || missingFormArgs) {
    usage();
    process.exit(args.help ? 0 : 1);
  }
  applyJobberPayment({
    clientId: args.clientId,
    invoiceIds,
    type: args.type,
    ref: args.ref,
    date: args.date,
    submit: !!args.submit,
    headless: !!args.headless,
    navigateOnly,
  }).catch((err) => {
    console.error('\nFAILED:', err.message);
    process.exit(1);
  });
}
