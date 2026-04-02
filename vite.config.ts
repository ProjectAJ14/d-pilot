import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [react(), tsconfigPaths()],
  server: {
    port: 3100,
    proxy: {
      "/api": {
        target: "http://localhost:3101",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist/client",
  },
});
