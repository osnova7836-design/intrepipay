// Ycheten — QBO sync-error backlog scanner (Phase 1: read-only scan + categorize + recommend).
//
// Jobber's own QuickBooks Online Integration sync log
// (https://qbo-integration.getjobber.com/qbo-integration) has a large,
// self-replenishing backlog of old historical records that have never synced
// to QBO. Found live 2026-10-06 while chasing two Rely payments — see
// project-qbo-sync-error-backlog.md in memory for the full incident history.
//
// Six root-cause categories were mapped and confirmed live that night:
//   1. COLLISION_INVOICE  — "Invoice number already exists in QuickBooks."
//      Could be a genuine DUPLICATE (same real transaction independently
//      recorded in both systems — confirmed cases had matching client+amount,
//      sometimes exact property address) or a coincidental collision between
//      two DIFFERENT transactions (confirmed cases had different client
//      and/or different amount). These need opposite fixes, so this script
//      never guesses — it reports both sides' details side by side and lets
//      a human decide (see buildCollisionReportLine below).
//   2. COLLISION_CLIENT   — "Client display name already exists in
//      QuickBooks." Same duplicate-name problem at the client level.
//   3. APOSTROPHE_BUG     — Jobber's own sync code throws a QueryParserError
//      on a literal apostrophe in a client name (e.g. "D'amico"). Not a
//      collision — a real parsing bug. Already patched for NEW Jobber
//      clients going forward (osnova-tbplumbing/jobberApi.js splitName()),
//      but existing broken clients need a one-off rename (apostrophe→space).
//   4. CLOSED_PERIOD      — "Accounting period closed in QuickBooks." Benign
//      per Jobber's own guidance: the underlying payment still syncs fine;
//      only the invoice-level update to a closed period fails. Safe to
//      Ignore.
//   5. BAD_DEBT_AMOUNT    — "Business Validation Error: Enter a transaction
//      amount that is 0 or greater" (code 6000). Caused by a bad-debt
//      write-off producing a negative/invalid total. Safe to Ignore IF the
//      invoice is genuinely marked bad debt in Jobber — this script flags it
//      for a quick human confirm rather than assuming.
//   6. CASCADING_DEPENDENT — a payment/payout/invoice errors only because
//      something it depends on (its own invoice, its own client) hasn't
//      synced yet. These clear automatically once the root cause is fixed —
//      no separate action, but worth not double-reporting as "new" work.
//
// CRITICAL SAFETY RULE (confirmed live incident, 2026-10-06 — see
// feedback-never-exceed-jobber-invoice-max.md): Jobber's own invoice-number
// auto-sequencing continues from whatever the highest number in the system
// is, even if a script put it there. This scanner NEVER writes anything —
// it is Phase 1, read-only, full stop. Any renumbering must go through
// Phase 2 (not yet built) which hard-codes a check against the real current
// max before ever touching a Jobber invoice number, and prefers fixing the
// QBO side (alphanumeric "-1" suffix) instead whenever the collision is a
// genuine different-transaction case.
//
// The error list is known to under-report on the first read after a
// retry/navigate — Jobber processes the sync queue in waves, and the true
// count only stabilizes after several seconds. This scanner polls until two
// consecutive reads agree before treating the list as final (confirmed
// pattern 2026-10-06: 29 → 2 (false) → 14 → 16 → 17 → 18 → 3 (false) → 5 →
// 12, never trust an immediate low number).
//
// Usage:
//   node scripts/qb-sync-errors-scan.js [--max-items N]
//
// Output: console summary + a full JSON report at
//   .qb-agent/qb-sync-errors-scan-<timestamp>.json

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const fetch = require('node-fetch');

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PROFILE_DIR = 'D:\\chrome-qb-profile';
const QB_AGENT_DIR = path.join(__dirname, '..', '.qb-agent');
// Navigating straight to this URL lands on Jobber's generic "App
// Marketplace" listing page for the integration (Manage App/Disconnect/
// marketing copy), NOT the real Sync Activity dashboard — confirmed live
// 2026-10-06 (a direct page.goto() here even triggered Jobber's own
// error-boundary page once). The dashboard only loads correctly when reached
// by clicking through Jobber's own UI: the alert-bell icon in the main app's
// top bar, then the "QuickBooks Online Integration has N alerts" link inside
// it, which opens the real dashboard in a NEW TAB. navigateToSyncActivity()
// below reproduces that exact path instead of a bare goto().
const SYNC_URL = 'https://qbo-integration.getjobber.com/qbo-integration';
const JOBBER_APP_URL = 'https://secure.getjobber.com/invoices';
const JOBBER_GRAPHQL_URL = 'https://api.getjobber.com/api/graphql';
const TOKEN_FILE = path.join(__dirname, '../tokens.json');
const TOKEN_URL = 'https://api.getjobber.com/api/oauth/token';

