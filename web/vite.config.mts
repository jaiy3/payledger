import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "url";

const root = fileURLToPath(new URL(".", import.meta.url));
const api = "http://localhost:4100";

export default defineConfig({
  root,
  plugins: [react()],
  build: { outDir: fileURLToPath(new URL("../dist/web", import.meta.url)), emptyOutDir: true },
  server: {
    port: 5180,
    proxy: { "/v1": api, "/docs": api, "/openapi.json": api, "/health": api },
  },
});
