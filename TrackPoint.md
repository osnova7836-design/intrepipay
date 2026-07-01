# TrackPoint OS — Complete Settings & Context

*Compiled 2026-05-22 · Updated 2026-06-07 (commits 102a399 → 881b26d)*

---

## Project Overview

TrackPoint is a Node.js/Express web app for payment reconciliation aimed at home service businesses.

- **Entry point:** `server.js`
- **Core dependencies:** `express`, `node-fetch@2`
- **Playwright** added 2026-05-13 as a dev dependency to automate applying payments inside Jobber
- **Project root:** `D:\TrackPoint`
- **Production URL:** https://intrepipay.com (hosted on Render: intrepipay.onrender.com)
- **Cache-Control:** `server.js` sets `Cache-Control: no-store` on `.html` responses to prevent browser caching of `index.html`. If local edits appear stale despite hard-refresh, push to GitHub and let Render deploy — that bypasses all local browser/proxy cache.

### Playwright Jobber Automation Workflow
1. Navigate to a specific Jobber payment URL
2. Fill payment type (Check / ACH), reference number, and date
3. Scroll-load all lazy-loaded invoices (virtual/windowed list — scroll until position stops changing)
4. Check every invoice checkbox
5. Submit the payment

---

## Environment & Disk Layout

| Drive | Size | Free | Notes |
|-------|------|------|-------|
| C: | 57 GB | ~1.4 GB | System drive — nearly full, still fragile |
| D: | 931 GB | ~922 GB | Primary work drive |

**Routing rules — before any install/cache-heavy command, redirect to D::**
- `PLAYWRIGHT_BROWSERS_PATH=D:\playwright-browsers` (set as persistent User env var 2026-05-13)
- npm cache → `D:\npm-cache` (moved 2026-05-19 via `npm config set cache D:\npm-cache`)

If a tool has no env-var escape hatch, ask the user before defaulting to C:.

---

## Shell Environment

The `!`-prefix in Claude Code runs through **Git Bash** (POSIX), NOT PowerShell.

**Rules for `!`-prefix commands:**
- Set env vars inline bash-style: `VAR='value' command ...`  (NOT `$env:VAR = 'value'; command`)
- Use forward-slash paths: `/d/TrackPoint/scripts/foo.js`  (NOT `D:\TrackPoint\scripts\foo.js`)
- Single-quoted values preserve backslashes literally

**Rules for PowerShell tool:** use `$env:VAR`, backslash paths are OK.

---

## Claude Code Settings

### Global settings (`C:\Users\drcal\.claude\settings.json`)
```json
{
  "theme": "dark",
  "voiceEnabled": true,
  "voice": {
    "enabled": true,
    "mode": "hold"
  }
}
```

### Global local settings (`C:\Users\drcal\.claude\settings.local.json`)
Allowed permissions (user-level):
- `PowerShell(Get-Content *)`
- `PowerShell(netstat *)`
- `PowerShell(nslookup *)`
- `PowerShell(& "C:\Users\drcal\AppData\Roaming\npm\openclaw.cmd" browser snapshot ...)`
- `PowerShell(& "C:\Users\drcal\AppData\Roaming\npm\openclaw.cmd" browser list ...)`
- `PowerShell(& "C:\Users\drcal\AppData\Roaming\npm\openclaw.cmd" browser tabs ...)`

### Project settings (`D:\TrackPoint\.claude\settings.local.json`)
Allowed permissions (project-level):
- `Bash(PLAYWRIGHT_BROWSERS_PATH='D:\\playwright-browsers' node *)`
- `Bash(node *)`
- `Bash(git *)`
- `Bash(npm install *)`
- `Bash(npx kill-port *)`
- `Bash(curl -s http://localhost:3000/)`
- `Bash(curl -s http://localhost:3000/api/invoices)`
- `PowerShell(& "D:\\TrackPoint\\scripts\\launch-chrome-debug.ps1")`
- `PowerShell(Stop-Process *)`
- `PowerShell(Get-Process *)`
- `PowerShell(Get-NetTCPConnection *)`
- `PowerShell(netstat *)`
- `PowerShell(Get-ChildItem D:\\TrackPoint ...)`
- `PowerShell(Invoke-WebRequest ... http://localhost:3000 ...)`
- `PowerShell(Invoke-WebRequest ... http://127.0.0.1:9222/json/version ...)`
- `PowerShell(Resolve-DnsName *)`
- `PowerShell(nslookup *)`
- `PowerShell(Get-Content C:\\Windows\\System32\\drivers\\etc\\hosts ...)`
- `PowerShell(powershell -ExecutionPolicy Bypass -File D:\\TrackPoint\\scripts\\refresh-render-cookies.ps1)`
- `WebFetch(domain:intrepipay.onrender.com)`
- `WebFetch(domain:intrepipay.com)`
- `WebFetch(domain:developer.getjobber.com)`
- `WebSearch`

