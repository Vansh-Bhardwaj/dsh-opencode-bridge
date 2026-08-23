[CmdletBinding()]
param(
  [ValidateRange(1, 65535)]
  [int]$Port = 3080,

  [ValidateRange(1, 65535)]
  [int]$LanPort = 3443,

  [ValidateRange(1, 120)]
  [int]$StartupTimeoutSeconds = 30,

  [switch]$NoOpen,

  [switch]$RemoteAccess
)

$ErrorActionPreference = 'Stop'
$url = "http://127.0.0.1:$LanPort/"

function Test-LocalPort {
  param([int]$TargetPort)

  $client = [System.Net.Sockets.TcpClient]::new()
  try {
    $pending = $client.ConnectAsync('127.0.0.1', $TargetPort)
    return $pending.Wait(250) -and $client.Connected
  }
  catch {
    return $false
  }
  finally {
    $client.Dispose()
  }
}

function Show-LaunchError {
  param([string]$Message)

  try {
    Add-Type -AssemblyName PresentationFramework
    [void][System.Windows.MessageBox]::Show(
      $Message,
      'DeepSeek Harness Web',
      [System.Windows.MessageBoxButton]::OK,
      [System.Windows.MessageBoxImage]::Error
    )
  }
  catch {
    # The launcher is intentionally silent when desktop UI is unavailable.
  }
}

try {
  if (-not (Test-LocalPort -TargetPort $Port)) {
    $dshCommand = Get-Command dsh.cmd -ErrorAction SilentlyContinue
    if (-not $dshCommand) {
      $dshCommand = Get-Command dsh -ErrorAction Stop
    }

    $logDirectory = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.dsh\logs'
    New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
    $stdoutLog = Join-Path $logDirectory 'web-launcher.stdout.log'
    $stderrLog = Join-Path $logDirectory 'web-launcher.stderr.log'

    $server = Start-Process `
      -FilePath $dshCommand.Source `
      -ArgumentList @('web', '--no-open', '--port', [string]$Port) `
      -WindowStyle Hidden `
      -RedirectStandardOutput $stdoutLog `
      -RedirectStandardError $stderrLog `
      -PassThru

    $deadline = [DateTime]::UtcNow.AddSeconds($StartupTimeoutSeconds)
    while ([DateTime]::UtcNow -lt $deadline) {
      if (Test-LocalPort -TargetPort $Port) { break }
      if ($server.HasExited) {
        $detail = if (Test-Path -LiteralPath $stderrLog) {
          (Get-Content -LiteralPath $stderrLog -Tail 12) -join [Environment]::NewLine
        }
        else {
          "DSH exited with code $($server.ExitCode)."
        }
        throw $detail
      }
      Start-Sleep -Milliseconds 250
    }

    if (-not (Test-LocalPort -TargetPort $Port)) {
      throw "DSH Web did not become available on port $Port within $StartupTimeoutSeconds seconds."
    }
  }

  if (-not (Test-LocalPort -TargetPort $LanPort)) {
    $gatewayScript = Join-Path $PSScriptRoot 'gateway\server.mjs'
    if (-not (Test-Path -LiteralPath $gatewayScript)) {
      throw "LAN gateway is not installed: $gatewayScript"
    }
    $node = (Get-Command node.exe -ErrorAction Stop).Source
    $logDirectory = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.dsh\logs'
    New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
    $gateway = Start-Process `
      -FilePath $node `
      -ArgumentList @($gatewayScript) `
      -WindowStyle Hidden `
      -Environment @{ DSH_WEB_PORT = [string]$Port; DSH_LAN_PORT = [string]$LanPort } `
      -RedirectStandardOutput (Join-Path $logDirectory 'lan-gateway.stdout.log') `
      -RedirectStandardError (Join-Path $logDirectory 'lan-gateway.stderr.log') `
      -PassThru
    $deadline = [DateTime]::UtcNow.AddSeconds($StartupTimeoutSeconds)
    while ([DateTime]::UtcNow -lt $deadline) {
      if (Test-LocalPort -TargetPort $LanPort) { break }
      if ($gateway.HasExited) {
        $detail = (Get-Content -LiteralPath (Join-Path $logDirectory 'lan-gateway.stderr.log') -Tail 12) -join [Environment]::NewLine
        throw ($detail ?? "LAN gateway exited with code $($gateway.ExitCode).")
      }
      Start-Sleep -Milliseconds 200
    }
    if (-not (Test-LocalPort -TargetPort $LanPort)) {
      throw "Harness LAN gateway did not become available on port $LanPort."
    }
  }

  if (-not $NoOpen) {
    Start-Process ($RemoteAccess ? ($url + '_bridge/access') : $url)
  }
}
catch {
  Show-LaunchError -Message ("Could not open DeepSeek Harness Web.`n`n" + $_.Exception.Message)
  exit 1
}
