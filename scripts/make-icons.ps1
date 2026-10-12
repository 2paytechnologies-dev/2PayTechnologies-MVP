<#
  Generates every icon from public/icon.png (the logo, transparent background) on the company dark blue.
  Run from the repo root:   powershell -File scripts/make-icons.ps1
  Change the colour with -Brand "#0B2545". Keep it equal to BRAND_DARK in src/lib/brand.ts and
  ic_launcher_background in android/app/src/main/res/values/colors.xml.
#>
param([string]$Repo = (Get-Location).Path, [string]$Brand = "#0B2545")
Add-Type -AssemblyName System.Drawing
$logo = [System.Drawing.Bitmap]::FromFile("$Repo\public\icon.png")
$blue = [System.Drawing.ColorTranslator]::FromHtml($Brand)

function New-Canvas([int]$size) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'HighQuality'; $g.InterpolationMode = 'HighQualityBicubic'; $g.PixelOffsetMode = 'HighQuality'
  $g.Clear([System.Drawing.Color]::Transparent)
  return @{ bmp = $bmp; g = $g }
}

# Rounded rectangle with its top-left at ($x,$y), $w wide, corner radius $r.
function Rounded-Rect([double]$x, [double]$y, [double]$w, [double]$r) {
  $d = [Math]::Max(1, $r * 2)
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $p.AddArc($x, $y, $d, $d, 180, 90); $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $p.AddArc($x + $w - $d, $y + $w - $d, $d, $d, 0, 90); $p.AddArc($x, $y + $w - $d, $d, $d, 90, 90)
  $p.CloseFigure(); return $p
}

# shape: 'rounded' (rounded square, transparent corners), 'circle', 'square' (full bleed), or 'none' (logo only, transparent).
# 'rounded', 'circle' and 'ring-square' get a white edge all the way round; 'square' (maskable) does not, because
# the phone crops it. The white edge is $ring of the icon size, at least 1 pixel.
$ring = 0.045
function Save-Icon([string]$path, [int]$size, [double]$scale, [string]$shape) {
  $c = New-Canvas $size
  $brush = New-Object System.Drawing.SolidBrush $blue
  $white = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
  $w = [Math]::Max(1.0, $size * $ring); $full = $size - 1
  switch ($shape) {
    'rounded' {
      $r = $size * 0.225
      $c.g.FillPath($white, (Rounded-Rect 0 0 $full $r))
      $c.g.FillPath($brush, (Rounded-Rect $w $w ($full - 2 * $w) ([Math]::Max(1, $r - $w))))
    }
    'circle' {
      $c.g.FillEllipse($white, 0, 0, $full, $full)
      $c.g.FillEllipse($brush, $w, $w, $full - 2 * $w, $full - 2 * $w)
    }
    'ring-square' {
      $c.g.FillRectangle($white, 0, 0, $size, $size)
      $c.g.FillRectangle($brush, $w, $w, $size - 2 * $w, $size - 2 * $w)
    }
    'square'  { $c.g.FillRectangle($brush, 0, 0, $size, $size) }
    'adaptive-bg' {
      # Android adaptive background: the phone shows only the middle two thirds, cropped to its own shape (circle,
      # squircle...). White everywhere, with a navy tile inside, so whatever the shape there is a white edge around it.
      $c.g.FillRectangle($white, 0, 0, $size, $size)
      $n = $size * 0.54; $o2 = ($size - $n) / 2
      $c.g.FillPath($brush, (Rounded-Rect $o2 $o2 $n ($n * 0.225)))
    }
  }
  if ($shape -eq 'adaptive-bg') { $c.bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png); $c.g.Dispose(); $c.bmp.Dispose(); $brush.Dispose(); $white.Dispose(); return }
  $d = [int]($size * $scale); $o = [int](($size - $d) / 2)
  $c.g.DrawImage($logo, $o, $o, $d, $d)
  New-Item -ItemType Directory -Force (Split-Path $path) | Out-Null
  $c.bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $c.g.Dispose(); $c.bmp.Dispose(); $brush.Dispose(); $white.Dispose()
}

# --- Web: favicon / PWA / iOS home screen
Save-Icon "$Repo\public\icons\icon-192.png" 192 0.82 'rounded'
Save-Icon "$Repo\public\icons\icon-512.png" 512 0.82 'rounded'
Save-Icon "$Repo\public\icons\maskable-512.png" 512 0.62 'square'      # maskable: logo inside the 80% safe zone, full bleed
Save-Icon "$Repo\public\icons\apple-touch-icon.png" 180 0.74 'ring-square'   # iOS rounds the corners itself

# --- favicon.ico (PNG-compressed entries at 16, 32 and 48)
$sizes = 16, 32, 48; $pngs = @()
$ring = 0.045
foreach ($s in $sizes) { $tmp = Join-Path $env:TEMP "fav$s.png"; Save-Icon $tmp $s 0.84 'rounded'; $pngs += , [IO.File]::ReadAllBytes($tmp) }
$ring = 0.045
$ms = New-Object IO.MemoryStream; $bw = New-Object IO.BinaryWriter $ms
$bw.Write([uint16]0); $bw.Write([uint16]1); $bw.Write([uint16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
  $bw.Write([byte]$sizes[$i]); $bw.Write([byte]$sizes[$i]); $bw.Write([byte]0); $bw.Write([byte]0)
  $bw.Write([uint16]1); $bw.Write([uint16]32); $bw.Write([uint32]$pngs[$i].Length); $bw.Write([uint32]$offset)
  $offset += $pngs[$i].Length
}
foreach ($b in $pngs) { $bw.Write($b) }
[IO.File]::WriteAllBytes("$Repo\public\favicon.ico", $ms.ToArray())

# --- Android launcher icons
$res = "$Repo\android\app\src\main\res"
$legacy = @{ mdpi = 48; hdpi = 72; xhdpi = 96; xxhdpi = 144; xxxhdpi = 192 }
$fg     = @{ mdpi = 108; hdpi = 162; xhdpi = 216; xxhdpi = 324; xxxhdpi = 432 }
foreach ($d in $legacy.Keys) {
  Save-Icon "$res\mipmap-$d\ic_launcher.png"            $legacy[$d] 0.82 'rounded'
  Save-Icon "$res\mipmap-$d\ic_launcher_round.png"      $legacy[$d] 0.66 'circle'
  # Adaptive icon (Android 8+, what modern phones actually show): white background with a navy tile, logo sized to sit inside the tile.
  Save-Icon "$res\mipmap-$d\ic_launcher_background.png" $fg[$d]     1.0  'adaptive-bg'
  Save-Icon "$res\mipmap-$d\ic_launcher_foreground.png" $fg[$d]     0.443 'none'
}
$logo.Dispose()
Write-Output "Icons written on $Brand."
