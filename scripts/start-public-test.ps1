[CmdletBinding()]
param(
  [string]$AccessCode,
  [ValidateRange(1, 65535)]
  [int]$TestPort = 8790,
  [ValidateRange(1, 65535)]
  [int]$AdminPort = 8791,
  [ValidateRange(1, 30)]
  [int]$VisualConcurrency = 1,
  [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$runtimeLogs = Join-Path $projectRoot '.runtime-logs'
$gatewayOutput = Join-Path $runtimeLogs 'test-gateway.out.log'
$gatewayError = Join-Path $runtimeLogs 'test-gateway.err.log'
$cloudflaredOutput = Join-Path $runtimeLogs 'cloudflared.out.log'
$cloudflaredError = Join-Path $runtimeLogs 'cloudflared.err.log'

if ([string]::IsNullOrWhiteSpace($AccessCode)) {
  while ($true) {
    $AccessCode = Read-Host 'Step 1/2 - Enter TEST ACCESS CODE (minimum 6 characters; this is not concurrency)'
    if (-not [string]::IsNullOrWhiteSpace($AccessCode) -and $AccessCode.Trim().Length -ge 6) {
      break
    }
    Write-Host 'Access code is too short. Example: wash0902. Please enter it again.' -ForegroundColor Yellow
  }
} elseif ($AccessCode.Trim().Length -lt 6) {
  throw 'The test access code must contain at least 6 characters.'
}

if (-not $PSBoundParameters.ContainsKey('VisualConcurrency')) {
  while ($true) {
    $rawVisualConcurrency = Read-Host 'Step 2/2 - Enter VISUAL CONCURRENCY (1-30; press Enter for 1)'
    if ([string]::IsNullOrWhiteSpace($rawVisualConcurrency)) {
      $VisualConcurrency = 1
      break
    }
    $parsedVisualConcurrency = 0
    $isVisualConcurrencyInteger = [int]::TryParse($rawVisualConcurrency.Trim(), [ref]$parsedVisualConcurrency)
    if (-not $isVisualConcurrencyInteger -or $parsedVisualConcurrency -lt 1 -or $parsedVisualConcurrency -gt 30) {
      Write-Host 'Concurrency must be a whole number from 1 to 30. Please enter it again.' -ForegroundColor Yellow
      continue
    }
    $VisualConcurrency = $parsedVisualConcurrency
    break
  }
}

$cloudflaredCommand = Get-Command cloudflared.exe -ErrorAction SilentlyContinue
$cloudflaredPath = if ($cloudflaredCommand) {
  $cloudflaredCommand.Source
} else {
  Join-Path $env:LOCALAPPDATA 'Programs\cloudflared\cloudflared.exe'
}
if (-not (Test-Path -LiteralPath $cloudflaredPath)) {
  throw 'cloudflared.exe was not found. Download the Windows 64-bit build from https://developers.cloudflare.com/tunnel/downloads/.'
}

try {
  $backend = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:8787/api/health' -TimeoutSec 5
  if ($backend.StatusCode -ne 200) { throw "The local production API returned HTTP $($backend.StatusCode)." }
} catch {
  throw "The local production API on port 8787 is not ready. Start Washcut first. Original error: $($_.Exception.Message)"
}

$existing = Get-NetTCPConnection -State Listen -LocalPort $TestPort -ErrorAction SilentlyContinue
if ($existing) {
  throw "Test gateway port $TestPort is already used by process $($existing.OwningProcess). Stop the old test or choose another port with -TestPort."
}
if ($AdminPort -eq $TestPort) {
  throw 'The local administrator port must be different from the public test gateway port.'
}
$existingAdmin = Get-NetTCPConnection -State Listen -LocalPort $AdminPort -ErrorAction SilentlyContinue
if ($existingAdmin) {
  throw "Administrator dashboard port $AdminPort is already used by process $($existingAdmin.OwningProcess). Stop that process or choose another port with -AdminPort."
}

if (-not $SkipBuild) {
  Push-Location $projectRoot
  try {
    & pnpm.cmd build
    if ($LASTEXITCODE -ne 0) { throw "pnpm build failed with exit code $LASTEXITCODE." }
  } finally {
    Pop-Location
  }
}

New-Item -ItemType Directory -Force -Path $runtimeLogs | Out-Null
$previousCode = $env:WASHCUT_TEST_ACCESS_CODE
$previousPort = $env:WASHCUT_TEST_PORT
$previousAdminPort = $env:WASHCUT_TEST_ADMIN_PORT
$previousVisualConcurrency = $env:WASHCUT_TEST_VISUAL_CONCURRENCY
$env:WASHCUT_TEST_ACCESS_CODE = $AccessCode.Trim()
$env:WASHCUT_TEST_PORT = [string]$TestPort
$env:WASHCUT_TEST_ADMIN_PORT = [string]$AdminPort
$env:WASHCUT_TEST_VISUAL_CONCURRENCY = [string]$VisualConcurrency
$gateway = $null
$cloudflared = $null
$logReaders = @()

try {
  [System.IO.File]::WriteAllText($gatewayOutput, '')
  [System.IO.File]::WriteAllText($gatewayError, '')
  [System.IO.File]::WriteAllText($cloudflaredOutput, '')
  [System.IO.File]::WriteAllText($cloudflaredError, '')
  $pnpmPath = (Get-Command pnpm.cmd).Source
  $gateway = Start-Process -FilePath $pnpmPath -ArgumentList 'start:test-gateway' -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput $gatewayOutput -RedirectStandardError $gatewayError -PassThru
  $ready = $false
  for ($attempt = 0; $attempt -lt 40; $attempt++) {
    Start-Sleep -Milliseconds 250
    if ($gateway.HasExited) { break }
    try {
      $page = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$TestPort/test" -TimeoutSec 1
      $adminPage = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$AdminPort/admin" -TimeoutSec 1
      if ($page.StatusCode -eq 200 -and $adminPage.StatusCode -eq 200) { $ready = $true; break }
    } catch { }
  }
  if (-not $ready) {
    $rawError = if (Test-Path -LiteralPath $gatewayError) { Get-Content -Raw -LiteralPath $gatewayError } else { '' }
    throw "The test gateway did not start. Original error: $rawError"
  }

  Write-Host ''
  Write-Host "Local test gateway is ready: http://127.0.0.1:$TestPort/test" -ForegroundColor Green
  Write-Host "Local administrator dashboard: http://127.0.0.1:$AdminPort/admin" -ForegroundColor Green
  Write-Host "Visual analysis concurrency for new public test tasks: $VisualConcurrency" -ForegroundColor Green
  Write-Host 'Creating a temporary Cloudflare URL. Share the displayed trycloudflare.com URL and your access code with testers.' -ForegroundColor Cyan
  Write-Host 'This window now shows tester actions, task progress, model conversations, and original errors.' -ForegroundColor Cyan
  Write-Host 'Keep this window open. Press Ctrl+C to stop the public test.' -ForegroundColor Yellow
  Write-Host ''
  $adminUrl = "http://127.0.0.1:$AdminPort/admin"
  $edgeCandidates = @(
    (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'),
    (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe')
  )
  $edgePath = $edgeCandidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
  if ($edgePath) {
    Start-Process -FilePath $edgePath -ArgumentList @("--app=$adminUrl", '--new-window') | Out-Null
  } else {
    Start-Process $adminUrl | Out-Null
  }
  $cloudflared = Start-Process -FilePath $cloudflaredPath -ArgumentList @('tunnel', '--no-autoupdate', '--url', "http://127.0.0.1:$TestPort") -WindowStyle Hidden -RedirectStandardOutput $cloudflaredOutput -RedirectStandardError $cloudflaredError -PassThru

  foreach ($logPath in @($gatewayOutput, $gatewayError, $cloudflaredOutput, $cloudflaredError)) {
    $stream = [System.IO.File]::Open($logPath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
    $reader = New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::UTF8, $true)
    $logReaders += [pscustomobject]@{ Stream = $stream; Reader = $reader }
  }

  while (-not $cloudflared.HasExited) {
    foreach ($entry in $logReaders) {
      $newText = $entry.Reader.ReadToEnd()
      if (-not [string]::IsNullOrEmpty($newText)) { [Console]::Write($newText) }
    }
    if ($gateway.HasExited) {
      $rawError = if (Test-Path -LiteralPath $gatewayError) { Get-Content -Raw -LiteralPath $gatewayError } else { '' }
      throw "The test gateway stopped unexpectedly. Original error: $rawError"
    }
    Start-Sleep -Milliseconds 250
  }
  foreach ($entry in $logReaders) {
    $newText = $entry.Reader.ReadToEnd()
    if (-not [string]::IsNullOrEmpty($newText)) { [Console]::Write($newText) }
  }
  if ($cloudflared.ExitCode -ne 0) {
    throw "Cloudflare Tunnel stopped with exit code $($cloudflared.ExitCode)."
  }
} finally {
  foreach ($entry in $logReaders) {
    $entry.Reader.Dispose()
    $entry.Stream.Dispose()
  }
  if ($cloudflared -and -not $cloudflared.HasExited) {
    Stop-Process -Id $cloudflared.Id -Force -ErrorAction SilentlyContinue
  }
  if ($gateway -and -not $gateway.HasExited) {
    Stop-Process -Id $gateway.Id -Force -ErrorAction SilentlyContinue
  }
  $env:WASHCUT_TEST_ACCESS_CODE = $previousCode
  $env:WASHCUT_TEST_PORT = $previousPort
  $env:WASHCUT_TEST_ADMIN_PORT = $previousAdminPort
  $env:WASHCUT_TEST_VISUAL_CONCURRENCY = $previousVisualConcurrency
}
