import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const server = process.env.SLING_SERVER_URL ?? "http://localhost:8080";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // In development the browser talks to Vite, which forwards API and Runner
    // traffic to the control plane.
    proxy: {
      "/api": { target: server, ws: true },
      "/runner": { target: server, ws: true },
      "/healthz": server,
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
