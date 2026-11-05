# Installs sling-runner on Windows from GitHub Releases. Given a pairing code,
# it also pairs this machine with Sling and starts the Runner at logon.
#
#   $env:SLING_CODE = "<code>"; irm https://<your-sling>/install.ps1 | iex
#   $env:SLING_REPO = "owner/sling"; irm https://github.com/<owner>/<repo>/releases/latest/download/install.ps1 | iex
#
# Options:
#   $env:SLING_URL      Sling's public URL, to pair with.
#   $env:SLING_CODE     Pairing code from Machines > Add machine. With SLING_URL,
#                       the script runs `sling-runner pair` and
#                       `sling-runner service install`.
#   $env:SLING_REPO     GitHub repo to download from, as owner/name. When it's
#                       empty and sling-runner is already on PATH, the download
#                       is skipped.
#   $env:SLING_VERSION  Release tag. Defaults to the latest.
#   $env:SLING_BIN_DIR  Install directory. Defaults to $env:LOCALAPPDATA\Sling\bin.
$ErrorActionPreference = "Stop"
# sling:defaults

$Url = $env:SLING_URL
$Code = $env:SLING_CODE
$Repo = $env:SLING_REPO
$Version = if ($env:SLING_VERSION) { $env:SLING_VERSION } else { "latest" }
$BinDir = if ($env:SLING_BIN_DIR) { $env:SLING_BIN_DIR } else { Join-Path $env:LOCALAPPDATA "Sling\bin" }

if ($Code -and -not $Url) { throw "Set SLING_URL to Sling's public URL to pair with SLING_CODE." }

$Existing = Get-Command sling-runner -ErrorAction SilentlyContinue
if (-not $Repo -and $Existing) {
  $Runner = $Existing.Source
  Write-Host "Using $Runner, which is already installed."
} else {
  if (-not $Repo) { throw "Set SLING_REPO to the GitHub repo that publishes Sling, for example owner/sling" }
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
  $Runner = "$BinDir\sling-runner.exe"
}

if ($Code) {
  & $Runner pair $Url $Code
  if ($LASTEXITCODE -ne 0) { throw "Pairing failed." }
  & $Runner service install
  if ($LASTEXITCODE -ne 0) { throw "Installing the service failed." }
  Write-Host ""
  Write-Host "Choose the repos Sling may use under Machines in Sling."
} else {
  $PairUrl = if ($Url) { $Url } else { "<sling-url>" }
  Write-Host ""
  Write-Host "Next:"
  Write-Host "  sling-runner pair $PairUrl <code from Machines > Add machine>"
  Write-Host "  sling-runner service install"
  Write-Host "Then choose the repos Sling may use under Machines in Sling."
}
