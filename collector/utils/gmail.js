const { google } = require('googleapis');

function getGmailClient() {
  const auth = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET
  );
  auth.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });
  return google.gmail({ version: 'v1', auth });
}

async function fetchMessages(gmail, query, maxResults = 20) {
  const res = await gmail.users.messages.list({
    userId: 'me',
    q: query,
    maxResults,
  });
  const items = res.data.messages || [];
  return Promise.all(
    items.map(m => gmail.users.messages.get({ userId: 'me', id: m.id, format: 'full' }))
  );
}

function getHeader(msg, name) {
  const headers = msg.data.payload.headers;
  return headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';
}

function decodeBase64(str) {
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
}

function getPlainBody(msg) {
  const payload = msg.data.payload;

  function findPart(part) {
    if (part.mimeType === 'text/plain' && part.body?.data) return decodeBase64(part.body.data);
    if (part.mimeType === 'text/html' && part.body?.data) return decodeBase64(part.body.data);
    if (part.parts) {
      for (const p of part.parts) {
        const result = findPart(p);
        if (result) return result;
      }
    }
    return null;
  }

  if (payload.body?.data) return decodeBase64(payload.body.data);
  return findPart(payload);
}

function getAttachments(msg) {
  const attachments = [];

  function walk(part) {
    if (part.filename && part.body) {
      attachments.push({ filename: part.filename, mimeType: part.mimeType, attachmentId: part.body.attachmentId, data: part.body.data });
    }
    if (part.parts) part.parts.forEach(walk);
  }

  walk(msg.data.payload);
  return attachments;
}

async function downloadAttachment(gmail, messageId, attachmentId) {
  const res = await gmail.users.messages.attachments.get({
    userId: 'me',
    messageId,
    id: attachmentId,
  });
  return Buffer.from(res.data.data.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

module.exports = { getGmailClient, fetchMessages, getHeader, getPlainBody, getAttachments, downloadAttachment };
