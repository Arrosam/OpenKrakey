# OpenKrakey — minimalist microkernel autonomous-agent framework.
#
# The runtime executes TypeScript directly via `tsx` (there is NO build step). So
# the image ships source + node_modules (tsx is required at runtime, hence a full
# `npm ci`, not --omit=dev).
#
# Debian-slim (glibc) base: tsx bundles esbuild, whose native binary needs glibc —
# Alpine/musl would need the musl esbuild variant. Node >=22 per package.json engines.
FROM node:22-bookworm-slim

# tini as PID 1: reaps zombies and forwards SIGTERM/SIGINT straight to Node (we exec
# node directly below — not through npm — so the agent runtime's graceful shutdown works).
RUN apt-get update \
  && apt-get install -y --no-install-recommends tini \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# --- dependency layer (cached until package files change) ---
COPY package.json package-lock.json ./
RUN npm ci

# --- application source (see .dockerignore for what is excluded) ---
COPY . .

# Web surfaces bind loopback (127.0.0.1) by default, which is NOT reachable through a
# published container port. Bind all interfaces in-container so `-p` works. (web-chat
# 7718 + inspector 7719 read their host from the AGENT config — set "host": "0.0.0.0"
# there to expose them; the setup UI below writes that for you.)
ENV CONFIG_WEB_HOST=0.0.0.0 \
    CONSOLE_HOST=0.0.0.0

# console 7716 · config-web 7717 · web-chat 7718 · inspector 7719
EXPOSE 7716 7717 7718 7719

# Drop privileges to the image's built-in unprivileged `node` user.
RUN chown -R node:node /app
USER node

# tini -g forwards signals to the whole process group, so BOTH dashboard processes
# (Console + config-web, started by the entrypoint) get SIGTERM on `docker stop`.
ENTRYPOINT ["tini", "-g", "--"]

# DEFAULT = the unified Console DASHBOARD (the landing page), NOT the agent runtime.
# A fresh install has no agents, so first contact is the dashboard: one shell framing
# Config (the setup wizard), Chat and Inspector. The entrypoint runs the Console (7716)
# + config-web (7717) together and prints a tokened
# `http://127.0.0.1:7716/?token=…` Console URL — open it to add a provider + agent.
# (The runtime `npm start` would just print "No agents yet" and exit, which is why it
# is not the default.)
#
# Once configured, run the agent runtime instead (override the command):
#   docker run … ghcr.io/arrosam/openkrakey node --import tsx packages/boot/src/index.ts
CMD ["sh", "docker/dashboard-entrypoint.sh"]