// ---------- CLI args ----------

function parseArgs(argv) {
  const args = { maxItems: 200 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--max-items') args.maxItems = parseInt(argv[++i], 10);
  }
  return args;
}

// ---------- Logging ----------

let LOG_PATH;
function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.join(' ')}`;
  console.log(line);
  if (LOG_PATH) fs.appendFileSync(LOG_PATH, line + '\n');
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ---------- Jobber GraphQL (for cross-referencing invoice/client details) ----------

async function getJobberToken() {
  let store = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
  if (Date.now() > store.expires_at - 60000) {
    const resp = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: process.env.JOBBER_CLIENT_ID,
        client_secret: process.env.JOBBER_CLIENT_SECRET,
        refresh_token: store.refresh_token,
      }),
    });
    const data = await resp.json();
    if (!data.access_token) throw new Error('Jobber token refresh failed: ' + JSON.stringify(data));
    store = { access_token: data.access_token, refresh_token: data.refresh_token, expires_at: Date.now() + (data.expires_in || 3600) * 1000 };
    fs.writeFileSync(TOKEN_FILE, JSON.stringify(store));
  }
  return store.access_token;
}

async function gql(token, query, attempt = 0) {
  const resp = await fetch(JOBBER_GRAPHQL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-JOBBER-GRAPHQL-VERSION': '2025-04-16' },
    body: JSON.stringify({ query }),
  });
  const data = await resp.json();
  if (data.errors?.some((e) => e.extensions?.code === 'THROTTLED') && attempt < 4) {
    await sleep(8000);
    return gql(token, query, attempt + 1);
  }
  return data;
}

async function getJobberInvoiceByNumber(token, invoiceNumber) {
  const q = `{ invoices(searchTerm: ${JSON.stringify(invoiceNumber)}, first: 10) {
    nodes { id invoiceNumber issuedDate amounts { total } client { name }
      properties(first: 1) { nodes { address { street1 city province } } }
      lineItems(first: 5) { nodes { name unitPrice quantity } } }
  } }`;
  const data = await gql(token, q);
  if (data.errors) return { error: data.errors.map((e) => e.message).join(', ') };
  const exact = (data.data?.invoices?.nodes || []).find((n) => n.invoiceNumber === invoiceNumber);
  return { invoice: exact || null };
}

// Used for COLLISION_CLIENT — confirmed live 2026-10-06 (Eric Sharkey) that
// comparing email/phone against the QBO side is the only reliable way to
// tell "same real person, needs matching/linking" from "two different
// people who happen to share a name, needs disambiguation" before deciding
// anything — see the COLLISION_CLIENT note on RECOMMENDED_ACTION above.
async function getJobberClientByName(token, name) {
  const q = `{ clients(searchTerm: ${JSON.stringify(name)}, first: 5) {
    nodes { id name emails { address } phones { number } }
  } }`;
  const data = await gql(token, q);
  if (data.errors) return { error: data.errors.map((e) => e.message).join(', ') };
  const exact = (data.data?.clients?.nodes || []).find((n) => n.name === name);
  return { client: exact || (data.data?.clients?.nodes || [])[0] || null };
}

// ---------- Category detection ----------
// Matched against the FULL page text captured while the detail modal is
// open — not an isolated "heading" extraction. A heading-only regex (first
// "Error\n{text}" match in the page) was tried first but proved unreliable:
// the background item list stays in the DOM behind the modal and contains
// many of its own "Error" status badges, so a positional "first match" grabs
// text from the list, not the modal, as often as not (confirmed live
// 2026-10-06). Each pattern below is a distinctive phrase from the modal's
// own body copy that doesn't otherwise appear on the list page, so matching
// against the whole captured text is robust regardless of where exactly the
// modal's text lands relative to the list's.
const CATEGORY_RULES = [
  { category: 'COLLISION_INVOICE', test: (text) => /invoice number already (exists|in use)/i.test(text) },
  { category: 'COLLISION_CLIENT', test: (text) => /client (display name )?already exists/i.test(text) },
  { category: 'APOSTROPHE_BUG', test: (text) => /queryparsererror/i.test(text) },
  { category: 'CLOSED_PERIOD', test: (text) => /accounting period closed/i.test(text) },
  { category: 'BAD_DEBT_AMOUNT', test: (text) => /business validation error/i.test(text) && /amount.*0 or greater/i.test(text) },
  { category: 'CASCADING_DEPENDENT', test: (text) => /not been synced to quickbooks|missing invoice|payment\(s\) not found|bulk payment invoices not synced/i.test(text) },
];

function categorize(fullText) {
  const text = fullText || '';
  for (const rule of CATEGORY_RULES) {
    if (rule.test(text)) return rule.category;
  }
  return 'UNKNOWN';
}

const RECOMMENDED_ACTION = {
  COLLISION_INVOICE: null, // decided per-item below, once Jobber vs QBO details are compared
  // Confirmed live 2026-10-06 (Eric Sharkey case): NEVER rename the Jobber
  // client — Nova matches incoming warranty-company jobs to existing
  // clients by name, so renaming breaks future job matching and splits
  // the same real person's history across two client records (Os caught
  // this). Check email/phone/address first: if it's the same real person
  // already in both systems, the fix is a Jobber-side "Match to existing
  // QuickBooks customer" action if offered (links the two records, no
  // rename anywhere), or Ignore as a safe fallback. Only consider renaming
  // the QBO side — mirroring the invoice-collision pattern — if the
  // identifying details show these are genuinely two different people.
  COLLISION_CLIENT: 'INVESTIGATE — compare email/phone/address on both sides. Same person: use "Match to existing QuickBooks customer" in Jobber if offered, else Ignore. Different people: rename the QBO side only. NEVER rename the Jobber client (breaks future job matching).',
  APOSTROPHE_BUG: 'FIX — rename the Jobber client, replacing the apostrophe with a space (one-off); confirm Nova\'s splitName() fix is deployed so this stops recurring',
  CLOSED_PERIOD: 'IGNORE — benign, the underlying payment still syncs fine',
  BAD_DEBT_AMOUNT: 'IGNORE (confirm bad debt first) — check the invoice is genuinely marked bad debt in Jobber before ignoring',
  CASCADING_DEPENDENT: 'NO ACTION — will clear automatically once its root cause (own invoice/client) is fixed',
  UNKNOWN: 'INVESTIGATE — does not match any known pattern, needs a human look',
};

// Extracts the invoice number from an item label like "#18066 for Rely Home
// - CHW/HWA/HSC" or "Invoice - #18066 for Rely Home - CHW/HWA/HSC".
function extractInvoiceNumber(itemLabel) {
  const m = /#(\d+)/.exec(itemLabel || '');
  return m ? m[1] : null;
}

// ---------- Collision classification ----------
// Compares Jobber's own invoice (client/amount/address) against whatever
// detail Jobber's error panel shows about the conflicting QBO invoice (it
// embeds the QBO invoice number as a link, but not its client/amount — that
// has to come from the Jobber-side invoice at the SAME number, since the
// error means Jobber doesn't have two; it's QBO holding the OTHER one. This
// script can only compare confidently when it can also read the QBO side —
// left as a manual step for now (open the "View in QuickBooks" link printed
// in the report) rather than scraping QBO's invoice page, which has no
// stable selectors tested yet. Future Phase 1.5: automate that read too.

function buildCollisionReportLine(jobberInvoice, qboLink) {
  if (!jobberInvoice) {
    return { note: 'Jobber invoice detail not found via search — check manually', qboLink };
  }
  const addr = jobberInvoice.properties?.nodes?.[0]?.address;
  return {
    jobberSide: {
      invoiceNumber: jobberInvoice.invoiceNumber,
      client: jobberInvoice.client?.name,
      total: jobberInvoice.amounts?.total,
      issuedDate: jobberInvoice.issuedDate,
      address: addr ? `${addr.street1}, ${addr.city}, ${addr.province}` : null,
      lineItems: (jobberInvoice.lineItems?.nodes || []).map((li) => `${li.name} x${li.quantity} @ $${li.unitPrice}`),
    },
    qboLink,
    note: 'Compare against the QBO invoice at this link: same client+amount+address = genuine DUPLICATE (Ignore); different = different transaction (QBO-side "-1" rename, see feedback)',
  };
}

// ---------- QBO-side lookups (auto duplicate-vs-different verdict) ----------
// Confirmed live 2026-10-06: scraping the QBO web UI with Playwright hit
// three separate timing bugs in one night (stale-draft loads showing the
// wrong invoice, SPA render races needing 30-60s/item, networkidle never
// resolving). Replaced entirely with the real QuickBooks API via the
// deployed intrepipay-app server's OAuth connection (one-time setup done
// live 2026-10-06 — see scripts/qbo-api.js) — same data, under a second.
const { getQboInvoice, getQboCustomer } = require('./qbo-api');

function fuzzyNameMatch(a, b) {
  if (!a || !b) return false;
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const na = norm(a);
  const nb = norm(b);
  return na.includes(nb) || nb.includes(na);
}

function verdictInvoiceCollision(jobberSide, qboSide) {
  if (!qboSide || qboSide.error) return { verdict: 'UNKNOWN', reason: `could not read QBO invoice: ${qboSide?.error || 'no data'}` };
  const amountsClose = jobberSide.total != null && qboSide.total != null && Math.abs(jobberSide.total - qboSide.total) < 0.01;
  const namesMatch = fuzzyNameMatch(jobberSide.client, qboSide.customer);
  if (amountsClose && namesMatch) {
    return { verdict: 'DUPLICATE', reason: `same client ("${qboSide.customer}") and amount ($${qboSide.total}) on both sides — safe to Ignore in Jobber` };
  }
  return {
    verdict: 'DIFFERENT',
    reason: `QBO #${jobberSide.invoiceNumber} is "${qboSide.customer}" for $${qboSide.total} vs Jobber's "${jobberSide.client}" for $${jobberSide.total} — different transaction, rename the QBO-side number with a "-1" suffix (never touch the record itself, just its number)`,
  };
}

