// Ycheten — verifies QBO "For Review" bank-feed lines against real Jobber
// payment records, the same way qb-verify-checklog.js verifies a check log
// against checkNumber.
//
// Confirmed live 2026-10-06 (FAHW $145 case): the bank ACH description's
// "ID:XXXXXXX" number is often a CONSTANT vendor/batch id the payer reuses
// across unrelated payments (confirmed: FAHW's "ID:1164427" appeared on
// both this $145 item AND a completely different $1,555 payment from a
// different date) — NOT a per-transaction reference, so it never matches
// anything and isn't worth comparing against. The real per-payment key is
// each payment type's own identifying field in Jobber:
//   CheckPaymentRecord              -> checkNumber
//   CreditCardPaymentRecord         -> ccTransactionNumber
//   JobberPayments*PaymentRecord    -> transactionId
//   AchBankPayment/BankTransfer/CashApp/ETransfer/Other/Paypal/Venmo/Zelle
//                                    -> confirmationNumber (e.g. FAHW's
//                                       "EFTPY061919" — this IS unique per
//                                       payment and is what finally proved
//                                       the $145 case against two identical-
//                                       amount, identical-client decoys)
//
// Uses the top-level `paymentRecords(filter: {clientId, entryDate})` query
// (confirmed live 2026-10-06 it exists, 30k+ records, filterable) instead
// of walking each invoice's own paymentRecords — faster, and crucially
// also surfaces UNAPPLIED payments an invoice-based search would miss
// entirely (the $145 case: the real payment was recorded on invoice
// #20978, but a `paymentRecords` global scan found it in one query instead
// of needing to already know which invoice to check).
//
// Read-only. Reports CONFIRMED (via confirmationNumber/checkNumber/etc, OR
// a single clean amount+date match with nothing else to prove against) /
// AMBIGUOUS / NOT_FOUND per item — never auto-matches anything in QBO.

const fs = require('fs');
const path = require('path');

const JOBBER_GRAPHQL_URL = 'https://api.getjobber.com/api/graphql';
const TOKEN_FILE = path.join(__dirname, '..', 'tokens.json');
const TOKEN_URL = 'https://api.getjobber.com/api/oauth/token';

// refCandidates: every ID-looking token pulled from the raw bank detail —
// full numbers where visible, trailing digits where QBO masked them. Any
// one matching a payment's confirmationNumber/checkNumber/etc counts as
// proof. nameHints: every client name worth trying, QBO's suggested payee
// included but never trusted alone (confirmed wrong before — the $145
// case: QBO said "Rely Home", the real client was FAHW).
const ITEMS = [
  // Resolved 2026-10-06 outside this script: QBO's own suggested-matches
  // list independently surfaced "Payment EFTPY061919 09/14/2026 $145.00
  // FAHW" -- exactly matching Jobber invoice #20978's confirmationNumber.
  // "1164427" is FAHW's constant vendor/batch id (confirmed it also
  // appears on an unrelated $1,555 payment from a different date) -- never
  // a usable refCandidate, intentionally left out here.
  { amount: 145.00, date: '09/17/2026', qboPayee: 'Rely Home - CHW/HWA/HSC', bankDetail: '1ST AME WARRANTY DES:PAYABLES ID:1164427 INDN:TB PLUMBING CO ID:XXXXX96164 PPD', nameHints: ['Rely Home', 'FIRST AMERICAN HOME WARRENTY'], refCandidates: [] },
  { amount: 65.00, date: '09/09/2026', qboPayee: 'Rely Home - CHW/HWA/HSC', bankDetail: 'BKOFAMERICA MOBILE 09/09 XXXXX02527 DEPOSIT *MOBILE FL', nameHints: ['Rely Home'], refCandidates: ['02527', '2527'] },
  { amount: 90.00, date: '10/01/2026', qboPayee: 'Rely Home - CHW/HWA/HSC', bankDetail: 'Cinch PMD DES:PAYMENT ID:XXXXX7095 INDN:TBPlumbing.Receivables CO ID:XXXXX32275 CCD', nameHints: ['Rely Home', 'Cinch'], refCandidates: ['7095', '32275'] },
  { amount: 165.00, date: '09/28/2026', qboPayee: 'Old Republic Home Protection - ORHP', bankDetail: 'BKOFAMERICAATM 09/25 XXXXX3391 DEPOSIT CLERMONT CLERMONT FL CKCD XXXXXXXXXX078679', nameHints: ['Old Republic'], refCandidates: ['3391', '078679', '78679'] },
  { amount: 75.00, date: '09/23/2026', qboPayee: 'Jamain Braxton', bankDetail: 'XXXXX0248 DES:AHI LLC OP ID: INDN:THE BEST PLUMBING GROU CO ID:XXXXX03566 CCD', nameHints: ['Jamain Braxton', 'AHI'], refCandidates: ['0248', '248', '03566', '3566'] },
  { amount: 100.00, date: '09/10/2026', qboPayee: 'Loretta Johnson', bankDetail: 'Zelle payment from MARINA HARMON for "TOILET"; Conf# T22MSKBWV', nameHints: ['Loretta Johnson', 'Marina Harmon'], refCandidates: ['T22MSKBWV'] },
];

