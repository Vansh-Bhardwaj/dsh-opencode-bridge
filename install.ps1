[CmdletBinding()]
param(
  [string]$DshHome = (Join-Path $env:USERPROFILE '.dsh'),
  [switch]$KeepDeepSeekApi
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = $PSScriptRoot
$sourcePlugin = Join-Path $repoRoot 'plugin'
$targetPlugin = Join-Path $DshHome '.agent-presets\ocui\plugin'
$syncSource = Join-Path $repoRoot 'scripts\sync-dsh-models.py'
$syncTarget = Join-Path $DshHome 'sync-dsh-models.py'

if (-not (Test-Path -LiteralPath (Join-Path $sourcePlugin 'lib\index.js'))) {
  throw 'Plugin source is incomplete.'
}

if (Test-Path -LiteralPath $targetPlugin) {
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $backup = Join-Path $DshHome "backups\ocui-$stamp"
  New-Item -ItemType Directory -Path $backup -Force | Out-Null
  Copy-Item -LiteralPath $targetPlugin -Destination $backup -Recurse
  Write-Host "Backed up the existing plugin to $backup"
}

New-Item -ItemType Directory -Path (Join-Path $targetPlugin 'lib') -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $sourcePlugin 'lib\index.js') -Destination (Join-Path $targetPlugin 'lib\index.js') -Force
Copy-Item -LiteralPath (Join-Path $sourcePlugin 'lib\client.js') -Destination (Join-Path $targetPlugin 'lib\client.js') -Force
Copy-Item -LiteralPath (Join-Path $sourcePlugin 'package.json') -Destination (Join-Path $targetPlugin 'package.json') -Force
Copy-Item -LiteralPath $syncSource -Destination $syncTarget -Force

function Read-Patch([string]$profile) {
  $directory = Join-Path $DshHome "profiles\$profile"
  $path = Join-Path $directory 'cordis.patch.yml'
  New-Item -ItemType Directory -Path $directory -Force | Out-Null
  if (-not (Test-Path -LiteralPath $path)) {
    [IO.File]::WriteAllText($path, "# Local DSH profile overrides.`n", [Text.UTF8Encoding]::new($false))
  }
  return $path
}

function Add-BlockIfMissing([string]$path, [string]$needle, [string]$block) {
  $content = [IO.File]::ReadAllText($path)
  if ($content.Contains($needle)) { return }
  if ($content.Length -gt 0 -and -not $content.EndsWith("`n")) { $content += "`n" }
  $content += "`n$block`n"
  [IO.File]::WriteAllText($path, $content, [Text.UTF8Encoding]::new($false))
}

$webPatch = Read-Patch 'web'
Add-BlockIfMissing $webPatch "name: '@local/dsh-plugin-ocui'" @"
- insert:
    - id: ocui
      name: '@local/dsh-plugin-ocui'
"@

if (-not $KeepDeepSeekApi) {
  foreach ($profile in @('web', 'headless')) {
    $patch = Read-Patch $profile
    foreach ($id in @('llm-deepseek', 'web-search-deepseek', 'tool-web')) {
      Add-BlockIfMissing $patch "- id: $id" @"
- id: $id
  disabled: true
"@
    }
  }
}

Write-Host ''
Write-Host 'Installed DSH OpenCode Bridge.'
Write-Host 'Restart with: dsh web'
Write-Host 'The plugin discovers models on startup and refreshes every 15 minutes.'

