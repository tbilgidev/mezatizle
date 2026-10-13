FROM oven/bun:1.4 AS build
WORKDIR /app
COPY package.json bun.lockb* ./
COPY apps/web/package.json apps/web/
RUN bun install --frozen-lockfile || bun install
COPY apps/web apps/web
WORKDIR /app/apps/web
RUN bun run build

FROM oven/bun:1.4
WORKDIR /app
COPY --from=build /app/apps/web/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY apps/web/package.json ./
EXPOSE 43128
CMD ["bunx", "vite", "preview", "--host", "0.0.0.0", "--port", "43128"]
