# Installs sling-runner on Windows from GitHub Releases.
#
#   $env:SLING_REPO = "owner/sling"; irm https://github.com/<owner>/<repo>/releases/latest/download/install.ps1 | iex
#
# Options: $env:SLING_REPO (required), $env:SLING_VERSION (default latest),
# $env:SLING_BIN_DIR (default $env:LOCALAPPDATA\Sling\bin).
$ErrorActionPreference = "Stop"

$Repo = $env:SLING_REPO
if (-not $Repo) { throw "Set SLING_REPO to the GitHub repo that publishes Sling, for example owner/sling" }
$Version = if ($env:SLING_VERSION) { $env:SLING_VERSION } else { "latest" }
$BinDir = if ($env:SLING_BIN_DIR) { $env:SLING_BIN_DIR } else { Join-Path $env:LOCALAPPDATA "Sling\bin" }

if ($Version -eq "latest") {
  $Version = (Invoke-RestMethod "https://api.github.com/repos/$Repo/releases/latest").tag_name
}
$Target = "x86_64-pc-windows-msvc"
$Name = "sling-runner-$Version-$Target"
$Base = "https://github.com/$Repo/releases/download/$Version"
$Tmp = Join-Path ([System.IO.Path]::GetTempPath()) ([System.Guid]::NewGuid())
New-Item -ItemType Directory -Path $Tmp | Out-Null

try {
  Write-Host "Downloading $Name"
  Invoke-WebRequest "$Base/$Name.zip" -OutFile "$Tmp\$Name.zip"
  Invoke-WebRequest "$Base/$Name.zip.sha256" -OutFile "$Tmp\$Name.zip.sha256"
  $Expected = (Get-Content "$Tmp\$Name.zip.sha256").Split(" ")[0].Trim().ToLower()
  $Actual = (Get-FileHash "$Tmp\$Name.zip" -Algorithm SHA256).Hash.ToLower()
  if ($Expected -ne $Actual) { throw "Checksum mismatch, not installing." }

  Expand-Archive "$Tmp\$Name.zip" -DestinationPath $Tmp
  New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
  Copy-Item "$Tmp\$Name\sling-runner.exe" "$BinDir\sling-runner.exe" -Force
  Write-Host "Installed $BinDir\sling-runner.exe ($Version)"

  $UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
  if (-not ($UserPath -split ";" | Where-Object { $_ -eq $BinDir })) {
    [Environment]::SetEnvironmentVariable("Path", "$UserPath;$BinDir", "User")
    Write-Host "Added $BinDir to your user PATH. Open a new terminal to use it."
  }
} finally {
  Remove-Item -Recurse -Force $Tmp
}

Write-Host ""
Write-Host "Next:"
Write-Host "  sling-runner repo add C:\code\your-repo"
Write-Host "  sling-runner pair <sling-url> <code from the Machines page>"
Write-Host "  sling-runner service install"
