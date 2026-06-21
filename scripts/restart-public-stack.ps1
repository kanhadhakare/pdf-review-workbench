$ErrorActionPreference = "Stop"

$root = "E:\pdf-review-workbench"
Set-Location $root

Write-Host "Stopping existing public stack..."
& "$root\scripts\stop-public-stack.ps1"

Start-Sleep -Seconds 2

Write-Host "Building backend..."
Push-Location "$root\backend"
npm.cmd run build
Pop-Location

Write-Host "Starting backend, frontend, and protected gateway..."
node "$root\scripts\start-public-stack.mjs"

Start-Sleep -Seconds 8

Write-Host "Checking ports..."
netstat -ano | findstr ":3000 :4300 :8090"

Write-Host "Checking backend..."
Invoke-WebRequest -Uri "http://127.0.0.1:3000/api/health" -UseBasicParsing -TimeoutSec 10 | Select-Object -ExpandProperty Content

Write-Host "Checking protected gateway..."
$envFile = Get-Content "$root\.public-gateway.env"
$user = ($envFile | Where-Object { $_ -like "PUBLIC_GATEWAY_USER=*" }).Split("=")[1]
$pass = ($envFile | Where-Object { $_ -like "PUBLIC_GATEWAY_PASS=*" }).Split("=")[1]
$pair = "${user}:${pass}"
$auth = "Basic " + [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes($pair))
$response = Invoke-WebRequest -Uri "http://127.0.0.1:8090" -Headers @{ Authorization = $auth } -UseBasicParsing -TimeoutSec 10
Write-Host "Gateway status: $($response.StatusCode)"

Write-Host ""
Write-Host "Windows app stack is ready."
Write-Host "Restart WSL tunnel with:"
Write-Host "  sudo systemctl restart cloudflared"
Write-Host "  curl -I https://tools.dlskr.com"
