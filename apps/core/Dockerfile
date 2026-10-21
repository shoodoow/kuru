# The core server. Build from the repository root:
#   docker build -f apps/core/Dockerfile -t kuru-core .
# The image keeps the repository layout because the core reads prompts/,
# skills/ and apps/core/drizzle/ by their paths relative to its own files.

FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
# Manifests first, so the install layer is reused until a dependency changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/core/package.json apps/core/
COPY apps/mobile/package.json apps/mobile/
COPY apps/desktop/package.json apps/desktop/
COPY packages/shared/package.json packages/shared/
COPY packages/agent-tools/package.json packages/agent-tools/
RUN pnpm install --frozen-lockfile --filter "core..."
COPY tsconfig.json tsconfig.base.json ./
COPY packages/shared packages/shared
COPY packages/agent-tools packages/agent-tools
COPY apps/core apps/core
RUN pnpm --filter @kuru/shared build \
  && pnpm --filter @kuru/agent-tools build \
  && pnpm --filter core build
# Drop compilers and test tools from what the final image copies.
RUN CI=true pnpm install --frozen-lockfile --prod --filter "core..."

# The web and desktop app, which the server serves from its own address at
# /app. It is the phone app's code built for a browser. A stage of its own, so
# its tools (Expo, React Native) never reach the final image; only the built
# files do.
FROM node:24-bookworm-slim AS web
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/core/package.json apps/core/
COPY apps/mobile/package.json apps/mobile/
COPY apps/desktop/package.json apps/desktop/
COPY packages/shared/package.json packages/shared/
COPY packages/agent-tools/package.json packages/agent-tools/
RUN pnpm install --frozen-lockfile --filter "mobile..."
COPY tsconfig.json tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/mobile apps/mobile
RUN pnpm --filter @kuru/shared build && pnpm --filter mobile build:web

FROM node:24-bookworm-slim
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
WORKDIR /app
COPY --from=build /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/packages packages
COPY --from=build /app/apps/core/package.json apps/core/package.json
COPY --from=build /app/apps/core/node_modules apps/core/node_modules
COPY --from=build /app/apps/core/dist apps/core/dist
COPY --from=build /app/apps/core/drizzle apps/core/drizzle
COPY --from=web /app/apps/mobile/dist-web apps/mobile/dist-web
COPY prompts prompts
COPY skills skills
WORKDIR /app/apps/core
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=6 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
# Runs as root on purpose: the core drives Docker through the mounted socket,
# and access to that socket is already full control of the host.
CMD ["sh", "-c", "node dist/db/migrate.js && exec node dist/main.js"]
