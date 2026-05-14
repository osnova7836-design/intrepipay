// Exports your local Jobber session cookies so they can be set as the
// JOBBER_COOKIES environment variable on Render.
//
// Usage (run locally, not on Render):
//   node scripts/export-jobber-cookies.js
//
// Then copy the printed JSON into Render → Environment → JOBBER_COOKIES.
// Cookies expire with your session — re-run this whenever Jobber logs you out.

const { chromium } = require('playwright');

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PROFILE_DIR = 'D:\\chrome-debug-profile';
const JOBBER_ORIGIN = 'https://secure.getjobber.com';

(async () => {
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    executablePath: CHROME_PATH,
    headless: true,
    args: ['--disable-blink-features=AutomationControlled', '--disable-gpu'],
    ignoreDefaultArgs: ['--enable-automation'],
  });

  try {
    const page = await ctx.newPage();
    await page.goto(JOBBER_ORIGIN + '/', { waitUntil: 'load' });

    if (/\/login|\/sign_in|\/users\/sign_in/.test(page.url())) {
      console.error(
        'ERROR: Not logged in to Jobber.\n' +
        'Run "node scripts/jobber-payment.js --clientId=X --invoiceId=Y --navigate-only" first ' +
        'to open Chrome and log in, then re-run this script.'
      );
      process.exit(1);
    }

    await page.close();

    const cookies = await ctx.cookies(JOBBER_ORIGIN);
    console.log('\n=== Paste the following JSON as JOBBER_COOKIES in Render Environment Variables ===\n');
    console.log(JSON.stringify(cookies));
    console.log('\n=== Done — ' + cookies.length + ' cookies exported ===\n');
  } finally {
    await ctx.close();
  }
})().catch((err) => {
  console.error('Failed:', err.message);
  process.exit(1);
});
