import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const serverPort = parseInt(env.PORT || "3101", 10);
  const clientPort = parseInt(env.VITE_PORT || String(serverPort - 1), 10);

  return {
    plugins: [react(), tsconfigPaths()],
    server: {
      port: clientPort,
      host: true,
      proxy: {
        "/api": {
          target: `http://localhost:${serverPort}`,
          changeOrigin: true,
        },
      },
    },
    build: {
      outDir: "dist/client",
    },
  };
});
