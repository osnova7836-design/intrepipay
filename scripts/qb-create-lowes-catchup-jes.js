// One-off: catches up the 4 missing Lowe's reclass JEs (Jul/Aug/Sep/Oct
// 2026 closings), matching the exact pre-existing pattern -- Debit
// "Supplies & materials" (72) / Credit "Lowes - WELLS FARGO CARD"
// (1150040009), amount = statement Purchases/Debits minus Other Credits
// for that billing period. Formula verified against the 06/02 close
// (already booked, $682.57, Other Credits $0.00 that cycle -- no net
// adjustment needed to confirm, but the 10/02 close's own math checks:
// 1775.85 - 608.88 = 1166.97, matching its own New Balance exactly).
const { createJournalEntry } = require('./qbo-api');

const DEBIT_ACCT = '72'; // Supplies & materials
const CREDIT_ACCT = '1150040009'; // Lowes - WELLS FARGO CARD

const ENTRIES = [
  { txnDate: '2026-07-02', docNumber: '07022026Lowes', amount: 1874.07 - 0, desc: 'Purchases' },
  { txnDate: '2026-08-02', docNumber: '08022026Lowes', amount: 443.59 - 0, desc: 'Purchases' },
  { txnDate: '2026-09-02', docNumber: '09022026Lowes', amount: 1083.75 - 0, desc: 'Purchases' },
  { txnDate: '2026-10-02', docNumber: '10022026Lowes', amount: 1775.85 - 608.88, desc: 'Purchases' },
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
