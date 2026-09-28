[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [ValidateRange(1, 65535)]
  [int]$TestPort = 8790
)

$ErrorActionPreference = 'Stop'
$stopped = 0
$matchedProcessIds = [System.Collections.Generic.HashSet[int]]::new()

function Stop-MatchedProcess {
  param(
    [Parameter(Mandatory = $true)]
    [int]$ProcessId,
    [Parameter(Mandatory = $true)]
    [string]$Description
  )

  if (-not $matchedProcessIds.Add($ProcessId)) {
    return
  }

  if ($PSCmdlet.ShouldProcess("PID $ProcessId ($Description)", 'Stop process')) {
    Stop-Process -Id $ProcessId -Force -ErrorAction Stop
    $script:stopped++
    Write-Host "Stopped $Description (PID $ProcessId)." -ForegroundColor Green
  }
}

$listeners = @(Get-NetTCPConnection -State Listen -LocalPort $TestPort -ErrorAction SilentlyContinue)
foreach ($listener in $listeners) {
  $process = Get-CimInstance Win32_Process -Filter "ProcessId = $($listener.OwningProcess)" -ErrorAction SilentlyContinue
  if (-not $process) {
    continue
  }

  if ($process.CommandLine -like '*test-gateway-bootstrap.ts*') {
    Stop-MatchedProcess -ProcessId $process.ProcessId -Description "Washcut test gateway on port $TestPort"
  } else {
    Write-Warning "Port $TestPort is used by PID $($process.ProcessId), but it is not the Washcut test gateway. It was not stopped."
  }
}

$escapedPort = [regex]::Escape([string]$TestPort)
$tunnelPattern = "--url\s+(?:`"|')?http://(?:127\.0\.0\.1|localhost):$escapedPort(?:/)?(?:`"|'|\s|$)"
$cloudflaredProcesses = @(Get-CimInstance Win32_Process -Filter "Name = 'cloudflared.exe'" -ErrorAction SilentlyContinue)
foreach ($process in $cloudflaredProcesses) {
  if ($process.CommandLine -match $tunnelPattern) {
    Stop-MatchedProcess -ProcessId $process.ProcessId -Description "Cloudflare Quick Tunnel for port $TestPort"
  }
}

if ($stopped -eq 0 -and -not $WhatIfPreference) {
  Write-Host "No running Washcut public test was found on port $TestPort." -ForegroundColor Yellow
}

Write-Host 'The main Washcut service on port 8787 and all task files were left unchanged.' -ForegroundColor Cyan
