# The Highland app image: the server, its migrations and the built web app. No secrets: all settings arrive as environment variables.
FROM node:22-bookworm-slim AS build
WORKDIR /app
# Manifests first, so the install layer is reused until a dependency changes.
COPY package.json package-lock.json .npmrc ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY ops/package.json ops/
RUN npm ci --ignore-scripts
COPY tsconfig.base.json foundation.json ./
COPY packages packages
COPY apps apps
RUN npm run build --if-present -w @hf/shared -w @hf/server -w @hf/web \
 && npm prune --omit=dev --ignore-scripts

FROM node:22-bookworm-slim
ARG APP_VERSION=0.0.0-dev
ARG GIT_COMMIT=unknown
ENV NODE_ENV=production APP_VERSION=${APP_VERSION} GIT_COMMIT=${GIT_COMMIT}
LABEL org.opencontainers.image.title="highland-app" \
      org.opencontainers.image.version="${APP_VERSION}" \
      org.opencontainers.image.revision="${GIT_COMMIT}"
WORKDIR /app
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/package.json /app/foundation.json ./
COPY --from=build /app/packages/shared/package.json packages/shared/package.json
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/apps/server/package.json apps/server/package.json
COPY --from=build /app/apps/server/dist apps/server/dist
COPY --from=build /app/apps/server/drizzle apps/server/drizzle
COPY --from=build /app/apps/web/dist apps/web/dist
# Docker fills an empty named volume from this folder, owner included. Without it the uploads volume is root-owned and every upload fails.
RUN mkdir -p /data/uploads && chown node:node /data/uploads
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "apps/server/dist/main.js"]
