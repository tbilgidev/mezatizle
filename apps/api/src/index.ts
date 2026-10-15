import { Hono } from "hono";
import { cors } from "hono/cors";
import { createSql, migrate } from "@mezatizle/db";
import { loadEnv } from "./lib/env.ts";
import { ensureStorageDirs } from "./lib/storage.ts";
import { recordingsRoutes } from "./routes/recordings.ts";
import { salesRoutes } from "./routes/sales.ts";
import { commentsRoutes } from "./routes/comments.ts";
import { metaRoutes } from "./routes/meta.ts";
import { reportsRoutes } from "./routes/reports.ts";
import { workerLoop } from "./worker.ts";
import { liveCaptureLoop } from "./modules/live_capture.ts";

const env = loadEnv();
await ensureStorageDirs(env.storageRoot);
await migrate(env.databaseUrl);

const sql = createSql(env.databaseUrl);
const app = new Hono();

app.use(
  "*",
  cors({
    origin:
      env.corsOrigin === "*"
        ? "*"
        : env.corsOrigin.split(",").map((s) => s.trim()),
    allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  }),
);

app.route("/api", metaRoutes(sql, env));
app.route("/api/recordings", recordingsRoutes(sql, env));
app.route("/api/sales", salesRoutes(sql));
app.route("/api/comments", commentsRoutes(sql));
app.route("/api/reports", reportsRoutes(sql));

app.get("/", (c) =>
  c.json({
    name: "mezatizle",
    docs: "See README.md",
    health: "/api/health",
  }),
);

const embeddedWorker = process.env.EMBEDDED_WORKER !== "0";
if (embeddedWorker) {
  workerLoop().catch((e) => console.error("[embedded-worker]", e));
}
if (process.env.LIVE_CAPTURE_SUPERVISOR !== "0") {
  liveCaptureLoop(sql, env).catch((e) => console.error("[live-capture]", e));
}

console.log(
  `[api] listening http://${env.host}:${env.port} profile=${env.profile.profile}`,
);

export default {
  port: env.port,
  hostname: env.host,
  fetch: app.fetch,
};

export { app };
