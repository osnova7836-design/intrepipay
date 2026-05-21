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
  // ASCENDING puts oldest-due-date invoices first. Insurance checks typically cover
  // older outstanding invoices, so they land near the top rather than buried below
  // newer ones. Chrome tab crashes if the list grows beyond ~250 rows.
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

// Scroll through Jobber's invoice list and click each needed checkbox as it
// comes into view. Runs entirely inside ONE page.evaluate() call so there is
// only one V8 Zone allocation — the per-invoice loop approach made hundreds of
// separate evaluate() calls which exhausted Zone memory and crashed Chrome.
async function ensureInvoicesChecked(page, invoiceIds, { type, ref } = {}) {
  const paymentUrl = page.url();
  let clicked = [], skipped = invoiceIds.map(String), debug = null;

  for (let attempt = 1; attempt <= 2; attempt++) {
    if (attempt === 2) {
      // Navigated away mid-evaluate — go back, re-fill form, and try once more.
      const badUrl = page.url();
      console.log(`  Page navigated to ${badUrl} — reloading payment form for retry`);
      await page.goto(paymentUrl, { waitUntil: 'load' });
      await page.waitForSelector('select, input[type="text"], input[type="date"]', { timeout: 30000 });
      await page.waitForSelector('[data-testid="ATL-DataList-stickyHeader"]', { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(2000);
      if (type) await selectPaymentMethod(page, type);
      if (ref && type) await fillReference(page, type, ref);
    }

    ({ clicked, skipped, debug } = await page.evaluate(async ({ ids }) => {
    const needed = new Set(ids);
    const clicked = [];

    function tryClickVisible() {
      for (const id of needed) {
        if (clicked.includes(id)) continue;
        const link = document.querySelector(`a[href*="/invoices/${id}"]`);
        if (!link) continue;
        let el = link.parentElement;
        for (let k = 0; k < 12; k++) {
          const cb = el?.querySelector('input[type="checkbox"]');
          if (cb) { if (!cb.checked) cb.click(); clicked.push(id); break; }
          el = el?.parentElement;
        }
      }
    }

    // Find the scrollable container for Jobber's invoice list (virtual/windowed list).
    // Walking up from the sticky header is most reliable; fall back to checkbox parent.
    function getScrollContainer() {
      const header = document.querySelector('[data-testid="ATL-DataList-stickyHeader"]');
      if (header) {
        let el = header.parentElement;
        for (let i = 0; i < 12; i++) {
          if (!el || el === document.body) break;
          if (el.scrollHeight > el.clientHeight + 50) return el;
          el = el.parentElement;
        }
      }
      const cb = document.querySelector('input[type="checkbox"]');
      if (cb) {
        let el = cb.parentElement;
        for (let i = 0; i < 20; i++) {
          if (!el || el === document.body) break;
          const s = window.getComputedStyle(el);
          if ((s.overflowY === 'auto' || s.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 10) return el;
          el = el.parentElement;
        }
      }
      return document.scrollingElement || document.body;
    }

    function getScrollTop(c) {
      return (c === document.scrollingElement || c === document.body)
        ? (window.scrollY || document.documentElement.scrollTop)
        : c.scrollTop;
    }

    function scrollDown(c) {
      if (c === document.scrollingElement || c === document.body) {
        window.scrollBy(0, 600);
      } else {
        c.scrollTop += 600;
        // No dispatchEvent — setting scrollTop already fires a native scroll event
        // on the element. A bubbling synthetic event can accidentally hit Jobber's
        // router and trigger a page navigation mid-evaluate.
      }
    }

    // Wait up to 5s for the invoice list to render its first rows
    await new Promise(r => {
      const start = Date.now();
      (function check() {
        if (document.querySelectorAll('input[type="checkbox"]').length > 0) r();
        else if (Date.now() - start < 5000) setTimeout(check, 200);
        else r();
      })();
    });

    tryClickVisible();

    if (clicked.length < ids.length) {
      const container = getScrollContainer();
      let stableCount = 0;
      let lastScrollTop = -1;

      // Scroll until all found, or scroll position stops changing (end of list).
      // Up to 150 iterations × 700ms ≈ 105s max. Stops early when all clicked.
      for (let iter = 0; iter < 150 && clicked.length < ids.length; iter++) {
        const top = getScrollTop(container);
        if (top === lastScrollTop) {
          stableCount++;
          if (stableCount >= 3) break;
        } else {
          stableCount = 0;
        }
        lastScrollTop = top;
        scrollDown(container);
        await new Promise(r => setTimeout(r, 700));
        tryClickVisible();
      }
    }

    const skipped = ids.filter(id => !clicked.includes(id));
    const debug = clicked.length < ids.length ? {
      cbCount: document.querySelectorAll('input[type="checkbox"]').length,
      invoiceLinks: Array.from(document.querySelectorAll('a[href*="/invoices/"]')).slice(0, 8).map(a => a.getAttribute('href')),
      pageUrl: window.location.href,
    } : null;
    return { clicked, skipped, debug };
    }, { ids: invoiceIds.map(String) }).catch(err => {
      console.log(`  evaluate interrupted (${err.message.slice(0, 80)})`);
      return { clicked: [], skipped: invoiceIds.map(String), debug: null };
    }));

    console.log(`  Clicked ${clicked.length}/${invoiceIds.length} invoices${attempt > 1 ? ` (attempt ${attempt})` : ''}`);

    if (clicked.length > 0) break;
    if (attempt === 2) break; // no more retries
    // If page didn't navigate away, a retry won't help — bail early
    if (page.url() === paymentUrl) break;
  }

  if (skipped.length && skipped.length < invoiceIds.length) {
    console.log(`  Skipped ${skipped.length} (beyond list or already paid):`);
    skipped.forEach(id => console.log(`    - ${id}`));
  }

  if (clicked.length === 0) {
    if (debug) {
      console.log(`  DEBUG cbCount=${debug.cbCount}`);
      console.log(`  DEBUG pageUrl=${debug.pageUrl}`);
      console.log(`  DEBUG invoiceLinks (first 8): ${JSON.stringify(debug.invoiceLinks)}`);
    }
    throw new Error('No invoices found in the payment form — aborting.');
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
  await ensureInvoicesChecked(page, invoiceIds, { type, ref });

  // Scroll back to the top so the Transaction Date field is already in view —
  // Playwright scrolling it into view through a large invoice DOM crashes Chrome.
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await page.waitForTimeout(1500);

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
        // Give Jobber time to finish processing and Chrome time to GC the previous
        // tab's DOM before opening the next batch.
        if (!isLast) await new Promise(r => setTimeout(r, 10000));
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
