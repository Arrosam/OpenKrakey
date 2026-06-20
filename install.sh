#!/bin/sh
# OpenKrakey installer (macOS / Linux).
#
#   1. checks Node.js >= 22 (instructs and exits if missing - never touches your
#      system toolchain),
#   2. installs dependencies (npm install),
#   3. puts the `krakey` command on your PATH (a symlink to ./bin/krakey),
#      anchored to THIS install.
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

# --- 1. Node.js >= 22 --------------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  echo "error: Node.js is not installed." >&2
  echo "       OpenKrakey needs Node.js >= 22 - install it from https://nodejs.org/ and re-run." >&2
  exit 1
fi
node_major=$(node -p 'process.versions.node.split(".")[0]')
if [ "$node_major" -lt 22 ]; then
  echo "error: Node.js >= 22 is required, but found $(node -v)." >&2
  echo "       Upgrade from https://nodejs.org/ (or via nvm) and re-run." >&2
  exit 1
fi
echo "  node: $(node -v) ok"

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
