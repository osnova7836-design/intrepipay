const https = require('https');
const http = require('http');

// Solves reCAPTCHA v2 via 2captcha.com
// Requires TWO_CAPTCHA_API_KEY env var
async function solveRecaptcha(page) {
  const apiKey = process.env.TWO_CAPTCHA_API_KEY;
  if (!apiKey) throw new Error('TWO_CAPTCHA_API_KEY env var not set');

  // Extract sitekey from page
  const sitekey = await page.evaluate(() => {
    const el = document.querySelector('[data-sitekey]');
    if (el) return el.getAttribute('data-sitekey');
    // Also check iframe src for sitekey param
    const iframe = document.querySelector('iframe[src*="recaptcha"]');
    if (iframe) {
      const match = iframe.src.match(/[?&]k=([^&]+)/);
      if (match) return match[1];
    }
    return null;
  });

  if (!sitekey) throw new Error('Could not find reCAPTCHA sitekey on page');
  console.log(`[captcha] Sitekey found: ${sitekey.slice(0, 20)}...`);

  const pageUrl = page.url();

  // Submit to 2captcha
  const taskId = await submitCaptcha(apiKey, sitekey, pageUrl);
  console.log(`[captcha] Task submitted: ${taskId}, polling for solution...`);

  // Poll for result (up to 2 minutes)
  const token = await pollResult(apiKey, taskId);
  console.log('[captcha] Solution received');

  // Inject token into page
  await page.evaluate((t) => {
    // Set the hidden textarea that reCAPTCHA uses
    const textarea = document.querySelector('#g-recaptcha-response');
    if (textarea) {
      textarea.style.display = 'block';
      textarea.value = t;
    }
    // Also set any other g-recaptcha-response fields
    document.querySelectorAll('[name="g-recaptcha-response"]').forEach(el => {
      el.value = t;
    });
    // Trigger the callback if defined
    if (typeof grecaptcha !== 'undefined') {
      try {
        const widgetId = Object.keys(grecaptcha).find(k => !isNaN(k));
        if (widgetId !== undefined) grecaptcha.getResponse(widgetId);
      } catch {}
    }
    // Fire the form's submit callback if there's a data-callback attribute
    const callbackEl = document.querySelector('[data-callback]');
    if (callbackEl) {
      const fn = callbackEl.getAttribute('data-callback');
      if (fn && window[fn]) window[fn](t);
    }
  }, token);

  return token;
}

function submitCaptcha(apiKey, sitekey, pageUrl) {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({
      key: apiKey,
      method: 'userrecaptcha',
      googlekey: sitekey,
      pageurl: pageUrl,
      json: '1',
    });
    const url = `http://2captcha.com/in.php?${params}`;
    http.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.status !== 1) return reject(new Error(`2captcha submit failed: ${parsed.request}`));
          resolve(parsed.request);
        } catch {
          reject(new Error(`2captcha submit parse error: ${data}`));
        }
      });
    }).on('error', reject);
  });
}

function pollResult(apiKey, taskId, attempts = 0) {
  return new Promise((resolve, reject) => {
    if (attempts > 24) return reject(new Error('2captcha timed out after 2 minutes'));

    const delay = attempts === 0 ? 15000 : 5000; // wait 15s before first check, then every 5s

    setTimeout(() => {
      const url = `http://2captcha.com/res.php?key=${apiKey}&action=get&id=${taskId}&json=1`;
      http.get(url, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.status === 1) return resolve(parsed.request);
            if (parsed.request === 'CAPCHA_NOT_READY') return resolve(pollResult(apiKey, taskId, attempts + 1));
            reject(new Error(`2captcha error: ${parsed.request}`));
          } catch {
            reject(new Error(`2captcha poll parse error: ${data}`));
          }
        });
      }).on('error', reject);
    }, delay);
  });
}

module.exports = { solveRecaptcha };
