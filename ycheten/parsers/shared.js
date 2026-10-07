// Shared helpers for every statement parser. Each parser's job is narrow:
// turn raw PDF text into { closingDate (YYYY-MM-DD), purchases, credits,
// netAmount, docNumber }. Vendor detection and account mapping live in
// index.js, not here.

function toNum(str) {
  return parseFloat(String(str).replace(/[,$]/g, ''));
}

// Accepts MM/DD/YY or MM/DD/YYYY, returns YYYY-MM-DD. 2-digit years are
// assumed 20YY -- fine as long as this tool is used in the 2000s.
function normalizeDate(mm, dd, yy) {
  const year = yy.length === 2 ? `20${yy}` : yy;
  return `${year}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
}

function docNumberFromDate(closingDateISO, suffix) {
  const [y, m, d] = closingDateISO.split('-');
  return `${m}${d}${y}${suffix}`;
}

module.exports = { toNum, normalizeDate, docNumberFromDate };
