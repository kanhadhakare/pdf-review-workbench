$ports = @(3000, 4200, 8090)
$pids = @()

foreach ($port in $ports) {
  $connections = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
  foreach ($connection in $connections) {
    if ($connection.OwningProcess -and ($pids -notcontains $connection.OwningProcess)) {
      $pids += $connection.OwningProcess
    }
  }

  if (-not $connections) {
    $netstatLines = netstat -ano | Select-String -Pattern ":$port\s+.*LISTENING\s+(\d+)"
    foreach ($line in $netstatLines) {
      $processId = [int]$line.Matches[0].Groups[1].Value
      if ($processId -and ($pids -notcontains $processId)) {
        $pids += $processId
      }
    }
  }
}

foreach ($pidValue in $pids) {
  Stop-Process -Id $pidValue -Force
  Write-Host "Stopped process $pidValue"
}

if ($pids.Count -eq 0) {
  Write-Host "No public stack processes found on ports 3000, 4200, 8090."
}
