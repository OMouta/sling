# Installs sling-runner on Windows. Given a pairing code, it also pairs this
# machine with Sling and starts the Runner at logon.
#
#   $env:SLING_CODE = "<code>"; irm https://<your-sling>/install.ps1 | iex
#   $env:SLING_REPO = "owner/sling"; irm https://github.com/<owner>/<repo>/releases/latest/download/install.ps1 | iex
#
# Options:
#   $env:SLING_URL      Sling's public URL. The script downloads sling-runner
#                       from there, the version that Sling runs, and pairs with it.
#   $env:SLING_CODE     Pairing code from Machines > Add machine. With SLING_URL,
#                       the script runs `sling-runner pair` and
#                       `sling-runner service install`. Without it, a machine
#                       that's already paired gets its Runner restarted on the
#                       new version.
#   $env:SLING_REPO     GitHub repo to download from instead, as owner/name.
#   $env:SLING_VERSION  Release tag to download from SLING_REPO. Defaults to the latest.
#   $env:SLING_BIN_DIR  Install directory. Defaults to $env:LOCALAPPDATA\Sling\bin.
#
# With neither SLING_URL nor SLING_REPO, it uses the sling-runner on PATH.
$ErrorActionPreference = "Stop"
# sling:defaults

$Url = $env:SLING_URL
$Code = $env:SLING_CODE
$Repo = $env:SLING_REPO
$Version = if ($env:SLING_VERSION) { $env:SLING_VERSION } else { "latest" }
$BinDir = if ($env:SLING_BIN_DIR) { $env:SLING_BIN_DIR } else { Join-Path $env:LOCALAPPDATA "Sling\bin" }

if ($Code -and -not $Url) { throw "Set SLING_URL to Sling's public URL to pair with SLING_CODE." }

# Downloads $From to $To. When the server says no, shows what it said.
function Get-File($From, $To) {
  try {
    Invoke-WebRequest $From -OutFile $To -UseBasicParsing
  } catch {
    $Said = if ($_.ErrorDetails -and $_.ErrorDetails.Message) { "`n" + $_.ErrorDetails.Message.Trim() } else { "" }
    throw "Couldn't download $From ($($_.Exception.Message))$Said"
  }
}

if ($Repo -or $Url) {
  $Target = "x86_64-pc-windows-msvc"
  if ($Repo) {
    if ($Version -eq "latest") {
      $Version = (Invoke-RestMethod "https://api.github.com/repos/$Repo/releases/latest").tag_name
    }
    $File = "sling-runner-$Version-$Target.zip"
    $Base = "https://github.com/$Repo/releases/download/$Version"
    $From = $Repo
  } else {
    $File = "sling-runner-$Target.zip"
    $Base = "$($Url.TrimEnd('/'))/runner/download"
    $From = $Url
  }
  $Tmp = Join-Path ([System.IO.Path]::GetTempPath()) ([System.Guid]::NewGuid())
  New-Item -ItemType Directory -Path $Tmp | Out-Null

  try {
    Write-Host "Downloading sling-runner for $Target from $From"
    Get-File "$Base/$File" "$Tmp\$File"
    Get-File "$Base/$File.sha256" "$Tmp\$File.sha256"
    $Expected = (Get-Content "$Tmp\$File.sha256" -Raw).Trim().Split(" ")[0].ToLower()
    $Actual = (Get-FileHash "$Tmp\$File" -Algorithm SHA256).Hash.ToLower()
    if ($Expected -ne $Actual) { throw "Checksum mismatch, not installing." }

    Expand-Archive "$Tmp\$File" -DestinationPath "$Tmp\unpacked"
    $Exe = Get-ChildItem "$Tmp\unpacked" -Recurse -Filter sling-runner.exe | Select-Object -First 1
    if (-not $Exe) { throw "$File has no sling-runner.exe." }
    New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
    # A running Runner keeps sling-runner.exe open, so it can't be replaced.
    # `sling-runner service install` starts it again.
    if ($IsWindows -ne $false) {
      Get-ScheduledTask -TaskName SlingRunner -ErrorAction SilentlyContinue | Stop-ScheduledTask
      Get-CimInstance Win32_Process -Filter "Name = 'sling-runner.exe'" |
        Where-Object { $_.CommandLine -match '\srun( --service)?\s*$' } |
        ForEach-Object {
          Write-Host "Stopping the running Runner to replace it."
          taskkill /PID $_.ProcessId /T /F | Out-Null
        }
    }
    Copy-Item $Exe.FullName "$BinDir\sling-runner.exe" -Force
    Write-Host "Installed $(& "$BinDir\sling-runner.exe" --version) in $BinDir"

    $UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if (-not ($UserPath -split ";" | Where-Object { $_ -eq $BinDir })) {
      [Environment]::SetEnvironmentVariable("Path", "$UserPath;$BinDir", "User")
      Write-Host "Added $BinDir to your user PATH. Open a new terminal to use it."
    }
  } finally {
    Remove-Item -Recurse -Force $Tmp
  }
  $Runner = "$BinDir\sling-runner.exe"
} else {
  $Existing = Get-Command sling-runner -ErrorAction SilentlyContinue
  if (-not $Existing) {
    throw "Set SLING_URL to Sling's address, or SLING_REPO to the GitHub repo that publishes Sling, for example owner/sling"
  }
  $Runner = $Existing.Source
  Write-Host "Using $Runner, which is already installed."
}

if ($Code) {
  & $Runner pair $Url $Code
  if ($LASTEXITCODE -ne 0) { throw "Pairing failed." }
  & $Runner service install
  if ($LASTEXITCODE -ne 0) { throw "Installing the service failed." }
  Write-Host ""
  Write-Host "Choose the repos Sling may use under Machines in Sling."
} elseif (& $Runner config show 2>$null | Select-String -Quiet '^runner_id = ') {
  # Already paired: restart the Runner on the binary just installed.
  & $Runner service install
  if ($LASTEXITCODE -ne 0) { throw "Restarting the Runner failed." }
  Write-Host "This machine is already paired, so the Runner was restarted on the new version."
} else {
  $PairUrl = if ($Url) { $Url } else { "<sling-url>" }
  Write-Host ""
  Write-Host "Next:"
  Write-Host "  sling-runner pair $PairUrl <code from Machines > Add machine>"
  Write-Host "  sling-runner service install"
  Write-Host "Then choose the repos Sling may use under Machines in Sling."
}
