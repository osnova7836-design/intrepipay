# Launch Chrome with remote debugging enabled on port 9222
$chromePath = "C:\Program Files\Google\Chrome\Application\chrome.exe"
$debugPort = 9222
$profileDir = "D:\chrome-debug-profile"

if (-not (Test-Path $chromePath)) {
    Write-Error "Chrome not found at: $chromePath"
    exit 1
}

$existing = Get-Process -Name "chrome" -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "Stopping existing Chrome processes..."
    $existing | Stop-Process -Force
    Start-Sleep -Seconds 1
}

Write-Host "Launching Chrome on debug port $debugPort..."
Start-Process $chromePath -ArgumentList "--remote-debugging-port=$debugPort", "--user-data-dir=$profileDir"
Write-Host "Chrome launched. Debugger available at http://localhost:$debugPort"
