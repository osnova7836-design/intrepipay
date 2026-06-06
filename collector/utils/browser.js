if (process.env.RENDER) process.env.PLAYWRIGHT_BROWSERS_PATH = '/opt/render/project/src/collector/.playwright-browsers';

const { chromium } = require('playwright');
const path = require('path');

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const DOWNLOAD_DIR = process.env.RENDER ? '/tmp/collector-downloads' : path.join(__dirname, '../../.collector-downloads');

async function launchBrowser(name = 'default') {
  const onRender = !!process.env.RENDER;
  const ctx = await chromium.launchPersistentContext(
    process.env.RENDER ? `/tmp/collector-profile-${name}` : path.join(__dirname, `../../.collector-profile-${name}`),
    {
      headless: onRender,
      acceptDownloads: true,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--disable-gpu',
        ...(onRender ? ['--no-sandbox', '--disable-setuid-sandbox'] : []),
      ],
      ignoreDefaultArgs: ['--enable-automation'],
      executablePath: onRender ? chromium.executablePath() : CHROME_PATH,
    }
  );
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  return ctx;
}

module.exports = { launchBrowser, DOWNLOAD_DIR };
