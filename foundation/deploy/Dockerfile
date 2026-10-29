# The Highland app image: the server, its migrations and the built web app. No secrets: all settings arrive as environment variables.
FROM node:22-bookworm-slim AS build
WORKDIR /app
# Manifests first, so the install layer is reused until a dependency changes.
COPY package.json package-lock.json .npmrc ./
COPY packages/shared/package.json packages/shared/
COPY modules/ocr/package.json modules/ocr/
COPY modules/pdf-export/package.json modules/pdf-export/
COPY modules/xlsx-export/package.json modules/xlsx-export/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY ops/package.json ops/
RUN npm ci --ignore-scripts
# app-profile.json before the build: the web build reads it to decide which module pages it carries (no file: none).
COPY tsconfig.base.json foundation.json app-profile.json ./
COPY packages packages
COPY modules modules
COPY apps apps
# The optional modules are built before the server, which uses them. Then what the app never loads is removed, to keep the
# image small: pdfjs-dist's optional native canvas (reading a PDF's text never draws), the browser-only copies of the
# Tesseract engines (*.wasm.js, the engine inlined for a browser; Node loads a .js loader and its .wasm file, picked by the
# CPU's features: relaxed SIMD, SIMD or plain. tesseract.js 7.0.0 in Node passes a boolean where getCore expects the OEM,
# so it loads the full engines, not the -lstm ones: both kinds stay), the legacy 4.0.0 English model (local OCR reads with 4.0.0_best_int), pdfjs-dist's browser builds (the app loads only
# legacy/build/pdf.mjs and its worker) and every source map.
RUN npm run build --if-present -w @hf/shared -w @hf/ocr -w @hf/pdf-export -w @hf/xlsx-export -w @hf/server -w @hf/web \
 && npm prune --omit=dev --ignore-scripts \
 && rm -rf node_modules/@napi-rs/canvas node_modules/@napi-rs/canvas-* \
 && find node_modules/tesseract.js-core -maxdepth 1 -name 'tesseract-core*.wasm.js' -delete \
 && rm -rf node_modules/@tesseract.js-data/eng/4.0.0 \
 && rm -rf node_modules/pdfjs-dist/build node_modules/pdfjs-dist/web node_modules/pdfjs-dist/image_decoders node_modules/pdfjs-dist/types \
           node_modules/pdfjs-dist/legacy/web node_modules/pdfjs-dist/legacy/image_decoders \
 && find node_modules -name '*.map' -type f -delete

FROM node:22-bookworm-slim
ARG APP_VERSION=0.0.0-dev
ARG GIT_COMMIT=unknown
ENV NODE_ENV=production APP_VERSION=${APP_VERSION} GIT_COMMIT=${GIT_COMMIT}
LABEL org.opencontainers.image.title="highland-app" \
      org.opencontainers.image.version="${APP_VERSION}" \
      org.opencontainers.image.revision="${GIT_COMMIT}"
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
COPY --from=build /app/apps/server/drizzle apps/server/drizzle
# The demo seeder's fictional receipt photos (read from src/seed/receipts in the built app as well).
COPY --from=build /app/apps/server/src/seed/receipts apps/server/src/seed/receipts
COPY --from=build /app/apps/web/dist apps/web/dist
# Docker fills an empty named volume from this folder, owner included. Without it the uploads volume is root-owned and every upload fails.
RUN mkdir -p /data/uploads && chown node:node /data/uploads
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "apps/server/dist/main.js"]
