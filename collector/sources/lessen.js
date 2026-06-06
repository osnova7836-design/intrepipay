const path = require('path');
const os = require('os');
const fs = require('fs');
const pdfParse = require('pdf-parse');
const { getGmailClient, fetchMessages, getHeader, getAttachments, downloadAttachment } = require('../utils/gmail');

// Lessen sends PDF attachment emails from accountspayable@lessen.com
// Payment Ref # is in the PDF filename (e.g. "10326322.pdf" or similar)
// PDF body: work order in description field ("Bill 1048505 - GPS FAC")
// May include credits (negative rows)

async function collect({ daysBack = 30 } = {}) {
  const gmail = getGmailClient();
  const after = new Date();
  after.setDate(after.getDate() - daysBack);
  const afterUnix = Math.floor(after.getTime() / 1000);

  const messages = await fetchMessages(
    gmail,
    `from:accountspayable@lessen.com after:${afterUnix}`,
    50
  );

  console.log(`[Lessen] Found ${messages.length} emails`);
  const results = [];

  for (const msg of messages) {
    try {
      const parsed = await parseEmail(gmail, msg);
      if (parsed) results.push(...parsed);
    } catch (err) {
      console.warn(`[Lessen] Failed to parse message ${msg.data.id}: ${err.message}`);
    }
  }

  console.log(`[Lessen] Parsed ${results.length} payments`);
  return results;
}

async function parseEmail(gmail, msg) {
  const attachments = getAttachments(msg);
  const pdfs = attachments.filter(a => a.mimeType === 'application/pdf' || a.filename?.endsWith('.pdf'));

  if (!pdfs.length) return null;

  const results = [];

  for (const att of pdfs) {
    // Payment ref # is the number after "#" in the filename
    // e.g. "Bill Payment_#10326322 via ACH.pdf" → "10326322"
    const numMatch = att.filename.match(/#(\d+)/);
    const paymentRef = numMatch ? numMatch[1] : path.basename(att.filename, '.pdf').trim();

    const pdfBuffer = att.attachmentId
      ? await downloadAttachment(gmail, msg.data.id, att.attachmentId)
      : Buffer.from(att.data, 'base64');

    const tmpPath = path.join(os.tmpdir(), `lessen-${Date.now()}.pdf`);
    fs.writeFileSync(tmpPath, pdfBuffer);

    try {
      const pdfData = await pdfParse(pdfBuffer);
      const payment = parsePdfText(pdfData.text, paymentRef);
      if (payment) results.push(payment);
    } finally {
      fs.unlinkSync(tmpPath);
    }
  }

  return results;
}

function parsePdfText(text, paymentRef) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  // Payment date is labeled "Date:" (with colon) at the top of the PDF.
  // Table column headers say "Date" without a colon — that distinguishes them.
  // PDF text extraction may replace tabs with spaces, so allow flexible whitespace.
  let paymentDate = '';
  const dateMatch = text.match(/Date:\s+(\d{2}\/\d{2}\/\d{4})/i);
  if (dateMatch) paymentDate = normalizeDate(dateMatch[1]);

  // Work orders: "Bill 1048505 - GPS FAC ... $1,638.50"
  // Credits:     "Bill Credit 1048505 - LSN TECH ... -$129.00"
  // Work order number is the digits immediately after "Bill" or "Bill Credit" — stop at the dash
  const workOrders = [];
  let totalAmount = 0;

  for (const line of lines) {
    // Match "Bill [Credit] <number>" — the dash and everything after is description, not WO#
    const billMatch = line.match(/Bill(?:\s+Credit)?\s+(\d+)/i);
    // Amount at end of line — handles both "$1,638.50" and "-$129.00"
    const amtMatch = line.match(/(-?\$?[\d,]+\.?\d*)\s*$/);

    if (billMatch && amtMatch) {
      const isCredit = /Bill Credit/i.test(line);
      const amount = parseFloat(amtMatch[1].replace(/[$,]/g, '')) || 0;
      // Credit rows are negative; payment rows are positive
      const finalAmount = isCredit ? -Math.abs(amount) : Math.abs(amount);
      workOrders.push({ workOrder: billMatch[1], amount: finalAmount });
      totalAmount += finalAmount;
    }
  }

  if (!workOrders.length) return null;

  return {
    company: 'Lessen',
    paymentRef,
    paymentDate,
    amount: totalAmount,
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
