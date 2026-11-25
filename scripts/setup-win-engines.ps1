$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Split-Path -Parent $ScriptDir
$BinRoot = Join-Path $RepoRoot 'electron\bin'

$FfmpegDir = Join-Path $BinRoot 'ffmpeg'
$TskDir = Join-Path $BinRoot 'sleuthkit'
$TestDiskDir = Join-Path $BinRoot 'testdisk'

New-Item -ItemType Directory -Force -Path $FfmpegDir, $TskDir, $TestDiskDir | Out-Null
$TempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("td_engines_" + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force -Path $TempRoot | Out-Null

function Install-ZipArchive {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$Url,
    [Parameter(Mandatory = $true)][string]$DestDir
  )
  Write-Host "Downloading $Name from $Url ..."
  $ZipPath = Join-Path $TempRoot "$Name.zip"
  $ExtractPath = Join-Path $TempRoot $Name
  Invoke-WebRequest -Uri $Url -OutFile $ZipPath -UseBasicParsing
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
  Install-ZipArchive -Name 'ffmpeg' -Url 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip' -DestDir $FfmpegDir
  Install-ZipArchive -Name 'testdisk' -Url 'https://www.cgsecurity.org/testdisk-7.2.win64.zip' -DestDir $TestDiskDir

  try {
    $TskRelease = Invoke-RestMethod -Uri 'https://api.github.com/repos/sleuthkit/sleuthkit/releases/latest' -UseBasicParsing
    $WinAsset = $TskRelease.assets | Where-Object { $_.name -match 'win32\.zip$|win64\.zip$' } | Select-Object -First 1
    if ($WinAsset) {
      Install-ZipArchive -Name 'sleuthkit' -Url $WinAsset.browser_download_url -DestDir $TskDir
    } else {
      Write-Warning 'No prebuilt Windows Sleuth Kit zip asset found in latest GitHub release; skipping optional TSK ext/HFS+ addon.'
    }
  } catch {
    Write-Warning "Skipping optional Sleuth Kit download: $($_.Exception.Message)"
  }

  Write-Host ''
  Write-Host 'Done! Ready to build desktop package with: npm run dist:win'
} finally {
  if (Test-Path $TempRoot) {
    Remove-Item -Path $TempRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}
