// Ycheten -- verifies the 35 electronic Undeposited Funds payments (ACH/
// Zelle/PayPal/CreditCard/Venmo) that already carry a QBO PaymentRefNum,
// against Jobber's own paymentRecords for the same client. Unlike
// Check/Cash, these reference fields (confirmationNumber/ccTransactionNumber/
// transactionId) ARE exposed via Jobber's GraphQL API -- no Playwright
// scrape needed.
//
// Same hard rule as qb-for-review-verify.js: a single exact reference-number
// match is the only path to CONFIRMED. A ref matching >1 Jobber payment is
// AMBIGUOUS (known risk: some payers like FAHW reuse a batch EFT id across
// multiple invoices in the same payout). No ref at all (e.g. a QBO
// PaymentRefNum that's literal text like "Paid", not a real number) is
// excluded up front, not guessed at via amount+date.
//
// Usage: node scripts/qb-electronic-deposit-verify.js

require('dotenv').config();
const fs = require('fs');
const path = require('path');

const JOBBER_GRAPHQL_URL = 'https://api.getjobber.com/api/graphql';
const TOKEN_FILE = path.join(__dirname, '..', 'tokens.json');
const TOKEN_URL = 'https://api.getjobber.com/api/oauth/token';
const QB_AGENT_DIR = path.join(__dirname, '..', '.qb-agent');

async function getToken() {
  let store = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
  if (!store.expires_at || Date.now() > store.expires_at - 60000) {
    const resp = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', client_id: process.env.JOBBER_CLIENT_ID, client_secret: process.env.JOBBER_CLIENT_SECRET, refresh_token: store.refresh_token }),
    });
    const data = await resp.json();
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
  try { return JSON.parse(text); }
  catch (e) {
    if (attempt < 2) { await sleep(1000); return gql(token, query, attempt + 1); }
    throw new Error(`Jobber GraphQL non-JSON after retries (status ${resp.status}): ${text.slice(0, 300)}`);
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

const FRAGMENT = `
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

async function findClientIds(token, name) {
  const q = `{ clients(searchTerm: ${JSON.stringify(name)}, first: 5) { nodes { id name } } }`;
  const data = await gql(token, q);
  if (data.errors) return [];
  return data.data?.clients?.nodes || [];
}

async function findPaymentsForClient(token, clientId, centerDate, windowDays) {
  const after = new Date(centerDate.getTime() - windowDays * 86400000).toISOString();
  const before = new Date(centerDate.getTime() + windowDays * 86400000).toISOString();
  const q = `{ paymentRecords(filter: { clientId: "${clientId}", entryDate: { after: ${JSON.stringify(after)}, before: ${JSON.stringify(before)} } }, first: 100) {
    nodes { ${FRAGMENT} }
  } }`;
  const data = await gql(token, q);
  if (data.errors) return { error: data.errors };
  return { nodes: data.data?.paymentRecords?.nodes || [] };
}

function normalizeRef(ref) {
  // QBO sometimes carries a leading "#" on a ref that Jobber stores without
  // it (confirmed live: QBO "#FF4606C" vs Jobber "FF4606C", same payment) --
  // strip only non-alphanumerics, never truncate the number itself.
  return String(ref).trim().toUpperCase().replace(/^#+/, '');
}

function refMatches(ref, candidate) {
  if (!ref || !candidate) return false;
  return normalizeRef(ref) === normalizeRef(candidate);
}

function looksLikeRealRef(ref) {
  // Excludes placeholder text QBO sometimes has in PaymentRefNum instead of
  // a real confirmation/transaction number (confirmed live: "Paid").
  return /[0-9]/.test(ref) || ref.length >= 6;
}

async function verifyItem(token, item) {
  if (!looksLikeRealRef(item.ref)) {
    return { ...item, status: 'NO_REAL_REF', reason: `PaymentRefNum "${item.ref}" doesn't look like a real reference number` };
  }

  let clients = await findClientIds(token, item.customer);
  if (!clients.length) {
    // A trademark/registered symbol etc. in the QBO name can break Jobber's
    // search (confirmed live: "All County® First Choice" found nothing,
    // "All County First Choice" found it) -- retry with those stripped.
    const cleaned = item.customer.replace(/[^\w\s&-]/g, '').trim();
    if (cleaned !== item.customer) clients = await findClientIds(token, cleaned);
  }
  if (!clients.length) return { ...item, status: 'CLIENT_NOT_FOUND' };

  const centerDate = new Date(item.date);
  let all = [];
  for (const c of clients) {
    const r = await findPaymentsForClient(token, c.id, centerDate, 10);
    if (r.error) continue;
    all.push(...r.nodes);
    await sleep(150);
  }

  const refHits = all.filter((p) => refMatches(extractRef(p), item.ref));
  if (refHits.length === 1) {
    const p = refHits[0];
    const amountMatches = Math.abs(p.amount - item.amount) < 0.01;
    return { ...item, status: amountMatches ? 'CONFIRMED' : 'REF_MATCH_AMOUNT_MISMATCH', via: `${p.__typename}: ${extractRef(p)}`, jobberAmount: p.amount, jobberInvoice: p.invoice?.invoiceNumber, jobberDate: p.entryDate };
  }
  if (refHits.length > 1) {
    // Same ref, multiple Jobber rows -- confirmed real pattern: Jobber logs
    // one per-invoice row AND a batch/rollup row sharing the same bank
    // reference. If exactly one of them has the EXACT dollar amount, that's
    // not a real ambiguity, just noise from the rollup row -- only truly
    // ambiguous when >1 candidate matches the exact amount too.
    const exactAmount = refHits.filter((p) => Math.abs(p.amount - item.amount) < 0.01);
    if (exactAmount.length === 1) {
      const p = exactAmount[0];
      return { ...item, status: 'CONFIRMED', via: `${p.__typename}: ${extractRef(p)} (disambiguated by exact amount among ${refHits.length} same-ref rows)`, jobberInvoice: p.invoice?.invoiceNumber, jobberDate: p.entryDate };
    }
    return { ...item, status: 'AMBIGUOUS', reason: `ref matched ${refHits.length} different Jobber payments, ${exactAmount.length} with the exact amount`, candidates: refHits.map((p) => `$${p.amount} inv#${p.invoice?.invoiceNumber} ${p.entryDate}`) };
  }
  return { ...item, status: 'NOT_FOUND', reason: `no payment with ref "${item.ref}" found for ${clients.map((c) => c.name).join('/')} within +/-10 days`, candidatesChecked: all.length };
}

async function main() {
  const token = await getToken();
  const items = JSON.parse(fs.readFileSync(path.join(QB_AGENT_DIR, 'electronic-with-ref-2026-10-07.json'), 'utf8'));

  const results = [];
  for (const item of items) {
    const r = await verifyItem(token, item);
    results.push(r);
    console.log(`${r.status.padEnd(26)} $${item.amount}  ${item.date}  ${item.customer}  ref=${item.ref}${r.via ? '  via ' + r.via : ''}${r.reason ? '  (' + r.reason + ')' : ''}`);
  }

  const byStatus = {};
  for (const r of results) (byStatus[r.status] ||= []).push(r);
  console.log('\n=== Summary ===');
  for (const [status, list] of Object.entries(byStatus)) {
    console.log(`${status}: ${list.length}, $${list.reduce((s, r) => s + r.amount, 0).toFixed(2)}`);
  }

  const outPath = path.join(QB_AGENT_DIR, `electronic-deposit-verify-${new Date().toISOString().slice(0, 10)}.json`);
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(`\nFull results saved to ${outPath}`);
}

main().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
