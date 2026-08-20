import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";
import { VitePWA } from "vite-plugin-pwa";

import { pwaOptions } from "./vite.pwa.config";

const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL("./package.json", import.meta.url)), "utf8"),
);

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const serverPort = parseInt(env.PORT || "3101", 10);
  const clientPort = parseInt(env.VITE_PORT || String(serverPort - 1), 10);

  return {
    plugins: [react(), tsconfigPaths(), VitePWA(pwaOptions)],
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
    },
    server: {
      port: clientPort,
      host: true,
      proxy: {
        "/api": {
          target: `http://localhost:${serverPort}`,
          changeOrigin: true,
        },
        // The web manifest is rendered by Express from APP_NAME, so the dev
        // server has to proxy it too or the install metadata 404s.
        "/manifest.webmanifest": {
          target: `http://localhost:${serverPort}`,
          changeOrigin: true,
        },
      },
    },
    build: {
      outDir: "dist/client",
      rollupOptions: {
        output: {
          // Monaco is bundled rather than CDN-loaded (see utils/monaco-setup.ts)
          // and dwarfs the app itself. Splitting it out keeps it cached across
          // app deploys instead of being invalidated by every release.
          manualChunks(id: string) {
            if (id.includes("node_modules/monaco-editor")) return "monaco";
          },
        },
      },
    },
  };
});
