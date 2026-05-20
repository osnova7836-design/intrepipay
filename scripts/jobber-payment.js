// Must be set before requiring playwright so the browser path resolves correctly.
if (process.env.RENDER) process.env.PLAYWRIGHT_BROWSERS_PATH = '/opt/render/project/src/.playwright-browsers';

const { chromium } = require('playwright');
const path = require('path');
const readline = require('readline');

const JOBBER_ORIGIN = 'https://secure.getjobber.com';
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PROFILE_DIR = process.env.RENDER ? '/tmp/chrome-profile' : 'D:\\chrome-debug-profile';
const BATCH_SIZE = 50; // Jobber rejects payment applications with more than 50 invoices

function buildPaymentUrl({ clientId, invoiceIds }) {
  const u = new URL('/payments/new', JOBBER_ORIGIN);
  u.searchParams.set('clientId', clientId);
  u.searchParams.set('invoiceId', invoiceIds[0]); // First ID pre-selects on load
  // DESCENDING puts newest invoices at the top — target invoices are recent so
  // they land at low indices (< 50) instead of deep in the virtual list (200+)
  u.searchParams.set('order', 'DESCENDING');
  u.searchParams.set('sort', 'DUE_DATE');
  return u.toString();
}

function waitForEnter(prompt = 'Press Enter to continue...') {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, () => { rl.close(); resolve(); });
  });
}

// Launches real Chrome (local) or Playwright's bundled Chromium (Render/Linux).
// Cloudflare sees a normal Chrome process — no --remote-debugging-port, no
// --enable-automation, and navigator.webdriver is patched out via init script.
async function launchStealthContext(headless = false) {
  const onRender = !!process.env.RENDER;
  const opts = {
    headless: onRender ? true : headless,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-gpu',
      ...(onRender ? ['--no-sandbox', '--disable-setuid-sandbox'] : []),
    ],
    ignoreDefaultArgs: ['--enable-automation'],
  };
  opts.executablePath = onRender ? chromium.executablePath() : CHROME_PATH;

  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, opts);
  // Runs before any page script so webdriver is never observable.
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  return ctx;
}

// On Render: injects Jobber cookies from the JOBBER_COOKIES env var (no display available).
// Locally: uses the persistent Chrome profile; prompts for interactive login if expired.
async function ensureLoggedIn(ctx) {
  if (process.env.RENDER) {
    if (!process.env.JOBBER_COOKIES) {
      throw new Error(
        'JOBBER_COOKIES env var is not set. ' +
        'Run "node scripts/export-jobber-cookies.js" locally and paste the output into Render.'
      );
    }
    const cookies = JSON.parse(process.env.JOBBER_COOKIES);
    await ctx.addCookies(cookies);
    console.log(`Injected ${cookies.length} Jobber cookies from JOBBER_COOKIES env var.`);
    return;
  }

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
  // Jobber shows two sections: "Collect payment with Jobber Payments" (charges the client)
  // and "Create a Payment Record" (records an already-received payment). Always use the latter.
  const createRecord = page.getByText('Create a Payment Record', { exact: false });
  if (await createRecord.count() > 0) {
    await createRecord.first().click();
    await page.waitForTimeout(400);
    console.log('  Switched to "Create a Payment Record" mode');
  }

  // Wait for any select to have options
  await page.waitForFunction(
    () => Array.from(document.querySelectorAll('select')).some(s => s.options.length > 1),
    { timeout: 15000 }
  ).catch(() => {});

  // Find the select that belongs to "Create a Payment Record":
  // it will have record-type options (Check, Cash, Other) that the Jobber Payments select won't.
  const allSelects = page.locator('select');
  const selectCount = await allSelects.count();
  let targetSelect = allSelects.last(); // fallback
  let opts = [];

  for (let i = 0; i < selectCount; i++) {
    const s = allSelects.nth(i);
    const sopts = await s.evaluate(el =>
      Array.from(el.options).map(o => ({ value: o.value, label: o.text.trim() })).filter(o => o.label)
    );
    if (sopts.some(o => /check|cash|other/i.test(o.label))) {
      targetSelect = s;
      opts = sopts;
      break;
    }
  }

  if (!opts.length) {
    opts = await targetSelect.evaluate(el =>
      Array.from(el.options).map(o => ({ value: o.value, label: o.text.trim() })).filter(o => o.label)
    );
  }

  console.log(`  Available payment options: ${opts.map(o => o.label).join(', ')}`);
  if (!opts.length) throw new Error('Payment method select has no options — form may not have loaded');

  const tl = type.toLowerCase().replace(/[\s_-]/g, '');
  const aliases = {
    ach:        ['ach', 'bank transfer', 'bank payment', 'bank', 'eft', 'electronic'],
    check:      ['check', 'cheque'],
    cash:       ['cash'],
    creditcard: ['credit card', 'credit', 'card'],
    other:      ['other'],
  };
  const candidates = aliases[tl] || [tl];

  let matchIdx = opts.findIndex(o => o.label.toLowerCase() === type.toLowerCase());
  if (matchIdx < 0) matchIdx = opts.findIndex(o => candidates.some(a => o.label.toLowerCase().includes(a)));

  if (matchIdx < 0) throw new Error(`No option matches "${type}". Available: ${opts.map(o => o.label).join(', ')}`);

  await targetSelect.selectOption({ index: matchIdx });
  console.log(`  Payment method: selected "${opts[matchIdx].label}"`);
}

