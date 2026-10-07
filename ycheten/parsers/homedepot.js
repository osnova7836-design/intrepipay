// Home Depot Pro Xtra commercial card statement. Confirmed live 2026-10-07
// against 3 real statements -- format: "Purchases +$19,260.17", "Credits
// -$1,530.97", "Closing Date 09/25/26" (2-digit year; "Next Closing Date"
// also appears and must NOT match).
const { toNum, normalizeDate, docNumberFromDate } = require('./shared');

const ACCOUNTS = {
  debit: { id: '72', name: 'Supplies & materials' },
  credit: { id: '167', name: 'Home Depot - QuickBooks Purchases' },
};

function looksLikeThisVendor(text) {
  return /home\s*depot/i.test(text) && /pro\s*xtra|homedepot\.com\/mycrc/i.test(text);
}

function parse(text) {
  const closingMatch = text.match(/(?<!Next )Closing Date\s+(\d{2})\/(\d{2})\/(\d{2,4})/i);
  const purchasesMatch = text.match(/Purchases\s*\+?\$?([\d,]+\.\d{2})/i);
  const creditsMatch = text.match(/\bCredits\s*-?\$?([\d,]+\.\d{2})/i);

  if (!closingMatch) return { ok: false, error: 'Could not find a "Closing Date" on this statement.' };
  if (!purchasesMatch) return { ok: false, error: 'Could not find a "Purchases" total on this statement.' };

  const closingDate = normalizeDate(closingMatch[1], closingMatch[2], closingMatch[3]);
  const purchases = toNum(purchasesMatch[1]);
  const credits = creditsMatch ? toNum(creditsMatch[1]) : 0;
  const netAmount = Math.round((purchases - credits) * 100) / 100;

  return {
    ok: true,
    vendor: 'Home Depot',
    closingDate,
    purchases,
    credits,
    netAmount,
    docNumber: docNumberFromDate(closingDate, 'HD'),
    accounts: ACCOUNTS,
  };
}

module.exports = { looksLikeThisVendor, parse, ACCOUNTS };
