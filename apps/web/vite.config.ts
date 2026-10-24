import path from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/**
 * Funnel: https://…ts.net/mezatizle → :43128 (Tailscale path prefix is STRIPPED).
 * Vite base /mezatizle/ so the browser requests /mezatizle/... (not Ozy root).
 * Re-attach the stripped prefix on the Vite/preview server.
 *
 * For Funnel exposure prefer `bun run scripts/serve-web.ts` (production dist).
 */
const BASE = process.env.MEZATIZLE_VITE_BASE ?? "/mezatizle/";
const BASE_NO_SLASH = BASE.replace(/\/$/, "") || "/mezatizle";
const apiTarget = process.env.VITE_PROXY_API ?? "http://127.0.0.1:43127";

function funnelBasePlugin(): Plugin {
  const rewrite = (req: { url?: string }, _res: unknown, next: () => void) => {
    const raw = req.url ?? "/";
    const pathOnly = raw.split("?", 1)[0] ?? "/";
    if (pathOnly === BASE_NO_SLASH || pathOnly.startsWith(`${BASE_NO_SLASH}/`)) {
      next();
      return;
    }
    const q = raw.includes("?") ? raw.slice(raw.indexOf("?")) : "";
    req.url = `${BASE_NO_SLASH}${pathOnly === "/" ? "/" : pathOnly}${q}`;
    next();
  };
  return {
    name: "mezatizle-funnel-base",
    configureServer(server) {
      server.middlewares.use(rewrite);
    },
    configurePreviewServer(server) {
      server.middlewares.use(rewrite);
    },
  };
}

const proxy = {
  "/api": {
    target: apiTarget,
    changeOrigin: true,
  },
  [`${BASE_NO_SLASH}/api`]: {
    target: apiTarget,
    changeOrigin: true,
    rewrite: (p: string) => p.replace(new RegExp(`^${BASE_NO_SLASH}`), ""),
  },
};

export default defineConfig({
  base: BASE,
  plugins: [react(), tailwindcss(), funnelBasePlugin()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    host: "127.0.0.1",
    port: 43128,
    allowedHosts: true,
    hmr: {
      protocol: "wss",
      clientPort: 443,
      path: `${BASE_NO_SLASH}/`,
    },
    origin: process.env.MEZATIZLE_ORIGIN ?? "https://tolga-mini.tailf479ba.ts.net",
    proxy,
  },
  preview: {
    host: "127.0.0.1",
    port: 43128,
    allowedHosts: true,
    proxy,
  },
});
