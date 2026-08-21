[CmdletBinding()]
param(
  [ValidateRange(1, 65535)]
  [int]$Port = 3080,

  [string]$InstallRoot = (Join-Path ([Environment]::GetFolderPath('UserProfile')) '.dsh\launcher'),

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

$pwsh = (Get-Command pwsh.exe -ErrorAction Stop).Source
$arguments = "-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$installedLauncher`" -Port $Port"
$shell = New-Object -ComObject WScript.Shell

function New-DshShortcut {
  param([string]$Path)

  $shortcut = $shell.CreateShortcut($Path)
  $shortcut.TargetPath = $pwsh
  $shortcut.Arguments = $arguments
  $shortcut.WorkingDirectory = [Environment]::GetFolderPath('UserProfile')
  $shortcut.WindowStyle = 7
  $shortcut.IconLocation = "$env:SystemRoot\System32\shell32.dll,220"
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
}

Write-Output "Installed launcher: $installedLauncher"
$created | ForEach-Object { Write-Output "Created shortcut: $_" }
