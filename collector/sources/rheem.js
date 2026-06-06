const { getGmailClient, fetchMessages, downloadAttachment } = require('../utils/gmail');

// Rheem sends HTML as a named attachment (Payment####.html) via multipart/related
// Table columns: Document Reference Number | Comments | Document Date | Document Amount | Document Currency | Amount Withheld | Discount Taken | Amount Paid
// Multiple WCNs on one row = one job, one payment — do NOT split amount

async function collect({ daysBack = 30 } = {}) {
  const gmail = getGmailClient();
  const after = new Date();
  after.setDate(after.getDate() - daysBack);
  const afterUnix = Math.floor(after.getTime() / 1000);

  const messages = await fetchMessages(
    gmail,
    `from:account.payables@rheem.com after:${afterUnix}`,
    50
  );

  console.log(`[Rheem] Found ${messages.length} emails`);
  const results = [];

  for (const msg of messages) {
    try {
      const parsed = await parseEmail(gmail, msg);
      if (parsed) results.push(...parsed);
    } catch (err) {
      console.warn(`[Rheem] Failed to parse message ${msg.data.id}: ${err.message}`);
    }
  }

  console.log(`[Rheem] Parsed ${results.length} payments`);
  return results;
}

function findHtmlAttachment(part) {
  if (part.mimeType === 'text/html' && part.body?.attachmentId) return part;
  if (part.parts) {
    for (const p of part.parts) {
      const r = findHtmlAttachment(p);
      if (r) return r;
    }
  }
  return null;
}

async function parseEmail(gmail, msg) {
  const htmlPart = findHtmlAttachment(msg.data.payload);
  if (!htmlPart) return null;

  const buf = await downloadAttachment(gmail, msg.data.id, htmlPart.body.attachmentId);
  const html = buf.toString('utf-8');
  const text = html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');

  const refMatch = text.match(/Payment Reference Number\s+(\d+)/i);
  const dateMatch = text.match(/Payment Date\s+([A-Za-z]+ \d+,?\s*\d{4}|\d{1,2}\/\d{1,2}\/\d{4})/i);
  if (!refMatch) return null;

  const paymentRef = refMatch[1].trim();
  const paymentDate = normalizeDate(dateMatch?.[1] || '');

  const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];
  const workOrders = [];
  let totalAmount = 0;
  let inDetailTable = false;

  for (const row of rows) {
    const cells = [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)]
      .map(m => m[1].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim())
      .filter(Boolean);

    if (!cells.length) continue;
    if (/Document Reference Number/i.test(cells[0])) { inDetailTable = true; continue; }
    if (!inDetailTable) continue;
    if (/^Total$/i.test(cells[0])) break;

    // First cell = comma-separated WCNs, last cell = Amount Paid
    const amount = parseFloat(cells[cells.length - 1].replace(/,/g, '')) || 0;
    if (!amount) continue;

    const wcns = cells[0].split(/[,\s]+/).map(s => s.trim()).filter(s => /^\d{6,}$/.test(s));
    if (!wcns.length) continue;

    // Keep WCNs joined — multiple WCNs on one row = one job
    workOrders.push({ workOrder: wcns.join(','), amount });
    totalAmount += amount;
  }

  if (!workOrders.length) return null;

  return [{ company: 'Rheem', paymentRef, paymentDate, amount: totalAmount, workOrders }];
}

function normalizeDate(val) {
  if (!val) return '';
  const d = new Date(val);
  if (!isNaN(d)) return d.toISOString().slice(0, 10);
  return String(val);
}

module.exports = { collect };
