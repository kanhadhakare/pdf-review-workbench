$pass = (Get-Content .public-gateway.env | Where-Object { $_ -like 'PUBLIC_GATEWAY_PASS=*' }).Split('=')[1]
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = 'C:\Program Files\nodejs\node.exe'
$psi.Arguments = 'scripts/public-gateway.mjs'
$psi.WorkingDirectory = 'E:\pdf-review-workbench'
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true
if ($null -eq $psi.EnvironmentVariables) { throw 'EnvironmentVariables is null' }
$psi.EnvironmentVariables['PUBLIC_GATEWAY_USER'] = 'reviewer'
$psi.EnvironmentVariables['PUBLIC_GATEWAY_PASS'] = $pass
$psi.EnvironmentVariables['PUBLIC_GATEWAY_PORT'] = '8090'
$p = [System.Diagnostics.Process]::Start($psi)
Start-Sleep -Seconds 2
"PID=$($p.Id) PASS=$pass"
