// Ycheten — QBO sync-error backlog FIXER (Phase 2).
//
// Reads the latest Phase 1 report (scripts/qb-sync-errors-scan.js) and
// plans a concrete action per item. DRY-RUN BY DEFAULT — prints the plan,
// writes nothing to Jobber or QBO. Pass --execute to actually perform the
// SAFE subset of actions (see ACTION PLAN below); anything not safe is
// always left for a human, execute flag or not.
//
// ACTION PLAN per category (confirmed live 2026-10-06):
//   COLLISION_INVOICE + verdict DUPLICATE  -> Jobber: click Ignore.
//     Safe: QBO already has the same real transaction recorded.
//   COLLISION_INVOICE + verdict DIFFERENT  -> NOT auto-executed. Reported
//     only. Renaming a QBO invoice's DocNumber is a real financial-record
//     write — flagged for Os to do by hand (or approve explicitly) rather
//     than automated on a first pass, same caution as the Jobber
//     invoice-number rule (never touched programmatically after a past
//     incident — see feedback-never-exceed-jobber-invoice-max).
//   COLLISION_CLIENT (any)   -> NOT auto-executed. Always needs a human
//     look — confirmed live 2026-10-06 that renaming the WRONG side here
//     breaks future job-matching (Eric Sharkey case, Os caught it).
//   CLOSED_PERIOD            -> Jobber: click Ignore. Confirmed benign —
//     the underlying payment still syncs fine.
//   BAD_DEBT_AMOUNT          -> NOT auto-executed. Needs the invoice
//     confirmed as genuinely marked bad debt in Jobber first.
//   CASCADING_DEPENDENT      -> no action, skipped (resolves on its own
//     once its root cause is fixed).
//   UNKNOWN                  -> no action, skipped (needs a human look).
//
// So on --execute, only COLLISION_INVOICE/DUPLICATE and CLOSED_PERIOD
// items get a real Jobber click — everything else is report-only. Each
// Jobber click is a real UI action (no public API for this — confirmed
// live 2026-10-06 via GraphQL mutation introspection, only 111 mutations
// total, none for sync-error actions), reusing the exact navigation/modal
// logic already proven live in qb-sync-errors-scan.js.

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const {
  CHROME_PATH,
  PROFILE_DIR,
  navigateToSyncActivity,
  ensureLoggedIn,
  waitForStableErrorCount,
  closeAnyOpenDialog,
  log,
} = require('./qb-sync-errors-scan');

const QB_AGENT_DIR = path.join(__dirname, '..', '.qb-agent');

function parseArgs() {
  const args = process.argv.slice(2);
  return {
    execute: args.includes('--execute'),
    reportPath: (() => {
      const i = args.indexOf('--report');
      return i >= 0 ? args[i + 1] : null;
    })(),
  };
}

