// Ycheten — QBO deposit matcher.
//
// Confirmed live 2026-10-06 solving the $2,282.50 / $25,650 Rely deposits:
// when a check covers more invoices than QBO allows on one Payment record
// (observed cap: 50 line items), QBO silently SPLITS it into several
// separate Payment entities that all share the same PaymentRefNum — and
// reconciliation attempts sometimes leave behind ORPHANED duplicate
// Payment records (same ref#, same amount, but ZERO invoice line items —
// nothing ever applied) that look identical to the real ones in QBO's own
// "Find match" list (same date/amount/payee, no visible distinguishing
// field). A human staring at that list has no way to tell which of two
// identical-looking $7,285 rows is real.
//
// This script queries every Payment sharing a reference number, separates
// real (has line items) from orphan (zero line items), and — if a target
// deposit amount is given — finds the exact subset of REAL payments that
// sums to it. Read-only: only ever runs a SELECT query, never writes
// anything. Reports exact Payment IDs and direct QBO links so a human can
// act with certainty instead of guessing between identical-looking rows.
//
// Usage:
//   node scripts/qb-deposit-match.js --ref 2734435 --amount 25650
//   node scripts/qb-deposit-match.js --ref 2736840            (no amount: just lists everything)

const { qboQuery } = require('./qbo-api');

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : null;
  };
  return { ref: get('--ref'), amount: get('--amount') ? parseFloat(get('--amount')) : null };
}

// Finds every subset of `real` payments whose amounts sum to `target`
// (within a cent of float rounding). N is always small in practice (QBO's
// own split cap keeps it well under 20), so brute-force 2^N is fine.
function findSummingSubsets(real, target) {
  const n = real.length;
  const results = [];
  for (let mask = 1; mask < (1 << n); mask++) {
    let sum = 0;
    const subset = [];
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i)) {
        sum += real[i].TotalAmt;
        subset.push(real[i]);
      }
    }
    if (Math.abs(sum - target) < 0.01) results.push(subset);
  }
  return results;
}

async function main() {
  const { ref, amount } = parseArgs();
  if (!ref) {
    console.log('Usage: node scripts/qb-deposit-match.js --ref <referenceNumber> [--amount <targetDepositAmount>]');
    process.exit(1);
  }

  console.log(`Querying QBO Payments with PaymentRefNum = '${ref}'...\n`);
  const r = await qboQuery(`SELECT * FROM Payment WHERE PaymentRefNum = '${ref}'`);
  const payments = r.QueryResponse?.Payment || [];
  if (!payments.length) {
    console.log('No payments found with that reference number.');
    return;
  }

  const real = [];
  const orphans = [];
  for (const p of payments) {
    const lineCount = (p.Line || []).filter((l) => l.LinkedTxn?.length).length;
    (lineCount > 0 ? real : orphans).push({ ...p, lineCount });
  }

  console.log(`Found ${payments.length} payment(s): ${real.length} real (has invoice lines), ${orphans.length} orphan (zero lines)\n`);

  console.log('--- Real payments ---');
  for (const p of real) {
    console.log(`  #${p.Id}  $${p.TotalAmt}  ${p.TxnDate}  ${p.lineCount} invoice line(s)  https://app.qbo.intuit.com/app/recvpayment?txnId=${p.Id}`);
  }

  if (orphans.length) {
    console.log('\n--- Orphan payments (0 invoice lines — safe to delete, nothing applied) ---');
    for (const p of orphans) {
      console.log(`  #${p.Id}  $${p.TotalAmt}  ${p.TxnDate}  https://app.qbo.intuit.com/app/recvpayment?txnId=${p.Id}`);
    }
  }

  if (amount != null) {
    console.log(`\n--- Looking for a combination of REAL payments summing to $${amount} ---`);
    const subsets = findSummingSubsets(real, amount);
    if (!subsets.length) {
      const realTotal = real.reduce((s, p) => s + p.TotalAmt, 0);
      console.log(`No exact combination found. Sum of all real payments: $${realTotal}. Needs a human look.`);
    } else {
      if (subsets.length > 1) console.log(`WARNING: ${subsets.length} different combinations sum to this amount — showing all, pick carefully.`);
      subsets.forEach((subset, i) => {
        console.log(`\nMatch ${i + 1} — select these ${subset.length} payment(s) in Find Match:`);
        for (const p of subset) console.log(`  #${p.Id}  $${p.TotalAmt}  https://app.qbo.intuit.com/app/recvpayment?txnId=${p.Id}`);
      });
    }
  }
}

main().catch((err) => {
  console.error('FATAL', err.message);
  process.exit(1);
});
