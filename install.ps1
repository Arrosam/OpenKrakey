<#
  OpenKrakey installer (Windows).

    1. ensures Node.js >= 22 -- if missing or too old, installs it via winget
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

# --- presentation: mint brand, gated to interactive color terminals ----------
# Color, banner glyphs, and the spinner appear ONLY when stdout is an
# interactive console. Redirected (piped to a file, captured by `krakey
# update`, CI) or NO_COLOR set => PLAIN ASCII: no ANSI escapes, no spinner.
$script:Fancy = (-not [Console]::IsOutputRedirected) -and (-not $env:NO_COLOR)

# Brand glyphs built from code points so the source stays pure ASCII (Windows
# PowerShell 5.1's parser misreads raw multi-byte UTF-8 without a BOM). They
# render correctly because we set the console to UTF-8 below.
$script:gStar = [char]0x2726  # star
$script:gOk   = [char]0x2714  # check
$script:gFail = [char]0x2716  # cross

if ($script:Fancy) {
  # Render the brand glyphs correctly regardless of the console code page.
  try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}
  $e = [char]27
  $script:cMint  = "$e[38;2;47;214;156m"
  $script:cDim   = "$e[2m"
  $script:cBold  = "$e[1m"
  $script:cRed   = "$e[38;2;255;107;107m"
  $script:cReset = "$e[0m"
} else {
  $script:cMint = ''; $script:cDim = ''; $script:cBold = ''; $script:cRed = ''; $script:cReset = ''
}

# Paint TEXT with COLOR (ANSI when fancy, plain otherwise).
function Paint([string]$color, [string]$text) { "$color$text$($script:cReset)" }

# Banner: a mint KRAKEY wordmark + dim tagline (fancy), or a plain title.
function Write-Banner {
  Write-Host ""
  if ($script:Fancy) {
    $art = @(
      " _  __  ____    _    _  __ _____  __   __",
      "| |/ / |  _ \  / \  | |/ /| ____| \ \ / /",
      "| ' /  | |_) |/ _ \ | ' / |  _|    \ V / ",
      "| . \  |  _ </ ___ \| . \ | |___    | |  ",
      "|_|\_\ |_| \_\_/   \_\_|\_\|_____|   |_|  "
    )
    foreach ($line in $art) { Write-Host "$($script:cMint)$($script:cBold)$line$($script:cReset)" }
    Write-Host "$($script:cDim)$($script:gStar) the ultimate autonomous agent$($script:cReset)"
  } else {
    Write-Host "KRAKEY"
    Write-Host "the ultimate autonomous agent"
  }
  Write-Host ""
}

# Invoke-Step LABEL { ...phase... }
# Runs the scriptblock in a background job, animating a spinner (fancy) or
# printing plain markers, and resolves to a check/cross verdict. Returns $true on
# success. On failure, prints the tail of the job's captured output so errors
# are not hidden behind the spinner.
function Invoke-Step([string]$label, [scriptblock]$action) {
  if ($script:Fancy) {
    $job = Start-Job -ScriptBlock $action
    $frames = '|','/','-','\'
    $i = 0
    while ($job.State -eq 'Running') {
      $frame = $frames[$i % $frames.Length]
      Write-Host -NoNewline "`r$($script:cMint)$frame$($script:cReset) $label "
      Start-Sleep -Milliseconds 100
      $i++
    }
    $output = Receive-Job $job 2>&1
    $ok = ($job.State -eq 'Completed')
    Remove-Job $job -Force
    # Clear the spinner line.
    Write-Host -NoNewline "`r$(' ' * ($label.Length + 4))`r"
  } else {
    Write-Host "-> $label"
    $output = & $action 2>&1
    $ok = $?
  }

  if ($ok) {
    if ($script:Fancy) {
      Write-Host "$(Paint $script:cMint $script:gOk) $label"
    } else {
      Write-Host "[ok] $label"
    }
  } else {
    if ($script:Fancy) {
      Write-Host "$(Paint $script:cRed $script:gFail) $label"
    } else {
      Write-Host "[fail] $label"
    }
    if ($output) {
      Write-Host "    --- last output ---"
      $tail = @($output | Select-Object -Last 20)
      foreach ($line in $tail) { Write-Host "    $line" }
    }
  }
  return $ok
}