function findLatestReport() {
  const files = fs.readdirSync(QB_AGENT_DIR)
    .filter((f) => /^qb-sync-errors-scan-\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort();
  if (!files.length) throw new Error('No qb-sync-errors-scan-*.json report found in .qb-agent/ — run scripts/qb-sync-errors-scan.js first');
  return path.join(QB_AGENT_DIR, files[files.length - 1]);
}

// Returns { action: 'IGNORE'|'REPORT_ONLY'|'SKIP', system: 'jobber'|'qbo'|null, reason }
function planAction(entry) {
  switch (entry.category) {
    case 'COLLISION_INVOICE':
      if (entry.collision?.verdict === 'DUPLICATE') {
        return { action: 'IGNORE', system: 'jobber', reason: 'confirmed duplicate — same client+amount already in QBO' };
      }
      if (entry.collision?.verdict === 'DIFFERENT') {
        return { action: 'REPORT_ONLY', system: 'qbo', reason: `different transaction — rename QBO #${entry.collision?.jobberSide?.invoiceNumber} by hand (never automated — same caution as the Jobber invoice-number rule)` };
      }
      return { action: 'REPORT_ONLY', system: null, reason: 'collision verdict unknown — needs a human look' };
    case 'CLOSED_PERIOD':
      return { action: 'IGNORE', system: 'jobber', reason: 'benign — underlying payment still syncs fine' };
    case 'COLLISION_CLIENT':
      return { action: 'REPORT_ONLY', system: null, reason: entry.samePerson ? 'same real person — needs "Match to existing" or manual Ignore, never a Jobber rename' : 'different people — needs a human look before any rename' };
    case 'BAD_DEBT_AMOUNT':
      return { action: 'REPORT_ONLY', system: null, reason: 'needs confirmation the invoice is genuinely marked bad debt in Jobber first' };
    case 'CASCADING_DEPENDENT':
      return { action: 'SKIP', system: null, reason: 'resolves automatically once its root cause is fixed' };
    default:
      return { action: 'SKIP', system: null, reason: 'unknown category — needs a human look' };
  }
}

function buildPlan(report) {
  return report.map((entry) => ({ item: entry.item, category: entry.category, ...planAction(entry) }));
}

async function main() {
  const args = parseArgs();
  const reportPath = args.reportPath || findLatestReport();
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  console.log(`Loaded ${report.length} item(s) from ${reportPath}\n`);

  const plan = buildPlan(report);
  const toIgnore = plan.filter((p) => p.action === 'IGNORE');
  const reportOnly = plan.filter((p) => p.action === 'REPORT_ONLY');
  const skipped = plan.filter((p) => p.action === 'SKIP');

  console.log(`=== Plan: ${toIgnore.length} auto-Ignore, ${reportOnly.length} report-only (human needed), ${skipped.length} skip ===\n`);

  console.log(`--- Would click Ignore in Jobber (${toIgnore.length}) ---`);
  for (const p of toIgnore) console.log(`  [${p.category}] ${p.item} — ${p.reason}`);

  console.log(`\n--- Needs a human (${reportOnly.length}) ---`);
  for (const p of reportOnly) console.log(`  [${p.category}] ${p.item} — ${p.reason}`);

  console.log(`\n--- Skipped, no action needed (${skipped.length}) ---`);
  for (const p of skipped) console.log(`  [${p.category}] ${p.item} — ${p.reason}`);

  if (!args.execute) {
    console.log('\nDRY RUN — nothing was written. Re-run with --execute to actually click Ignore on the items above.');
    return;
  }

  if (!toIgnore.length) {
    console.log('\nNothing to execute — no items planned for auto-Ignore.');
    return;
  }

  console.log(`\n--execute passed — about to click Ignore on ${toIgnore.length} item(s) in Jobber's live Sync Activity page.`);
  await executeIgnores(toIgnore);
}

// Opens an item's detail modal (same proven logic as the scanner) and
// clicks its "Ignore" button. Returns {success, reason}.
async function clickIgnoreForItem(page, itemLabel) {
  const dialogLocator = page.locator('[role="dialog"]');
  const baselineLength = (await page.locator('body').innerText().catch(() => '')).length;
  const rowText = page.getByText(itemLabel, { exact: false }).first();

  let opened = false;
  for (let attempt = 0; attempt < 3 && !opened; attempt++) {
    if (attempt > 0) {
      await closeAnyOpenDialog(page);
      await page.waitForTimeout(500);
    }
    await rowText.click({ timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(1200 + attempt * 800);
    const dialogCount = await dialogLocator.count().catch(() => 0);
    const len = (await page.locator('body').innerText().catch(() => '')).length;
    opened = dialogCount > 0 && len > baselineLength + 150;
  }
  if (!opened) return { success: false, reason: 'could not open detail modal' };

  const ignoreBtn = page.getByRole('button', { name: /^ignore$/i }).first();
  if (!(await ignoreBtn.count().catch(() => 0))) {
    await closeAnyOpenDialog(page);
    return { success: false, reason: 'no Ignore button found in modal' };
  }
  await ignoreBtn.click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(1500);
  await closeAnyOpenDialog(page);

  // Confirm the row is actually gone from the error list afterward — the
  // whole point of verifying, not just trusting the click happened.
  // Confirmed live 2026-10-06: a single check right after the click can be
  // a false negative — the list's own re-render lagged behind the actual
  // Ignore (a re-scan moments later showed all 6 items correctly gone,
  // despite every one of them failing this check at 1500ms). Poll instead
  // of trusting one snapshot.
  let stillThere = 1;
  for (let i = 0; i < 6 && stillThere > 0; i++) {
    await page.waitForTimeout(1500);
    stillThere = await page.getByText(itemLabel, { exact: false }).first().count().catch(() => 0);
  }
  if (stillThere > 0) return { success: false, reason: 'clicked Ignore but item still shows in the list after 9s — verify manually' };
  return { success: true };
}

async function executeIgnores(toIgnore) {
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

  log("Navigating via Jobber's own UI (App Alerts bell -> QuickBooks Online Integration alert link)...");
  const page = await navigateToSyncActivity(ctx, entryPage);
  await ensureLoggedIn(page);
  await waitForStableErrorCount(page);

  const results = [];
  for (const p of toIgnore) {
    log(`Ignoring: ${p.item}...`);
    const result = await clickIgnoreForItem(page, p.item);
    results.push({ ...p, ...result });
    log(result.success ? '  done' : `  FAILED: ${result.reason}`);
    await new Promise((r) => setTimeout(r, 500));
  }

  console.log('\n=== Execution results ===');
  for (const r of results) {
    console.log(`  ${r.success ? 'OK' : 'FAILED'} — [${r.category}] ${r.item}${r.success ? '' : ` (${r.reason})`}`);
  }

  await ctx.close();
  return results;
}

main().catch((err) => {
  console.error('FATAL', err.message);
  process.exit(1);
});
