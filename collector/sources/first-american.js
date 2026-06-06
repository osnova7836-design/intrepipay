const { getGmailClient, fetchMessages, getPlainBody } = require('../utils/gmail');

// First American sends HTML emails with table rows as raw <tr><td> markup
// Columns: Vendor Invoice | FALCON Invoice | Work Order | Total | Gross Amount | Adj. Amount | Total Adj. Gross Amount | Service Fee | Discount Amount | Other | Net Paid Amount
// Work Order = cells[2], Net Paid Amount = cells[10] (last)

async function collect({ daysBack = 30 } = {}) {
  const gmail = getGmailClient();
  const after = new Date();
  after.setDate(after.getDate() - daysBack);
  const afterUnix = Math.floor(after.getTime() / 1000);

  const messages = await fetchMessages(
    gmail,
    `subject:"EFT" after:${afterUnix} (from:firstam OR "first american")`,
    50
  );

  console.log(`[First American] Found ${messages.length} emails`);
  const results = [];

  for (const msg of messages) {
    try {
      const parsed = parseEmail(msg);
      if (parsed) results.push(...parsed);
    } catch (err) {
      console.warn(`[First American] Failed to parse message ${msg.data.id}: ${err.message}`);
    }
  }

  console.log(`[First American] Parsed ${results.length} payments`);
  return results;
}

function parseEmail(msg) {
  const body = getPlainBody(msg);
  if (!body) return null;

  const paymentRefMatch = body.match(/\b(EFTPY\d+)\b/i);
  if (!paymentRefMatch) return null;
  const paymentRef = paymentRefMatch[1].toUpperCase();

  const dateMatch = body.match(/Total Amount Paid on\s+([\d\/]+)/i);
  const paymentDate = normalizeDate(dateMatch?.[1] || '');

  // Data rows come through as raw HTML: <tr align="right"><td>...</td>...<td>netPaid</td></tr>
  const rows = [...body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];
  const workOrders = [];
  let totalAmount = 0;

  for (const row of rows) {
    const cells = [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)]
      .map(m => m[1].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim());

    if (cells.length < 3) continue;

    const workOrder = cells[2]?.trim();
    const netPaid = cells[cells.length - 1]?.replace(/[$,]/g, '').trim();
    const amount = parseFloat(netPaid) || 0;

    if (workOrder && /^\d+$/.test(workOrder) && amount) {
      workOrders.push({ workOrder, amount });
      totalAmount += amount;
    }
  }

  if (!workOrders.length) return null;

  return [{ company: 'First American', paymentRef, paymentDate, amount: totalAmount, workOrders }];
}

function normalizeDate(val) {
  if (!val) return '';
  const d = new Date(val);
  if (!isNaN(d)) return d.toISOString().slice(0, 10);
  return String(val);
}

module.exports = { collect };