async function getToken() {
  require('dotenv').config();
  let store = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
  if (!store.expires_at || Date.now() > store.expires_at - 60000) {
    const resp = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', client_id: process.env.JOBBER_CLIENT_ID, client_secret: process.env.JOBBER_CLIENT_SECRET, refresh_token: store.refresh_token }),
    });
    const text = await resp.text();
    let data;
    try { data = JSON.parse(text); } catch (e) { throw new Error(`Jobber token refresh returned non-JSON (status ${resp.status}): ${text.slice(0, 300)}`); }
    if (!data.access_token) throw new Error('Jobber token refresh failed: ' + JSON.stringify(data));
    store = { access_token: data.access_token, refresh_token: data.refresh_token, expires_at: Date.now() + (data.expires_in || 3600) * 1000 };
    fs.writeFileSync(TOKEN_FILE, JSON.stringify(store));
  }
  return store.access_token;
}

async function gql(token, query, attempt = 0) {
  const resp = await fetch(JOBBER_GRAPHQL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-JOBBER-GRAPHQL-VERSION': '2023-11-15' },
    body: JSON.stringify({ query }),
  });
  const text = await resp.text();
  try {
    return JSON.parse(text);
  } catch (e) {
    if (attempt < 2) { await sleep(1000); return gql(token, query, attempt + 1); }
    throw new Error(`Jobber GraphQL returned non-JSON after retries (status ${resp.status}): ${text.slice(0, 300)}`);
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function parseLooseDate(s) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(String(s).trim());
  if (!m) return null;
  let year = Number(m[3]);
  if (year < 100) year += 2000;
  return new Date(year, Number(m[1]) - 1, Number(m[2]));
}

async function findClientIds(token, name) {
  const q = `{ clients(searchTerm: ${JSON.stringify(name)}, first: 5) { nodes { id name } } }`;
  const data = await gql(token, q);
  if (data.errors) return [];
  return data.data?.clients?.nodes || [];
}

const PAYMENT_DETAIL_FRAGMENT = `
  __typename amount entryDate client { name }
  invoice { invoiceNumber }
  ... on CheckPaymentRecord { checkNumber }
  ... on CreditCardPaymentRecord { ccTransactionNumber }
  ... on AchBankPaymentPaymentRecord { confirmationNumber }
  ... on BankTransferPaymentRecord { confirmationNumber }
  ... on CashAppPaymentRecord { confirmationNumber }
  ... on ETransferPaymentRecord { confirmationNumber }
  ... on OtherPaymentRecord { confirmationNumber }
  ... on PaypalPaymentRecord { confirmationNumber }
  ... on VenmoPaymentRecord { confirmationNumber }
  ... on ZellePaymentRecord { confirmationNumber }
  ... on JobberPaymentsACHPaymentRecord { transactionId }
  ... on JobberPaymentsCreditCardPaymentRecord { transactionId }
`;

function extractRef(pr) {
  return pr.checkNumber || pr.ccTransactionNumber || pr.confirmationNumber || pr.transactionId || null;
}

async function findPaymentsForClient(token, clientId, amount, dateObj, windowDays) {
  const after = new Date(dateObj.getTime() - windowDays * 86400000).toISOString();
  const before = new Date(dateObj.getTime() + windowDays * 86400000).toISOString();
  const q = `{ paymentRecords(filter: { clientId: "${clientId}", entryDate: { after: ${JSON.stringify(after)}, before: ${JSON.stringify(before)} } }, first: 50) {
    totalCount
    nodes { ${PAYMENT_DETAIL_FRAGMENT} }
  } }`;
  const data = await gql(token, q);
  if (data.errors) return [];
  return (data.data?.paymentRecords?.nodes || []).filter((p) => Math.abs(p.amount - amount) < 0.005);
}

