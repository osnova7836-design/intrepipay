require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const GRAPHQL_URL = 'https://api.getjobber.com/api/graphql';
const TOKEN_FILE = path.join(__dirname, '../tokens.json');
const TOKEN_URL = 'https://api.getjobber.com/api/oauth/token';

const PAYMENT = {
  ref: '1062087',
  date: '2026-06-11',
  type: 'ACH',
  workOrders: [
    { workOrder: 'SHMV54E4EA35-1', amount: 262.50 },
    { workOrder: 'SHMV44DF033F-2', amount: 150.00 },
    { workOrder: 'SHMV54E5202E-2', amount:  85.00 },
    { workOrder: 'SHMV54E70140-2', amount: 210.00 },
    { workOrder: 'SHMV54E432CC-2', amount: 265.00 },
    { workOrder: 'SHMV54E85D1F-1', amount:  85.00 },
    { workOrder: 'SHMV54E47349-2', amount: 150.00 },
    { workOrder: 'SHMV44E3DF15-2', amount: 295.00 },
  ]
};

async function getToken() {
  let store = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
  if (Date.now() > store.expires_at - 60000) {
    const resp = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: process.env.JOBBER_CLIENT_ID,
        client_secret: process.env.JOBBER_CLIENT_SECRET,
        refresh_token: store.refresh_token,
      })
    });
    const data = await resp.json();
    if (!data.access_token) throw new Error('Token refresh failed: ' + JSON.stringify(data));
    store = { access_token: data.access_token, refresh_token: data.refresh_token, expires_at: Date.now() + (data.expires_in || 3600) * 1000 };
    fs.writeFileSync(TOKEN_FILE, JSON.stringify(store));
  }
  return store.access_token;
}

async function gql(token, query) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const resp = await fetch(GRAPHQL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}`, 'X-JOBBER-GRAPHQL-VERSION': '2025-04-16' },
      body: JSON.stringify({ query })
    });
    const data = await resp.json();
    if (data.errors?.some(e => e.extensions?.code === 'THROTTLED')) {
      console.log('Throttled — waiting 15s...');
      await new Promise(r => setTimeout(r, 15000));
      continue;
    }
    return data;
  }
  throw new Error('Repeatedly throttled by Jobber API');
}

async function findHomeServeInvoices(token) {
  const subjects = PAYMENT.workOrders.map(w => w.workOrder);
  let allInvoices = [];
  let cursor = null;
  let page = 0;

  while (page < 50) {
    const after = cursor ? `(first: 250, after: "${cursor}")` : `(first: 250)`;
    const data = await gql(token, `{
      invoices${after} {
        nodes { id invoiceNumber subject total invoiceStatus client { id name } }
        pageInfo { hasNextPage endCursor }
      }
    }`);

    if (data.errors) throw new Error(data.errors.map(e => e.message).join(', '));

    const nodes = data.data.invoices.nodes;
    // Keep only HomeServe invoices whose subject matches a WO#
    const matched = nodes.filter(inv =>
      /home.?serve/i.test(inv.client?.name || '') &&
      subjects.some(s => inv.subject === s)
    );
    allInvoices.push(...matched);

    if (!data.data.invoices.pageInfo.hasNextPage) break;
    cursor = data.data.invoices.pageInfo.endCursor;
    page++;
    await new Promise(r => setTimeout(r, 500));
  }

  return allInvoices;
}

async function main() {
  const submit = process.argv.includes('--submit');
  const token = await getToken();

  console.log('Searching Jobber for HomeServe invoices...');
  const invoices = await findHomeServeInvoices(token);

  if (!invoices.length) {
    console.error('No matching HomeServe invoices found. Check that WO#s are in the subject field.');
    process.exit(1);
  }

  // Map WO# → invoice
  const bySubject = Object.fromEntries(invoices.map(inv => [inv.subject, inv]));
  const clientId = invoices[0].client.id;

  console.log(`\nFound ${invoices.length}/${PAYMENT.workOrders.length} invoices under client: ${invoices[0].client.name} (${clientId})\n`);

  const matched = [];
  const missing = [];

  for (const wo of PAYMENT.workOrders) {
    const inv = bySubject[wo.workOrder];
    if (inv) {
      console.log(`  ✓ ${wo.workOrder} → Invoice #${inv.invoiceNumber} (${inv.invoiceStatus}) $${inv.total}`);
      matched.push({ ...wo, invoice: inv });
    } else {
      console.log(`  ✗ ${wo.workOrder} → NOT FOUND in Jobber`);
      missing.push(wo);
    }
  }

  if (!matched.length) {
    console.error('\nNothing to apply.');
    process.exit(1);
  }

  const total = matched.reduce((s, m) => s + m.amount, 0);
  console.log(`\nTotal to apply: $${total.toFixed(2)} across ${matched.length} invoices`);
  console.log(`Payment ref: ${PAYMENT.ref} | Date: ${PAYMENT.date} | Type: ${PAYMENT.type}`);

  if (!submit) {
    console.log('\nDRY RUN — re-run with --submit to apply in Jobber');
    return;
  }

  // Apply each invoice payment individually via GraphQL
  let succeeded = 0;
  for (const m of matched) {
    const mutation = `mutation {
      invoicePaymentCreate(input: {
        invoiceId: "${m.invoice.id}"
        amount: ${m.amount}
        paidAt: "${PAYMENT.date}T00:00:00Z"
      }) {
        invoicePayment { id amount }
        userErrors { message }
      }
    }`;
    const resp = await fetch(GRAPHQL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}`, 'X-JOBBER-GRAPHQL-VERSION': '2024-11-15' },
      body: JSON.stringify({ query: mutation })
    });
    const data = await resp.json();
    const errs = data.data?.invoicePaymentCreate?.userErrors;
    if (data.errors || errs?.length) {
      const msg = data.errors?.map(e => e.message).join(', ') || errs.map(e => e.message).join(', ');
      console.log(`  ✗ ${m.workOrder} (#${m.invoice.invoiceNumber}): ${msg}`);
    } else {
      console.log(`  ✓ ${m.workOrder} (#${m.invoice.invoiceNumber}) $${m.amount} applied`);
      succeeded++;
    }
    await new Promise(r => setTimeout(r, 400));
  }

  console.log(`\nDone! ${succeeded}/${matched.length} payments applied.`);
}

main().catch(err => { console.error(err.message); process.exit(1); });
