# Renders the E2EE-Discord logo (white X, red O on black — matches assets/logo.svg) to PNGs.
# Usage: powershell -ExecutionPolicy Bypass -File scripts\make-icons.ps1
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$assets = Join-Path $root 'assets'
$extensionIcons = Join-Path $root 'extension\icons'
New-Item -ItemType Directory -Force $assets, $extensionIcons | Out-Null

function New-Logo([int]$size, [string]$path) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.Clear([System.Drawing.Color]::Transparent)
  $s = $size / 128.0

  # rounded black square
  $r = 28 * $s
  $bg = New-Object System.Drawing.Drawing2D.GraphicsPath
  $bg.AddArc(0, 0, 2 * $r, 2 * $r, 180, 90)
  $bg.AddArc($size - 2 * $r, 0, 2 * $r, 2 * $r, 270, 90)
  $bg.AddArc($size - 2 * $r, $size - 2 * $r, 2 * $r, 2 * $r, 0, 90)
  $bg.AddArc(0, $size - 2 * $r, 2 * $r, 2 * $r, 90, 90)
  $bg.CloseFigure()
  $g.FillPath([System.Drawing.Brushes]::Black, $bg)

  # white X
  $white = New-Object System.Drawing.Pen ([System.Drawing.Color]::White), ([Math]::Max(1.5, 13 * $s))
  $white.StartCap = [System.Drawing.Drawing2D.LineCap]::Square
  $white.EndCap = [System.Drawing.Drawing2D.LineCap]::Square
  $g.DrawLine($white, 22 * $s, 41 * $s, 54 * $s, 87 * $s)
  $g.DrawLine($white, 54 * $s, 41 * $s, 22 * $s, 87 * $s)

  # red O
  $red = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(255, 255, 0, 0)), ([Math]::Max(1.5, 12 * $s))
  $g.DrawEllipse($red, (88 - 20) * $s, (64 - 20) * $s, 40 * $s, 40 * $s)

  $g.Dispose()
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
}

foreach ($size in 16, 32, 48, 128, 256, 512) {
  New-Logo $size (Join-Path $assets "logo-$size.png")
}
foreach ($size in 16, 32, 48, 128) {
  Copy-Item (Join-Path $assets "logo-$size.png") (Join-Path $extensionIcons "logo-$size.png") -Force
}
Write-Output "icons written to $assets and $extensionIcons"
