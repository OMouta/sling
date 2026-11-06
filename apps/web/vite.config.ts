import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const server = process.env.SLING_SERVER_URL ?? "http://localhost:8080";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // A second dev server on the same checkout, such as a preview on another
  // port, keeps its own prebundled dependencies. Sharing them lets one swap
  // them out under the other, and the page then loads two copies of React.
  cacheDir: process.env.SLING_VITE_CACHE_DIR ?? "node_modules/.vite",
  server: {
    port: 5173,
    // In development the browser talks to Vite, which forwards API and Runner
    // traffic to the control plane.
    proxy: {
      "/api": { target: server, ws: true },
      "/runner": { target: server, ws: true },
      "/healthz": server,
      "/install.sh": server,
      "/install.ps1": server,
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
