# hadrontool-websearch — stateless web search capability tool.
#
# Built by Komodo from this repo's `main`, pushed to GHCR, deployed on the
# `komodo_default` network as an INTERNAL-ONLY service: no Traefik router, no
# public DNS. hadron-server reaches it by container name at
# http://hadrontool-websearch:8080. Secrets are injected at runtime by Doppler
# (`doppler run --`), matching the other services — Komodo sets only
# DOPPLER_TOKEN.

FROM node:22-slim

WORKDIR /app

# Doppler CLI for runtime secret injection (same pattern as the other services).
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
  && curl -sLf --retry 3 --tlsv1.2 --proto '=https' 'https://cli.doppler.com/install.sh' | sh \
  && apt-get purge -y curl gnupg && apt-get autoremove -y \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PORT=8080

# Reproducible install from the committed lockfile, then compile and drop dev
# deps. --include=dev is required because NODE_ENV=production (set above)
# would otherwise make `npm ci` skip devDependencies (typescript/tsx) and the
# build would fail with `tsc: not found`.
#
# COPY every tsconfig the build references: `npm run build` runs
# `tsc -p tsconfig.build.json`, so that file must be in the image or the build
# fails with TS5058 (hadrontool-webfetch#3).
COPY package.json package-lock.json ./
RUN npm ci --include=dev
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

RUN chown -R node:node /app
USER node

EXPOSE 8080
# Doppler injects WEBSEARCH_TOOL_TOKEN / NODE_ENV / PORT via DOPPLER_TOKEN.
CMD ["doppler", "run", "--", "node", "dist/index.js"]
