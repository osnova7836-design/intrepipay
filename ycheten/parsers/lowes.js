// Lowe's Pro Rewards commercial card statement (Synchrony Bank). Confirmed
// live 2026-10-07 against 5 real statements -- format: "Purchases/Debits
// $1,775.85", "Other Credits $608.88", "Statement Closing Date 10/02/2026"
// (4-digit year).
const { toNum, normalizeDate, docNumberFromDate } = require('./shared');

const ACCOUNTS = {
  debit: { id: '72', name: 'Supplies & materials' },
  credit: { id: '1150040009', name: 'Lowes - WELLS FARGO CARD' },
};

function looksLikeThisVendor(text) {
  return /lowe'?s/i.test(text) && /lowes\.com\/credit|myLowe'?s Pro Rewards/i.test(text);
}

function parse(text) {
  const closingMatch = text.match(/Statement Closing Date\s+(\d{2})\/(\d{2})\/(\d{4})/i);
  const purchasesMatch = text.match(/Purchases\/Debits\s*\$?([\d,]+\.\d{2})/i);
  const creditsMatch = text.match(/Other Credits\s*\$?([\d,]+\.\d{2})/i);

  if (!closingMatch) return { ok: false, error: 'Could not find a "Statement Closing Date" on this statement.' };
  if (!purchasesMatch) return { ok: false, error: 'Could not find a "Purchases/Debits" total on this statement.' };

  const closingDate = normalizeDate(closingMatch[1], closingMatch[2], closingMatch[3]);
  const purchases = toNum(purchasesMatch[1]);
  const credits = creditsMatch ? toNum(creditsMatch[1]) : 0;
  const netAmount = Math.round((purchases - credits) * 100) / 100;

  return {
    ok: true,
    vendor: "Lowe's",
    closingDate,
    purchases,
    credits,
    netAmount,
    docNumber: docNumberFromDate(closingDate, 'Lowes'),
    accounts: ACCOUNTS,
  };
}

module.exports = { looksLikeThisVendor, parse, ACCOUNTS };
