// Ycheten — verifies a QBO "For Review" bank-feed line against real Jobber
// payment records. The matching logic is BUILT AROUND the payment
// reference number, not amount+date proximity — confirmed live 2026-10-06
// across 6 real items that amount+date alone produces false confidence
// (a $145 item had 2 identical-amount, identical-client candidates only a
// reference number could tell apart) and sometimes QBO's own suggested
// payee is flat wrong (a $100 Zelle labeled "Loretta Johnson" was actually
// "Marina Harmon" — only provable because the Zelle confirmation number
// matched Jobber's record exactly).
//
// Each Jobber payment type carries its own identifying field:
//   CheckPaymentRecord              -> checkNumber
//   CreditCardPaymentRecord         -> ccTransactionNumber
//   JobberPayments*PaymentRecord    -> transactionId
//   AchBankPayment/BankTransfer/CashApp/ETransfer/Other/Paypal/Venmo/Zelle
//                                    -> confirmationNumber
// This pulls every plausible reference token out of the bank feed's raw
// description text automatically (ID:, Conf#, trailing digits after an
// XXXXX mask, etc.) and matches them against those fields directly —
// CONFIRMED only ever means a reference number actually matched. A single
// amount+date candidate with no reference to check against is reported
// separately as UNCONFIRMED_SINGLE_MATCH, never CONFIRMED, since that was
// exactly the kind of false confidence that caused problems before.
//
// Watch out: some payers reuse a constant vendor/batch ID across
// unrelated payments (confirmed: FAHW's "ID:1164427" appeared on two
// different payments on two different dates) — that number will never
// match anything and isn't a bug when it doesn't.
//
// Usage:
//   node scripts/qb-for-review-verify.js --amount 145.00 --date 09/17/2026 \
//     --detail "1ST AME WARRANTY DES:PAYABLES ID:1164427..." \
//     --qbo-payee "Rely Home - CHW/HWA/HSC"
//   node scripts/qb-for-review-verify.js --file items.json   (batch; see ITEM_SHAPE below)
//
// Read-only. Never writes or matches anything in QBO.

const fs = require('fs');
const path = require('path');

const JOBBER_GRAPHQL_URL = 'https://api.getjobber.com/api/graphql';
const TOKEN_FILE = path.join(__dirname, '..', 'tokens.json');
const TOKEN_URL = 'https://api.getjobber.com/api/oauth/token';

// Batch file shape: [{ amount, date: "MM/DD/YYYY", detail, qboPayee, nameHints?: [] }, ...]

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

