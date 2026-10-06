<#
  E2EE-Discord — one-click installer for Vencord (Windows)
  Made by XO.ST · https://github.com/xo907/e2ee-discord

  Vencord only loads custom plugins that are compiled into it, so this script:
    1. installs git / Node.js / pnpm if they're missing (asks first),
    2. downloads Vencord's source to %LOCALAPPDATA%\E2EE-Discord\Vencord,
    3. adds the E2EE-Discord plugin, builds Vencord and injects it into Discord,
    4. enables the plugin and restarts Discord.
  Run it again any time to update Vencord and E2EE-Discord.

  Usage (or just double-click Install-E2EE-Discord.cmd):
    powershell -ExecutionPolicy Bypass -File install-vencord.ps1 [-Branch auto|stable|ptb|canary] [-Uninstall] [-Yes]
#>
param(
  [ValidateSet('auto', 'stable', 'ptb', 'canary')]
  [string]$Branch = 'auto',
  [switch]$Uninstall,
  [switch]$Yes
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$RepoRaw = 'https://raw.githubusercontent.com/xo907/e2ee-discord/main'
$VencordRepo = 'https://github.com/Vendicated/Vencord.git'
$InstallRoot = Join-Path $env:LOCALAPPDATA 'E2EE-Discord'
$VencordDir = Join-Path $InstallRoot 'Vencord'
$PluginFolder = 'e2eeDiscord'
$PluginName = 'E2EEDiscord'
$PluginFiles = @('index.ts', 'native.ts', 'core.js')
$MinNodeMajor = 22

function Write-Banner {
  Write-Host ''
  Write-Host '  X ' -ForegroundColor White -NoNewline
  Write-Host 'O' -ForegroundColor Red -NoNewline
  Write-Host '   E2EE-Discord installer for Vencord' -ForegroundColor White
  Write-Host '       Made by XO.ST' -ForegroundColor DarkGray
  Write-Host ''
}
function Write-Step([string]$message) { Write-Host "==> $message" -ForegroundColor Red }
function Write-Info([string]$message) { Write-Host "    $message" -ForegroundColor Gray }
function Write-Done([string]$message) { Write-Host "    $message" -ForegroundColor Green }

function Confirm-Step([string]$question) {
  if ($Yes) { return $true }
  $answer = Read-Host "    $question [Y/n]"
  return ($answer -eq '' -or $answer -match '^[Yy]')
}
function Test-Command([string]$name) { return [bool](Get-Command $name -ErrorAction SilentlyContinue) }
function Update-SessionPath {
  $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = "$machine;$user"
}
function Invoke-Native([string]$what, [scriptblock]$command) {
  & $command
  if ($LASTEXITCODE -ne 0) { throw "$what failed (exit code $LASTEXITCODE)" }
}

function Install-WithWinget([string]$id, [string]$label, [string]$manualUrl) {
  if (-not (Test-Command 'winget')) {
    Write-Info "$label is required. Install it from $manualUrl and run this installer again."
    Start-Process $manualUrl
    throw "$label is missing"
  }
  if (-not (Confirm-Step "$label is required but not installed. Install it now with winget?")) {
    throw "$label is required"
  }
  Invoke-Native "Installing $label" { winget install --id $id -e --source winget --accept-package-agreements --accept-source-agreements }
  Update-SessionPath
}

function Get-NodeMajor {
  if (-not (Test-Command 'node')) { return 0 }
  $version = (& node --version) -replace '^v', ''
  return [int]($version.Split('.')[0])
}

function Install-Prerequisites {
  Write-Step 'Checking requirements'

  if (-not (Test-Command 'git')) { Install-WithWinget 'Git.Git' 'Git' 'https://git-scm.com/download/win' }
  Write-Done "git $((& git --version) -replace '^git version ', '')"

  if ((Get-NodeMajor) -lt $MinNodeMajor) {
    Install-WithWinget 'OpenJS.NodeJS.LTS' "Node.js $MinNodeMajor or newer" 'https://nodejs.org/'
    if ((Get-NodeMajor) -lt $MinNodeMajor) {
      throw "Node.js $MinNodeMajor or newer is required. Close this window, open a new one and run the installer again."
    }
  }
  Write-Done "node $(& node --version)"

  if (-not (Test-Command 'pnpm')) {
    if (-not (Confirm-Step 'pnpm (the package manager Vencord uses) is not installed. Install it with npm?')) { throw 'pnpm is required' }
    Invoke-Native 'Installing pnpm' { npm install --global pnpm }
    Update-SessionPath
    if (-not (Test-Command 'pnpm')) { throw 'pnpm was installed but is not on PATH yet. Open a new window and run the installer again.' }
  }
  Write-Done "pnpm $(& pnpm --version)"
}

function Get-DiscordProcesses {
  return @(Get-Process -Name 'Discord', 'DiscordPTB', 'DiscordCanary', 'DiscordDevelopment' -ErrorAction SilentlyContinue)
}

function Stop-Discord {
  $processes = Get-DiscordProcesses
  if ($processes.Count -eq 0) { return @() }
  $names = @($processes | Select-Object -ExpandProperty Name -Unique)
  if (-not (Confirm-Step "Discord ($($names -join ', ')) needs to be closed. Close it now?")) {
    throw 'Please close Discord and run the installer again.'
  }
  $restart = @()
  foreach ($name in $names) {
    $exe = ($processes | Where-Object { $_.Name -eq $name -and $_.Path } | Select-Object -First 1).Path
    if ($exe) { $restart += $exe }
  }
  $processes | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
  return $restart
}

function Start-Discord([string[]]$executables) {
  foreach ($exe in $executables) {
    # Discord.exe lives in ...\Discord\app-x.y.z\, Update.exe in ...\Discord\
    $installDir = Split-Path (Split-Path $exe -Parent) -Parent
    $updater = Join-Path $installDir 'Update.exe'
    if (Test-Path $updater) {
      Start-Process $updater -ArgumentList '--processStart', (Split-Path $exe -Leaf)
    } else {
      Start-Process $exe
    }
  }
}

function Sync-Vencord {
  Write-Step 'Getting the latest Vencord'
  New-Item -ItemType Directory -Force $InstallRoot | Out-Null
  if (Test-Path (Join-Path $VencordDir '.git')) {
    Invoke-Native 'Updating Vencord' { git -C $VencordDir fetch --depth 1 origin main }
    Invoke-Native 'Updating Vencord' { git -C $VencordDir reset --hard origin/main }
  } else {
    if (Test-Path $VencordDir) { Remove-Item $VencordDir -Recurse -Force }
    Invoke-Native 'Downloading Vencord' { git clone --depth 1 $VencordRepo $VencordDir }
  }
  Write-Done "Vencord $(git -C $VencordDir rev-parse --short HEAD)"
}

function Copy-Plugin {
  Write-Step 'Adding the E2EE-Discord plugin'
  $target = Join-Path $VencordDir "src\userplugins\$PluginFolder"
  New-Item -ItemType Directory -Force $target | Out-Null

  $local = Join-Path $PSScriptRoot "vencord\$PluginFolder"
  if (@($PluginFiles | Where-Object { -not (Test-Path (Join-Path $local $_)) }).Count -eq 0) {
    foreach ($file in $PluginFiles) { Copy-Item (Join-Path $local $file) (Join-Path $target $file) -Force }
    Write-Done "copied from $local"
  } else {
    foreach ($file in $PluginFiles) {
      Invoke-WebRequest -UseBasicParsing "$RepoRaw/vencord/$PluginFolder/$file" -OutFile (Join-Path $target $file)
    }
    Write-Done 'downloaded from github.com/xo907/e2ee-discord'
  }
}

function Build-Vencord {
  Write-Step 'Building Vencord (this takes a minute)'
  Push-Location $VencordDir
  try {
    $env:CI = 'true' # keep pnpm non-interactive
    Invoke-Native 'Installing Vencord dependencies' { pnpm install --frozen-lockfile }
    Invoke-Native 'Building Vencord' { pnpm build }
  } finally {
    Remove-Item Env:\CI -ErrorAction SilentlyContinue
    Pop-Location
  }
  Write-Done 'built'
}

function Invoke-VencordInstaller([string]$action) {
  Push-Location $VencordDir
  try {
    # '--' is quoted so PowerShell passes it through; runInstaller forwards everything after it
    Invoke-Native "Vencord installer ($action)" { node scripts/runInstaller.mjs '--' "--$action" '--branch' $Branch }
  } finally {
    Pop-Location
  }
}

function Enable-Plugin {
  Write-Step 'Enabling E2EE-Discord'
  $settingsDir = Join-Path $VencordDir 'settings'
  $settingsFile = Join-Path $settingsDir 'settings.json'
  New-Item -ItemType Directory -Force $settingsDir | Out-Null

  if (Test-Path $settingsFile) {
    $settings = Get-Content $settingsFile -Raw -Encoding UTF8 | ConvertFrom-Json
  } else {
    $settings = [pscustomobject]@{}
  }
  if (-not $settings.PSObject.Properties['plugins']) {
    $settings | Add-Member -NotePropertyName plugins -NotePropertyValue ([pscustomobject]@{})
  }
  if ($settings.plugins.PSObject.Properties[$PluginName]) {
    $plugin = $settings.plugins.$PluginName
    if ($plugin.PSObject.Properties['enabled']) { $plugin.enabled = $true }
    else { $plugin | Add-Member -NotePropertyName enabled -NotePropertyValue $true }
  } else {
    $settings.plugins | Add-Member -NotePropertyName $PluginName -NotePropertyValue ([pscustomobject]@{ enabled = $true })
  }
  $json = $settings | ConvertTo-Json -Depth 64
  [System.IO.File]::WriteAllText($settingsFile, $json, (New-Object System.Text.UTF8Encoding $false))
  Write-Done 'enabled in Vencord settings'
}

# ───────────────────────────────────────────────────────────────────────────

try {
  Write-Banner

  if ($Uninstall) {
    if (-not (Test-Path (Join-Path $VencordDir 'scripts\runInstaller.mjs'))) { throw "Nothing to uninstall: $VencordDir not found." }
    $restart = Stop-Discord
    Write-Step 'Removing Vencord from Discord'
    Invoke-VencordInstaller 'uninstall'
    if (Confirm-Step "Also delete $InstallRoot?") { Remove-Item $InstallRoot -Recurse -Force }
    Start-Discord $restart
    Write-Host ''
    Write-Done 'E2EE-Discord and Vencord were removed. Export your key database first next time!'
    exit 0
  }

  Install-Prerequisites
  Sync-Vencord
  Copy-Plugin
  Build-Vencord
  $restart = Stop-Discord
  Write-Step "Injecting Vencord into Discord (branch: $Branch)"
  Invoke-VencordInstaller 'install'
  Enable-Plugin

  if ($restart.Count -gt 0) { Start-Discord $restart; $started = 'Discord is restarting.' }
  else { $started = 'Start Discord.' }

  Write-Host ''
  Write-Host '  All set! ' -ForegroundColor Green -NoNewline
  Write-Host $started
  Write-Info 'Open any chat and click the lock in the message bar. Right-click it for the menu.'
  Write-Info "Keep the folder $InstallRoot — Discord loads Vencord from it."
  Write-Info 'Run this installer again to update. Use -Uninstall to remove.'
} catch {
  Write-Host ''
  Write-Host "  Installation failed: $($_.Exception.Message)" -ForegroundColor Red
  Write-Info 'Help: https://github.com/xo907/e2ee-discord/issues'
  exit 1
} finally {
  if (-not $Yes -and $Host.Name -eq 'ConsoleHost' -and [Environment]::UserInteractive) {
    Write-Host ''
    Read-Host '  Press Enter to close' | Out-Null
  }
}