function refMatches(ref, candidates) {
  if (!ref) return false;
  const normRef = String(ref).trim().toUpperCase();
  return candidates.some((c) => {
    const normC = String(c).trim().toUpperCase();
    return normRef.includes(normC) || normC.includes(normRef);
  });
}

async function verifyItem(token, item) {
  const dateObj = parseLooseDate(item.date);

  // Resolve every name hint to candidate client IDs (QBO's own suggested
  // payee is included but never trusted alone).
  const clientIds = new Map();
  for (const name of [item.qboPayee, ...(item.nameHints || [])]) {
    for (const c of await findClientIds(token, name)) clientIds.set(c.id, c.name);
  }

  let all = [];
  for (const [clientId, clientName] of clientIds) {
    const found = await findPaymentsForClient(token, clientId, item.amount, dateObj, 21);
    await sleep(150);
    all.push(...found);
  }
  // De-dupe by entryDate+invoice (payment ids aren't returned by this query shape, but this combo is unique enough in practice).
  const seen = new Set();
  all = all.filter((p) => {
    const key = `${p.entryDate}|${p.invoice?.invoiceNumber}|${p.amount}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  if (!all.length) return { ...item, status: 'NOT_FOUND', reason: `no payment at $${item.amount} found for any of [${[...clientIds.values()].join(', ')}] within +/-21 days` };

  if (item.refCandidates.length) {
    const refHits = all.filter((p) => refMatches(extractRef(p), item.refCandidates));
    if (refHits.length === 1) {
      const p = refHits[0];
      return { ...item, status: 'CONFIRMED', via: `reference match (${p.__typename}: ${extractRef(p)})`, invoiceNumber: p.invoice?.invoiceNumber, client: p.client?.name, entryDate: p.entryDate, payeeMatchesQbo: p.client?.name === item.qboPayee };
    }
    if (refHits.length > 1) {
      return { ...item, status: 'AMBIGUOUS', reason: `reference matched ${refHits.length} different payments`, candidates: refHits.map((p) => `#${p.invoice?.invoiceNumber} (${p.client?.name}) ref=${extractRef(p)} ${p.entryDate}`) };
    }
  }

  if (all.length === 1) {
    const p = all[0];
    return { ...item, status: 'CONFIRMED', via: 'single amount+date match (no reference# to confirm further)', invoiceNumber: p.invoice?.invoiceNumber, client: p.client?.name, entryDate: p.entryDate, payeeMatchesQbo: p.client?.name === item.qboPayee };
  }

  const uniqueClients = new Set(all.map((p) => p.client?.name));
  return { ...item, status: 'AMBIGUOUS', reason: `${all.length} matching payments across ${uniqueClients.size} client(s)${item.refCandidates.length ? ', none of their reference numbers matched' : ''}`, candidates: all.map((p) => `#${p.invoice?.invoiceNumber} (${p.client?.name}) ref=${extractRef(p) || '(none)'} ${p.entryDate}`) };
}

async function main() {
  const token = await getToken();
  for (const item of ITEMS) {
    const result = await verifyItem(token, item);
    console.log(`\n$${item.amount} ${item.date} [QBO suggests: ${item.qboPayee}]`);
    console.log(`  bank detail: ${item.bankDetail}`);
    console.log(`  status: ${result.status}`);
    if (result.status === 'CONFIRMED') {
      console.log(`  -> Jobber invoice #${result.invoiceNumber} (${result.client}), paid ${result.entryDate}`);
      console.log(`  via: ${result.via}`);
      if (!result.payeeMatchesQbo) console.log(`  !! QBO's suggested payee ("${item.qboPayee}") does NOT match the real client ("${result.client}")`);
    } else {
      console.log(`  ${result.reason}`);
      if (result.candidates) for (const c of result.candidates) console.log(`    - ${c}`);
    }
    await sleep(200);
  }
}

main().catch((err) => {
  console.error('FATAL', err.message);
  process.exit(1);
});
