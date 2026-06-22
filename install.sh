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

# --- presentation: mint brand, gated to interactive color terminals ----------
# Color, banner glyphs, and the spinner appear ONLY on an interactive color
# terminal. Piped / redirected / CI / NO_COLOR => PLAIN ASCII (no escapes, no
# spinner), so output stays clean in logs (e.g. `krakey update`).
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  FANCY=1
  C_MINT=$(printf '\033[38;2;47;214;156m')
  C_DIM=$(printf '\033[2m')
  C_BOLD=$(printf '\033[1m')
  C_RED=$(printf '\033[38;2;255;107;107m')
  C_RESET=$(printf '\033[0m')
else
  FANCY=0
  C_MINT='' C_DIM='' C_BOLD='' C_RED='' C_RESET=''
fi

# paint COLOR TEXT -> TEXT (with ANSI when FANCY, plain otherwise).
paint() { printf '%s%s%s' "$1" "$2" "$C_RESET"; }

# banner: the KRAKEY wordmark, inherited verbatim from the CLI landing page
# (packages/cli/src/logo.ts) — rendered as a vertical gradient (light → #2FD69C
# → deep) when fancy, or the plain wordmark otherwise.
banner() {
  printf '\n'
  if [ "$FANCY" = "1" ]; then
    _i=0
    while IFS= read -r _ln; do
      case "$_i" in
        0) _c='\033[38;2;151;235;206m' ;;
        1) _c='\033[38;2;128;230;195m' ;;
        2) _c='\033[38;2;105;225;184m' ;;
        3) _c='\033[38;2;82;221;173m' ;;
        4) _c='\033[38;2;59;216;162m' ;;
        5) _c='\033[38;2;44;202;147m' ;;
        6) _c='\033[38;2;39;178;130m' ;;
        7) _c='\033[38;2;34;155;113m' ;;
        8) _c='\033[38;2;29;131;95m' ;;
        *) _c='\033[38;2;24;107;78m' ;;
      esac
      printf "$_c%s$C_RESET\n" "$_ln"
      _i=$((_i + 1))
    done <<'WM'
    d8b                           d8b
    ?88                           ?88
     88b                           88b
     888  d88'  88bd88b d888b8b    888  d88' d8888b?88   d8P
     888bd8P'   88P'  `d8P' ?88    888bd8P' d8b_,dPd88   88
    d88888b    d88     88b  ,88b  d88888b   88b    ?8(  d88
    d88' `?88b,d88'     `?88P'`88bd88' `?88b,`?888P'`?88P'?8b
                                                          )88
                                                          ,d8P
                                                      `?888P'
WM
    printf '%s\n' "$(paint "$C_MINT" '        u l t i m a t e   a u t o n o m o u s   a g e n t')"
  else
    cat <<'WM'
    d8b                           d8b
    ?88                           ?88
     88b                           88b
     888  d88'  88bd88b d888b8b    888  d88' d8888b?88   d8P
     888bd8P'   88P'  `d8P' ?88    888bd8P' d8b_,dPd88   88
    d88888b    d88     88b  ,88b  d88888b   88b    ?8(  d88
    d88' `?88b,d88'     `?88P'`88bd88' `?88b,`?888P'`?88P'?8b
                                                          )88
                                                          ,d8P
                                                      `?888P'
        u l t i m a t e   a u t o n o m o u s   a g e n t
WM
  fi
  printf '\n'
}

# step LABEL CMD...  -> run CMD with a spinner (fancy) or plain markers.
# On success: ✔ LABEL. On failure: ✖ LABEL + the tail of captured output, and
# returns the command's non-zero status (never aborts via set -e itself).
step() {
  _label=$1
  shift
  _log=$(mktemp 2>/dev/null || printf '/tmp/krakey-step.%s' "$$")
  if [ "$FANCY" = "1" ]; then
    # Run the phase in the background; animate a spinner until it exits.
    ( "$@" >"$_log" 2>&1 ) &
    _pid=$!
    _frames='|/-\'
    _i=0
    # Hide cursor for a cleaner spin; restored after the loop.
    printf '\033[?25l'
    while kill -0 "$_pid" 2>/dev/null; do
      _i=$(( (_i + 1) % 4 ))
      _frame=$(printf '%s' "$_frames" | cut -c $((_i + 1)))
      printf '\r%s %s ' "$(paint "$C_MINT" "$_frame")" "$_label"
      sleep 0.1
    done
    # `wait` may return non-zero; capture it without tripping set -e.
    if wait "$_pid"; then _rc=0; else _rc=$?; fi
    printf '\033[?25h\r\033[K'
  else
    printf '%s\n' "-> $_label"
    # Subshell may fail; capture status in a tested context (set -e safe).
    if ( "$@" >"$_log" 2>&1 ); then _rc=0; else _rc=$?; fi
  fi
  if [ "$_rc" -eq 0 ]; then
    if [ "$FANCY" = "1" ]; then
      printf '%s %s\n' "$(paint "$C_MINT" '✔')" "$_label"
    else
      printf '%s\n' "[ok] $_label"
    fi
  else
    if [ "$FANCY" = "1" ]; then
      printf '%s %s\n' "$(paint "$C_RED" '✖')" "$_label"
    else
      printf '%s\n' "[fail] $_label"
    fi
    # Surface the error: don't hide it behind the spinner.
    if [ -s "$_log" ]; then
      printf '%s\n' "    --- last output ---"
      tail -n 20 "$_log" 2>/dev/null | while IFS= read -r _line; do
        printf '    %s\n' "$_line"
      done
    fi
  fi
  rm -f "$_log" 2>/dev/null || true
  return "$_rc"
}

