[CmdletBinding()]
param(
  [ValidateRange(1, 65535)]
  [int]$Port = 3080,

  [ValidateRange(1, 65535)]
  [int]$LanPort = 3443,

  [string]$InstallRoot = (Join-Path ([Environment]::GetFolderPath('UserProfile')) '.dsh\launcher'),

  [string]$IconPath,

  [switch]$SkipDesktop,

  [switch]$SkipStartMenu
)

$ErrorActionPreference = 'Stop'
$sourceLauncher = Join-Path $PSScriptRoot 'Start-DSHWeb.ps1'
if (-not (Test-Path -LiteralPath $sourceLauncher)) {
  throw "Launcher script not found: $sourceLauncher"
}

New-Item -ItemType Directory -Path $InstallRoot -Force | Out-Null
$installedLauncher = Join-Path $InstallRoot 'Start-DSHWeb.ps1'
Copy-Item -LiteralPath $sourceLauncher -Destination $installedLauncher -Force
$sourceGateway = Join-Path (Split-Path -Parent $PSScriptRoot) 'gateway'
if (-not (Test-Path -LiteralPath (Join-Path $sourceGateway 'server.mjs'))) {
  throw "LAN gateway source not found: $sourceGateway"
}
$installedGateway = Join-Path $InstallRoot 'gateway'
New-Item -ItemType Directory -Path $installedGateway -Force | Out-Null
Copy-Item -Path (Join-Path $sourceGateway '*') -Destination $installedGateway -Recurse -Force

$installedIcon = Join-Path $InstallRoot 'deepseek.ico'
if (-not [string]::IsNullOrWhiteSpace($IconPath)) {
  $resolvedIcon = Resolve-Path -LiteralPath $IconPath -ErrorAction Stop
  if ([IO.Path]::GetExtension($resolvedIcon.Path) -ine '.ico') {
    throw "Shortcut icon must be an .ico file: $($resolvedIcon.Path)"
  }
  Copy-Item -LiteralPath $resolvedIcon.Path -Destination $installedIcon -Force
} elseif (-not (Test-Path -LiteralPath $installedIcon)) {
  $installedIcon = $null
}

$pwsh = (Get-Command pwsh.exe -ErrorAction Stop).Source
$arguments = "-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$installedLauncher`" -Port $Port -LanPort $LanPort"
$shell = New-Object -ComObject WScript.Shell

function New-DshShortcut {
  param([string]$Path, [switch]$RemoteAccess)

  $shortcut = $shell.CreateShortcut($Path)
  $shortcut.TargetPath = $pwsh
  $shortcut.Arguments = $arguments + $(if ($RemoteAccess) { ' -RemoteAccess' } else { '' })
  $shortcut.WorkingDirectory = [Environment]::GetFolderPath('UserProfile')
  $shortcut.WindowStyle = 7
  $shortcut.IconLocation = if ($installedIcon) { "$installedIcon,0" } else { "$env:SystemRoot\System32\shell32.dll,220" }
  $shortcut.Description = 'Open DeepSeek Harness Web without a visible terminal'
  $shortcut.Save()
}

$created = [System.Collections.Generic.List[string]]::new()
if (-not $SkipDesktop) {
  $desktop = [Environment]::GetFolderPath('Desktop')
  if ([string]::IsNullOrWhiteSpace($desktop)) {
    $desktop = Join-Path ([Environment]::GetFolderPath('UserProfile')) 'Desktop'
  }
  New-Item -ItemType Directory -Path $desktop -Force | Out-Null
  $desktopShortcut = Join-Path $desktop 'DeepSeek Harness Web.lnk'
  New-DshShortcut -Path $desktopShortcut
  $created.Add($desktopShortcut)
}

if (-not $SkipStartMenu) {
  $programs = [Environment]::GetFolderPath('Programs')
  $startMenuDirectory = Join-Path $programs 'DeepSeek Harness'
  New-Item -ItemType Directory -Path $startMenuDirectory -Force | Out-Null
  $startMenuShortcut = Join-Path $startMenuDirectory 'DeepSeek Harness Web.lnk'
  New-DshShortcut -Path $startMenuShortcut
  $created.Add($startMenuShortcut)
  $remoteShortcut = Join-Path $startMenuDirectory 'Harness Remote Access.lnk'
  New-DshShortcut -Path $remoteShortcut -RemoteAccess
  $created.Add($remoteShortcut)
}

Write-Output "Installed launcher: $installedLauncher"
$created | ForEach-Object { Write-Output "Created shortcut: $_" }
