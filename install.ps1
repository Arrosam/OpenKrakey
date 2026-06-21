<#
  OpenKrakey installer (Windows).

    1. ensures Node.js >= 22 — if missing or too old, installs it via winget
       (the Windows Package Manager, built into Windows 10/11),
    2. installs dependencies (npm install),
    3. adds <install>\bin to your user PATH so the `krakey` command is available,
       anchored to THIS install.

  Set $env:KRAKEY_YES=1 for a non-interactive run (auto-confirm the Node install).

  Usage (from this folder, or anywhere):
    powershell -ExecutionPolicy Bypass -File install.ps1
#>
#Requires -Version 5
$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root

Write-Host "OpenKrakey installer"
Write-Host "  install dir: $Root"

function Test-NodeOk {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if (-not $cmd) { return $false }
  try {
    $major = [int]((& node -v).Trim().TrimStart('v').Split('.')[0])
    return ($major -ge 22)
  } catch { return $false }
}

# Refresh this session's PATH from Machine + User so a freshly-installed node is
# visible without opening a new terminal.
function Update-SessionPath {
  $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user    = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = (@($machine, $user) | Where-Object { $_ }) -join ';'
}

function Install-Node {
  $winget = Get-Command winget -ErrorAction SilentlyContinue
  if (-not $winget) {
    Write-Host "  winget (the Windows Package Manager) is not available, so Node can't be installed automatically." -ForegroundColor Yellow
    return
  }
  Write-Host "  installing Node.js LTS via winget (OpenJS.NodeJS.LTS)..."
  # winget is a native exe: a non-zero exit won't throw here, so Test-NodeOk
  # below is the real gate. The try/catch only guards winget itself faulting.
  try {
    & winget install --exact --id OpenJS.NodeJS.LTS --silent `
        --accept-source-agreements --accept-package-agreements
  } catch {
    Write-Host "  winget reported: $($_.Exception.Message)" -ForegroundColor Yellow
  }
  Update-SessionPath
}

# --- 1. Node.js >= 22 --------------------------------------------------------
if (Test-NodeOk) {
  Write-Host "  node: $((& node -v).Trim()) ok"
} else {
  Write-Host "  node: not found (or older than 22)"

  $doInstall = $false
  if ($env:KRAKEY_YES) {
    $doInstall = $true
  } else {
    # Read-Host throws under -NonInteractive; in that case don't surprise-install.
    try {
      $ans = Read-Host "Install Node.js LTS now via winget? [Y/n]"
      if ($ans -notmatch '^[Nn]') { $doInstall = $true }
    } catch { $doInstall = $false }
  }
  if ($doInstall) { Install-Node }

  if (Test-NodeOk) {
    Write-Host "  node: $((& node -v).Trim()) ok (installed)"
  } else {
    Write-Host "error: Node.js >= 22 is required and could not be installed automatically." -ForegroundColor Red
    Write-Host "       Install it from https://nodejs.org/ and re-run install.ps1."
    Write-Host "       Tip: if you just installed Node, open a NEW terminal and re-run."
    exit 1
  }
}

# --- 2. dependencies ---------------------------------------------------------
Write-Host "Installing dependencies (npm install)..."
& npm install
if ($LASTEXITCODE -ne 0) {
  Write-Host "error: npm install failed (exit $LASTEXITCODE)." -ForegroundColor Red
  exit 1
}

# --- 3. add <install>\bin to the user PATH -----------------------------------
$binDir = Join-Path $Root 'bin'
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($null -eq $userPath) { $userPath = '' }
$entries = $userPath.Split(';') | Where-Object { $_ -ne '' }

if ($entries -contains $binDir) {
  Write-Host "  already on your user PATH: $binDir"
} else {
  $newPath = (@($binDir) + $entries) -join ';'
  [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
  Write-Host "  added to your user PATH: $binDir"
  Write-Host "  (open a NEW terminal for the change to take effect)"
}

# Make `krakey` work in THIS session too.
if (($env:Path -split ';') -notcontains $binDir) {
  $env:Path = "$binDir;$env:Path"
}

Write-Host ""
Write-Host "Done. Try:  krakey setup"
Write-Host "      then: krakey start  |  krakey dashboard  |  krakey help"
