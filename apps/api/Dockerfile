# syntax=docker/dockerfile:1.7
# CL Buddy API (Fastify + Prisma). Build from the repository root:
#   docker build -f apps/api/Dockerfile -t clbuddy-api .
# Behind a TLS-intercepting corporate proxy, pass its CA as a build secret (never stored in the image):
#   docker build --secret id=npm_ca,src=/path/to/ca.pem -f apps/api/Dockerfile .

# Full Debian image: ships OpenSSL (needed by Prisma) and CA certificates, so no apt step is needed.
FROM node:22-bookworm AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
# The shared package is built by its own "prepare" script during install, so copy it in full.
COPY packages/shared packages/shared
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY prisma prisma
RUN --mount=type=secret,id=npm_ca,required=false \
    if [ -f /run/secrets/npm_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/npm_ca npm_config_cafile=/run/secrets/npm_ca; fi; \
    npm ci --no-audit --no-fund
COPY apps/api apps/api
RUN npm run build -w @clbuddy/api

FROM node:22-bookworm
WORKDIR /app
ENV NODE_ENV=production
# Dependencies include the Prisma CLI (migrations) and tsx (demo seed / mock model).
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/package.json /app/tsconfig.base.json ./
COPY --from=build /app/prisma prisma
COPY --from=build /app/packages/shared packages/shared
COPY --from=build /app/apps/api apps/api
WORKDIR /app/apps/api
RUN mkdir -p data/uploads && chown -R node:node data
USER node
EXPOSE 4000
# Apply database migrations, then start the API.
CMD ["sh", "-c", "npx prisma migrate deploy --schema ../../prisma/schema.prisma && node dist/server.js"]