// ---------- Playwright: scan the sync-errors page ----------

// Reproduces the exact click path confirmed live 2026-10-06: open the main
// Jobber app, click the alert-bell icon (shows an "App Alerts" panel with a
// red badge count), click the "QuickBooks Online Integration has N alerts"
// link inside it, which opens the real Sync Activity dashboard in a NEW TAB.
// Returns that new tab's Page — the caller should use it for everything
// else, not the original `page`.
async function navigateToSyncActivity(context, page) {
  await page.goto(JOBBER_APP_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  // Confirmed live 2026-10-06 via devtools (Os pasted the real element): the
  // bell icon's actual aria-label is "Open App Alerts" — a plain page.evaluate
  // dump of the un-clicked button missed it (possibly only reads reliably
  // once focused/rendered in its interactive state), which is why earlier
  // guesses ("App Alerts", missing-aria-label heuristics, an absolute XPath)
  // all had to be tried first. This is the clean, idiomatic selector.
  const bell = page.getByRole('button', { name: 'Open App Alerts' });
  await bell.waitFor({ state: 'visible', timeout: 20000 });
  await bell.click();
  await page.waitForTimeout(1000);

  const alertLink = page.getByText(/quickbooks online integration has \d+ alerts?/i).first();
  await alertLink.waitFor({ state: 'visible', timeout: 10000 });

  const [newPage] = await Promise.all([
    context.waitForEvent('page', { timeout: 30000 }),
    alertLink.click(),
  ]);
  await newPage.waitForLoadState('domcontentloaded', { timeout: 30000 });
  await newPage.waitForTimeout(2000);
  return newPage;
}

async function ensureLoggedIn(page) {
  // Jobber's own app, not QBO — simpler login flow, but still never enter
  // credentials from a script per the standing rule. The heading renders
  // visually as "SYNC ACTIVITY" but that's CSS text-transform — the real DOM
  // text is mixed-case "Sync Activity", confirmed live 2026-10-06 (a
  // case-sensitive match on the all-caps string never found it even with
  // the real page loaded and visible).
  const heading = page.getByText(/sync activity/i).first();
  const isUp = await heading.isVisible().catch(() => false);
  if (isUp) return;
  log('  Not on the sync-activity page yet (login?) — waiting for you (up to 3 minutes)...');
  for (let i = 0; i < 60; i++) {
    if (await heading.isVisible().catch(() => false)) {
      log('  Sync activity page loaded — continuing.');
      return;
    }
    await page.waitForTimeout(3000);
  }
  throw new Error('Still not on the sync-activity page after 3 minutes.');
}

// Reads the current error count. Returns null if the page hasn't finished
// loading yet (skeleton placeholders still showing).
async function readErrorCount(page) {
  const text = await page.locator('body').innerText();
  const m = /Errors\s*\n?\s*(\d+)/.exec(text);
  if (!m) return null;
  // "No items" with Errors: 0 is only trustworthy once the table itself has
  // rendered real rows or genuinely says "No items" — a bare skeleton can
  // also show stale 0s mid-load. Confirmed live 2026-10-06: wait for either
  // "No items" text or at least one real row before accepting a 0.
  if (parseInt(m[1], 10) === 0 && !/No items/.test(text)) return null;
  return parseInt(m[1], 10);
}

// Polls until two consecutive reads agree — the fix for the "never trust an
// immediate 0 / low number" pattern confirmed live 2026-10-06. Deliberately
// does NOT call page.reload() between reads — this exact page is known to
// hang on navigation/reload (confirmed independently both by hand earlier
// tonight and by this script's own first attempts), so this just re-reads
// the already-loaded page's text repeatedly instead, same as what actually
// worked manually.
async function waitForStableErrorCount(page, { maxWaitMs = 60000, pollMs = 4000 } = {}) {
  let last = null;
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    await page.waitForTimeout(pollMs);
    const count = await readErrorCount(page);
    log(`  error count read: ${count === null ? '(still loading)' : count}`);
    if (count !== null && count === last) return count;
    last = count;
  }
  log(`  WARNING: error count did not stabilize within ${maxWaitMs}ms — proceeding with last read (${last})`);
  return last;
}

