// Intercepts all network requests made during a Jobber payment application.
// Run locally with your logged-in Chrome profile, complete a real payment,
// then check intercept-log.json for the API calls to replay server-side.
//
// Usage:
//   node scripts/intercept-jobber-payment.js --clientId=12345 --invoiceId=67890

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const JOBBER_ORIGIN = 'https://secure.getjobber.com';
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PROFILE_DIR = 'D:\\chrome-debug-profile';
const LOG_FILE = path.join(__dirname, '..', 'intercept-log.json');

const args = Object.fromEntries(
  process.argv.slice(2).map(a => { const [k, v] = a.replace('--', '').split('='); return [k, v]; })
);

if (!args.clientId || !args.invoiceId) {
  console.error('Usage: node scripts/intercept-jobber-payment.js --clientId=X --invoiceId=Y');
  process.exit(1);
}

(async () => {
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    executablePath: CHROME_PATH,
    headless: false,
    args: ['--disable-blink-features=AutomationControlled', '--disable-gpu'],
    ignoreDefaultArgs: ['--enable-automation'],
  });

  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  const captured = [];

  // Intercept all requests going to Jobber
  await ctx.route('**/*', async (route) => {
    const req = route.request();
    const url = req.url();
    const method = req.method();
    const headers = req.headers();
    const postData = req.postData();

    // Only log non-trivial requests to Jobber (skip assets)
    if (
      url.includes('getjobber.com') &&
      !url.match(/\.(js|css|png|jpg|svg|ico|woff|woff2|ttf)(\?|$)/)
    ) {
      const entry = { method, url, headers, body: null };

      if (postData) {
        try { entry.body = JSON.parse(postData); }
        catch { entry.body = postData; }
      }

      // Capture the response too
      const response = await route.fetch();
      let responseBody = null;
      try {
        const text = await response.text();
        try { responseBody = JSON.parse(text); }
        catch { responseBody = text.slice(0, 500); } // truncate large HTML
      } catch { /* ignore */ }

      entry.responseStatus = response.status();
      entry.responseBody = responseBody;

      captured.push(entry);

      // Print API calls live so you can watch what's happening
      if (method !== 'GET' || url.includes('/api/') || url.includes('graphql')) {
        console.log(`\n[${method}] ${url}`);
        if (entry.body) console.log('  Body:', JSON.stringify(entry.body).slice(0, 300));
        console.log(`  → ${response.status()}`);
        if (responseBody && typeof responseBody === 'object') {
          console.log('  Response:', JSON.stringify(responseBody).slice(0, 300));
        }
      }

      await route.fulfill({ response });
    } else {
      await route.continue();
    }
  });

  const page = await ctx.newPage();

  const paymentUrl = new URL('/payments/new', JOBBER_ORIGIN);
  paymentUrl.searchParams.set('clientId', args.clientId);
  paymentUrl.searchParams.set('invoiceId', args.invoiceId);
  paymentUrl.searchParams.set('order', 'ASCENDING');
  paymentUrl.searchParams.set('sort', 'DUE_DATE');

  console.log(`\nOpening: ${paymentUrl}\n`);
  console.log('='.repeat(60));
  console.log('Complete the payment in the browser window.');
  console.log('All Jobber API calls will be logged here and saved to:');
  console.log(`  ${LOG_FILE}`);
  console.log('='.repeat(60));
  console.log('Press Ctrl+C when done to save the log.\n');

  await page.goto(paymentUrl.toString(), { waitUntil: 'domcontentloaded' });

  // Wait until user presses Ctrl+C
  const save = () => {
    fs.writeFileSync(LOG_FILE, JSON.stringify(captured, null, 2));
    console.log(`\nSaved ${captured.length} requests to ${LOG_FILE}`);
    ctx.close().then(() => process.exit(0));
  };

  process.on('SIGINT', save);
  process.on('SIGTERM', save);

  // Also save if the page navigates away after payment submission
  page.on('framenavigated', async (frame) => {
    if (frame === page.mainFrame() && page.url().includes('/payments/')) {
      console.log(`\nPage navigated to: ${page.url()} — payment likely submitted.`);
      await new Promise(r => setTimeout(r, 2000)); // let final requests land
      save();
    }
  });
})().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
