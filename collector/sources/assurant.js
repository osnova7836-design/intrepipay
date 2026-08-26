const xlsx = require('xlsx');
const { getGmailClient, fetchMessages, getAttachments, downloadAttachment } = require('../utils/gmail');

// Assurant (the bank descriptor for this shows "Federal Warranty", not "Assurant" — same
// payer) emails a structured .xlsx per ACH payment run from
// audit.claims.depart@assurant.com, subject "Assurant Vendor ACH Remittance Detail-THE
// BEST PLUMBING GROUP, LLC-<date>". Columns (confirmed against real attachments
// 2026-08-26): Vendor ID | Vendor Name | Claim Number | Invoice Number | PO Number |
// Invoice Date | Invoice Gross Amt | Pmt Amount | Pmt Nbr | Pmt Date.
//
// One payment (grouped by Pmt Nbr) can cover multiple claims — Pmt Amount repeats the same
// check total on every row for that Pmt Nbr; Invoice Gross Amt is the real per-claim
// amount. First data row is a blank/zero placeholder row and must be skipped.
//
// Jobber invoice Subject is "<Claim Number>-<code>-<seq>" (e.g. "26000432417-HWBP-1") —
// Claim Number is a PREFIX of Subject, never an exact match, and is NOT the "Invoice
// Number" column (that's Assurant's own small sequential numbering, unrelated to Jobber).
// Jobber client name is "Assurant".

async function collect({ daysBack = 30 } = {}) {
  const gmail = getGmailClient();
  const after = new Date();
  after.setDate(after.getDate() - daysBack);
  const afterUnix = Math.floor(after.getTime() / 1000);

  const messages = await fetchMessages(
    gmail,
    `from:audit.claims.depart@assurant.com after:${afterUnix}`,
    50
  );

  console.log(`[Assurant] Found ${messages.length} emails`);
  const results = [];

  for (const msg of messages) {
    try {
      const parsed = await parseEmail(gmail, msg);
      if (parsed) results.push(...parsed);
    } catch (err) {
      console.warn(`[Assurant] Failed to parse message ${msg.data.id}: ${err.message}`);
    }
  }

  console.log(`[Assurant] Parsed ${results.length} payments`);
  return results;
}

async function parseEmail(gmail, msg) {
  const atts = getAttachments(msg).filter(a => /\.xlsx?$/i.test(a.filename));
  if (!atts.length) return null;

  const paymentsByNbr = {};

  for (const att of atts) {
    const buf = await downloadAttachment(gmail, msg.data.id, att.attachmentId);
    const wb = xlsx.read(buf, { type: 'buffer' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows = xlsx.utils.sheet_to_json(sheet, { defval: '' });

    for (const row of rows) {
      const claimNumber = String(row['Claim Number'] || '').trim();
      const pmtNbr = String(row['Pmt Nbr'] || '').trim();
      const grossAmt = parseFloat(row['Invoice Gross Amt']) || 0;
      if (!claimNumber || !pmtNbr || !grossAmt) continue; // skip the blank placeholder row

      if (!paymentsByNbr[pmtNbr]) {
        paymentsByNbr[pmtNbr] = {
          company: 'Assurant',
          paymentRef: pmtNbr,
          paymentDate: normalizeDate(row['Pmt Date']),
          amount: parseFloat(row['Pmt Amount']) || 0,
          workOrders: [],
        };
      }
      paymentsByNbr[pmtNbr].workOrders.push({ workOrder: claimNumber, amount: grossAmt });
    }
  }

  return Object.values(paymentsByNbr);
}

function normalizeDate(val) {
  if (!val) return '';
  const d = new Date(val);
  if (!isNaN(d)) return d.toISOString().slice(0, 10);
  return String(val);
}

module.exports = { collect };