banner
printf '%s\n' "$(paint "$C_DIM" "install dir: $ROOT")"

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
  step "Checking Node.js ($(node -v))" true || true
else
  printf '%s\n' "$(paint "$C_DIM" "node: not found (or older than 22)")"
  if confirm "Install Node.js 22 now? (Homebrew on macOS, otherwise a user-local nvm)"; then
    # Run inline (NOT in a backgrounded step): install_node sources nvm / shifts
    # PATH into THIS shell, which a subshell would lose. It prints its own
    # progress and swallows failures; the node_ok check below is the real gate.
    install_node || true
  fi
  if node_ok; then
    step "Checking Node.js ($(node -v))" true || true
  else
    if [ "$FANCY" = "1" ]; then
      printf '%s\n' "$(paint "$C_RED" '✖') Node.js >= 22 is required and could not be installed automatically." >&2
    else
      echo "error: Node.js >= 22 is required and could not be installed automatically." >&2
    fi
    echo "       Install it from https://nodejs.org/ (or 'nvm install 22') and re-run ./install.sh." >&2
    echo "       Tip: if you just installed Node, open a NEW terminal and re-run." >&2
    exit 1
  fi
fi

# --- 2. dependencies ---------------------------------------------------------
if ! step "Installing dependencies (npm install)" npm install; then
  exit 1
fi

# --- 3. put `krakey` on PATH -------------------------------------------------
launcher="$ROOT/bin/krakey"
chmod +x "$launcher"

# Where we ended up linking, and a PATH-hint to print after the verdict (so the
# spinner line stays clean). Populated by link_into / the fallback below.
LINK_TARGET=''
PATH_HINT=''

link_into() {
  dir=$1
  if [ -d "$dir" ] && [ -w "$dir" ]; then
    ln -sf "$launcher" "$dir/krakey" && {
      LINK_TARGET="$dir/krakey"
      case ":$PATH:" in
        *":$dir:"*) ;;
        *) PATH_HINT="$dir is not on your PATH - add it, e.g.:
          export PATH=\"$dir:\$PATH\"" ;;
      esac
      return 0
    }
  fi
  return 1
}

# The linking is quick and must set LINK_TARGET/PATH_HINT in THIS shell (a
# backgrounded step subshell would lose them), so run it inline and frame the
# verdict by hand — same look as step()'s output.
_link_label="Linking krakey"
if link_into "/usr/local/bin"; then
  :
elif link_into "$HOME/.local/bin"; then
  :
else
  mkdir -p "$HOME/.local/bin"
  ln -sf "$launcher" "$HOME/.local/bin/krakey"
  LINK_TARGET="$HOME/.local/bin/krakey"
  case ":$PATH:" in
    *":$HOME/.local/bin:"*) ;;
    *) PATH_HINT="\$HOME/.local/bin is not on your PATH - add it, e.g.:
          export PATH=\"\$HOME/.local/bin:\$PATH\"" ;;
  esac
fi

if [ -n "$LINK_TARGET" ]; then
  if [ "$FANCY" = "1" ]; then
    printf '%s %s\n' "$(paint "$C_MINT" '✔')" "$_link_label"
  else
    printf '%s\n' "[ok] $_link_label"
  fi
  printf '%s\n' "$(paint "$C_DIM" "linked: $LINK_TARGET -> $launcher")"
  if [ -n "$PATH_HINT" ]; then
    printf '%s\n' "$(paint "$C_DIM" "note: $PATH_HINT")"
  fi
else
  if [ "$FANCY" = "1" ]; then
    printf '%s %s\n' "$(paint "$C_RED" '✖')" "$_link_label" >&2
  else
    printf '%s\n' "[fail] $_link_label" >&2
  fi
  exit 1
fi

# --- success panel -----------------------------------------------------------
printf '\n'
if [ "$FANCY" = "1" ]; then
  printf '%s\n' "$(paint "$C_MINT" "$C_BOLD✦ Krakey is ready")"
else
  printf '%s\n' "Krakey is ready"
fi
printf '%s\n' "  Try:  krakey setup"
printf '%s\n' "  then: krakey start  |  krakey dashboard  |  krakey help"
