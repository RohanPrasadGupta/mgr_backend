# MoneyMgr API. Build context = the repo root (pnpm workspace):
#   docker build -f apps/api/Dockerfile -t moneymgr-api .
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /src
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter @moneymgr/api build \
 && pnpm --filter @moneymgr/api deploy --prod --legacy /out \
 && cp -r apps/api/dist apps/api/drizzle /out/

FROM node:22-alpine
ENV NODE_ENV=production PORT=8000 UPLOAD_DIR=/data/uploads
WORKDIR /app
COPY --from=build --chown=node:node /out ./
RUN mkdir -p /data/uploads && chown node:node /data/uploads
USER node
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8000/openapi.json').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
# Migrations are idempotent: every start brings the schema up to date before serving.
CMD ["sh", "-c", "node dist/migrate.js && exec node dist/main.js"]
