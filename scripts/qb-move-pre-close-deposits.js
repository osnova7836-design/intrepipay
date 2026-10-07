// Ycheten -- moves the Undeposited Funds cleanup deposits (created
// 2026-10-07) that are dated on or before the accountant's closing date
// (2026-05-31, per Os) out of the real BOA account and into "Prior Period
// Clearing" (acct 175, a Bank-type account created for exactly this).
// This is the standard "dummy account" fix for catching up a closed
// period without disturbing its already-reconciled real bank balance --
// only the deposit's destination account changes; TxnDate, amount, and
// the link to the real underlying customer Payment are untouched.
//
// Usage: node scripts/qb-move-pre-close-deposits.js
const { qboQuery, updateDepositAccount } = require('./qbo-api');

const CLEARING_ACCOUNT_ID = '175'; // Prior Period Clearing
const CLOSE_DATE = '2026-05-31';

async function main() {
  const r = await qboQuery(`SELECT * FROM Deposit WHERE Id >= '36747' AND Id <= '36950' ORDERBY TxnDate ASC MAXRESULTS 300`);
  const all = r.QueryResponse.Deposit || [];
  const targets = all.filter((d) => d.TxnDate <= CLOSE_DATE && d.DepositToAccountRef?.value !== CLEARING_ACCOUNT_ID);

  console.log(`${targets.length} deposits dated <= ${CLOSE_DATE} to move, $${targets.reduce((s, d) => s + d.TotalAmt, 0).toFixed(2)} total\n`);

  const results = [];
  for (const d of targets) {
    process.stdout.write(`${d.Id}  ${d.TxnDate}  $${d.TotalAmt}... `);
    try {
      await updateDepositAccount({ depositId: d.Id, syncToken: d.SyncToken, newAccountId: CLEARING_ACCOUNT_ID });
      console.log('moved');
      results.push({ id: d.Id, date: d.TxnDate, amount: d.TotalAmt, status: 'moved' });
    } catch (err) {
      console.log('FAILED:', err.message);
      results.push({ id: d.Id, date: d.TxnDate, amount: d.TotalAmt, status: 'failed', error: err.message });
    }
    await new Promise((res) => setTimeout(res, 300));
  }

  const moved = results.filter((r) => r.status === 'moved');
  const failed = results.filter((r) => r.status === 'failed');
  console.log(`\n=== Summary ===`);
  console.log(`Moved: ${moved.length}, $${moved.reduce((s, r) => s + r.amount, 0).toFixed(2)}`);
  console.log(`Failed: ${failed.length}`);
  if (failed.length) for (const f of failed) console.log(`  ${f.id} ${f.date} $${f.amount}: ${f.error}`);
}

main().catch((err) => { console.error('FATAL', err.message); process.exit(1); });
