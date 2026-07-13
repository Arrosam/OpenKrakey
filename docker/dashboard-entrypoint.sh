#!/bin/sh
# Krakey dashboard for Docker — the landing page for first-run setup.
#
# Runs the unified Console (7716) + config-web (7717) in ONE container, wired the
# same way `krakey dashboard` wires them locally. The Console is the landing page:
# a single shell that frames Config (setup), Chat and Inspector. config-web powers
# the Console's Config panel and is the onboarding wizard. Chat/Inspector belong to
# the agent runtime and show "Not connected" until you start it (compose `run` profile).
#
# Open the tokened Console URL this prints (✦ Krakey Console: http://127.0.0.1:7716/?token=…).
set -eu

# One SHARED Config token so the Console's embedded Config panel authenticates against
# config-web. Minted here unless provided; the Console token gates the shell itself.
CONFIG_WEB_TOKEN="${CONFIG_WEB_TOKEN:-$(head -c16 /dev/urandom | od -An -tx1 | tr -d ' \n')}"
CONSOLE_TOKEN="${CONSOLE_TOKEN:-$(head -c16 /dev/urandom | od -An -tx1 | tr -d ' \n')}"
export CONFIG_WEB_TOKEN CONSOLE_TOKEN

# config-web (7717) — background. In-container it also answers the Console's server-side
# reachability probe at 127.0.0.1:7717, so the Config status dot reads correctly.
CONFIG_WEB_HOST=0.0.0.0 CONFIG_WEB_PORT=7717 \
  node --import tsx packages/config-web/src/bin.ts &

# The unified Console (7716) — foreground = the container's main process. Its framed
# surface URLs must be reachable from the user's BROWSER (the published host ports), so
# they use 127.0.0.1, not the in-container bind host. Chat/Inspector point at the runtime.
export CONSOLE_HOST=0.0.0.0
export CONSOLE_PORT=7716
export CONFIG_WEB_URL="http://127.0.0.1:7717/?token=${CONFIG_WEB_TOKEN}"
export WEB_CHAT_URL="${WEB_CHAT_URL:-http://127.0.0.1:7718}"
export INSPECTOR_URL="${INSPECTOR_URL:-http://127.0.0.1:7719}"
exec node --import tsx packages/console/src/bin.ts
