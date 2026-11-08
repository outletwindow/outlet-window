FROM node:22-bookworm-slim AS build
WORKDIR /workspace
RUN corepack enable
COPY . .
RUN pnpm install --no-frozen-lockfile
RUN pnpm build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /workspace
RUN corepack enable && groupadd --system outlet && useradd --system --gid outlet --home-dir /workspace outlet
COPY --from=build --chown=outlet:outlet /workspace /workspace
USER outlet
EXPOSE 3000
CMD ["node", "dist/apps/api/src/server.js"]
