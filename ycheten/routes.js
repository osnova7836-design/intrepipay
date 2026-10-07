// Ycheten's own page: upload a card/loan statement PDF, see the exact
// journal entry it would create, confirm it, and QuickBooks gets written --
// via the same createJournalEntry/qboQuery this whole project has used all
// along (scripts/qbo-api.js), not a separate code path.
//
// Two-step by design, same as every live write earlier in this project:
// /parse never touches QuickBooks, only /confirm does, and only after a
// human has seen the exact numbers and clicked a button.
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { PDFParse } = require('pdf-parse');
const { detectAndParse } = require('./parsers');
const { createJournalEntry, qboQuery } = require('../scripts/qbo-api');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const LOG_FILE = path.join(__dirname, 'log.json');

function loadLog() {
  try { return JSON.parse(fs.readFileSync(LOG_FILE, 'utf8')); } catch { return []; }
}
function saveLog(entries) {
  fs.writeFileSync(LOG_FILE, JSON.stringify(entries, null, 2));
}

const router = express.Router();

router.post('/parse', upload.single('statement'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded (field name must be "statement").' });
  try {
    const parser = new PDFParse({ data: req.file.buffer });
    const result = await parser.getText();
    const parsed = detectAndParse(result.text);
    if (!parsed.ok) return res.status(422).json({ error: parsed.error, filename: req.file.originalname });
    res.json({ ...parsed, filename: req.file.originalname });
  } catch (err) {
    res.status(500).json({ error: 'Could not read this PDF: ' + err.message });
  }
});

router.post('/confirm', async (req, res) => {
  const { vendor, closingDate, netAmount, docNumber, accounts, filename } = req.body || {};
  if (!closingDate || !netAmount || !accounts?.debit?.id || !accounts?.credit?.id) {
    return res.status(400).json({ error: 'Missing required fields from the parsed statement.' });
  }

  // Guard against uploading the same statement twice -- QBO JournalEntry
  // supports filtering by DocNumber, so check before writing a duplicate.
  try {
    const existing = await qboQuery(`SELECT Id FROM JournalEntry WHERE DocNumber = '${docNumber}'`);
    if (existing.QueryResponse?.JournalEntry?.length) {
      return res.status(409).json({ error: `A journal entry with number ${docNumber} already exists (JE #${existing.QueryResponse.JournalEntry[0].Id}) -- this statement looks already recorded.` });
    }
  } catch (e) {
    console.warn('[ycheten] duplicate-check query failed, proceeding anyway:', e.message);
  }

  try {
    const result = await createJournalEntry({
      txnDate: closingDate,
      docNumber,
      debitAccountId: accounts.debit.id,
      creditAccountId: accounts.credit.id,
      amount: netAmount,
      description: 'Purchases',
    });
    const jeId = result.JournalEntry.Id;

    const balanceCheck = await qboQuery(`SELECT Id, Name, CurrentBalance FROM Account WHERE Id = '${accounts.credit.id}'`).catch(() => null);
    const newBalance = balanceCheck?.QueryResponse?.Account?.[0]?.CurrentBalance ?? null;

    const log = loadLog();
    log.unshift({
      id: jeId,
      vendor,
      filename,
      closingDate,
      netAmount,
      docNumber,
      creditAccount: accounts.credit.name,
      newAccountBalance: newBalance,
      createdAt: new Date().toISOString(),
    });
    saveLog(log);

    res.json({ ok: true, jeId, newAccountBalance: newBalance });
  } catch (err) {
    res.status(500).json({ error: 'QuickBooks write failed: ' + err.message });
  }
});

router.get('/log', (req, res) => {
  res.json(loadLog());
});

module.exports = router;
