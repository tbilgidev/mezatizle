/**
 * Production web server for Tailscale Funnel path /mezatizle.
 * Serves apps/web/dist under /mezatizle/, proxies /api → API :43127,
 * SPA fallback to index.html. No Vite HMR (avoids blank pages via Funnel).
 *
 * Usage: bun run scripts/serve-web.ts
 */
import { join, normalize, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { stat } from "node:fs/promises";

const ROOT = join(fileURLToPath(new URL("..", import.meta.url)));
const DIST = join(ROOT, "apps/web/dist");
const BASE = (process.env.MEZATIZLE_PUBLIC_PATH || "/mezatizle").replace(/\/$/, "") || "/mezatizle";
const PORT = Number(process.env.MEZATIZLE_WEB_PORT || "43128");
const API = (process.env.VITE_PROXY_API || "http://127.0.0.1:43127").replace(/\/$/, "");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json",
};

function stripBase(pathname: string): string {
  if (pathname === BASE || pathname === `${BASE}/`) return "/";
  if (pathname.startsWith(`${BASE}/`)) return pathname.slice(BASE.length) || "/";
  return pathname;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isFile();
  } catch {
    return false;
  }
}

async function proxyApi(req: Request, apiPath: string): Promise<Response> {
  const url = new URL(req.url);
  const target = `${API}${apiPath}${url.search}`;
  const headers = new Headers(req.headers);
  headers.delete("host");
  const init: RequestInit = {
    method: req.method,
    headers,
    redirect: "manual",
  };
  if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = await req.arrayBuffer();
  }
  try {
    const upstream = await fetch(target, init);
    return new Response(upstream.body, {
      status: upstream.status,
      headers: upstream.headers,
    });
  } catch (err) {
    // Never fall through to SPA HTML for /api — UI would parse HTML as empty lists.
    const detail = err instanceof Error ? err.message : String(err);
    return Response.json(
      {
        error: `API erişilemiyor (${API}). Bir an sonra yenileyin.`,
        detail,
      },
      { status: 502 },
    );
  }
}

async function serveStatic(relPath: string): Promise<Response | null> {
  const clean = normalize(relPath).replace(/^(\.\.(\/|\\|$))+/, "");
  const candidate = join(DIST, clean === "/" ? "index.html" : clean.replace(/^\//, ""));
  if (!candidate.startsWith(DIST)) return new Response("Forbidden", { status: 403 });
  if (!(await fileExists(candidate))) return null;
  const ext = extname(candidate).toLowerCase();
  return new Response(Bun.file(candidate), {
    headers: {
      "content-type": MIME[ext] || "application/octet-stream",
      "cache-control": ext === ".html" ? "no-cache" : "public, max-age=31536000, immutable",
    },
  });
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    let pathname = decodeURIComponent(url.pathname);

    // Funnel strips /mezatizle → requests arrive as / or /assets/... or /api/...
    // Also accept full /mezatizle/... if something preserves the prefix.
    if (pathname === BASE || pathname.startsWith(`${BASE}/`)) {
      pathname = stripBase(pathname);
    }

    if (pathname === "/api" || pathname.startsWith("/api/")) {
      return proxyApi(req, pathname);
    }

    if (pathname === "/" || pathname === "") {
      return (await serveStatic("/index.html"))!;
    }

    const fileRes = await serveStatic(pathname);
    if (fileRes) return fileRes;

    // SPA fallback for client routes (/recordings, /sales, ...)
    if (!extname(pathname)) {
      return (await serveStatic("/index.html"))!;
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log(
  `[mezatizle-web] http://127.0.0.1:${server.port}${BASE}/  (dist → Funnel path, api → ${API})`,
);
