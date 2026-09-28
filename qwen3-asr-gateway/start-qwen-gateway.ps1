[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$PythonPath,

  [Parameter(Mandatory = $true)]
  [string]$GatewayDir,

  [Parameter(Mandatory = $true)]
  [string]$BindHost,

  [Parameter(Mandatory = $true)]
  [string]$Port
)

$ErrorActionPreference = 'Stop'

$stdoutPath = Join-Path $GatewayDir 'gateway-elevated.out.log'
$stderrPath = Join-Path $GatewayDir 'gateway-elevated.err.log'
$statusPath = Join-Path $GatewayDir 'gateway-elevated.status.log'

function Quote-WindowsArgument {
  param([Parameter(Mandatory = $true)][string]$Value)
  if ($Value -notmatch '[\s"]') { return $Value }
  return '"' + $Value.Replace('"', '\"') + '"'
}

function Write-Status {
  param([Parameter(Mandatory = $true)][string]$Message)
  $timestamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss.fff zzz'
  Add-Content -LiteralPath $statusPath -Value "[$timestamp] $Message" -Encoding UTF8
}

New-Item -ItemType Directory -Path $GatewayDir -Force | Out-Null

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
$isAdministrator = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdministrator) {
  $relaunchArguments = @(
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    $PSCommandPath,
    '-PythonPath',
    $PythonPath,
    '-GatewayDir',
    $GatewayDir,
    '-BindHost',
    $BindHost,
    '-Port',
    $Port
  )
  $argumentLine = ($relaunchArguments | ForEach-Object { Quote-WindowsArgument $_ }) -join ' '
  try {
    Write-Status 'Requesting administrator permission through Windows UAC.'
    Start-Process -Verb RunAs -WindowStyle Hidden -FilePath (Join-Path $PSHOME 'powershell.exe') -WorkingDirectory $GatewayDir -ArgumentList $argumentLine | Out-Null
    exit 0
  } catch {
    Write-Status "UAC launch failed: $($_.Exception.Message)"
    [Console]::Error.WriteLine("Qwen gateway elevation failed: $($_.Exception.Message)")
    exit 1
  }
}

if (-not (Test-Path -LiteralPath $PythonPath -PathType Leaf)) {
  Write-Status "Python executable was not found: $PythonPath"
  [Console]::Error.WriteLine("Qwen gateway Python executable was not found: $PythonPath")
  exit 2
}

Write-Status "Starting elevated Qwen gateway with $PythonPath."
$uvicornArguments = @('-m', 'uvicorn', 'app:app', '--host', $BindHost, '--port', $Port)
try {
  & $PythonPath @uvicornArguments >> $stdoutPath 2>> $stderrPath
  $exitCode = $LASTEXITCODE
  Write-Status "Qwen gateway exited with code $exitCode."
  exit $exitCode
} catch {
  Write-Status "Qwen gateway process failed: $($_.Exception.Message)"
  [Console]::Error.WriteLine("Qwen gateway process failed: $($_.Exception.Message)")
  exit 3
}
