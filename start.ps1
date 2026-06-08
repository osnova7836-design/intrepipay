# TrackPoint_OS startup — server first, then Chrome + tabs
$root = $PSScriptRoot
$chromePath = "C:\Program Files\Google\Chrome\Application\chrome.exe"
$profileDir = "D:\chrome-debug-profile"

Write-Host "Starting TrackPoint server..."
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$root'; node server.js"
Start-Sleep -Seconds 3

Write-Host "Starting local worker..."
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$root'; node scripts/local-worker.js"

$existing = Get-Process -Name "chrome" -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "Stopping existing Chrome processes..."
    $existing | Stop-Process -Force
    Start-Sleep -Seconds 1
}

Write-Host "Launching Chrome with Jobber and TrackPoint tabs..."
Start-Process $chromePath -ArgumentList "--remote-debugging-port=9222", "--user-data-dir=$profileDir", "https://secure.getjobber.com", "http://localhost:3000"

Write-Host "Done. TrackPoint_OS running at http://localhost:3000"
