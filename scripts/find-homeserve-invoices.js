require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const GQL = 'https://api.getjobber.com/api/graphql';
const token = JSON.parse(fs.readFileSync(path.join(__dirname, '../tokens.json'))).access_token;

// Invoice 18290 (SHMV54E4EA35-1, $262.50) — test with $0.01 first
const INVOICE_ID = 'Z2lkOi8vSm9iYmVyL0ludm9pY2UvMTU5MTYxMDI4';

async function tryMutation(version, input) {
  const fields = Object.entries(input).map(([k, v]) =>
    typeof v === 'string' ? `${k}: "${v}"` : `${k}: ${v}`
  ).join('\n        ');

  const r = await fetch(GQL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}`, 'X-JOBBER-GRAPHQL-VERSION': version },
    body: JSON.stringify({ query: `mutation {
      invoicePaymentCreate(input: {
        ${fields}
      }) {
        invoicePayment { id amount }
        userErrors { message }
      }
    }` })
  });
  const d = await r.json();
  console.log(`v${version}:`, JSON.stringify(d));
}

(async () => {
  // Try with checkNumber on different versions
  for (const v of ['2025-04-16', '2023-11-15']) {
    await tryMutation(v, {
      invoiceId: INVOICE_ID,
      amount: 0.01,
      paidAt: '"2026-06-11T00:00:00Z"',
      checkNumber: '1062087',
    });
    await new Promise(r => setTimeout(r, 1000));
  }
})().catch(console.error);
