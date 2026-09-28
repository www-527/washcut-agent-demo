param(
  [int]$StartPort = 5173,
  [int]$EndPort = 5273
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

foreach ($port in $StartPort..$EndPort) {
  $listener = $null
  try {
    $listener = [System.Net.Sockets.TcpListener]::new(
      [System.Net.IPAddress]::Loopback,
      $port
    )
    $listener.Start()
    Write-Output $port
    exit 0
  } catch [System.Net.Sockets.SocketException] {
    continue
  } finally {
    if ($null -ne $listener) {
      $listener.Stop()
    }
  }
}

Write-Error "No available TCP port was found between $StartPort and $EndPort."
exit 1
