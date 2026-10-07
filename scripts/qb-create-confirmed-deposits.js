// Ycheten — creates one real QBO Deposit per confirmed payment from the
// latest manual-deposit-crossref-*.json (Cash + Check payments confirmed
// "Manually deposited" in Jobber -- see qb-manual-deposit-crossref.js).
// One deposit per payment, no date-grouping guesswork, per Os's explicit
// call 2026-10-07. Uses each payment's own TxnDate so the deposit lands
// on the real historical date the money came in.
//
// Writes real QBO Deposit transactions. Confirmed live against one test
// payment before this batch version was built (Deposit #36747, Carla And
// Dwanna Williams, $100, verified the Payment's LinkedTxn updated
// correctly afterward).
//
// Usage: node scripts/qb-create-confirmed-deposits.js

const { createDepositForPayment, qboQuery } = require('./qbo-api');
const fs = require('fs');
const path = require('path');

const QB_AGENT_DIR = path.join(__dirname, '..', '.qb-agent');
const BANK_ACCOUNT_ID = '149'; // BOA Business Adv Fundamentals - 6763 - 1

function findLatestCrossrefReport() {
  const files = fs.readdirSync(QB_AGENT_DIR)
    .filter((f) => /^manual-deposit-crossref-\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort();
  if (!files.length) throw new Error('No manual-deposit-crossref-*.json found -- run qb-manual-deposit-crossref.js first');
  return path.join(QB_AGENT_DIR, files[files.length - 1]);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  const reportPath = findLatestCrossrefReport();
  const data = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  console.log(`Loaded ${reportPath}`);

  const all = [
    ...(data.Cash?.confirmedDeposited || []),
    ...(data.Check?.confirmedDeposited || []),
  ];
  console.log(`Total confirmed payments to deposit: ${all.length}, $${all.reduce((s, r) => s + r.qbo.TotalAmt, 0).toFixed(2)}\n`);

  const results = [];
  for (const r of all) {
    const p = r.qbo;
    process.stdout.write(`$${p.TotalAmt}  ${p.TxnDate}  ${p.CustomerRef?.name}  (Payment #${p.Id})... `);

    // Skip if this payment already got a Deposit since the report was generated
    // (e.g. the earlier manual test run, or a re-run of this script).
    const current = await qboQuery(`SELECT * FROM Payment WHERE Id = '${p.Id}'`).catch(() => null);
    const alreadyLinked = (current?.QueryResponse?.Payment?.[0]?.LinkedTxn || []).some((lt) => lt.TxnType === 'Deposit');
    if (alreadyLinked) {
      console.log('already deposited, skipping');
      results.push({ paymentId: p.Id, amount: p.TotalAmt, client: p.CustomerRef?.name, status: 'skipped_already_deposited' });
      continue;
    }

    try {
      const dep = await createDepositForPayment({ paymentId: p.Id, amount: p.TotalAmt, txnDate: p.TxnDate, bankAccountId: BANK_ACCOUNT_ID });
      console.log(`OK -> Deposit #${dep.Deposit.Id}`);
      results.push({ paymentId: p.Id, amount: p.TotalAmt, client: p.CustomerRef?.name, status: 'created', depositId: dep.Deposit.Id });
    } catch (err) {
      console.log(`FAILED: ${err.message}`);
      results.push({ paymentId: p.Id, amount: p.TotalAmt, client: p.CustomerRef?.name, status: 'failed', error: err.message });
    }
    await sleep(400);
  }

  const created = results.filter((r) => r.status === 'created');
  const skipped = results.filter((r) => r.status === 'skipped_already_deposited');
  const failed = results.filter((r) => r.status === 'failed');

  console.log('\n=== Summary ===');
  console.log(`Created: ${created.length}, $${created.reduce((s, r) => s + r.amount, 0).toFixed(2)}`);
  console.log(`Already deposited (skipped): ${skipped.length}`);
  console.log(`Failed: ${failed.length}`);
  if (failed.length) {
    console.log('\nFailed payments:');
    for (const f of failed) console.log(`  $${f.amount} ${f.client} (Payment #${f.paymentId}): ${f.error}`);
  }

  const outPath = path.join(QB_AGENT_DIR, `deposits-created-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(`\nFull results saved to ${outPath}`);
}

main().catch((err) => {
  console.error('FATAL', err.message);
  process.exit(1);
});
