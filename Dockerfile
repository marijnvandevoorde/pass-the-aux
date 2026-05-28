# Build stage: compile the browser bundle (src/web -> public/js).
FROM node:26-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.web.json ./
COPY src ./src
RUN npm run build

# Runtime stage: the server runs TypeScript directly via Node's native
# type stripping. The only runtime dep is mysql2 (STORAGE_DRIVER=mysql);
# ffmpeg is the system tool used for server-side audio analysis.
FROM node:26-alpine AS runtime
WORKDIR /app
# Build stamp — pass `--build-arg APP_VERSION=$(git rev-parse --short HEAD)`
# (the compose file does this) so the image carries the SHA it was
# built from. Without it the server falls back to a boot timestamp,
# which still changes per restart but doesn't tie back to a commit.
ARG APP_VERSION=""
ENV APP_VERSION=${APP_VERSION} \
    NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=5174 \
    MUSIC_DIR=/app/music

# ffmpeg: decodes audio for the server-side analysis (BPM/key/energy).
RUN apk add --no-cache ffmpeg

COPY package.json package-lock.json server.ts ./
# Only the sanctioned runtime dep (mysql2); devDependencies excluded.
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
COPY --from=build /app/public/js ./public/js

RUN addgroup -S app && adduser -S app -G app && chown -R app:app /app
USER app

EXPOSE 5174
CMD ["node", "server.ts"]
