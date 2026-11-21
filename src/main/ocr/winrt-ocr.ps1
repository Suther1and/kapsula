param(
  [Parameter(Mandatory = $true)]
  [string]$ImagePath
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName System.Runtime.WindowsRuntime

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]

function AwaitWinRt($WinRtTask, $ResultType) {
  $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
  $netTask = $asTask.Invoke($null, @($WinRtTask))
  $netTask.Wait(-1) | Out-Null
  return $netTask.Result
}

$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Storage.FileAccessMode, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrResult, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]

$absPath = (Resolve-Path -LiteralPath $ImagePath).Path
$file = AwaitWinRt ([Windows.Storage.StorageFile]::GetFileFromPathAsync($absPath)) ([Windows.Storage.StorageFile])
$stream = AwaitWinRt ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = AwaitWinRt ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$sbmp = AwaitWinRt ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])

$bestText = ""
$bestLines = @()

$engines = @()
$userEngine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if ($null -ne $userEngine) { $engines += $userEngine }

try {
  $ruLang = New-Object Windows.Globalization.Language("ru")
  if ([Windows.Media.Ocr.OcrEngine]::IsLanguageSupported($ruLang)) {
    $ruEngine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($ruLang)
    if ($null -ne $ruEngine) { $engines += $ruEngine }
  }
} catch {}

foreach ($eng in $engines) {
  try {
    $res = AwaitWinRt ($eng.RecognizeAsync($sbmp)) ([Windows.Media.Ocr.OcrResult])
    if ($null -ne $res -and $res.Text) {
      $txt = $res.Text.Trim()
      if ($txt.Length -gt $bestText.Length) {
        $bestText = $txt
        $bestLines = @($res.Lines | ForEach-Object { $_.Text })
      }
    }
  } catch {}
  if ($bestText -match '[\p{IsCyrillic}]' -and $bestText.Length -ge 8) {
    break
  }
}

$stream.Dispose()

$payload = @{
  text = $bestText
  lines = $bestLines
} | ConvertTo-Json -Compress -Depth 3

[Console]::Out.Write($payload)
