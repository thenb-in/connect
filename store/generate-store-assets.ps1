# Generates Play Store graphic assets from the existing brand icon using .NET
# System.Drawing (no external tooling needed). Outputs:
#   store/play-icon-512.png          - 512x512 hi-res app icon
#   store/feature-graphic-1024x500.png - 1024x500 feature graphic
Add-Type -AssemblyName System.Drawing

$root   = Split-Path -Parent $MyInvocation.MyCommand.Path
$proj   = Split-Path -Parent $root
$srcIcon = Join-Path $proj 'ios/connect/Images.xcassets/AppIcon.appiconset/icon-1024.png'

# Brand palette (from src/theme.js)
$teal     = [System.Drawing.Color]::FromArgb(47, 111, 143)   # #2F6F8F
$tealDark = [System.Drawing.Color]::FromArgb(31, 79, 107)    # #1F4F6B
$cream    = [System.Drawing.Color]::FromArgb(246, 243, 238)  # #F6F3EE
$creamDim = [System.Drawing.Color]::FromArgb(220, 246, 243, 238)

# ---- 1. 512x512 app icon (downscale from the 1024 master) ----
$src = [System.Drawing.Image]::FromFile($srcIcon)
$icon512 = New-Object System.Drawing.Bitmap 512, 512
$g = [System.Drawing.Graphics]::FromImage($icon512)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.SmoothingMode     = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
$g.PixelOffsetMode   = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$g.DrawImage($src, 0, 0, 512, 512)
$g.Dispose()
$iconOut = Join-Path $root 'play-icon-512.png'
$icon512.Save($iconOut, [System.Drawing.Imaging.ImageFormat]::Png)
Write-Output "wrote $iconOut"

# ---- 2. 1024x500 feature graphic ----
$W = 1024; $H = 500
$fg = New-Object System.Drawing.Bitmap $W, $H
$g = [System.Drawing.Graphics]::FromImage($fg)
$g.SmoothingMode     = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit

# Diagonal teal gradient background
$rect = New-Object System.Drawing.Rectangle 0, 0, $W, $H
$grad = New-Object System.Drawing.Drawing2D.LinearGradientBrush $rect, $tealDark, $teal, 35.0
$g.FillRectangle($grad, $rect)

# Soft decorative circles (echo the brand's roundness)
$blob = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(18, 255, 255, 255))
$g.FillEllipse($blob, 760, -120, 360, 360)
$g.FillEllipse($blob, 820, 300, 280, 280)

# App icon, left, rounded corners
$iconSize = 300
$ix = 70; $iy = [int](($H - $iconSize) / 2)
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$r = 64
$path.AddArc($ix, $iy, $r, $r, 180, 90)
$path.AddArc($ix + $iconSize - $r, $iy, $r, $r, 270, 90)
$path.AddArc($ix + $iconSize - $r, $iy + $iconSize - $r, $r, $r, 0, 90)
$path.AddArc($ix, $iy + $iconSize - $r, $r, $r, 90, 90)
$path.CloseFigure()
$g.SetClip($path)
$g.DrawImage($src, $ix, $iy, $iconSize, $iconSize)
$g.ResetClip()

# Text block
$tx = 430
$titleFont = New-Object System.Drawing.Font 'Segoe UI', 64, ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)
$tagFont   = New-Object System.Drawing.Font 'Segoe UI Semibold', 27, ([System.Drawing.FontStyle]::Regular), ([System.Drawing.GraphicsUnit]::Pixel)
$creamBrush = New-Object System.Drawing.SolidBrush $cream
$dimBrush   = New-Object System.Drawing.SolidBrush $creamDim
$accentBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(224, 120, 86)) # #E07856

$g.DrawString('Connect', $titleFont, $creamBrush, $tx, 150)

# Accent underline pill under the title
$g.FillRectangle($accentBrush, $tx + 4, 238, 96, 7)

# Tagline (two lines)
$g.DrawString('Stay in touch with the', $tagFont, $dimBrush, $tx, 270)
$g.DrawString('people who matter.', $tagFont, $dimBrush, $tx, 308)

$g.Dispose()
$fgOut = Join-Path $root 'feature-graphic-1024x500.png'
$fg.Save($fgOut, [System.Drawing.Imaging.ImageFormat]::Png)
Write-Output "wrote $fgOut"

$src.Dispose()