Write-Banner
Write-Host (Paint $script:cDim "install dir: $Root")

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
    Write-Host (Paint $script:cRed "winget (the Windows Package Manager) is not available, so Node can't be installed automatically.")
    return
  }
  Write-Host (Paint $script:cDim "installing Node.js LTS via winget (OpenJS.NodeJS.LTS)...")
  # winget is a native exe: a non-zero exit won't throw here, so Test-NodeOk
  # below is the real gate. The try/catch only guards winget itself faulting.
  try {
    & winget install --exact --id OpenJS.NodeJS.LTS --silent `
        --accept-source-agreements --accept-package-agreements
  } catch {
    Write-Host (Paint $script:cDim "winget reported: $($_.Exception.Message)")
  }
  Update-SessionPath
}

# --- 1. Node.js >= 22 --------------------------------------------------------
if (Test-NodeOk) {
  Invoke-Step "Checking Node.js ($((& node -v).Trim()))" { $true } | Out-Null
} else {
  Write-Host (Paint $script:cDim "node: not found (or older than 22)")

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
  # Install-Node drives winget interactively + refreshes PATH in THIS session, so
  # it runs inline (not in a background job). Test-NodeOk below is the real gate.
  if ($doInstall) { Install-Node }

  if (Test-NodeOk) {
    Invoke-Step "Checking Node.js ($((& node -v).Trim()))" { $true } | Out-Null
  } else {
    if ($script:Fancy) {
      Write-Host "$(Paint $script:cRed $script:gFail) Node.js >= 22 is required and could not be installed automatically."
    } else {
      Write-Host "error: Node.js >= 22 is required and could not be installed automatically."
    }
    Write-Host "       Install it from https://nodejs.org/ and re-run install.ps1."
    Write-Host "       Tip: if you just installed Node, open a NEW terminal and re-run."
    exit 1
  }
}

# --- 2. dependencies ---------------------------------------------------------
# Run npm install inline so $LASTEXITCODE is the authoritative gate (a background
# job would not surface npm's native exit code reliably). Frame it as a step.
if ($script:Fancy) {
  Write-Host -NoNewline "$($script:cMint)*$($script:cReset) Installing dependencies (npm install) "
} else {
  Write-Host "-> Installing dependencies (npm install)"
}
& npm install
$npmExit = $LASTEXITCODE
if ($script:Fancy) { Write-Host -NoNewline "`r$(' ' * 48)`r" }
if ($npmExit -ne 0) {
  if ($script:Fancy) {
    Write-Host "$(Paint $script:cRed $script:gFail) Installing dependencies (npm install)"
  } else {
    Write-Host "[fail] Installing dependencies (npm install)"
  }
  Write-Host (Paint $script:cRed "error: npm install failed (exit $npmExit).")
  exit 1
}
if ($script:Fancy) {
  Write-Host "$(Paint $script:cMint $script:gOk) Installing dependencies (npm install)"
} else {
  Write-Host "[ok] Installing dependencies (npm install)"
}

# --- 3. add <install>\bin to the user PATH -----------------------------------
$binDir = Join-Path $Root 'bin'
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($null -eq $userPath) { $userPath = '' }
$entries = $userPath.Split(';') | Where-Object { $_ -ne '' }

if ($entries -contains $binDir) {
  if ($script:Fancy) {
    Write-Host "$(Paint $script:cMint $script:gOk) Adding to PATH"
  } else {
    Write-Host "[ok] Adding to PATH"
  }
  Write-Host (Paint $script:cDim "already on your user PATH: $binDir")
} else {
  $newPath = (@($binDir) + $entries) -join ';'
  [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
  if ($script:Fancy) {
    Write-Host "$(Paint $script:cMint $script:gOk) Adding to PATH"
  } else {
    Write-Host "[ok] Adding to PATH"
  }
  Write-Host (Paint $script:cDim "added to your user PATH: $binDir")
  Write-Host (Paint $script:cDim "(open a NEW terminal for the change to take effect)")
}

# Make `krakey` work in THIS session too.
if (($env:Path -split ';') -notcontains $binDir) {
  $env:Path = "$binDir;$env:Path"
}

# --- success panel -----------------------------------------------------------
Write-Host ""
if ($script:Fancy) {
  Write-Host "$($script:cMint)$($script:cBold)$($script:gStar) Krakey is ready$($script:cReset)"
} else {
  Write-Host "Krakey is ready"
}
Write-Host "  Try:  krakey setup"
Write-Host "  then: krakey start  |  krakey dashboard  |  krakey help"
