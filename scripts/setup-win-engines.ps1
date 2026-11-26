$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Split-Path -Parent $ScriptDir
$BinRoot = Join-Path $RepoRoot 'electron\bin'

$FfmpegDir = Join-Path $BinRoot 'ffmpeg'
$TskDir = Join-Path $BinRoot 'sleuthkit'

New-Item -ItemType Directory -Force -Path $FfmpegDir, $TskDir | Out-Null
$TempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("td_engines_" + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force -Path $TempRoot | Out-Null

function Install-ZipArchive {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$Url,
    [Parameter(Mandatory = $true)][string]$ExpectedSha256,
    [Parameter(Mandatory = $true)][string]$DestDir
  )
  Write-Host "Downloading $Name from $Url ..."
  $ZipPath = Join-Path $TempRoot "$Name.zip"
  $ExtractPath = Join-Path $TempRoot $Name
  Invoke-WebRequest -Uri $Url -OutFile $ZipPath -UseBasicParsing
  $ActualSha256 = (Get-FileHash -Path $ZipPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($ActualSha256 -ne $ExpectedSha256.ToLowerInvariant()) {
    throw "$Name SHA-256 verification failed! Expected $ExpectedSha256, got $ActualSha256"
  }
  Write-Host "$Name SHA-256 verified ($ActualSha256)"
  Expand-Archive -Path $ZipPath -DestinationPath $ExtractPath -Force

  $BinSubDir = Get-ChildItem -Path $ExtractPath -Directory -Recurse | Where-Object { $_.Name -ieq 'bin' } | Select-Object -First 1
  $SourceDir = if ($BinSubDir) { $BinSubDir.FullName } else {
    $FirstExe = Get-ChildItem -Path $ExtractPath -Filter '*.exe' -Recurse | Select-Object -First 1
    if ($FirstExe) { $FirstExe.Directory.FullName } else { $ExtractPath }
  }

  Get-ChildItem -Path $SourceDir -File | Where-Object { $_.Extension -in '.exe', '.dll' } | ForEach-Object {
    Copy-Item -Path $_.FullName -Destination (Join-Path $DestDir $_.Name) -Force
  }
  Write-Host "Staged $Name into $DestDir"
}

try {
  Install-ZipArchive `
    -Name 'ffmpeg' `
    -Url 'https://github.com/GyanD/codexffmpeg/releases/download/9.1/ffmpeg-9.1-essentials_build.zip' `
    -ExpectedSha256 'b9bbbb3acece000cbeec994f856649354e52c773807841e78908374b24d658fd' `
    -DestDir $FfmpegDir

  Install-ZipArchive `
    -Name 'sleuthkit' `
    -Url 'https://github.com/sleuthkit/sleuthkit/releases/download/sleuthkit-4.15.0/sleuthkit-4.15.0-win32.zip' `
    -ExpectedSha256 'c2ebab8105b893d97bd8ce35b88e01985e2a106efc97f03adf95840a631b20ce' `
    -DestDir $TskDir

  Write-Host ''
  Write-Host 'Done! Ready to build desktop package with: npm run dist:win'
} finally {
  if (Test-Path $TempRoot) {
    Remove-Item -Path $TempRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}
