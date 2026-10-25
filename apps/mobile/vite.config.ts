import { defineConfig, loadEnv } from "vite";

/**
 * No plugins on purpose.
 *
 * Vite's own esbuild transform handles TSX through the `react-jsx` runtime
 * configured in tsconfig.json, so `@vitejs/plugin-react` would add a root
 * dependency for fast refresh this spike does not need. Every dependency added
 * for a spike is one the lockfile carries afterwards.
 *
 * `base: "./"` matters: Capacitor serves the bundle from the app's own origin
 * (capacitor://localhost on iOS, https://localhost on Android) and absolute
 * asset paths resolve differently between the two. Relative paths work on both
 * and in `vite preview`.
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");
  let returnOrigin: URL | null = null;
  try { returnOrigin = new URL(env.VITE_MOBILE_AUTH_APP_LINK_ORIGIN ?? ""); } catch {}
  if (env.VITE_MOBILE_AUTH_APP_LINKS_ENABLED === "true" && (!returnOrigin || returnOrigin.protocol !== "https:" ||
      returnOrigin.username || returnOrigin.password || returnOrigin.port || returnOrigin.pathname !== "/" || returnOrigin.search || returnOrigin.hash)) {
    throw new Error("VITE_MOBILE_AUTH_APP_LINK_ORIGIN must be an exact HTTPS origin when mobile auth app links are enabled.");
  }
  return {
    base: "./",
    build: {
      outDir: "dist",
      // A local bundle ships to a store; a source map in the binary publishes the
      // source. The web app's own Sentry upload path is separate and unaffected.
      sourcemap: false,
      target: "es2022",
    },
  };
});
