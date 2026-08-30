import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

/**
 * What `packages/*` may not import (PACKAGE-01,
 * docs/policy/shared-packages.md).
 *
 * These packages are the mechanism that stops the web app and the native
 * shell from becoming two products with two chat implementations. That only
 * holds while the shared half runs unchanged in all three environments --
 * the Next.js server, a plain browser bundle, and the Capacitor shell -- so
 * the rule is about *reachability*, not about Next.js alone:
 *
 *  - a framework import (`next/*`) pins the code to one client;
 *  - `server-only` pins it to the server;
 *  - `@/...` reaches back into the app, which is the same coupling wearing
 *    an alias -- a package that can import the app is not extracted;
 *  - Node builtins pin it out of the browser;
 *  - native bridges pin it to the shell.
 *
 * Anything genuinely platform-specific is injected as an adapter: the
 * package declares the port, each client supplies it.
 */
const FORBIDDEN_IN_SHARED_PACKAGES = [
  {
    group: ["next", "next/*"],
    message:
      "Shared packages must stay framework-neutral (PACKAGE-01). Inject navigation, images and routing through an adapter the client supplies.",
  },
  {
    group: ["server-only", "@/*", "@prisma/client", "next-auth", "next-auth/*"],
    message:
      "Shared packages run in the browser and in the native shell too, so they cannot reach the server or the app root (PACKAGE-01). Pass server data in as arguments.",
  },
  {
    group: [
      "node:*",
      "fs",
      "fs/*",
      "path",
      "crypto",
      "os",
      "child_process",
      "stream",
      "stream/*",
      "buffer",
      "util",
    ],
    message:
      "Shared packages must load in a browser bundle (PACKAGE-01), so Node builtins are not available. Use Web Crypto/Streams, or take the capability as an injected port.",
  },
  {
    group: ["@capacitor/*", "react-native", "react-native/*"],
    message:
      "Shared packages must not depend on a native bridge (PACKAGE-01). The shell injects it.",
  },
];

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "playwright-report/**",
    "test-results/**",
    ".claude/**",
    // The Admin Console E2E suite writes its own report and artifact
    // directories. Both are gitignored, but they were not listed here, so
    // running that suite and then `npm run lint` produced hundreds of errors
    // out of Playwright's bundled report viewer.
    "playwright-report-admin/**",
    "test-results-admin/**",
    "next-env.d.ts",
    // Vite output for the Capacitor shell (apps/mobile). Gitignored, but a
    // local build leaves it in the tree, and linting a minified bundle
    // produces hundreds of warnings -- enough to fail `npm run check`, which
    // runs with --max-warnings=0.
    "apps/*/dist/**",
  ]),
  {
    // The one rule PACKAGE-01 is measured on. `npm run check:shared-packages`
    // counts violations of it through ESLint's own API rather than
    // re-implementing the scan, so the gate metric and the lint failure can
    // never disagree about what "forbidden" means.
    name: "tomverse/shared-package-purity",
    files: ["packages/*/src/**/*.{ts,tsx,mts,js,jsx,mjs}"],
    rules: {
      "no-restricted-imports": ["error", { patterns: FORBIDDEN_IN_SHARED_PACKAGES }],
    },
  },
]);

export { FORBIDDEN_IN_SHARED_PACKAGES };
export default eslintConfig;
