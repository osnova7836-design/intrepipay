'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const GRAPHQL_URL = 'https://api.getjobber.com/api/graphql';
const TOKEN_FILE  = path.join(__dirname, '..', 'tokens.json');
const TOKEN_URL   = 'https://api.getjobber.com/api/oauth/token';
const { JOBBER_CLIENT_ID, JOBBER_CLIENT_SECRET } = process.env;

// ── Invoice NUMBERS to reopen (from the #XXXXX column in TrackPoint) ──────────
const TARGET_NUMBERS = new Set([
  // Batch 1
  13859, 13864, 13881, 13885, 13890, 13902, 13904, 13914, 13943, 13945,
  13968, 13969, 14004, 14005, 14010, 14011, 14033, 14044, 14048, 14099,
  14100, 14109, 14127, 14128, 14135, 14139, 14151, 14168, 14196, 14197,
  14208, 14210, 14213, 14216, 14221, 14236, 14278, 14280, 14282, 14300,
  14301, 14310, 14316, 14317, 14318, 14320, 14321, 14325, 14326, 14336,
  14344, 14350, 14351, 14353, 14355, 14376, 14377, 14395, 14440, 14442,
  14443, 14444, 14457, 14458, 14459, 14461, 14462, 14464, 14469, 14475,
  14486, 14505, 14520, 14552, 14553, 14574, 14590, 14670, 14854, 14874,
  15089, 15197, 15198, 15200, 15215, 15845, 15847, 15848, 15880, 15881,
  15882, 15883, 15884, 15924, 15928, 15929, 15930, 15938, 15939, 15951,
  15952, 15953, 15954, 15955, 15956, 15978, 17564, 17567, 18752, 18801,
  // Batch 2
  13696, 13699, 13704, 13725, 13726, 13730, 13735, 13737, 13744, 13749,
  13750, 13759, 13760, 13766, 13778, 13795, 13803, 13855, 13858, 13860,
  13862, 13872, 13888, 13903, 13971, 14000, 14007, 14024, 14038, 14047,
  14095, 14096, 14134, 14182, 14193, 14226, 14228, 14421, 14422, 14463,
  14465, 14468, 14474, 14478, 14512, 14517, 14533, 14535, 14547, 14561,
  14567, 14568, 14575, 14593, 14610, 14622, 14624, 14626, 14786, 14809,
  14810, 14812, 14817, 14861, 14941, 14946, 14972, 14993, 15026, 15036,
  15195, 15199, 15204, 15207, 16002, 16004, 16025, 16027, 16033, 16037,
  16038, 16048, 16062, 16063, 16082, 16096, 16098, 16099, 16106, 16111,
  16112, 16113,
  // Batch 3 (overpay/shortpay invoices)
  18753, 18755, 18756, 18757, 18802,
]);

console.log(`Target invoice numbers: ${TARGET_NUMBERS.size}`);

// ── Token management ──────────────────────────────────────────────────────────
function loadTokens() { return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')); }
function saveTokens(t) { fs.writeFileSync(TOKEN_FILE, JSON.stringify(t)); }

async function getValidToken() {
  let store = loadTokens();
  if (!store.access_token) throw new Error('Not connected to Jobber');
  if (Date.now() > store.expires_at - 60000) {
    console.log('Refreshing token...');
    const resp = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: JOBBER_CLIENT_ID,
        client_secret: JOBBER_CLIENT_SECRET,
        refresh_token: store.refresh_token,
      }),
    });
    let data; try { data = await resp.json(); } catch { data = {}; }
    if (!data.access_token) throw new Error('Token refresh failed — re-auth in TrackPoint');
    store = { access_token: data.access_token, refresh_token: data.refresh_token, expires_at: Date.now() + ((data.expires_in || 3600) * 1000) };
    saveTokens(store);
  }
  return store.access_token;
}

