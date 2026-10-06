# E2EE-Discord build — Made by XO.ST
# Assembles every distribution from the single source file src/core.js.
# Usage: powershell -ExecutionPolicy Bypass -File build.ps1
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$utf8 = New-Object System.Text.UTF8Encoding $false

function Read-Text([string]$path) { [System.IO.File]::ReadAllText((Join-Path $root $path), $utf8).Replace("`r`n", "`n") }
function Write-Text([string]$path, [string]$text) {
  $full = Join-Path $root $path
  New-Item -ItemType Directory -Force (Split-Path -Parent $full) | Out-Null
  [System.IO.File]::WriteAllText($full, $text, $utf8)
  Write-Output ("  {0,-48} {1,8:N0} bytes" -f $path, $text.Length)
}

$core = Read-Text 'src\core.js'
$version = [regex]::Match($core, "const AppVersion = '([^']+)'").Groups[1].Value
if (-not $version) { throw 'AppVersion not found in src/core.js' }
Write-Output "E2EE-Discord v$version"

$fill = { param($text) $text.Replace('{{VERSION}}', $version) }

# Userscript (Tampermonkey / Violentmonkey)
$userscriptHeader = & $fill (Read-Text 'src\hosts\userscript.header.js')
Write-Text 'dist\E2EE-Discord.user.js' ($userscriptHeader + "`n(function () {`n" + $core + (Read-Text 'src\hosts\userscript.boot.js') + "})();`n")
Write-Text 'dist\E2EE-Discord.meta.js' $userscriptHeader

# Browser extension (Manifest V3: Chrome, Edge, Brave, Opera, Firefox 128+)
Write-Text 'extension\manifest.json' (& $fill (Read-Text 'src\hosts\extension.manifest.json'))
Write-Text 'extension\rules.json' (Read-Text 'src\hosts\extension.rules.json')
Write-Text 'extension\e2ee-discord.js' ("(function () {`n" + $core + (Read-Text 'src\hosts\extension.boot.js') + "})();`n")

# Vencord userplugin (core as an ES module next to index.ts)
Write-Text 'vencord\e2eeDiscord\core.js' ($core + "`nexport default E2EEDiscord;`n")

# BetterDiscord
Write-Text 'betterdiscord\E2EEDiscord.plugin.js' ((& $fill (Read-Text 'src\hosts\betterdiscord.header.js')) + "`n'use strict';`n`n" + $core + (Read-Text 'src\hosts\betterdiscord.boot.js'))

# Zipped extension for sideloading / store upload
$zip = Join-Path $root "dist\E2EE-Discord-extension-$version.zip"
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path (Join-Path $root 'extension\*') -DestinationPath $zip
Write-Output ("  {0,-48} {1,8:N0} bytes" -f "dist\E2EE-Discord-extension-$version.zip", (Get-Item $zip).Length)

Write-Output 'done'
