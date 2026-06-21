#!/bin/sh
# OpenKrakey installer (macOS / Linux).
#
#   1. ensures Node.js >= 22 — if it is missing or too old, offers to install it
#      (Homebrew on macOS, otherwise a user-local nvm: no sudo, nothing
#      system-wide),
#   2. installs dependencies (npm install),
#   3. puts the `krakey` command on your PATH (a symlink to ./bin/krakey),
#      anchored to THIS install.
#
# Set KRAKEY_YES=1 for a non-interactive run (auto-confirm the Node install).
#
# Usage:  ./install.sh        (run from anywhere; it locates its own directory)
set -eu

# --- locate the repo root (this script's directory, symlinks followed) -------
self=$0
while [ -h "$self" ]; do
  link=$(readlink "$self")
  case $link in
    /*) self=$link ;;
    *)  self=$(dirname "$self")/$link ;;
  esac
done
ROOT=$(cd "$(dirname "$self")" && pwd)
cd "$ROOT"

echo "OpenKrakey installer"
echo "  install dir: $ROOT"

# --- helpers -----------------------------------------------------------------
KRAKEY_YES="${KRAKEY_YES:-}"

# confirm MESSAGE -> 0 (yes) / 1 (no). KRAKEY_YES=1 auto-confirms; a
# non-interactive shell without it defaults to NO (never surprise-install).
confirm() {
  [ "$KRAKEY_YES" = "1" ] && return 0
  [ -t 0 ] || return 1
  printf "%s [Y/n] " "$1"
  read -r _reply || _reply=""
  case "$_reply" in [Nn]*) return 1 ;; *) return 0 ;; esac
}

# node_ok -> 0 if `node` is present AND its major version is >= 22.
node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  _major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
  [ "${_major:-0}" -ge 22 ] 2>/dev/null
}

# Source an existing nvm into THIS shell so its `node` becomes usable. 0 if found.
load_nvm() {
  NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  [ -s "$NVM_DIR/nvm.sh" ] || return 1
  # nvm.sh is not written for `set -eu`; relax while sourcing + driving it.
  set +eu
  # shellcheck disable=SC1090
  . "$NVM_DIR/nvm.sh"
  set -eu
  return 0
}

# Try hard to get Node >= 22 onto this machine. Returns 0 on success.
install_node() {
  _os=$(uname -s 2>/dev/null || echo unknown)

  # 1) macOS with Homebrew already present.
  if [ "$_os" = "Darwin" ] && command -v brew >/dev/null 2>&1; then
    echo "  installing Node via Homebrew (brew install node)..."
    brew install node || true
    if node_ok; then return 0; fi
  fi

  # 2) An nvm that is already installed.
  if load_nvm; then
    echo "  installing Node 22 via your existing nvm..."
    set +eu; nvm install 22; nvm use 22; set -eu
    if node_ok; then return 0; fi
  fi

  # 3) Install nvm (user-local, no sudo) then Node 22 through it.
  if command -v curl >/dev/null 2>&1 || command -v wget >/dev/null 2>&1; then
    echo "  installing nvm (user-local Node version manager)..."
    _nvm_url="https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh"
    set +eu
    if command -v curl >/dev/null 2>&1; then
      curl -fsSL "$_nvm_url" | bash
    else
      wget -qO- "$_nvm_url" | bash
    fi
    set -eu
    if load_nvm; then
      echo "  installing Node 22 via nvm..."
      set +eu; nvm install 22; nvm use 22; set -eu
      if node_ok; then return 0; fi
    fi
  fi

  return 1
}

# --- 1. Node.js >= 22 --------------------------------------------------------
if node_ok; then
  echo "  node: $(node -v) ok"
else
  echo "  node: not found (or older than 22)"
  if confirm "Install Node.js 22 now? (Homebrew on macOS, otherwise a user-local nvm)"; then
    install_node || true
  fi
  if node_ok; then
    echo "  node: $(node -v) ok (installed)"
  else
    echo "error: Node.js >= 22 is required and could not be installed automatically." >&2
    echo "       Install it from https://nodejs.org/ (or 'nvm install 22') and re-run ./install.sh." >&2
    echo "       Tip: if you just installed Node, open a NEW terminal and re-run." >&2
    exit 1
  fi
fi

# --- 2. dependencies ---------------------------------------------------------
echo "Installing dependencies (npm install)..."
npm install

# --- 3. put `krakey` on PATH -------------------------------------------------
launcher="$ROOT/bin/krakey"
chmod +x "$launcher"

link_into() {
  dir=$1
  if [ -d "$dir" ] && [ -w "$dir" ]; then
    ln -sf "$launcher" "$dir/krakey" && {
      echo "  linked: $dir/krakey -> $launcher"
      case ":$PATH:" in
        *":$dir:"*) ;;
        *) echo "  note: $dir is not on your PATH - add it, e.g.:"
           echo "          export PATH=\"$dir:\$PATH\"" ;;
      esac
      return 0
    }
  fi
  return 1
}

if link_into "/usr/local/bin"; then
  :
elif link_into "$HOME/.local/bin"; then
  :
else
  mkdir -p "$HOME/.local/bin"
  ln -sf "$launcher" "$HOME/.local/bin/krakey"
  echo "  linked: $HOME/.local/bin/krakey -> $launcher"
  case ":$PATH:" in
    *":$HOME/.local/bin:"*) ;;
    *) echo "  note: \$HOME/.local/bin is not on your PATH - add it, e.g.:"
       echo "          export PATH=\"\$HOME/.local/bin:\$PATH\"" ;;
  esac
fi

echo
echo "Done. Try:  krakey setup"
echo "      then: krakey start  |  krakey dashboard  |  krakey help"