async function gql(query) {
  const token = await getValidToken();
  const resp = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}`, 'X-JOBBER-GRAPHQL-VERSION': '2025-04-16' },
    body: JSON.stringify({ query }),
  });
  return resp.json();
}

// ── Fetch all Jobber invoices (paginated) → build invoiceNumber→gqlId map ────
async function buildInvoiceMap() {
  const map = {};   // invoiceNumber (string) → gqlId
  let cursor = null;
  let page = 0;

  console.log('Fetching all Jobber invoices (paginated)...');
  while (true) {
    const afterClause = cursor ? `(first: 100, after: "${cursor}")` : `(first: 100)`;
    const q = `{
      invoices${afterClause} {
        nodes { id invoiceNumber invoiceStatus }
        pageInfo { hasNextPage endCursor }
      }
    }`;
    const data = await gql(q);
    const inv = data.data?.invoices;
    if (!inv) { console.error('Bad invoices response:', JSON.stringify(data).substring(0,300)); break; }
    inv.nodes.forEach(n => { map[String(n.invoiceNumber)] = { gqlId: n.id, status: n.invoiceStatus }; });
    page++;
    process.stdout.write(`  Page ${page}: ${inv.nodes.length} invoices (total so far: ${Object.keys(map).length})\r`);
    if (!inv.pageInfo.hasNextPage) break;
    cursor = inv.pageInfo.endCursor;
    await new Promise(r => setTimeout(r, 500));
  }
  console.log(`\nDone — ${Object.keys(map).length} invoices fetched.`);
  return map;
}

// ── Reopen one invoice by GQL id ──────────────────────────────────────────────
async function reopenInvoice(gqlId) {
  const mutation = `mutation { invoiceReopen(id: "${gqlId}") { invoice { id invoiceStatus } userErrors { message } } }`;
  const result = await gql(mutation);
  if (result.errors) return { ok: false, raw: result.errors.map(e => e.message).join('; ') };
  const payload = result.data?.invoiceReopen;
  if (!payload) return { ok: false, raw: 'no payload: ' + JSON.stringify(result).substring(0,200) };
  if (payload.userErrors?.length) return { ok: false, raw: payload.userErrors.map(e => e.message).join('; ') };
  return { ok: true, status: payload.invoice?.invoiceStatus };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const dryRun = process.argv.includes('--dry-run');
  if (dryRun) console.log('DRY RUN\n');

  // Step 1: fetch all invoices and build map
  const invoiceMap = await buildInvoiceMap();

  // Step 2: resolve target invoice numbers to GQL ids
  const toProcess = [];
  const notFound = [];
  for (const num of TARGET_NUMBERS) {
    const entry = invoiceMap[String(num)];
    if (!entry) { notFound.push(num); continue; }
    toProcess.push({ number: num, gqlId: entry.gqlId, currentStatus: entry.status });
  }

  console.log(`\nResolved: ${toProcess.length} invoices | Not found: ${notFound.length}`);
  if (notFound.length) console.log('Not found:', notFound.join(', '));

  const alreadyOpen = toProcess.filter(i => i.currentStatus !== 'paid');
  const needReopen  = toProcess.filter(i => i.currentStatus === 'paid');
  console.log(`Already open (skipping): ${alreadyOpen.length}`);
  console.log(`Need reopening (paid):   ${needReopen.length}`);
  alreadyOpen.forEach(i => console.log(`  – #${i.number} → ${i.currentStatus}`));

  if (dryRun) {
    console.log('\nWould reopen:', needReopen.map(i => '#' + i.number).join(', '));
    return;
  }

  if (needReopen.length === 0) {
    console.log('\nNothing to do — all target invoices are already open.');
    return;
  }

  // Step 3: reopen each paid invoice
  console.log(`\nReopening ${needReopen.length} invoices...`);
  let succeeded = 0, failed = 0;
  const failures = [];

  for (let i = 0; i < needReopen.length; i++) {
    const inv = needReopen[i];
    const result = await reopenInvoice(inv.gqlId);
    if (result.ok) {
      console.log(`  ✓ [${i+1}/${needReopen.length}] #${inv.number} → ${result.status}`);
      succeeded++;
    } else {
      console.error(`  ✗ [${i+1}/${needReopen.length}] #${inv.number}: ${result.raw}`);
      failures.push({ number: inv.number, error: result.raw });
      failed++;
    }
    await new Promise(r => setTimeout(r, 300));
  }

  console.log(`\n=== Done ===`);
  console.log(`✓ Reopened:     ${succeeded}`);
  console.log(`– Skipped open: ${alreadyOpen.length}`);
  console.log(`✗ Failed:       ${failed}`);
  if (failures.length) {
    console.log('\nFailed invoices:');
    failures.forEach(f => console.log(`  #${f.number}: ${f.error}`));
  }
  console.log('\nNext step: Upload your remittances in TrackPoint and re-apply payments.');
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
