# The Highland ops image: backups, restore tests, checks and updates. No secrets: all settings arrive as environment variables.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY packages/shared/package.json packages/shared/
COPY modules/ocr/package.json modules/ocr/
COPY modules/pdf-export/package.json modules/pdf-export/
COPY modules/xlsx-export/package.json modules/xlsx-export/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY ops/package.json ops/
RUN npm ci --ignore-scripts
# app-profile.json says whether "scheduled-jobs" is on: without it ops runs none of the app's jobs.
COPY tsconfig.base.json foundation.json app-profile.json ./
COPY packages packages
# Ops records its runs in the app's database through the server's schema (apps/server/src/db) and runs the app's scheduled
# jobs (apps/server/src/jobs), so it builds the server too, and the modules the server uses.
COPY modules modules
COPY apps/server apps/server
COPY ops ops
RUN npm run build --if-present -w @hf/ops \
 && npm prune --omit=dev --ignore-scripts \
 && rm -rf node_modules/@napi-rs/canvas node_modules/@napi-rs/canvas-*

FROM node:22-bookworm-slim
ARG APP_VERSION=0.0.0-dev
ARG GIT_COMMIT=unknown
ARG RESTIC_VERSION=0.18.1
ARG DOCKER_KEY_FPR=9DC858229FC7DD38854AE2D88D81803C0EBFCD88
ARG PGDG_KEY_FPR=B97B0AFCAA1A47F044F244A07FCC7D46ACCC4CF8
ARG RESTIC_SHA256=680838f19d67151adba227e1570cdd8af12c19cf1735783ed1ba928bc41f363d
ENV NODE_ENV=production
LABEL org.opencontainers.image.title="highland-ops" \
      org.opencontainers.image.version="${APP_VERSION}" \
      org.opencontainers.image.revision="${GIT_COMMIT}"
# postgresql-client-17 (to match the 17 server) and the Docker CLI with the Compose plugin (used only by the updater, which alone gets the socket).
# Each downloaded key file goes into a throwaway keyring and only the pinned fingerprint is exported to apt's keyring,
# so an extra key added to the download is never trusted (deploy/pin-apt-key.sh, tested in deploy/test/pin-apt-key.test.ts).
COPY deploy/pin-apt-key.sh /usr/local/sbin/pin-apt-key
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gnupg bzip2 \
 && install -d -m 0755 /etc/apt/keyrings \
 && curl -fsSL -o /tmp/pgdg.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc \
 && curl -fsSL -o /tmp/docker.asc https://download.docker.com/linux/debian/gpg \
 && pin-apt-key /tmp/pgdg.asc "${PGDG_KEY_FPR}" /etc/apt/keyrings/pgdg.gpg \
 && pin-apt-key /tmp/docker.asc "${DOCKER_KEY_FPR}" /etc/apt/keyrings/docker.gpg \
 && rm /tmp/pgdg.asc /tmp/docker.asc /usr/local/sbin/pin-apt-key \
 && echo "deb [signed-by=/etc/apt/keyrings/pgdg.gpg] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
 && echo "deb [signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian bookworm stable" > /etc/apt/sources.list.d/docker.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends postgresql-client-17 docker-ce-cli docker-compose-plugin \
 && curl -fsSL -o /tmp/restic.bz2 "https://github.com/restic/restic/releases/download/v${RESTIC_VERSION}/restic_${RESTIC_VERSION}_linux_amd64.bz2" \
 && echo "${RESTIC_SHA256}  /tmp/restic.bz2" | sha256sum -c - \
 && bunzip2 /tmp/restic.bz2 && install -m 0755 /tmp/restic /usr/local/bin/restic && rm /tmp/restic \
 && apt-get purge -y --auto-remove curl gnupg bzip2 \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/package.json /app/foundation.json /app/app-profile.json ./
COPY --from=build /app/packages/shared/package.json packages/shared/package.json
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/modules/ocr/package.json modules/ocr/package.json
COPY --from=build /app/modules/ocr/dist modules/ocr/dist
COPY --from=build /app/modules/pdf-export/package.json modules/pdf-export/package.json
COPY --from=build /app/modules/pdf-export/dist modules/pdf-export/dist
COPY --from=build /app/modules/xlsx-export/package.json modules/xlsx-export/package.json
COPY --from=build /app/modules/xlsx-export/dist modules/xlsx-export/dist
COPY --from=build /app/apps/server/package.json apps/server/package.json
COPY --from=build /app/apps/server/dist apps/server/dist
COPY --from=build /app/ops/package.json ops/package.json
COPY --from=build /app/ops/dist ops/dist
# Same owner as in the app image (uid/gid 1000 is `node` there), because either container may be the first to mount the uploads volume.
# /state holds the backup work folder (with a full database dump while a backup runs) and the restic cache: readable only by
# uid 1000, the user the ops daemon runs as (compose.yaml). A fresh state volume takes this owner and mode.
RUN mkdir -p /data/uploads && chown 1000:1000 /data/uploads && install -d -m 0700 -o 1000 -g 1000 /state
# An absolute path: the updater runs with its working directory set to the bundle folder (compose.yaml).
ENTRYPOINT ["node", "/app/ops/dist/cli.js"]
