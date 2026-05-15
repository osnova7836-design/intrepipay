# Exports fresh Jobber cookies and pushes them to Render, then triggers a redeploy.
# Run manually or via Windows Task Scheduler every 3 days.
#
# Required env vars (set once in System Properties > Environment Variables):
#   RENDER_API_KEY    — Render dashboard > Account > API Keys
#   RENDER_SERVICE_ID — from your Render service URL: dashboard.render.com/web/srv-XXXXXXXX

$ErrorActionPreference = 'Stop'

$ScriptDir  = "D:\intrepipay"
$LogDir     = "D:\intrepipay\logs"
$LogFile    = "$LogDir\cookie-refresh.log"

function Write-Log($msg) {
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $msg"
    Write-Host $line
    Add-Content -Path $LogFile -Value $line
}

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

Write-Log "=== Starting Jobber cookie refresh ==="

# --- 1. Export cookies from local Chrome profile ---
$output = & node "$ScriptDir\scripts\export-jobber-cookies.js" 2>$null
$cookiesJson = ($output | Where-Object { $_ -match '^\[' }) | Select-Object -First 1

if (-not $cookiesJson) {
    Write-Log "ERROR: No JSON found in script output. Is Chrome logged in to Jobber?"
    Write-Log "Script output: $($output -join ' | ')"
    exit 1
}

$cookieCount = ($cookiesJson | ConvertFrom-Json).Count
Write-Log "Exported $cookieCount cookies."

# --- 2. Push to Render ---
$apiKey    = if ($env:RENDER_API_KEY)    { $env:RENDER_API_KEY }    else { [System.Environment]::GetEnvironmentVariable("RENDER_API_KEY",    "Machine") }
$serviceId = if ($env:RENDER_SERVICE_ID) { $env:RENDER_SERVICE_ID } else { [System.Environment]::GetEnvironmentVariable("RENDER_SERVICE_ID", "Machine") }

if (-not $apiKey)    { Write-Log "ERROR: RENDER_API_KEY not set.";    exit 1 }
if (-not $serviceId) { Write-Log "ERROR: RENDER_SERVICE_ID not set."; exit 1 }

$headers = @{
    Authorization  = "Bearer $apiKey"
    Accept         = "application/json"
    "Content-Type" = "application/json"
}

# GET current env vars so we only replace JOBBER_COOKIES and keep everything else
Write-Log "Fetching current Render env vars..."
$current = Invoke-RestMethod -Uri "https://api.render.com/v1/services/$serviceId/env-vars" -Headers $headers

$updated = [System.Collections.Generic.List[hashtable]]::new()
$found = $false
foreach ($item in $current) {
    if ($item.envVar.key -eq "JOBBER_COOKIES") {
        $updated.Add(@{ key = "JOBBER_COOKIES"; value = $cookiesJson })
        $found = $true
    } else {
        $updated.Add(@{ key = $item.envVar.key; value = $item.envVar.value })
    }
}
if (-not $found) { $updated.Add(@{ key = "JOBBER_COOKIES"; value = $cookiesJson }) }

$body = ConvertTo-Json $updated -Compress -Depth 3

Write-Log "Updating JOBBER_COOKIES on Render..."
Invoke-RestMethod -Method PUT `
    -Uri "https://api.render.com/v1/services/$serviceId/env-vars" `
    -Headers $headers -Body $body | Out-Null

# --- 3. Trigger a redeploy so the new cookies take effect ---
Write-Log "Triggering redeploy..."
Invoke-RestMethod -Method POST `
    -Uri "https://api.render.com/v1/services/$serviceId/deploys" `
    -Headers $headers -Body "{}" | Out-Null

Write-Log "Done. Cookies refreshed and redeploy triggered."
Write-Log "=== Finished ==="
