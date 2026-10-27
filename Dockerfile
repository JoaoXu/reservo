# Reservo: one small image runs the web app, the worker and migrations.
# Node runs the TypeScript sources directly (type stripping), so there is no
# build step and nothing to transpile.
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi && npm cache clean --force

FROM node:22-alpine
ENV NODE_ENV=production \
    PORT=8080 \
    NODE_OPTIONS="--disable-warning=ExperimentalWarning --max-old-space-size=384"
WORKDIR /app
# tini forwards SIGTERM so in-flight requests finish during deploys
RUN apk add --no-cache tini
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY scripts ./scripts
COPY migrations ./migrations
COPY clients ./clients
COPY public ./public
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/server.ts"]
# Worker:     docker run ... node src/worker.ts
# Migrations: docker run ... node scripts/migrate.ts
