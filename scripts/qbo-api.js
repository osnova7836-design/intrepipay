// QBO (QuickBooks Online) API client — calls Intuit's API directly using a
// LOCALLY stored token (D:\TrackPoint\qbo-tokens.json, gitignored).
//
// Confirmed live 2026-10-06: routing every call through the deployed
// intrepipay-app server broke the same night it was built — Render's
// free-tier disk is wiped on ANY redeploy (even one unrelated to
// server.js), which silently killed the QBO connection. The fix: only the
// INITIAL authorization-code exchange needs that public HTTPS server
// (Intuit's Production redirect_uri rules require it); refreshing a token
// needs no redirect_uri at all, so once seeded, this script refreshes and
// calls quickbooks.api.intuit.com directly — completely decoupled from
// Render's redeploy cycle from then on.
//
// One-time setup after connecting (or reconnecting) via
// https://intrepipay.com/auth/quickbooks:
//   node scripts/qbo-api.js --pull-tokens
// pulls the current tokens down from the server once and saves them here.
// After that, this file refreshes itself locally — no server involved.
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const { QUICKBOOKS_CLIENT_ID, QUICKBOOKS_CLIENT_SECRET, WORKER_SECRET } = process.env;
const QBO_TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const QBO_API_BASE = 'https://quickbooks.api.intuit.com';
const TOKEN_FILE = path.join(__dirname, '..', 'qbo-tokens.json');

function loadTokens() {
  try {
    if (fs.existsSync(TOKEN_FILE)) return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
  } catch (e) {}
  return { access_token: null, refresh_token: null, expires_at: null, realm_id: null };
}

function saveTokens(t) {
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(t, null, 2));
}

function basicAuthHeader() {
  return 'Basic ' + Buffer.from(`${QUICKBOOKS_CLIENT_ID}:${QUICKBOOKS_CLIENT_SECRET}`).toString('base64');
}

async function pullTokensFromServer() {
  const resp = await fetch('https://intrepipay.com/api/qbo/tokens', {
    headers: { 'x-worker-secret': WORKER_SECRET },
    redirect: 'follow',
  });
  const data = await resp.json();
  if (!data.access_token) throw new Error('Server has no QBO tokens — visit https://intrepipay.com/auth/quickbooks first');
  saveTokens(data);
  console.log('Pulled tokens from server. realm_id:', data.realm_id);
}

async function getValidAccessToken() {
  let t = loadTokens();
  if (!t.access_token) throw new Error('No local QBO tokens — run: node scripts/qbo-api.js --pull-tokens');

  if (Date.now() > t.expires_at - 60000) {
    const resp = await fetch(QBO_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        Authorization: basicAuthHeader(),
      },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: t.refresh_token }),
    });
    const data = await resp.json();
    if (!data.access_token) throw new Error('QBO refresh failed: ' + JSON.stringify(data));
    t = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Date.now() + (data.expires_in || 3600) * 1000,
      realm_id: t.realm_id,
    };
    saveTokens(t);
  }
  return t;
}