async function fillReference(page, type, ref) {
  // Jobber uses floating labels (not placeholder attributes) for these fields.
  const pattern = type === 'ACH' ? /reference/i : /check/i;
  await page.getByLabel(pattern).fill(ref);
}

async function fillTransactionDate(page, date) {
  let month, day, year;
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(date)) {
    [month, day, year] = date.split('/');
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    [year, month, day] = date.split('-');
  } else {
    throw new Error(`Unrecognised date format: ${date}`);
  }

  // react-datepicker ignores programmatic .value assignment and resets on blur.
  // Typing character-by-character through the keyboard updates its internal
  // state correctly without needing to navigate calendar months.
  const field = page.getByLabel('Transaction Date');
  await field.click();
  await page.waitForTimeout(300);
  await page.keyboard.press('Control+a');
  await page.keyboard.type(`${month}/${day}/${year}`, { delay: 50 });
  await page.keyboard.press('Tab');
  await page.waitForTimeout(300);
}

// Click any currently-visible checkboxes for invoices we need.
// Returns the list of IDs that were found and clicked (or were already checked).
async function clickVisibleNeeded(page, needed, found) {
  const remaining = Array.from(needed).filter(id => !found.has(id));
  if (!remaining.length) return [];
  const clicked = await page.evaluate((ids) => {
    const done = [];
    for (const id of ids) {
      const link = document.querySelector(`a[href*="/invoices/${id}"]`);
      if (!link) continue;
      let el = link.parentElement;
      for (let k = 0; k < 12; k++) {
        const cb = el?.querySelector('input[type="checkbox"]');
        if (cb) { if (!cb.checked) cb.click(); done.push(id); break; }
        el = el?.parentElement;
      }
    }
    return done;
  }, remaining);
  for (const id of clicked) found.add(id);
  if (clicked.length) {
    console.log(`  Clicked: ${clicked.join(', ')} (${found.size}/${needed.size} found)`);
  }
  return clicked;
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

// Scroll the virtual invoice list and click each needed invoice's checkbox as it
// becomes visible. Jobber only renders a window of rows at a time; scrolling the
// last visible checkbox into view advances that window. We stop when all invoices
// are found or the bottom of the list is reached (detected by 3 stalled passes).
async function ensureInvoicesChecked(page, invoiceIds) {
  const needed = new Set(invoiceIds.map(String));
  const found = new Set();
  const paymentUrl = page.url();

  // Pass 0: click anything already visible without scrolling
  await clickVisibleNeeded(page, needed, found);
  if (found.size >= needed.size) return;

  let lastBottomHref = '';
  let stallCount = 0;

  for (let pass = 0; pass < 400 && found.size < needed.size; pass++) {
    // Scroll the bottommost visible checkbox into view to advance the virtual list
    const bottomHref = await page.evaluate(() => {
      const cbs = document.querySelectorAll('input[type="checkbox"]');
      if (!cbs.length) return null;
      cbs[cbs.length - 1].scrollIntoView({ behavior: 'instant', block: 'end' });
      // Return the bottom invoice href so we can detect when we've stopped moving
      let el = cbs[cbs.length - 1].parentElement;
      for (let i = 0; i < 12; i++) {
        const a = el?.querySelector('a[href*="/invoices/"]');
        if (a) return a.getAttribute('href');
        el = el?.parentElement;
      }
      return null;
    });

    await page.waitForTimeout(200);
    await clickVisibleNeeded(page, needed, found);

    if (bottomHref === lastBottomHref) {
      if (++stallCount >= 3) { console.log('  Reached bottom of invoice list'); break; }
    } else {
      stallCount = 0;
      lastBottomHref = bottomHref || '';
    }

    if (page.url() !== paymentUrl) {
      console.log('  SPA navigated away — returning to payment page');
      await page.goto(paymentUrl, { waitUntil: 'load' });
      await page.waitForSelector('select, input[type="text"]', { timeout: 30000 });
      await page.waitForTimeout(1000);
    }
  }

  const missing = invoiceIds.filter(id => !found.has(String(id)));
  if (missing.length > 0) {
    console.log(`\n  Could not find: ${missing.join(', ')} — dumping visible rows:`);
    await dumpCheckboxRows(page);
    throw new Error(`Could not identify checkboxes for: ${missing.join(', ')}`);
  }
}

async function clickSubmit(page) {
  // Regex anchor ensures we match "Save" but not "Save and Email Receipt".
  const button = page.locator('button').filter({ hasText: /^\s*Save\s*$/ });
  await button.click();
  // Jobber's SPA keeps background connections open so networkidle never fires; 'load' is sufficient.
  await page.waitForLoadState('load');
}

// Fills and optionally submits one Jobber payment form for a single batch of invoices.
// The caller is responsible for opening and closing the page.
async function applyJobberPaymentBatch(page, { clientId, invoiceIds, type, ref, date, submit, navigateOnly }) {
  const url = buildPaymentUrl({ clientId, invoiceIds });
  console.log(`Navigating to ${url}`);
  await page.goto(url, { waitUntil: 'load' });
  // SPA may continue rendering after load — wait for the form's first interactive element.
  await page.waitForSelector('select, input[type="text"], input[type="date"]', { timeout: 30000 });
  // Wait for the sticky list header so checkbox indices are stable before we count them.
  await page.waitForSelector('[data-testid="ATL-DataList-stickyHeader"]', { timeout: 15000 })
    .catch(() => {});

  if (/\/login|\/sign_in|\/users\/sign_in/.test(page.url())) {
    throw new Error(`Redirected to login (${page.url()}) — session was not persisted.`);
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

  // Split into batches of BATCH_SIZE — Jobber rejects payment applications with more than 50 invoices.
  const batches = [];
  for (let i = 0; i < invoiceIds.length; i += BATCH_SIZE) {
    batches.push(invoiceIds.slice(i, i + BATCH_SIZE));
  }
  if (batches.length > 1) {
    console.log(`${invoiceIds.length} invoices → ${batches.length} batches of up to ${BATCH_SIZE}`);
  }

  // CDP mode: attach to an already-running Chrome so Cloudflare sees a real,
  // previously-validated browser rather than a freshly-launched automation process.
  const cdpUrl = process.env.CHROME_CDP_URL;
  if (cdpUrl) {
    console.log(`Connecting to Chrome via CDP at ${cdpUrl}...`);
    const browser = await chromium.connectOverCDP(cdpUrl);
    const ctx = browser.contexts()[0];
    if (!ctx) throw new Error('No browser context found — is Chrome open with a Jobber tab?');
    try {
      for (let i = 0; i < batches.length; i++) {
        const batch = batches[i];
        const isLast = i === batches.length - 1;
        if (batches.length > 1) console.log(`\n=== Batch ${i + 1} of ${batches.length} (${batch.length} invoices) ===`);
        const page = await ctx.newPage();
        let leaveOpen = false;
        try {
          await applyJobberPaymentBatch(page, { clientId, invoiceIds: batch, type, ref, date, submit, navigateOnly });
          if (submit && isLast) {
            leaveOpen = true;
            console.log('Jobber confirmation page left open in Chrome.');
          }
        } finally {
          if (!leaveOpen) await page.close();
        }
      }
    } finally {
      await browser.close(); // disconnects Playwright without closing Chrome
    }
    return;
  }

  // Normal mode: launch a new Chrome/Chromium instance.
  const ctx = await launchStealthContext(headless);
  try {
    await ensureLoggedIn(ctx);

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      if (batches.length > 1) {
        console.log(`\n=== Batch ${i + 1} of ${batches.length} (${batch.length} invoices) ===`);
      }
      const page = await ctx.newPage();
      try {
        await applyJobberPaymentBatch(page, { clientId, invoiceIds: batch, type, ref, date, submit, navigateOnly });
      } finally {
        await page.close();
      }
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
