<#
  OpenKrakey installer (Windows).

    1. checks Node.js >= 22 (instructs and exits if missing - never touches your
       system toolchain),
    2. installs dependencies (npm install),
    3. adds <install>\bin to your user PATH so the `krakey` command is available,
       anchored to THIS install.

  Usage (from this folder, or anywhere):
    powershell -ExecutionPolicy Bypass -File install.ps1
#>
#Requires -Version 5
$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root

Write-Host "OpenKrakey installer"
Write-Host "  install dir: $Root"

# --- 1. Node.js >= 22 --------------------------------------------------------
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Host "error: Node.js is not installed." -ForegroundColor Red
  Write-Host "       OpenKrakey needs Node.js >= 22 - install it from https://nodejs.org/ and re-run."
  exit 1
}
$nodeVer = (& node -v).Trim()            # e.g. v22.3.0
$major = [int]($nodeVer.TrimStart('v').Split('.')[0])
if ($major -lt 22) {
  Write-Host "error: Node.js >= 22 is required, but found $nodeVer." -ForegroundColor Red
  Write-Host "       Upgrade from https://nodejs.org/ and re-run."
  exit 1
}
Write-Host "  node: $nodeVer ok"

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
