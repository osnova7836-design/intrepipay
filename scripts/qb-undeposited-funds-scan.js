// Ycheten — scans QBO's "Payments to deposit" (Undeposited Funds) account
// for every payment that's been recorded but never grouped into a real
// bank Deposit. Confirmed live 2026-10-06: this account currently holds
// $75K+ going back to January 2026 — a real, substantial backlog, not
// noise. Read-only. Writes nothing to QBO.
//
// A payment counts as "still pending" only if NONE of its LinkedTxn
// entries point to a Deposit — simply being tagged to this account isn't
// enough, since most payments here eventually DO get swept into a real
// deposit later (confirmed: of ~7600 payments ever tagged to this account
// going back to 2025, only 178 are still genuinely outstanding).
//
// Categorizes by payment method, since the right next step differs a lot
// by type:
//   Check                     -> needs a deposit slip image to verify by
//                                check#, same blocker as ATM cash deposits
//   Cash                      -> no bank-side reference exists at all;
//                                cross-reference against the Tech Cash
//                                Tracker to find out if it's even been
//                                physically deposited yet
//   ACH/Zelle/Jobber Payments/
//   CreditCard/Venmo/PayPal   -> has a real reference number (confirmation#/
//                                transactionId/ccTransactionNumber), directly
//                                verifiable against bank activity the same
//                                way qb-for-review-verify.js already does
//
// Usage: node scripts/qb-undeposited-funds-scan.js [--max-scan N]

const { qboQuery } = require('./qbo-api');
const fs = require('fs');
const path = require('path');

const QB_AGENT_DIR = path.join(__dirname, '..', '.qb-agent');

const ELECTRONIC_METHOD_NAMES = new Set(['ACH', 'ACH Bank Payment', 'Cash App', 'Credit Card', 'CreditCard', 'Jobber Payments', 'PayPal', 'Venmo', 'Zelle']);

function parseArgs() {
  const args = process.argv.slice(2);
  const i = args.indexOf('--max-scan');
  return { maxScan: i >= 0 ? parseInt(args[i + 1], 10) : 8000 };
}

async function findUndepositedFundsAccount() {
  const r = await qboQuery(`SELECT * FROM Account MAXRESULTS 300`);
  const acct = (r.QueryResponse?.Account || []).find((a) => a.AccountSubType === 'UndepositedFunds');
  if (!acct) throw new Error('Could not find an Undeposited Funds account in this QBO company');
  return acct;
}

async function getPaymentMethodNames() {
  const r = await qboQuery(`SELECT * FROM PaymentMethod`);
  const map = {};
  for (const m of r.QueryResponse?.PaymentMethod || []) map[m.Id] = m.Name;
  return map;
}

async function scanAllTaggedPayments(acctId, maxScan) {
  let startPos = 1;
  let all = [];
  while (true) {
    const r = await qboQuery(`SELECT * FROM Payment ORDERBY TxnDate DESC STARTPOSITION ${startPos} MAXRESULTS 200`);
    const batch = r.QueryResponse?.Payment || [];
    if (!batch.length) break;
    all.push(...batch.filter((p) => p.DepositToAccountRef?.value === acctId));
    if (batch.length < 200) break;
    startPos += 200;
    if (startPos > maxScan) {
      console.log(`Hit scan cap of ${maxScan} payments — raise with --max-scan if the gap to the account balance looks too big.`);
      break;
    }
  }
  return all;
}

async function main() {
  const { maxScan } = parseArgs();

  console.log('Finding the Undeposited Funds account...');
  const acct = await findUndepositedFundsAccount();
  console.log(`Found: "${acct.Name}" (Id ${acct.Id}), current balance $${acct.CurrentBalance}`);

  console.log('\nScanning all Payment records tagged to this account...');
  const tagged = await scanAllTaggedPayments(acct.Id, maxScan);
  console.log(`Scanned ${tagged.length} tagged payments total (includes ones already swept into later deposits).`);

  const stillPending = tagged.filter((p) => !(p.LinkedTxn || []).some((lt) => lt.TxnType === 'Deposit'));
  const total = stillPending.reduce((s, p) => s + p.TotalAmt, 0);
  console.log(`\nStill genuinely pending (no Deposit link): ${stillPending.length}, sum $${total.toFixed(2)}`);
  console.log(`(Account's own CurrentBalance: $${acct.CurrentBalance} -- gap of $${(acct.CurrentBalance - total).toFixed(2)} likely means older payments exist beyond the scan cap)`);

  const methodNames = await getPaymentMethodNames();
  const byMethod = {};
  for (const p of stillPending) {
    const name = methodNames[p.PaymentMethodRef?.value] || '(unknown)';
    byMethod[name] = byMethod[name] || { count: 0, sum: 0, withRef: 0 };
    byMethod[name].count++;
    byMethod[name].sum += p.TotalAmt;
    if (p.PaymentRefNum && p.PaymentRefNum.trim()) byMethod[name].withRef++;
  }
  console.log('\nBy payment method:');
  for (const [name, v] of Object.entries(byMethod).sort((a, b) => b[1].sum - a[1].sum)) {
    console.log(`  ${name}: ${v.count} payments, $${v.sum.toFixed(2)} (${v.withRef} with a reference number)`);
  }

  const cash = stillPending.filter((p) => methodNames[p.PaymentMethodRef?.value] === 'Cash');
  const check = stillPending.filter((p) => methodNames[p.PaymentMethodRef?.value] === 'Check');
  const electronic = stillPending.filter((p) => ELECTRONIC_METHOD_NAMES.has(methodNames[p.PaymentMethodRef?.value]));
  const electronicWithRef = electronic.filter((p) => p.PaymentRefNum && p.PaymentRefNum.trim());

  console.log(`\n=== Triage summary ===`);
  console.log(`Cash (needs Tech Cash Tracker cross-reference): ${cash.length}, $${cash.reduce((s, p) => s + p.TotalAmt, 0).toFixed(2)}`);
  console.log(`Check (needs deposit slip images): ${check.length}, $${check.reduce((s, p) => s + p.TotalAmt, 0).toFixed(2)}`);
  console.log(`Electronic with a reference number (directly matchable now): ${electronicWithRef.length}, $${electronicWithRef.reduce((s, p) => s + p.TotalAmt, 0).toFixed(2)}`);
  console.log(`Electronic with NO reference number (needs manual judgment): ${electronic.length - electronicWithRef.length}, $${(electronic.reduce((s, p) => s + p.TotalAmt, 0) - electronicWithRef.reduce((s, p) => s + p.TotalAmt, 0)).toFixed(2)}`);

  const outPath = path.join(QB_AGENT_DIR, `undeposited-funds-${new Date().toISOString().slice(0, 10)}.json`);
  fs.writeFileSync(outPath, JSON.stringify({ scannedAt: new Date().toISOString(), accountId: acct.Id, accountBalance: acct.CurrentBalance, stillPending }, null, 2));
  console.log(`\nFull list saved to ${outPath}`);
}

main().catch((err) => {
  console.error('FATAL', err.message);
  process.exit(1);
});
