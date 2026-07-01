const { getGmailClient, fetchMessages } = require('../utils/gmail');

// HomeServe USA sends inline HTML emails (not attachments)
// Subject: "Separate Remittance Advice: payment reference number - XXXXXXX"
// From: USAccounts.PayableTrade@homeserveusa.com
// Table columns: Document Reference Number | Document Date | Description | Amount Paid
// workOrder = Document Reference Number (SHMV... WO#) — always the title of the Jobber invoice

async function collect({ daysBack = 30 } = {}) {
  const gmail = getGmailClient();
  const after = new Date();
  after.setDate(after.getDate() - daysBack);
  const afterUnix = Math.floor(after.getTime() / 1000);

  const messages = await fetchMessages(
    gmail,
    `from:homeserveusa.com after:${afterUnix}`,
    50
  );

  console.log(`[HomeServe] Found ${messages.length} emails`);
  const results = [];

  for (const msg of messages) {
    try {
      const parsed = parseEmail(msg);
      if (parsed) results.push(parsed);
    } catch (err) {
      console.warn(`[HomeServe] Failed to parse message ${msg.data.id}: ${err.message}`);
    }
  }

  console.log(`[HomeServe] Parsed ${results.length} payments`);
  return results;
}

function getHtmlBody(msg) {
  const payload = msg.data.payload;

  function findHtml(part) {
    if (part.mimeType === 'text/html' && part.body?.data) {
      return Buffer.from(part.body.data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
    }
    if (part.parts) {
      for (const p of part.parts) {
        const r = findHtml(p);
        if (r) return r;
      }
    }
    return null;
  }

  if (payload.body?.data) {
    return Buffer.from(payload.body.data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
  }
  return findHtml(payload);
}

function parseEmail(msg) {
  const html = getHtmlBody(msg);
  if (!html) return null;

  const subject = msg.data.payload.headers.find(h => h.name.toLowerCase() === 'subject')?.value || '';
  const refMatch = subject.match(/payment reference number\s*[-–]\s*(\d+)/i);
  if (!refMatch) return null;

  const paymentRef = refMatch[1].trim();

  // Date is in the table rows (Document Date column) — grab from first data row
  const text = html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
  const dateMatch = text.match(/([A-Z][a-z]+,?\s+\d{1,2}\s+\d{4})/);
  const paymentDate = normalizeDate(dateMatch?.[1] || '');

  const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];
  const workOrders = [];
  let totalAmount = 0;
  let inDetailTable = false;

  for (const row of rows) {
    const cells = [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)]
      .map(m => m[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim())
      .filter(c => c.length > 0);

    if (!cells.length) continue;
    if (/Document Reference Number/i.test(cells[0])) { inDetailTable = true; continue; }
    if (!inDetailTable) continue;

    const lastCell = cells[cells.length - 1];
    const amount = parseFloat(lastCell.replace(/[$,\s]/g, ''));
    if (isNaN(amount) || amount <= 0) continue;

    // Document Reference Number (index 0) = HomeServe WO#, which is the Jobber invoice title
    // Skip total/summary rows where first cell is just a number
    const workOrder = cells[0];
    if (!workOrder || /^[\d,$.]+$/.test(workOrder)) continue;

    workOrders.push({ workOrder, amount });
    totalAmount += amount;
  }

  if (!workOrders.length) return null;

  return {
    company: 'HomeServe USA',
    paymentRef,
    paymentDate,
    amount: Math.round(totalAmount * 100) / 100,
    workOrders,
  };
}

function normalizeDate(val) {
  if (!val) return '';
  const d = new Date(val);
  if (!isNaN(d)) return d.toISOString().slice(0, 10);
  return String(val);
}

module.exports = { collect };