async function qboApiGet(pathSuffix) {
  const { access_token, realm_id } = await getValidAccessToken();
  const resp = await fetch(`${QBO_API_BASE}/v3/company/${realm_id}${pathSuffix}`, {
    headers: { Authorization: `Bearer ${access_token}`, Accept: 'application/json' },
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(`QBO API ${resp.status}: ${JSON.stringify(data)}`);
  return data;
}

// Read-only QBO SQL-like query passthrough (SELECT ... FROM <Entity> WHERE
// ...), e.g. used to find every Payment sharing a given PaymentRefNum —
// confirmed live 2026-10-06 that QBO silently SPLITS one large check into
// several separate Payment records (likely a per-Payment line-item cap),
// and sometimes leaves orphaned zero-line duplicates behind from failed or
// repeated entry — both only discoverable by querying, not from a single
// invoice/customer lookup.
async function qboQuery(sql) {
  const { access_token, realm_id } = await getValidAccessToken();
  const url = `${QBO_API_BASE}/v3/company/${realm_id}/query?query=${encodeURIComponent(sql)}`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${access_token}`, Accept: 'application/json' } });
  const data = await resp.json();
  if (!resp.ok) throw new Error(`QBO query failed ${resp.status}: ${JSON.stringify(data)}`);
  return data;
}

async function qboPost(pathSuffix, body) {
  const { access_token, realm_id } = await getValidAccessToken();
  const url = `${QBO_API_BASE}/v3/company/${realm_id}${pathSuffix}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${access_token}`, Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(`QBO POST ${pathSuffix} failed ${resp.status}: ${JSON.stringify(data)}`);
  return data;
}

// Creates a real Deposit moving ONE payment out of Undeposited Funds into
// the actual bank account -- confirmed live 2026-10-07 for the Undeposited
// Funds backlog cleanup (each confirmed payment gets its OWN deposit, no
// grouping-by-date guessing about how they were actually bundled at the
// bank, per Os's explicit call). Uses the payment's own TxnDate so the
// deposit lands on the real historical date the money came in, not today.
async function createDepositForPayment({ paymentId, amount, txnDate, bankAccountId }) {
  const body = {
    TxnDate: txnDate,
    DepositToAccountRef: { value: bankAccountId },
    Line: [{ Amount: amount, LinkedTxn: [{ TxnId: paymentId, TxnType: 'Payment', TxnLineId: '0' }] }],
  };
  return qboPost('/deposit', body);
}

// Creates a 2-line Journal Entry (one debit, one credit) -- used for the
// recurring manual reclass entries (credit card clearing accounts, loan
// interest splits) that Mrs. Kevin does by hand every month. Matches the
// exact shape of the historical entries already in QBO.
async function createJournalEntry({ txnDate, docNumber, debitAccountId, creditAccountId, amount, description }) {
  const body = {
    TxnDate: txnDate,
    DocNumber: docNumber,
    Line: [
      { Amount: amount, DetailType: 'JournalEntryLineDetail', Description: description, JournalEntryLineDetail: { PostingType: 'Debit', AccountRef: { value: debitAccountId } } },
      { Amount: amount, DetailType: 'JournalEntryLineDetail', Description: description, JournalEntryLineDetail: { PostingType: 'Credit', AccountRef: { value: creditAccountId } } },
    ],
  };
  return qboPost('/journalentry', body);
}

function txnIdFromLink(qboLink) {
  const m = (qboLink || '').match(/txnId=(\d+)/);
  return m ? m[1] : null;
}
function nameIdFromLink(qboLink) {
  const m = (qboLink || '').match(/nameId=(\d+)/);
  return m ? m[1] : null;
}

async function getQboInvoice(qboLink) {
  const id = txnIdFromLink(qboLink);
  if (!id) return { error: 'no txnId in link' };
  try {
    const data = await qboApiGet(`/invoice/${id}`);
    const inv = data.Invoice;
    return {
      id,
      docNumber: inv.DocNumber,
      total: inv.TotalAmt,
      balance: inv.Balance,
      customer: inv.CustomerRef?.name,
      txnDate: inv.TxnDate,
    };
  } catch (err) {
    return { error: err.message };
  }
}

async function getQboCustomer(qboLink) {
  const id = nameIdFromLink(qboLink);
  if (!id) return { error: 'no nameId in link' };
  try {
    const data = await qboApiGet(`/customer/${id}`);
    const c = data.Customer;
    return {
      id,
      name: c.DisplayName,
      email: c.PrimaryEmailAddr?.Address,
      phone: c.PrimaryPhone?.FreeFormNumber,
      address: c.BillAddr ? `${c.BillAddr.Line1 || ''}, ${c.BillAddr.City || ''}, ${c.BillAddr.CountrySubDivisionCode || ''} ${c.BillAddr.PostalCode || ''}`.trim() : null,
      balance: c.Balance,
    };
  } catch (err) {
    return { error: err.message };
  }
}

module.exports = { getQboInvoice, getQboCustomer, pullTokensFromServer, qboQuery, createDepositForPayment, createJournalEntry };

if (require.main === module) {
  if (process.argv.includes('--pull-tokens')) {
    pullTokensFromServer().then(() => process.exit(0)).catch((e) => { console.error(e.message); process.exit(1); });
  } else {
    const link = process.argv[2];
    if (!link) {
      console.log('Usage: node scripts/qbo-api.js --pull-tokens   (one-time, after (re)connecting)');
      console.log('       node scripts/qbo-api.js <qboLink>        (test a lookup)');
      process.exit(1);
    }
    (async () => {
      const result = link.includes('nameId') ? await getQboCustomer(link) : await getQboInvoice(link);
      console.log(JSON.stringify(result, null, 2));
    })();
  }
}
