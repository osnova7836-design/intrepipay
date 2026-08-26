// Long-lived QB browser session, driven via filesystem command polling so
// multiple short-lived tool calls can steer one persistent Chrome window.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PROFILE_DIR = 'D:\\chrome-qb-profile';
const SCRATCH = path.join(__dirname, '..', '.qb-agent');
if (!fs.existsSync(SCRATCH)) fs.mkdirSync(SCRATCH, { recursive: true });
const CMD_FILE = path.join(SCRATCH, 'qb-cmd.json');
const RESULT_FILE = path.join(SCRATCH, 'qb-result.json');
const LOG_FILE = path.join(SCRATCH, 'qb-agent.log');

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}\n`;
  fs.appendFileSync(LOG_FILE, line);
}

(async () => {
  fs.writeFileSync(LOG_FILE, '');
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    executablePath: CHROME_PATH,
    args: ['--disable-blink-features=AutomationControlled', '--disable-gpu'],
    ignoreDefaultArgs: ['--enable-automation', '--no-sandbox'],
  });
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  let page = ctx.pages()[0] || await ctx.newPage();
  await page.goto('https://qbo.intuit.com/app/homepage', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(e => log('initial goto err', e.message));
  log('launched, url=', page.url());

  const deadline = Date.now() + 40 * 60 * 1000; // 40 min max lifetime
  let stopped = false;

  while (!stopped && Date.now() < deadline) {
    if (fs.existsSync(CMD_FILE)) {
      let cmd;
      try {
        cmd = JSON.parse(fs.readFileSync(CMD_FILE, 'utf8'));
      } catch (e) {
        log('bad cmd json', e.message);
        try { fs.unlinkSync(CMD_FILE); } catch {}
        continue;
      }
      try { fs.unlinkSync(CMD_FILE); } catch {}
      log('cmd:', JSON.stringify(cmd).slice(0, 300));

      let result = { ok: true };
      try {
        if (cmd.action === 'status') {
          result.url = page.url();
          result.title = await page.title();
        } else if (cmd.action === 'goto') {
          await page.goto(cmd.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
          await page.waitForTimeout(cmd.wait || 2000);
          result.url = page.url();
          result.title = await page.title();
        } else if (cmd.action === 'screenshot') {
          const shotPath = cmd.path || path.join(SCRATCH, 'qb-status.png');
          await page.screenshot({ path: shotPath, fullPage: !!cmd.fullPage });
          result.path = shotPath;
          result.url = page.url();
        } else if (cmd.action === 'eval') {
          // eslint-disable-next-line no-eval
          const fn = eval(`(${cmd.fn})`);
          result.value = await page.evaluate(fn, cmd.arg);
        } else if (cmd.action === 'click') {
          await page.click(cmd.selector, { timeout: cmd.timeout || 10000 });
          await page.waitForTimeout(cmd.wait || 1000);
          result.url = page.url();
        } else if (cmd.action === 'text') {
          result.text = await page.locator(cmd.selector).allTextContents();
        } else if (cmd.action === 'type') {
          const loc = page.locator(cmd.selector);
          await loc.click({ clickCount: 3 });
          await page.keyboard.press('Control+a');
          await page.keyboard.type(cmd.value, { delay: cmd.delay || 40 });
          if (cmd.pressEnter) await page.keyboard.press('Enter');
          if (cmd.pressTab) await page.keyboard.press('Tab');
          await page.waitForTimeout(cmd.wait || 500);
          result.url = page.url();
        } else if (cmd.action === 'press') {
          await page.keyboard.press(cmd.key);
          await page.waitForTimeout(cmd.wait || 500);
        } else if (cmd.action === 'newpage') {
          // Capture download triggered by a click (QB exports as file download)
          const [download] = await Promise.all([
            page.waitForEvent('download', { timeout: cmd.timeout || 30000 }),
            page.click(cmd.selector),
          ]);
          const savePath = cmd.savePath || path.join(SCRATCH, download.suggestedFilename());
          await download.saveAs(savePath);
          result.savedPath = savePath;
        } else if (cmd.action === 'waitfordownload') {
          const download = await page.waitForEvent('download', { timeout: cmd.timeout || 30000 });
          const savePath = cmd.savePath || path.join(SCRATCH, download.suggestedFilename());
          await download.saveAs(savePath);
          result.savedPath = savePath;
        } else if (cmd.action === 'stop') {
          stopped = true;
        } else {
          result = { ok: false, error: 'unknown action: ' + cmd.action };
        }
      } catch (e) {
        result = { ok: false, error: e.message };
      }
      fs.writeFileSync(RESULT_FILE, JSON.stringify(result, null, 2));
      log('result:', JSON.stringify(result).slice(0, 300));
    }
    await new Promise(r => setTimeout(r, 1200));
  }

  log('shutting down');
  await ctx.close();
})().catch((err) => {
  log('FATAL', err.message);
});
