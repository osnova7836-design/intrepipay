// One-time script to get a new Gmail refresh token
// Run: node get-gmail-token.js
// Then visit the URL it prints, authorize, and paste the code back

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { google } = require('googleapis');
const http = require('http');
const url = require('url');

const CLIENT_ID     = process.env.GMAIL_CLIENT_ID;
const CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET;
const REDIRECT_URI  = 'http://localhost:3000/callback';

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  scope: ['https://www.googleapis.com/auth/gmail.readonly'],
  prompt: 'consent',
});

console.log('\n=== Gmail Auth ===');
console.log('1. Open this URL in your browser:\n');
console.log(authUrl);
console.log('\n2. Authorize the app. You will be redirected to localhost.');
console.log('   (The page will say "This site can\'t be reached" — that is OK)');
console.log('3. Copy the full URL from your browser address bar and paste it below.\n');

// Spin up a temporary server to catch the redirect
const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  if (!parsed.query.code) {
    res.end('No code found.');
    return;
  }

  const code = parsed.query.code;
  res.end('<h2>Got it! You can close this tab.</h2>');
  server.close();

  try {
    const { tokens } = await oauth2Client.getToken(code);
    console.log('\n=== SUCCESS ===');
    console.log('Add this to your .env file:\n');
    console.log(`GMAIL_REFRESH_TOKEN=${tokens.refresh_token}`);
    console.log('\nDone.');
  } catch (err) {
    console.error('Error exchanging code:', err.message);
  }
});

server.listen(3000, () => {
  console.log('Waiting for browser redirect on http://localhost:3000/callback ...\n');
});
