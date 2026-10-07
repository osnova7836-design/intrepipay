// One-off: catches up the 3 missing Home Depot reclass JEs (Jul/Aug/Sep
// 2026 closings), matching the exact pre-existing pattern -- Debit
// "Supplies & materials" (72) / Credit "Home Depot - QuickBooks Purchases"
// (167), amount = statement Purchases minus Credits for that billing
// period. Verified formula against the last real entry (06/25 close:
// 14122.36 - 2776.05 = 11346.31, exact match to what was already booked).
const { createJournalEntry } = require('./qbo-api');

const DEBIT_ACCT = '72'; // Supplies & materials
const CREDIT_ACCT = '167'; // Home Depot - QuickBooks Purchases

const ENTRIES = [
  { txnDate: '2026-07-26', docNumber: '07262026HD', amount: 15568.32 - 1961.11, desc: 'Purchases' },
  { txnDate: '2026-08-26', docNumber: '08262026HD', amount: 9038.74 - 645.98, desc: 'Purchases' },
  { txnDate: '2026-09-25', docNumber: '09252026HD', amount: 19260.17 - 1530.97, desc: 'Purchases' },
];

async function main() {
  for (const e of ENTRIES) {
    const amt = Math.round(e.amount * 100) / 100;
    process.stdout.write(`${e.txnDate}  $${amt}  (doc# ${e.docNumber})... `);
    const result = await createJournalEntry({ txnDate: e.txnDate, docNumber: e.docNumber, debitAccountId: DEBIT_ACCT, creditAccountId: CREDIT_ACCT, amount: amt, description: e.desc });
    console.log(`OK -> JE #${result.JournalEntry.Id}`);
  }
}

main().catch((err) => { console.error('FATAL', err.message); process.exit(1); });
