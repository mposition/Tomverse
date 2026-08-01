import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

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
  ]),
]);

export default eslintConfig;
