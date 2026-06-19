import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

/** Always resolve `.env*` next to this config, not `process.cwd()` (running Vite from repo root breaks the latter). */
const configDir = path.dirname(fileURLToPath(import.meta.url));

const proxyRoute = (target, extra = {}) => ({
  target,
  changeOrigin: true,
  ...extra,
});

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, configDir, "");
  const target =
    process.env.P4KVM_PROXY_TARGET ||
    env.P4KVM_PROXY_TARGET ||
    "http://192.168.4.1";

  return {
    plugins: [viteSingleFile()],
    build: {
      outDir: "dist",
      emptyOutDir: true,
      assetsInlineLimit: 100000000,
      /* Terser incorrectly folded queueMouseAbs (dropped rAF coalescing). esbuild is fine here. */
      minify: "esbuild",
      cssMinify: true,
    },
    server: {
      proxy: {
        "/stream": proxyRoute(target, { timeout: 0 }),
        "/jpeg-quality": proxyRoute(target),
        "/ws": proxyRoute(target, {
          ws: true,
          /* Some embedded WS stacks reject Origin: http://localhost:5173 */
          rewriteWsOrigin: true,
          configure(proxy) {
            proxy.on("proxyReqWs", (proxyReq) => {
              /* http-proxy may forward Connection: close; WS upgrade requires Upgrade. */
              proxyReq.setHeader("Connection", "Upgrade");
            });
          },
        }),
      },
    },
  };
});
