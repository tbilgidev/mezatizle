import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Funnel: https://…ts.net/mezatizle → :43128 (Tailscale path prefix is STRIPPED).
 * Vite base /mezatizle/ so the browser requests /mezatizle/@vite/client (not Ozy root).
 * Re-attach the stripped prefix on the Vite server.
 */
const BASE = process.env.MEZATIZLE_VITE_BASE ?? "/mezatizle/";
const BASE_NO_SLASH = BASE.replace(/\/$/, "") || "/mezatizle";
const apiTarget = process.env.VITE_PROXY_API ?? "http://127.0.0.1:43127";

function funnelBasePlugin(): Plugin {
  return {
    name: "mezatizle-funnel-base",
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        const raw = req.url ?? "/";
        const pathOnly = raw.split("?", 1)[0] ?? "/";
        if (pathOnly === BASE_NO_SLASH || pathOnly.startsWith(`${BASE_NO_SLASH}/`)) {
          next();
          return;
        }
        const q = raw.includes("?") ? raw.slice(raw.indexOf("?")) : "";
        req.url = `${BASE_NO_SLASH}${pathOnly === "/" ? "/" : pathOnly}${q}`;
        next();
      });
    },
  };
}

export default defineConfig({
  base: BASE,
  plugins: [react(), funnelBasePlugin()],
  server: {
    host: "127.0.0.1",
    port: 43128,
    allowedHosts: true,
    proxy: {
      "/api": {
        target: apiTarget,
        changeOrigin: true,
      },
      [`${BASE_NO_SLASH}/api`]: {
        target: apiTarget,
        changeOrigin: true,
        rewrite: (p) => p.replace(new RegExp(`^${BASE_NO_SLASH}`), ""),
      },
    },
  },
  preview: {
    host: "127.0.0.1",
    port: 43128,
    allowedHosts: true,
    proxy: {
      "/api": {
        target: apiTarget,
        changeOrigin: true,
      },
      [`${BASE_NO_SLASH}/api`]: {
        target: apiTarget,
        changeOrigin: true,
        rewrite: (p) => p.replace(new RegExp(`^${BASE_NO_SLASH}`), ""),
      },
    },
  },
});
