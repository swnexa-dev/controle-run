param(
  [string]$SourcePath = (Join-Path $PSScriptRoot '..\build-resources\icons\app-icon.png'),
  [string]$OutputPath = (Join-Path $PSScriptRoot '..\build-resources\icons\app-icon.ico')
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$sourceFile = (Resolve-Path -LiteralPath $SourcePath).Path
$outputFile = [System.IO.Path]::GetFullPath($OutputPath)
$outputDirectory = Split-Path -Parent $outputFile
[System.IO.Directory]::CreateDirectory($outputDirectory) | Out-Null

$source = [System.Drawing.Image]::FromFile($sourceFile)
try {
  if ($source.Width -ne $source.Height) {
    throw 'O app-icon.png precisa ser quadrado.'
  }

  $sizes = @(16, 20, 24, 32, 40, 48, 64, 128, 256)
  $images = [System.Collections.Generic.List[byte[]]]::new()

  foreach ($size in $sizes) {
    $bitmap = [System.Drawing.Bitmap]::new(
      $size,
      $size,
      [System.Drawing.Imaging.PixelFormat]::Format32bppArgb
    )
    try {
      $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
      try {
        $graphics.Clear([System.Drawing.Color]::Transparent)
        $graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
        $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
        $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
        $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $graphics.DrawImage($source, 0, 0, $size, $size)
      }
      finally {
        $graphics.Dispose()
      }

      $memory = [System.IO.MemoryStream]::new()
      try {
        $bitmap.Save($memory, [System.Drawing.Imaging.ImageFormat]::Png)
        $images.Add($memory.ToArray())
      }
      finally {
        $memory.Dispose()
      }
    }
    finally {
      $bitmap.Dispose()
    }
  }

  $file = [System.IO.File]::Open(
    $outputFile,
    [System.IO.FileMode]::Create,
    [System.IO.FileAccess]::Write,
    [System.IO.FileShare]::None
  )
  try {
    $writer = [System.IO.BinaryWriter]::new($file)
    try {
      $writer.Write([uint16]0)
      $writer.Write([uint16]1)
      $writer.Write([uint16]$sizes.Count)

      $offset = 6 + (16 * $sizes.Count)
      for ($index = 0; $index -lt $sizes.Count; $index++) {
        $size = $sizes[$index]
        $dimension = if ($size -eq 256) { [byte]0 } else { [byte]$size }
        $writer.Write($dimension)
        $writer.Write($dimension)
        $writer.Write([byte]0)
        $writer.Write([byte]0)
        $writer.Write([uint16]1)
        $writer.Write([uint16]32)
        $writer.Write([uint32]$images[$index].Length)
        $writer.Write([uint32]$offset)
        $offset += $images[$index].Length
      }

      foreach ($image in $images) {
        $writer.Write([byte[]]$image)
      }
    }
    finally {
      $writer.Dispose()
    }
  }
  finally {
    $file.Dispose()
  }
}
finally {
  $source.Dispose()
}

Write-Host "Icone Windows gerado em: $outputFile"
