# Regenerate icons/ from a square source image (Windows: uses System.Drawing).
# The Windows counterpart of make_icons.sh; same inputs, same four outputs.
# Usage: tools\make_icons.ps1 path\to\source.png
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string]$Source
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$src = (Resolve-Path -LiteralPath $Source).Path
$dir = Join-Path (Split-Path -Parent $PSScriptRoot) 'icons'
if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }

# Image.FromFile keeps a lock on the file for the bitmap's whole lifetime,
# which would block rewriting the source in the same session. Decode from a
# copy of the bytes instead; the stream must outlive the Bitmap.
$bytes = [System.IO.File]::ReadAllBytes($src)
$stream = New-Object System.IO.MemoryStream (, $bytes)
$image = [System.Drawing.Image]::FromStream($stream)

try {
  # Chrome renders action icons in a square slot and warns that a non-square
  # image may be distorted. Padding to square is the master art's job (it
  # needs transparent pixels, added evenly), so this only reports the problem.
  if ($image.Width -ne $image.Height) {
    Write-Warning "source is $($image.Width)x$($image.Height), not square - Chrome may distort the icon"
  }

  foreach ($s in 16, 32, 48, 128) {
    $canvas = New-Object System.Drawing.Bitmap $s, $s, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($canvas)
    # SourceCopy writes the scaled pixels straight through rather than
    # blending them over the zeroed canvas, which is what keeps the card's
    # antialiased edge from picking up a dark fringe against transparency.
    $g.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
    $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality

    # Bicubic samples past the source rect at the borders and, left to itself,
    # pulls in the clamped-transparent edge as a halo. TileFlipXY mirrors the
    # image into that margin instead, so the outermost ring stays clean.
    $attrs = New-Object System.Drawing.Imaging.ImageAttributes
    $attrs.SetWrapMode([System.Drawing.Drawing2D.WrapMode]::TileFlipXY)
    $rect = New-Object System.Drawing.Rectangle 0, 0, $s, $s
    try {
      $g.DrawImage($image, $rect, 0, 0, $image.Width, $image.Height,
        [System.Drawing.GraphicsUnit]::Pixel, $attrs)
    } finally {
      $attrs.Dispose()
    }

    $canvas.Save((Join-Path $dir "icon$s.png"), [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose()
    $canvas.Dispose()
  }
} finally {
  $image.Dispose()
  $stream.Dispose()
}

Write-Host "icons written to $dir"
