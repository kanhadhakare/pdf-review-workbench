param(
  [switch]$SkipBuild,
  [switch]$SkipTunnel,
  [string]$PublicUrl = "https://tools.dlskr.com"
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Invoke-Checked {
  param(
    [string]$Label,
    [scriptblock]$Script
  )
  Write-Host ""
  Write-Host "== $Label =="
  & $Script
}

function Test-WslAvailable {
  try {
    $list = & wsl.exe -l -q 2>$null
    return (($LASTEXITCODE -eq 0) -and ($list | Where-Object { $_.Trim() }))
  } catch {
    return $false
  }
}

Invoke-Checked "Stop Windows app stack" {
  & "$root\scripts\stop-public-stack.ps1"
}

if (-not $SkipBuild) {
  Invoke-Checked "Build backend" {
    Push-Location "$root\backend"
    npm.cmd run build
    Pop-Location
  }
  Invoke-Checked "Build frontend" {
    Push-Location "$root\frontend"
    npm.cmd run build
    Pop-Location
  }
}

Invoke-Checked "Start Windows app stack" {
  node "$root\scripts\start-public-stack.mjs"
}

Start-Sleep -Seconds 8

Invoke-Checked "Check local ports" {
  netstat -ano | findstr ":3000 :4300 :8090"
}

Invoke-Checked "Check backend health" {
  Invoke-WebRequest -Uri "http://127.0.0.1:3000/api/health" -UseBasicParsing -TimeoutSec 10 | Select-Object -ExpandProperty Content
}

Invoke-Checked "Check protected gateway" {
  $envFile = Get-Content "$root\.public-gateway.env"
  $user = ($envFile | Where-Object { $_ -like "PUBLIC_GATEWAY_USER=*" }).Split("=", 2)[1]
  $pass = ($envFile | Where-Object { $_ -like "PUBLIC_GATEWAY_PASS=*" }).Split("=", 2)[1]
  $auth = "Basic " + [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("${user}:${pass}"))
  $response = Invoke-WebRequest -Uri "http://127.0.0.1:8090" -Headers @{ Authorization = $auth } -UseBasicParsing -TimeoutSec 10
  Write-Host "Gateway status: $($response.StatusCode)"
}

if (-not $SkipTunnel) {
  Invoke-Checked "Restart Cloudflare tunnel in WSL" {
    if (Test-WslAvailable) {
      & wsl.exe -e bash -lc "sudo systemctl restart cloudflared && sleep 5 && sudo systemctl status cloudflared --no-pager -l | tail -25"
    } else {
      Write-Warning "WSL is not available from this PowerShell session. Restart tunnel manually in WSL: sudo systemctl restart cloudflared"
    }
  }
}

Invoke-Checked "Check public URL" {
  try {
    curl.exe -I $PublicUrl
  } catch {
    Write-Warning "Public URL check failed. If you see 1033, cloudflared is not connected. If you see 502, origin/gateway is not reachable."
  }
}

Write-Host ""
Write-Host "Done."
Write-Host "Local gateway: http://127.0.0.1:8090"
Write-Host "Public URL: $PublicUrl"