---

## Playwright / Chrome Stealth Setup

**Browser:** Real Chrome via `launchPersistentContext` with profile at `D:\chrome-debug-profile`

**Why stealth approach:** Remote debug port (`--remote-debugging-port=9222`) was detectable by Cloudflare. Switched to persistent context with:
- No CDP port
- `ignoreDefaultArgs: ['--enable-automation']`
- `--disable-blink-features=AutomationControlled`
- `navigator.webdriver` init script patch

**Before every run:** Kill Chrome first:
```powershell
Stop-Process -Name "chrome" -Force
```
Profile lock from a previous session causes "context has been closed" errors.

---

## Key Selector Fixes (Jobber UI)

| Element | Selector / Method |
|---------|------------------|
| Payment method | `page.locator('select').selectOption({ label: type })` — native `<select>` |
| Check # / Reference # | `page.getByLabel(/check/i)` or `page.getByLabel(/reference/i)` — floating labels |
| Transaction Date | `page.getByLabel('Transaction Date')` — `input[type=text]` controlled by react-datepicker. Must click calendar day cell; do NOT set value programmatically (React resets on blur) |
| Invoice checkboxes | `a[href*="/invoices/DBID"]` in each row |
| Multi-invoice arg | `--invoiceId=ID1,ID2,ID3` (comma-separated) |

