FROM node:22-bookworm-slim@sha256:53ada149d435c38b14476cb57e4a7da73c15595aba79bd6971b547ceb6d018bf AS build

WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/core/package.json apps/core/package.json
RUN npm ci

COPY apps/core/src apps/core/src
COPY apps/core/tsconfig.json apps/core/tsconfig.json
COPY apps/core/tsconfig.build.json apps/core/tsconfig.build.json
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim@sha256:53ada149d435c38b14476cb57e4a7da73c15595aba79bd6971b547ceb6d018bf AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/apps/core/package.json apps/core/package.json
COPY --from=build --chown=node:node /app/apps/core/dist apps/core/dist
COPY --chown=node:node apps/core/migrations apps/core/migrations
COPY --chown=node:node deploy/pilot/verify-local-embedding.mjs /opt/iris/verify-local-embedding.mjs

USER node
STOPSIGNAL SIGTERM
CMD ["node", "apps/core/dist/app.js"]
