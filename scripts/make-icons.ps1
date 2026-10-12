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

function Rounded-Path([int]$size, [double]$radiusFrac) {
  $r = [int]($size * $radiusFrac); $d = $r * 2
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $p.AddArc(0, 0, $d, $d, 180, 90); $p.AddArc($size - $d - 1, 0, $d, $d, 270, 90)
  $p.AddArc($size - $d - 1, $size - $d - 1, $d, $d, 0, 90); $p.AddArc(0, $size - $d - 1, $d, $d, 90, 90)
  $p.CloseFigure(); return $p
}

# shape: 'rounded' (rounded square, transparent corners), 'square' (full bleed), 'circle', or 'none' (logo only, transparent)
function Save-Icon([string]$path, [int]$size, [double]$scale, [string]$shape) {
  $c = New-Canvas $size
  $brush = New-Object System.Drawing.SolidBrush $blue
  switch ($shape) {
    'rounded' { $c.g.FillPath($brush, (Rounded-Path $size 0.225)) }
    'square'  { $c.g.FillRectangle($brush, 0, 0, $size, $size) }
    'circle'  { $c.g.FillEllipse($brush, 0, 0, $size - 1, $size - 1) }
  }
  $d = [int]($size * $scale); $o = [int](($size - $d) / 2)
  $c.g.DrawImage($logo, $o, $o, $d, $d)
  New-Item -ItemType Directory -Force (Split-Path $path) | Out-Null
  $c.bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $c.g.Dispose(); $c.bmp.Dispose(); $brush.Dispose()
}

# --- Web: favicon / PWA / iOS home screen
Save-Icon "$Repo\public\icons\icon-192.png" 192 0.82 'rounded'
Save-Icon "$Repo\public\icons\icon-512.png" 512 0.82 'rounded'
Save-Icon "$Repo\public\icons\maskable-512.png" 512 0.62 'square'      # maskable: logo inside the 80% safe zone, full bleed
Save-Icon "$Repo\public\icons\apple-touch-icon.png" 180 0.74 'square'   # iOS rounds the corners itself

# --- favicon.ico (PNG-compressed entries at 16, 32 and 48)
$sizes = 16, 32, 48; $pngs = @()
foreach ($s in $sizes) { $tmp = Join-Path $env:TEMP "fav$s.png"; Save-Icon $tmp $s 0.84 'rounded'; $pngs += , [IO.File]::ReadAllBytes($tmp) }
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
  Save-Icon "$res\mipmap-$d\ic_launcher_foreground.png" $fg[$d]     0.62 'none'   # adaptive foreground; the blue comes from ic_launcher_background
}
$logo.Dispose()
Write-Output "Icons written on $Brand."
