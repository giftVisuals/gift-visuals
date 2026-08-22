# The render pipeline shells out to real ffmpeg/ffprobe binaries — Railway's
# Nixpacks/Railpack auto-detection was not reliably installing them, so this
# Dockerfile takes full, explicit control of what's in the runtime image.
# Railway auto-detects a Dockerfile at the repo root and builds with it.
FROM node:20-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
CMD ["node", "server.js"]