**Form fill order (updated 2026-05-21, commit 84de170):**
1. **Check all invoices first** (scroll entire virtual list)
2. Scroll back to top
3. Select payment method
4. Fill reference number
5. Fill date last (React can't reset it after this point)

Previously method + ref were filled before invoices, which caused React re-renders during the scroll to clear the reference field. Moving all form fills to after the scroll eliminates the problem entirely. No restart needed between payments — the script is loaded fresh each run.

### Virtual List Scroll Logic
Jobber's invoice list is a virtual/windowed list. Scroll termination uses **scroll position stability**, not row count:
- Scrolls 600px at a time
- Stops when position stops changing for 3 consecutive checks
- Do NOT dispatch bubbling scroll events — `container.scrollTop` fires a native scroll natively without bubbling (bubbling was accidentally hitting Jobber's router)

### Nav-Interrupt Retry
When Jobber navigates away mid-evaluate (session timeout), the evaluate context is destroyed. `ensureInvoicesChecked` retries: on attempt 2, navigates back to payment URL, re-selects method, re-fills reference, then scrolls again. Takes `{ type, ref }` params.

---

## Payment Script Status

**Confirmed working** (as of 2026-05-14):
- clientId=108338080, invoiceIds=146388256,149670672,149671648, type=Check, ref=2705192, date=05/08/2026

**Queue stuck fix:**
```
POST https://intrepipay.com/api/queue-reset
# or in browser console:
fetch('/api/queue-reset',{method:'POST'}).then(r=>r.json()).then(console.log)
```

---

## Shortpay Handling (added 2026-05-22)

A **shortpay** occurs when the remittance amount is less than the Jobber invoice total (e.g., Rheem pays $175 on a $200 invoice).

- **Status:** `shortpay` (alongside `match`, `overpay`, `no-match`)
- **Apply button:** shown for `match`, `overpay`, AND `shortpay` rows; defaults to remittance amount (not invoice total)
- **`applyAll` routing:** when any matched item is a shortpay, routes through `/api/apply-all-payments` (GraphQL with explicit per-item amounts) instead of Playwright (which applies full Jobber balance). Non-shortpay batches continue using Playwright.
- **Amount logic:** `match`/`shortpay` → `Math.abs(remittance_amount)`; `overpay` → `jobber_amount`
- **Needs verification:** confirm correct amount recorded in Jobber next time a Rheem shortpay payment is applied.

---

## Deduction Automation (Recouped Funds)

- **Current status:** Manual step (Option A) — user adds "Recouped Funds" line item by hand
- **Planned:** Full Playwright automation navigating to invoice's `jobberWebUri`, clicking Edit, adding line item (name="Recouped Funds", description="WO #XXXXXXX", unitPrice=negative amount), then saving
- **Why Playwright only:** Jobber's GraphQL API has no invoice line item mutation for existing invoices

---

## Excel Parsing — Company Formats

### Cinch Home Services (multi-tab Excel)

**Summary/single-SCC tab:**
- Col 0 = SCC# (e.g. `SCCV14CE8DE7-4 Ref CCCV3X1A1781`)
- Col 1 = per-SCC amount (`$300.00 USD`)
- Col 4 = `payment number` = batch ref
- Col 5 = `payment method` = ACH
- Col 6 = `payment total`
- Col 7 = `date`

**Line-item tab:**
- Row 0: header (`wo# | payment | (empty x2) | payment number | payment method | payment total | date`)
- Row 1: summary (batch ref in col 4)
- Rows 2+: WO line items

**Key parsing rules:**
- SCC# found by scanning ALL cells (may be in col 0 or col 5)
- Ref extracted from `payment number` (index 4) BEFORE SCC# check
- `sheetName` fallback for ref runs AFTER all company-specific loops

### Lessen & General Excel Fix (resolved 2026-05-17, commit 7f189e0)
Excel stores currency cells as plain numbers and date cells as Date objects when `XLSX.read` uses `cellDates:true`.
- Use `typeof cell === 'number'` fallback for amount extraction
- Use `cell instanceof Date` fallback for date extraction
- Use `amount.toFixed(2)` for remit lines

### Company Detection — Full-Text Scan Fallback (added 2026-05-22)
When the first 5 rows don't identify the company (e.g. Rheem SAP EFT, First American FAHW), `_parseExcelSheet` falls through to a full-text scan of all rows:
```javascript
const fullText = rows.map(r => r.map(c=>String(c||'')).join('\t')).join('\n');
if (/document reference number/i.test(fullText) || /\b260\d{7,8}\b/.test(fullText)) co = 'Rheem';
else if (/\bEFTPY\d+\b/i.test(fullText) || /\bFALCON\b/i.test(fullText)) co = 'First American / FALCON';
```

---

## First American / FALCON (FAHW) Remittance Format

**Format switched to Excel (FAHW EFT) as of 2026-05-22.**

- **Payment method:** EFT → use ACH type in Jobber
- **Ref for Playwright:** EFTPY number (e.g. `EFTPY060106`) — NOT the Contractor # (same every payment, not unique)

### FAHW EFT Excel Structure
- Row 3: `Payment #` | (blank) | `EFTPY060106` ← correct payment ref
- Row 4: `Contractor #` | (blank) | `13866923` ← company ID, ignore for ref
- Rows 5–9: other header info including "Total Amount Paid on MM/DD/YYYY" (date extracted from this row)
- Rows 10–11: two-row spanning column headers; `Work Order` in col 5, `Net Paid` in col 12
- Rows 12+: data — Work Order = 9-digit number starting with `621` or `622`; Net Paid = amount paid

### Parsing Notes
- **Company detection:** full-text scan for `\bEFTPY\d+\b` or `\bFALCON\b`
- **Ref extraction:** scan all cells for EFTPY pattern → `ref = 'EFTPY' + digits`
- **Work Order storage:** Excel stores large numbers in scientific notation; use `String(Math.round(woCellRaw))` to recover integer
- **`parseRemittance` fix:** FA Excel lines are tab-separated with only 2 tokens (WO + amount). Old PDF branch required ≥4 numbers and silently skipped these. New tab-split path runs first and checks for 9-digit prefix `6[12]\d{7}`.

---

## All County First Choice (ePay PDF)

- ePay PDF has `Check #: ePay` — not a real ref
- Real payment ID (e.g. `TXBN14`) lives only in bank statement description as `ID:TXBN14`
- `resolvedRef` in `matchPayment` auto-derives ref from `extractBankRef(matchedTxn.desc)` when `payment.ref` is blank
- Results block shows: `Ref TXBN14` (for Playwright) + full bank line for visual verification
- Jobber token refresh handles non-JSON error responses (expired refresh token → clears tokens → 401 → re-auth)

---

## Bank PDF Upload (Step 2)

### BofA Online Banking Print Format (primary)
- Access: Account Activity → filter "All credits, non-reconciled" → print to PDF
- Date format: `MM/DD/YYYY`
- Amount format: `$345.00`
- Multi-line: main line has date/desc/type/amount; continuation lines have `ID:XXXXXX INDN:... CO ID:... PPD`
- Payment ID extraction: strip `CO ID:` first, then match `ID:([A-Z0-9]{4,})`

### Traditional BofA Statement PDF (fallback)
- Date format: `MM/DD` (year inferred from statement header)
- Looks for "Deposits and Other Credits" section header
- Stops at "Withdrawals", "Checks Paid", etc.

**Mobile deposits:** show as `BKOFAMERICA MOBILE MM/DD XXXXX##### DEPOSIT *MOBILE FL` — no customer name, identifiable only by amount.

---

## Rheem Remittance Format

**Format switched to Excel (SAP EFT) as of 2026-05-22.**

- **Payment method:** EFT → use ACH type in Jobber
- **Ref for Playwright:** `Paper Document Number` value (e.g. `633348`) — NOT the WCN numbers, and NOT `Payment Reference Number` (that's an internal Rheem ID, not what shows on the bank statement)
- **WCN numbers:** listed in `Document Reference Number` column; match against Jobber invoice Subject

### SAP EFT Excel Structure
- Rows 0–9: key/value pairs — `Payment Reference Number`, `Paper Document Number`, `Payment Date`, `Payment Amount`, `Payment Method`
- Row 10: blank + "Remittance Detail" label
- Row 11: column headers — `Document Reference Number | Comments | Document Date | Document Amount | Document Currency | Amount Withheld | Discount Taken | Amount Paid`
- Rows 12+: data — WCNs comma-separated in col 0 (e.g. `"2603250343, 2603300112, 2604010137"`); Amount Paid in last col
- Date format in key/value section: `"18-May-26"` — parsed via month-name lookup

### Parsing Notes
- **Company detection:** full-text scan across all rows for `"document reference number"` or WCN pattern `\b260\d{7,8}\b` (first 5 rows don't contain these)
- **Amount override:** Rheem branch always sets `amt` from "Payment Amount" row — does NOT use `!amt` guard because generic loop picks up the ref number (numeric) as a false amount first
- **Multiple WCNs on one line = one invoice at full amount** — fixed 2026-05-21 (commit 4449e99). First WCN is the match key; remaining WCNs stored in `secondary_ref`.
- **Auto-detection (PDF):** regex `\b260\d{7,8}\b` also identifies Rheem in PDF text

### Jobber Subject Format (corrected 2026-06-07)
```
CAS-2166291-H6B8W7 -WCN - 2603120079 / 2603040048
```
WCNs appear after `-WCN -` separated by ` / `. `lookupJobber` splits any comma-joined ref from the collector using `/\b260\d{7,8}\b/g`, then tries each WCN individually as an exact key, then falls back to partial/contains match against all Jobber Subject keys.

---

## Changes Since 2026-05-22 (commits 102a399 → 881b26d)

### Rebrand — IntrepiPay → TrackPoint (102a399)
- App name, UI labels, Render service name, file paths, and this doc all updated to TrackPoint
- Production URL unchanged: https://intrepipay.com
- Render service renamed from `intrepipay` to `trackpoint`; `COLLECTOR_URL` env var added

### Lula Added (eb42fb9)
- Lula Home Services added as a supported company in the modal dropdown and parser
- `lookupJobber` handles Lula job IDs; "no invoice" notice shown when 0 claims match

### Parsing Fixes (2ef8872)
- **2-10 Home Buyers Warranty:** fixed Excel column detection
- **ORHP (Old Republic):** fixed key/value header extraction for Check Number + Check Date
- **Lula:** 3 different export formats now handled (standard, jobs-detail, compact payout)
- **Cinch PDF:** improved SCC# extraction from remittance PDFs

### AI Extraction Fallback (96b3014)
- When `_parseExcelSheet` returns null for an unrecognized format, `aiExtractRemittance` is called
- Sends raw sheet text to Claude API using the user's stored API key
- Returns structured `{co, ref, amt, date, remit}` — same shape as the manual parsers
- Requires `window._apiKey` to be set (via the 🔑 API Key button)

### Remittance Collector (7025771 → 8e05115)
- **Sources:** Rely, Lula, ORHP, 2-10, Rheem, First American, Lessen
- Each source uses Playwright to log into the company portal and scrape pending remittances
- Originally a separate process (`collector/index.js` on port 3001); **merged inline into `server.js`** (8e05115) using a try/catch IIFE
- On Render (where Playwright can't run), `collectorSources` is null → `/api/collect` returns 503 gracefully
- **Not deployed to Render** — runs locally only (would require a separate $25/mo Render instance for Playwright)
- `start.ps1` launches: Chrome (CDP port 9222) + `node server.js` + `node scripts/local-worker.js`
- Collect button status visibility fixed (CSS `display:none` was never overridden; now explicitly set via JS)

### Jobber Payment API Removed (30f4143 → 28e6377)
- Jobber removed `invoicePaymentCreate` mutation from newer API versions (~2026-05-22)
- TrackPoint probed multiple API versions to find this; ultimately removed GraphQL payment path entirely
- **All payments now route through Playwright** (local worker via SSE)
- Shortpay path: passes explicit `amount` param to Playwright; Playwright overrides the Jobber-computed balance
- Non-shortpay path: Playwright applies whatever Jobber computes (full balance)

### Local Worker / SSE Architecture (3da9d78)
- `scripts/local-worker.js` polls `GET /api/jobs/next` (authenticated by `WORKER_SECRET`)
- Server enqueues Playwright jobs; worker picks them up, runs them, streams log lines back via `POST /api/jobs/:id/log`
- Browser receives SSE stream from `GET /api/playwright-payment?...`
- Allows TrackPoint server to run on Render while Playwright automation runs on the local machine

### Invoice Matching — Wrong-Client Fix (e516238 → 881b26d)
- **Problem:** Invoices under the wrong Jobber client (e.g., a 2-10 invoice filed under a homeowner) were being matched and applied, causing incorrect payments
- **Fix — `coHasOwnClient` flag:** before filtering by client name, `lookupJobber` checks whether any Jobber invoice exists with that company as the client
  - If yes (e.g., "2-10", "Rely") → enforces client name filter; wrong-client rows return null → status = `missing`
  - If no (e.g., "Rheem" — invoices are always under homeowners) → skips filter entirely
- Prevents the Apply All button from appearing when an invoice is under the wrong client

### Rheem WCN Multi-Match Fix (881b26d)
- **Problem:** Collector stored multiple WCNs as `"2603110023,2603130027,2603240379"` (comma-joined); `lookupJobber` tried to look up the entire string as one key — not found
- **Fix:** `lookupJobber` splits the ref using `/\b260\d{7,8}\b/g` regex before lookup; tries each WCN individually, then falls back to partial key match (`k.includes(wcn)`)
- Jobber subject format (corrected): `CAS-2166291-H6B8W7 -WCN - 2603120079 / 2603040048` — WCNs after `-WCN -` separated by ` / `

### `start.ps1` Desktop Shortcut Updates
- Added `Start-Process "http://localhost:3000"` — opens TrackPoint automatically
- Opens Jobber + TrackPoint in Chrome, then starts server + worker in separate PowerShell windows

---

## Open Issues (as of 2026-06-07)

1. **Shortpay amount verification:** Next Rheem shortpay — confirm Jobber records the remittance amount (not invoice total) after Playwright applies it with the explicit `amount` override.

2. **Collector not on Render:** Playwright-based collection only works locally. Dedicated Render instance ($25/mo) needed if other clients ever use TrackPoint.

---

## External References

- Jobber GraphQL API docs: https://developer.getjobber.com
- Production app: https://intrepipay.com
- Render deploy: https://intrepipay.onrender.com
