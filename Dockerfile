# Stage 1: Build frontend
FROM node:20-alpine AS builder

ARG SENTRY_DSN_FRONTEND=""
ARG SENTRY_ENVIRONMENT="production"
ARG SENTRY_RELEASE="dev"

ENV VITE_SENTRY_DSN=${SENTRY_DSN_FRONTEND}
ENV VITE_SENTRY_ENVIRONMENT=${SENTRY_ENVIRONMENT}
ENV VITE_SENTRY_RELEASE=${SENTRY_RELEASE}

WORKDIR /app

# Build tools for native deps (sqlite3/better-sqlite3 node-gyp compilation).
# py3-setuptools needed too: Python 3.12 dropped distutils, which the bundled
# old node-gyp still imports — setuptools' vendored copy patches it back in.
RUN apk add --no-cache python3 py3-setuptools make g++

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build
# Remove sourcemaps from dist: shipped bundle has no `//# sourceMappingURL=`
# thanks to `sourcemap: 'hidden'`, but `.map` files still emitted — drop them.
RUN find dist -name '*.map' -delete

# Stage 2: Production
FROM node:20-alpine

# Build tools for better-sqlite3 native compilation
RUN apk add --no-cache python3 py3-setuptools make g++

WORKDIR /app

# Production dependencies (includes better-sqlite3 native build)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && apk del python3 make g++

# Server code — every root-level .cjs. Do NOT list them one by one: a new root
# module would silently miss the image and fail with MODULE_NOT_FOUND at runtime.
COPY *.cjs ./
COPY db/ ./db/
COPY auth.mjs seed-admin.mjs ./
COPY lib/ ./lib/
COPY middleware/ ./middleware/
COPY routes/ ./routes/
COPY scripts/ ./scripts/
COPY public/ ./public/
COPY docs/ru/user-guide.md ./docs/ru/user-guide.md
COPY index.html ./

# Built frontend from stage 1
COPY --from=builder /app/dist ./dist

# Data directories
RUN mkdir -p /app/data /app/uploads

ENV NODE_ENV=production
ENV PORT=3001
ENV DB_PATH=/app/data/repricer.db
ENV UPLOAD_DIR=/app/uploads

EXPOSE 3001

CMD ["node", "server.cjs"]
