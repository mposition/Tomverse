import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import { createOfflineChatCsp } from "../../lib/csp";
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  publicDir: "../../public",
  esbuild: { jsx: "automatic" },
  plugins: [{ name: "chat-fixture", configureServer(server) { server.middlewares.use((request, response, next) => { if (request.url === "/chat-offline.html") response.setHeader("Content-Security-Policy", createOfflineChatCsp()); if (request.url === "/chat") request.url = "/"; next(); }); } }],
  server: { host: "127.0.0.1", port: 5187, strictPort: true, fs: { allow: [fileURLToPath(new URL("../..", import.meta.url))] } },
});