// Jobber's per-page control is a native <select> near "per page" text — not
// yet confirmed via live DOM inspection with Playwright's own selectors
// (tonight's session only drove this page by screen coordinates). Falls back
// silently to the default page size (10) with a warning if this doesn't
// work — scanAllErrors's text-based parsing below still works correctly
// either way, just needs more pagination passes.
async function setPageSize(page, size) {
  try {
    await page.selectOption('select', String(size), { timeout: 3000 });
  } catch {
    log(`  (could not set page size to ${size} — will paginate instead)`);
  }
}

// Reads the full visible item list from the page's own text — confirmed
// reliable all night via get_page_text, unlike the table's internal DOM
// structure (never inspected live with Playwright's own selectors). Opens
// each item's detail by exact visible text match, which doesn't depend on
// the table's internal structure at all.
// Confirmed live 2026-10-06: the detail panel is a real `role="dialog"`
// overlay (aria-labelledby="ATL-Modal-Header"), and its ONLY close
// control is a single icon button with aria-label "Close modal" (no
// visible text) — confirmed to be the one and only "close"-matching
// button on the whole page, so it's not a wrong-element problem. The
// real failure mode: closeBtn.click() was silently swallowed by a
// .catch() with no verification, so a dialog could stay open and then
// silently eat the next item's click (Playwright even showed it directly:
// "<dialog> subtree intercepts pointer events"). This helper actually
// verifies the dialog is gone from the DOM before returning, retrying
// the close click up to 4 times. Shared between the scanner and the
// fixer (qb-sync-errors-fix.js) — both open/close the same detail modal.
async function closeAnyOpenDialog(page) {
  const dialogLocator = page.locator('[role="dialog"]');
  for (let i = 0; i < 4; i++) {
    const count = await dialogLocator.count().catch(() => 0);
    if (count === 0) return true;
    const closeBtn = page.getByRole('button', { name: /close modal|^close$|×|✕/i }).first();
    if (await closeBtn.count().catch(() => 0)) {
      await closeBtn.click({ timeout: 5000 }).catch(() => {});
    } else {
      await page.keyboard.press('Escape').catch(() => {});
    }
    await page.waitForTimeout(700);
  }
  return (await dialogLocator.count().catch(() => 0)) === 0;
}

