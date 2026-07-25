# One image, fifteen services.
#
# Every service shares the same dependency tree and differs only in which
# main.ts it runs, so building fifteen near-identical images would mean
# fifteen npm installs, fifteen layer caches, and fifteen chances for them
# to drift apart. The service is chosen at RUN time via SERVICE_MAIN.
#
# Build:  docker build -f infra/docker/Dockerfile -t besonc:dev .
# Run:    docker run -e SERVICE_MAIN=apps/svc-identity/src/main.ts besonc:dev

# ---------------------------------------------------------------------
# deps — cached independently of source changes
# ---------------------------------------------------------------------
FROM node:20-alpine AS deps
WORKDIR /app

# Copy ONLY the manifests first. Source edits then don't invalidate the
# npm layer, which is the difference between a 4-second and a 90-second
# rebuild on every commit.
#
# The `workspaces` entry in package.json currently matches no manifests
# (libs/ and apps/ have none of their own), so `npm ci` resolves a single
# flat tree from the root lockfile. If per-package manifests are added
# later, copy them here BEFORE this step or the cache stops working.
COPY package.json package-lock.json ./

# NOT --omit=optional: esbuild ships its native binary (@esbuild/linux-x64)
# as an optional platform dependency, and tsx cannot transform anything
# without it. Omitting optionals builds a smaller image that immediately
# dies with "The package @esbuild/linux-x64 could not be found".
RUN npm ci

# ---------------------------------------------------------------------
# runtime
# ---------------------------------------------------------------------
FROM node:20-alpine AS runtime
WORKDIR /app

# tini reaps zombies and forwards signals. Without it PID 1 is node, which
# ignores SIGTERM by default in some shells and Kubernetes then SIGKILLs
# the pod mid-request instead of letting it drain.
RUN apk add --no-cache tini curl

ENV NODE_ENV=production
ENV NODE_OPTIONS=--enable-source-maps

COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json tsconfig.base.json ./
COPY libs ./libs
COPY apps ./apps

# Never run as root. A compromised media service should not own the
# filesystem it is running on.
RUN addgroup -S besonc && adduser -S besonc -G besonc && chown -R besonc:besonc /app
USER besonc

# Which service this container is. Set per-deployment.
ENV SERVICE_MAIN=apps/gateway/src/main.ts
ENV PORT=3000

EXPOSE 3000

# The probe reads $PORT so one image works for every service.
HEALTHCHECK --interval=15s --timeout=3s --start-period=25s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/health" || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["sh", "-c", "exec node --import tsx \"$SERVICE_MAIN\""]
