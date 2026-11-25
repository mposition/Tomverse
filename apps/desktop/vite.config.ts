import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export default defineConfig({
  base: "./",
  resolve: { alias: { "@": resolve(fileURLToPath(new URL("../../", import.meta.url))) } },
  build: {
    outDir: "dist/renderer", target: "es2023",
    license: { fileName: "renderer-notices.md" },
  },
});
