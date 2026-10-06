// QBO (QuickBooks Online) API client — thin wrapper around the passthrough
// routes on the deployed intrepipay-app server (/api/qbo/invoice/:id,
// /api/qbo/customer/:id). That server holds the real OAuth tokens
// (connected live 2026-10-06 via https://intrepipay.com/auth/quickbooks);
// this script never needs them locally.
//
// Replaces scraping the QBO web UI with Playwright, which hit repeated
// timing bugs (stale-draft loads, SPA render races, 30-60s per lookup) —
// this returns real JSON in under a second.
require('dotenv').config();

const { WORKER_SECRET } = process.env;
const API_BASE = 'https://intrepipay.com';

async function qboFetch(path) {
  const resp = await fetch(`${API_BASE}${path}`, {
    headers: { 'x-worker-secret': WORKER_SECRET },
    redirect: 'follow',
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(`QBO API ${resp.status}: ${JSON.stringify(data)}`);
  return data;
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
    const data = await qboFetch(`/api/qbo/invoice/${id}`);
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
    const data = await qboFetch(`/api/qbo/customer/${id}`);
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

module.exports = { getQboInvoice, getQboCustomer };

if (require.main === module) {
  const link = process.argv[2];
  if (!link) {
    console.log('Usage: node scripts/qbo-api.js <qboLink>');
    process.exit(1);
  }
  (async () => {
    const result = link.includes('nameId') ? await getQboCustomer(link) : await getQboInvoice(link);
    console.log(JSON.stringify(result, null, 2));
  })();
}
