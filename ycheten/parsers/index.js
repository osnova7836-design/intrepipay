// Single source of truth for registered statement parsers -- same pattern
// as collector/sources/index.js: a parser that exists as a file but isn't
// required here silently never gets tried (see collector/sources/index.js's
// own comment for why that's a real risk, not a hypothetical one).
//
// WEX fuel card, GMC Yukon (GTE Financial), and Ford Transit (BofA) loan
// statements get added here once a real example of each has been seen --
// see ycheten/parsers/homedepot.js and lowes.js for the pattern: detect by
// a distinctive string, extract closingDate/purchases/credits by regex,
// return netAmount + the fixed debit/credit accounts for that vendor.
const parsers = {
  homedepot: require('./homedepot'),
  lowes: require('./lowes'),
};

// Tries every registered parser's looksLikeThisVendor() against the PDF
// text and returns the first match. Statements aren't ambiguous between
// vendors in practice (each carries its own name all over the page), so
// first-match is fine -- this isn't scoring confidence, it's elimination.
function detectAndParse(text) {
  for (const [key, parser] of Object.entries(parsers)) {
    if (parser.looksLikeThisVendor(text)) {
      return { parserKey: key, ...parser.parse(text) };
    }
  }
  return { ok: false, error: 'Could not identify this statement. Recognized vendors: ' + Object.keys(parsers).join(', ') + '. If this is a new vendor (WEX, GTE Financial, Bank of America), it needs its own parser added first.' };
}

module.exports = { parsers, detectAndParse };
