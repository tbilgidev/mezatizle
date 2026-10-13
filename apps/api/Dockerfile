FROM oven/bun:1.4 AS deps
WORKDIR /app
COPY package.json bun.lockb* ./
COPY apps/api/package.json apps/api/
COPY packages/db/package.json packages/db/
COPY packages/shared/package.json packages/shared/
RUN bun install --frozen-lockfile || bun install

FROM oven/bun:1.4
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV STORAGE_ROOT=/data/storage
EXPOSE 43127
CMD ["bun", "run", "apps/api/src/index.ts"]
