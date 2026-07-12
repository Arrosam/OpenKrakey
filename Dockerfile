# OpenKrakey — minimalist microkernel autonomous-agent framework.
#
# The runtime executes TypeScript directly via `tsx` (there is NO build step:
# `npm start` runs `tsx packages/boot/src/index.ts`). So the image ships source +
# node_modules (tsx is required at runtime, hence a full `npm ci`, not --omit=dev).
#
# Debian-slim (glibc) base: tsx bundles esbuild, whose native binary needs glibc —
# Alpine/musl would need the musl esbuild variant. Node >=22 per package.json engines.
FROM node:22-bookworm-slim

# Small init so PID 1 reaps zombies and forwards SIGTERM/SIGINT to Node, which
# boot handles for graceful agent teardown (see packages/boot/src/index.ts).
RUN apt-get update \
  && apt-get install -y --no-install-recommends tini \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# --- dependency layer (cached until package files change) ---
COPY package.json package-lock.json ./
RUN npm ci

# --- application source (see .dockerignore for what is excluded) ---
COPY . .

# Surfaces bind loopback (127.0.0.1) by default, which is NOT reachable from
# outside the container. Bind the console + config UI to all interfaces so a
# published port works. (web-chat 7718 + inspector 7719 read their host from the
# AGENT config — set "host": "0.0.0.0" there to expose them; see README/compose.)
ENV CONSOLE_HOST=0.0.0.0 \
    CONFIG_WEB_HOST=0.0.0.0

# console 7716 · config-web 7717 · web-chat 7718 · inspector 7719
EXPOSE 7716 7717 7718 7719

# Drop privileges: run as the image's built-in unprivileged `node` user. Bind-
# mounted config/agents dirs must be writable by uid 1000 (see README notes).
RUN chown -R node:node /app
USER node

# tini as PID 1 → correct signal handling & zombie reaping in a long-running agent.
ENTRYPOINT ["tini", "--"]

# Default: boot the agent runtime (reads agents/<id>/config.json + config/llm.json).
# Override for other entry points, e.g.:
#   docker run … openkrakey npm run cli            # guided setup (interactive)
#   docker run … openkrakey npm run config:web     # config web UI only
CMD ["npm", "start"]
