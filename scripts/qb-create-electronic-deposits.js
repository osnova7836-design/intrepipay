// Ycheten -- creates one real QBO Deposit per electronic Undeposited Funds
// payment confirmed against Jobber's own paymentRecords by exact reference
// number (see qb-electronic-deposit-verify.js). Includes the one
// REF_MATCH_AMOUNT_MISMATCH case that was manually verified as real: Lula
// Property Managment $2138.40 (payment #32450) is actually TWO separate
// Jobber ACH payments ($1588.40 ref 70FC639 + $550 ref 4B2458D) that QBO
// combined into one Payment record -- both refs independently verified.
//
// Usage: node scripts/qb-create-electronic-deposits.js

const { createDepositForPayment, qboQuery } = require('./qbo-api');
const fs = require('fs');
const path = require('path');

const BANK_ACCOUNT_ID = '149';
const QB_AGENT_DIR = path.join(__dirname, '..', '.qb-agent');

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  const results = JSON.parse(fs.readFileSync(path.join(QB_AGENT_DIR, 'electronic-deposit-verify-2026-10-07.json'), 'utf8'));
  const items = results.filter((r) => r.status === 'CONFIRMED');
  items.push({ paymentId: '32450', amount: 2138.4, date: '2026-07-02', customer: 'Lula Property Managment - LULA', ref: '70FC639 + 4B2458D (combined)' });

  console.log(`${items.length} payments to deposit, $${items.reduce((s, r) => s + r.amount, 0).toFixed(2)}\n`);

  const summary = [];
  for (const item of items) {
    process.stdout.write(`$${item.amount}  ${item.date}  ${item.customer}  (Payment #${item.paymentId})... `);
    const current = await qboQuery(`SELECT * FROM Payment WHERE Id = '${item.paymentId}'`).catch(() => null);
    const alreadyLinked = (current?.QueryResponse?.Payment?.[0]?.LinkedTxn || []).some((lt) => lt.TxnType === 'Deposit');
    if (alreadyLinked) { console.log('already deposited, skipping'); summary.push({ ...item, status: 'skipped_already_deposited' }); continue; }
    try {
      const dep = await createDepositForPayment({ paymentId: item.paymentId, amount: item.amount, txnDate: item.date, bankAccountId: BANK_ACCOUNT_ID });
      console.log(`OK -> Deposit #${dep.Deposit.Id}`);
      summary.push({ ...item, status: 'created', depositId: dep.Deposit.Id });
    } catch (err) {
      console.log(`FAILED: ${err.message}`);
      summary.push({ ...item, status: 'failed', error: err.message });
    }
    await sleep(400);
  }

  const created = summary.filter((r) => r.status === 'created');
  const failed = summary.filter((r) => r.status === 'failed');
  console.log('\n=== Summary ===');
  console.log(`Created: ${created.length}, $${created.reduce((s, r) => s + r.amount, 0).toFixed(2)}`);
  console.log(`Failed: ${failed.length}`);
  if (failed.length) for (const f of failed) console.log(`  $${f.amount} ${f.customer} (Payment #${f.paymentId}): ${f.error}`);

  const outPath = path.join(QB_AGENT_DIR, `electronic-deposits-created-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(outPath, JSON.stringify(summary, null, 2));
  console.log(`\nFull results saved to ${outPath}`);
}

main().catch((err) => { console.error('FATAL', err.message); process.exit(1); });