// Pulls every plausible reference token out of raw bank-feed text:
//   - "Conf# XXXXXXX" / "Conf#XXXXXXX"           -> the code itself
//   - "ID:1164427" / "ID:XXXXX96164"              -> digits (masked or not)
//   - a bare "XXXXX0248" mask anywhere in the text -> its trailing digits
//   - any standalone run of 5+ digits               -> as a last resort
// Short tokens (<4 chars) are dropped — too likely to false-match.
function extractRefCandidates(detail) {
  const found = new Set();
  const confMatch = detail.match(/Conf#\s*([A-Z0-9]+)/i);
  if (confMatch) found.add(confMatch[1]);
  for (const m of detail.matchAll(/ID:\s*X*([0-9]{4,})/gi)) found.add(m[1]);
  for (const m of detail.matchAll(/X{4,}([0-9]{4,})/g)) found.add(m[1]);
  for (const m of detail.matchAll(/\b([0-9]{5,})\b/g)) found.add(m[1]);
  return [...found].filter((s) => s.length >= 4);
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
    nodes { ${PAYMENT_DETAIL_FRAGMENT} }
  } }`;
  const data = await gql(token, q);
  if (data.errors) return [];
  return (data.data?.paymentRecords?.nodes || []).filter((p) => Math.abs(p.amount - amount) < 0.005);
}

// Exact-match only (no substring/includes) — a loose match was the bug
// that falsely tied two different EFTPY numbers together before.
function refMatches(ref, candidates) {
  if (!ref) return false;
  const normRef = String(ref).trim().toUpperCase();
  return candidates.some((c) => normRef === String(c).trim().toUpperCase());
}

async function verifyItem(token, item) {
  const dateObj = parseLooseDate(item.date);
  const refCandidates = extractRefCandidates(item.detail);

  const clientIds = new Map();
  for (const name of [item.qboPayee, ...(item.nameHints || [])].filter(Boolean)) {
    for (const c of await findClientIds(token, name)) clientIds.set(c.id, c.name);
  }

  let all = [];
  for (const [clientId] of clientIds) {
    all.push(...(await findPaymentsForClient(token, clientId, item.amount, dateObj, 21)));
    await sleep(150);
  }
  const seen = new Set();
  all = all.filter((p) => {
    const key = `${p.entryDate}|${p.invoice?.invoiceNumber}|${p.amount}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  if (!all.length) return { ...item, status: 'NOT_FOUND', refCandidates, reason: `no payment at $${item.amount} found for any of [${[...clientIds.values()].join(', ')}] within +/-21 days` };

  // The ONLY path to CONFIRMED: a reference number actually matched.
  if (refCandidates.length) {
    const refHits = all.filter((p) => refMatches(extractRef(p), refCandidates));
    if (refHits.length === 1) {
      const p = refHits[0];
      return { ...item, status: 'CONFIRMED', refCandidates, via: `reference match (${p.__typename}: ${extractRef(p)})`, invoiceNumber: p.invoice?.invoiceNumber, client: p.client?.name, entryDate: p.entryDate, payeeMatchesQbo: p.client?.name === item.qboPayee };
    }
    if (refHits.length > 1) {
      return { ...item, status: 'AMBIGUOUS', refCandidates, reason: `reference matched ${refHits.length} different payments`, candidates: refHits.map((p) => `#${p.invoice?.invoiceNumber} (${p.client?.name}) ref=${extractRef(p)} ${p.entryDate}`) };
    }
  }

  // No reference proof available or none matched -- report candidates
  // honestly, never upgrade a bare amount+date hit to CONFIRMED.
  const uniqueClients = new Set(all.map((p) => p.client?.name));
  if (all.length === 1) {
    const p = all[0];
    return { ...item, status: 'UNCONFIRMED_SINGLE_MATCH', refCandidates, reason: 'only one candidate, but no reference number to prove it', invoiceNumber: p.invoice?.invoiceNumber, client: p.client?.name, entryDate: p.entryDate, ref: extractRef(p), payeeMatchesQbo: p.client?.name === item.qboPayee };
  }
  return { ...item, status: 'AMBIGUOUS', refCandidates, reason: `${all.length} matching payments across ${uniqueClients.size} client(s), no reference number matched any of them`, candidates: all.map((p) => `#${p.invoice?.invoiceNumber} (${p.client?.name}) ref=${extractRef(p) || '(none)'} ${p.entryDate}`) };
}

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
  const file = get('--file');
  if (file) return { items: JSON.parse(fs.readFileSync(file, 'utf8')) };
  const amount = get('--amount');
  if (!amount) {
    console.log('Usage: node scripts/qb-for-review-verify.js --amount <n> --date MM/DD/YYYY --detail "<bank text>" --qbo-payee "<name>" [--name-hint "<name>" ...]');
    console.log('   or: node scripts/qb-for-review-verify.js --file <items.json>');
    process.exit(1);
  }
  const nameHints = [];
  args.forEach((a, i) => { if (a === '--name-hint') nameHints.push(args[i + 1]); });
  return { items: [{ amount: parseFloat(amount), date: get('--date'), detail: get('--detail') || '', qboPayee: get('--qbo-payee') || '', nameHints }] };
}

async function main() {
  const { items } = parseArgs();
  const token = await getToken();
  for (const item of items) {
    const result = await verifyItem(token, item);
    console.log(`\n$${item.amount} ${item.date} [QBO suggests: ${item.qboPayee || '(none given)'}]`);
    console.log(`  bank detail: ${item.detail}`);
    console.log(`  extracted reference candidates: ${result.refCandidates.length ? result.refCandidates.join(', ') : '(none found in text)'}`);
    console.log(`  status: ${result.status}`);
    if (result.status === 'CONFIRMED') {
      console.log(`  -> Jobber invoice #${result.invoiceNumber} (${result.client}), paid ${result.entryDate}`);
      console.log(`  via: ${result.via}`);
      if (!result.payeeMatchesQbo) console.log(`  !! QBO's suggested payee ("${item.qboPayee}") does NOT match the real client ("${result.client}")`);
    } else if (result.status === 'UNCONFIRMED_SINGLE_MATCH') {
      console.log(`  -> only candidate: Jobber invoice #${result.invoiceNumber} (${result.client}), paid ${result.entryDate}, ref=${result.ref || '(none)'}`);
      console.log(`  ${result.reason} -- use judgment, this is not proof-grade`);
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
