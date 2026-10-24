import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const sha = (process.env.VERCEL_GIT_COMMIT_SHA || process.env.RAILWAY_GIT_COMMIT_SHA || "local").slice(0, 7);

export default defineConfig({
  define: { __BUILD_ID__: JSON.stringify(sha) },
  plugins: [react(), tailwindcss()],
  server: { port: 5173 },
  build: { target: "es2020" },
});
