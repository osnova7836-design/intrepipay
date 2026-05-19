# TrackPoint_OS startup — launches Chrome debug + server + worker
$root = $PSScriptRoot
$chromePath = "C:\Program Files\Google\Chrome\Application\chrome.exe"
$profileDir = "D:\chrome-debug-profile"

# Launch Chrome with debug port
$existing = Get-Process -Name "chrome" -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "Stopping existing Chrome processes..."
    $existing | Stop-Process -Force
    Start-Sleep -Seconds 1
}
Write-Host "Launching Chrome on debug port 9222..."
Start-Process $chromePath -ArgumentList "--remote-debugging-port=9222", "--user-data-dir=$profileDir"

Write-Host "Opening Jobber in Chrome..."
Start-Sleep -Seconds 2
Start-Process "https://secure.getjobber.com"

# Start server and worker in separate windows
Write-Host "Starting server and worker..."
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$root'; node server.js"
Start-Sleep -Seconds 1
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$root'; node scripts/local-worker.js"

Write-Host "Done. TrackPoint_OS running at http://localhost:3000"