async function scanAllErrors(page, maxItems, expectedCount = 0) {
  await setPageSize(page, 50);
  await page.waitForTimeout(1500);

  // Each data row is exactly 3 non-blank lines once blank lines are
  // filtered out (confirmed live 2026-10-06 via a direct innerText dump):
  //   1. "{item label}\t{Type}"  — item label and type share ONE line,
  //      tab-separated (NOT two separate lines, as first assumed — innerText
  //      only breaks on \n, and the table cell gap renders as \t)
  //   2. "Error" or "Waiting to sync"
  //   3. the "Synced at" timestamp, e.g. "2026/10/06 1:37pm"
  function parseItems(bodyText) {
    const lines = bodyText.split('\n').map((l) => l.trim()).filter(Boolean);
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i] !== 'Error' && lines[i] !== 'Waiting to sync') continue;
      const labelLine = lines[i - 1] || '';
      const parts = labelLine.split('\t').map((s) => s.trim()).filter(Boolean);
      if (parts.length < 2) continue;
      const type = parts[parts.length - 1];
      if (!['Invoice', 'Client', 'Payment', 'Payout'].includes(type)) continue;
      const label = parts.slice(0, -1).join(' ').trim();
      if (label) out.push({ label, type, status: lines[i] });
    }
    return out;
  }

  // The list is known to under-report right after the 50-per-page switch
  // (same under-report-on-load pattern confirmed for the bell badge count)
  // — confirmed live 2026-10-06 when a 12-error page parsed only 10 items
  // on the first read. Retry until the parse matches the known stable
  // error count, instead of trusting the first read.
  let items = parseItems(await page.locator('body').innerText());
  for (let i = 0; i < 5 && expectedCount && items.length < expectedCount; i++) {
    log(`  parsed ${items.length}/${expectedCount} item(s) — list may still be rendering, re-reading...`);
    await page.waitForTimeout(1500);
    items = parseItems(await page.locator('body').innerText());
  }

  log(`  parsed ${items.length} item(s) from the visible list (status Error or Waiting to sync)`);

  const seen = new Set();
  const errorsOnly = items.filter((it) => it.status === 'Error' && !seen.has(it.label) && seen.add(it.label));

  const jobberToken = await getJobberToken();
  const report = [];

  // Confirmed live 2026-10-06: "How to fix the error" IS present in every
  // category's detail panel (verified directly on a #9482 collision item
  // that the marker-based check below had wrongly flagged as "not open" —
  // the modal content is appended at the END of body.innerText, after the
  // list's own "per page" footer, so body grew from 1003 -> 1595 chars even
  // though the marker check failed). The real cause of flakiness was
  // click-to-open timing in a tight loop, not a missing marker. Detection
  // now keys off body TEXT LENGTH GROWTH (robust across every category)
  // instead of one specific phrase, with more retries and a longer settle
  // wait so a slow-closing previous modal doesn't swallow the next click.
  const modalOpenMarker = page.getByText('How to fix the error', { exact: false }).first();
  const dialogLocator = page.locator('[role="dialog"]');

  for (const item of errorsOnly.slice(0, maxItems)) {
    // Defensive pre-check — never attempt a new row click while a dialog
    // from a previous item (successfully closed or not) is still around.
    const preStillOpen = !(await closeAnyOpenDialog(page));
    if (preStillOpen) log(`  WARNING: a dialog was still open before "${item.label}" — forced closed as best-effort`);

    log(`Opening: ${item.label} (${item.type})`);
    let detail = { heading: null, body: null, qboLink: null };
    try {
      const baselineLength = (await page.locator('body').innerText().catch(() => '')).length;
      const rowText = page.getByText(item.label, { exact: false }).first();
      let opened = false;
      let modalText = '';
      for (let attempt = 0; attempt < 3 && !opened; attempt++) {
        if (attempt > 0) {
          // A previous click may have left a stuck overlay — clear it
          // before retrying instead of just clicking blindly again.
          await closeAnyOpenDialog(page);
          await page.waitForTimeout(500);
        }
        await rowText.click({ timeout: 10000 });
        await page.waitForTimeout(1200 + attempt * 800);
        const dialogCount = await dialogLocator.count().catch(() => 0);
        modalText = await page.locator('body').innerText().catch(() => '');
        opened = dialogCount > 0 && modalText.length > baselineLength + 150;
        if (!opened) {
          log(`  attempt ${attempt + 1}: dialogCount=${dialogCount}, body length ${modalText.length} vs baseline ${baselineLength} — modal not detected. Tail: ${JSON.stringify(modalText.slice(-200))}`);
        }
      }
      if (!opened) throw new Error(`detail modal did not open after 3 click attempts (baseline ${baselineLength})`);
      // Heading = the bolded error-type line right after an "Error" badge,
      // e.g. "Invoice number already exists in QuickBooks" — display only,
      // NOT used for categorization (see categorize() above). The
      // background item list stays in the DOM behind the modal and has its
      // own "Error" badges, so the FIRST "Error\n{text}" match in the page
      // is usually the list's, not the modal's; the modal (an overlay
      // appended later in the DOM) tends to produce the LAST match instead.
      // Best-effort only — categorization doesn't depend on getting this
      // right, so a wrong display string here doesn't cause a misclassify.
      const headingMatches = [...modalText.matchAll(/Error\s*\n([^\n]+)\n/g)];
      detail.heading = headingMatches.length ? headingMatches[headingMatches.length - 1][1].trim() : null;
      detail.body = modalText;
      // "View in QuickBooks" / embedded "Invoice #XXXXX" links — capture
      // the href of any link whose text matches, for the human to open.
      const qboLinkLoc = page.getByRole('link', { name: /view in quickbooks|invoice #\d+|^#\d+$/i }).first();
      if (await qboLinkLoc.count()) {
        detail.qboLink = await qboLinkLoc.getAttribute('href').catch(() => null);
      }
      // Close the modal and CONFIRM it's actually gone from the DOM
      // (dialogLocator.count() === 0) before moving to the next item.
      const closedOk = await closeAnyOpenDialog(page);
      if (!closedOk) log(`  WARNING: modal for "${item.label}" would not close after 4 attempts`);
    } catch (err) {
      log(`  could not open detail for "${item.label}": ${err.message}`);
    }

    const category = categorize(detail.body);
    const entry = { item: item.label, type: item.type, heading: detail.heading, category, qboLink: detail.qboLink };

    if (category === 'COLLISION_INVOICE') {
      const invNum = extractInvoiceNumber(item.label);
      if (invNum) {
        const { invoice, error } = await getJobberInvoiceByNumber(jobberToken, invNum);
        await sleep(300);
        entry.collision = buildCollisionReportLine(invoice, detail.qboLink);
        if (error) entry.collision.jobberLookupError = error;
        if (invoice && detail.qboLink) {
          log(`  checking QBO side for #${invNum}...`);
          const qboSide = await getQboInvoice(detail.qboLink);
          entry.collision.qboSide = qboSide;
          const { verdict, reason } = verdictInvoiceCollision(entry.collision.jobberSide, qboSide);
          entry.collision.verdict = verdict;
          entry.recommendedAction = `${verdict} — ${reason}`;
          log(`  verdict: ${verdict} — ${reason}`);
        } else {
          entry.recommendedAction = 'SEE collision details — compare Jobber vs QBO side, then Ignore (duplicate) or QBO "-1" rename (different)';
        }
      } else {
        entry.recommendedAction = 'SEE collision details — compare Jobber vs QBO side, then Ignore (duplicate) or QBO "-1" rename (different)';
      }
    } else if (category === 'COLLISION_CLIENT' && detail.qboLink) {
      log(`  checking both sides for client "${item.label}"...`);
      const qboSide = await getQboCustomer(detail.qboLink);
      const { client: jobberClient } = await getJobberClientByName(jobberToken, item.label);
      await sleep(300);
      const jobberEmail = jobberClient?.emails?.[0]?.address;
      const jobberPhone = (jobberClient?.phones || []).map((p) => p.number.replace(/\D/g, '')).find(Boolean);
      const qboPhoneDigits = (qboSide?.phone || '').replace(/\D/g, '');
      const samePerson = (jobberEmail && qboSide?.email && jobberEmail.toLowerCase() === qboSide.email.toLowerCase())
        || (jobberPhone && qboPhoneDigits && jobberPhone.slice(-10) === qboPhoneDigits.slice(-10));
      entry.qboCustomer = qboSide;
      entry.jobberClient = jobberClient ? { name: jobberClient.name, email: jobberEmail, phone: jobberPhone } : null;
      entry.samePerson = samePerson;
      if (samePerson) {
        entry.recommendedAction = `SAME PERSON (email/phone match) — Jobber "${jobberClient.name}" (${jobberEmail || jobberPhone}) = QBO "${qboSide.name}" (${qboSide.email || qboSide.phone}). Use "Match to existing QuickBooks customer" in Jobber if offered, else Ignore. Do NOT rename the Jobber client.`;
      } else {
        entry.recommendedAction = `LIKELY DIFFERENT PEOPLE (no email/phone match) — Jobber: ${jobberEmail || jobberPhone || '(no contact info)'}, QBO "${qboSide?.name}": ${qboSide?.email || qboSide?.phone || '(no contact info)'}. If confirmed different, rename the QBO side only — never the Jobber client.`;
      }
    } else {
      entry.recommendedAction = RECOMMENDED_ACTION[category];
    }

    report.push(entry);
    await sleep(400);
  }

  return report;
}

// ---------- Main ----------

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!fs.existsSync(QB_AGENT_DIR)) fs.mkdirSync(QB_AGENT_DIR, { recursive: true });
  LOG_PATH = path.join(QB_AGENT_DIR, `qb-sync-errors-scan-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);

  log('Launching browser (persistent profile, same as qb-match-deposits.js)...');
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    executablePath: CHROME_PATH,
    args: ['--disable-blink-features=AutomationControlled', '--disable-gpu'],
    ignoreDefaultArgs: ['--enable-automation', '--no-sandbox'],
  });
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  const entryPage = ctx.pages()[0] || (await ctx.newPage());

  log('Navigating via Jobber\'s own UI (App Alerts bell -> QuickBooks Online Integration alert link)...');
  const page = await navigateToSyncActivity(ctx, entryPage);
  await ensureLoggedIn(page);

  log('Waiting for the error count to stabilize (known to under-report right after load)...');
  const stableCount = await waitForStableErrorCount(page);
  log(`Stable error count: ${stableCount}`);

  const report = await scanAllErrors(page, args.maxItems, stableCount);

  log('\n=== Summary ===');
  const byCategory = {};
  for (const r of report) byCategory[r.category] = (byCategory[r.category] || 0) + 1;
  for (const [cat, count] of Object.entries(byCategory)) log(` ${cat}: ${count}`);

  log('\n=== Items needing a decision (COLLISION_INVOICE / COLLISION_CLIENT / UNKNOWN) ===');
  for (const r of report) {
    if (!['COLLISION_INVOICE', 'COLLISION_CLIENT', 'UNKNOWN'].includes(r.category)) continue;
    log(`- ${r.item} [${r.category}]: ${r.heading || '(no heading captured)'}`);
  }

  const outPath = path.join(QB_AGENT_DIR, `qb-sync-errors-scan-${new Date().toISOString().slice(0, 10)}.json`);
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  log(`\nFull report written to ${outPath}`);

  await ctx.close();
}

module.exports = {
  CHROME_PATH,
  PROFILE_DIR,
  navigateToSyncActivity,
  ensureLoggedIn,
  waitForStableErrorCount,
  closeAnyOpenDialog,
  log,
};

if (require.main === module) {
  main().catch((err) => {
    console.error('FATAL', err.message);
    if (LOG_PATH) fs.appendFileSync(LOG_PATH, `FATAL ${err.message}\n`);
    process.exit(1);
  });
}
