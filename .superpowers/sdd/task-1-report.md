# Task 1 Report: Install and Configure Playwright

## Implementation Summary

Installed `@playwright/test` as a dev dependency and installed the Chromium and WebKit Playwright browser binaries. Added the requested E2E npm scripts, exact four-project Playwright configuration, initial home-shell smoke test, and generated-artifact ignore rules.

## Commands Run And Exact Outcomes

1. `npm install --save-dev @playwright/test`
   - Exit code `0`.
   - Added `@playwright/test@1.61.1`; npm reported `650` audited packages and `0` vulnerabilities.
   - npm emitted existing pending-install-script warnings for Prisma, Sharp, Tesseract, and resolver packages.
2. `npx playwright install chromium webkit`
   - Exit code `0`.
   - Installed Chromium `149.0.7827.55` / Playwright Chromium `v1228` and WebKit `26.5` / Playwright WebKit `v2311`.
3. `npm run build`
   - Exit code `0`.
   - Next.js `16.2.10` compiled successfully, TypeScript completed, and static page generation completed for `7/7` pages.
4. `npx playwright test tests/e2e/smoke.spec.ts --project=desktop-chromium`
   - Exit code `1`.
   - Playwright timed out after `120000ms` waiting for the configured `webServer` URL `http://127.0.0.1:3100`.
   - A standalone `npm run start:e2e` process reached `Ready`, but `curl http://127.0.0.1:3100/` returned HTTP `421 Misdirected Request`. The smoke test did not execute.
   - For comparison, `curl http://localhost:3100/` reached the app but returned HTTP `500 Internal Server Error` during page rendering.
5. `npm run check`
   - Exit code `0`.
   - ESLint, TypeScript, and the production build all completed successfully.
6. `npm ls @playwright/test --depth=0`
   - Confirmed direct installation: `ai-chat-hub@0.1.0` -> `@playwright/test@1.61.1`.
7. `npx playwright install --dry-run chromium webkit`
   - Confirmed installed locations for Chromium, WebKit, FFmpeg, headless Chromium, and Winldd.

## Files Changed

- `package.json`: added `start:e2e`, `test:e2e`, `test:e2e:quick`, and `test:e2e:ui`; added `@playwright/test` to `devDependencies`.
- `package-lock.json`: npm lockfile updates for the direct Playwright dependency and its packages.
- `playwright.config.ts`: added the exact required base URL, web server, reporters, artifact retention, and four named projects.
- `tests/e2e/smoke.spec.ts`: added the home application-shell smoke test.
- `.gitignore`: added `/playwright-report/`, `/test-results/`, and `/blob-report/`.

## Self-Review

- No production dependencies were added or changed intentionally.
- The config exposes all four required projects: `desktop-chromium`, `desktop-compact`, `mobile-safari`, and `mobile-chromium`.
- The requested npm scripts and exact port/host contract are present.
- The smoke test is scoped to the requested single `main` application shell assertion.
- `npm run check` and `npm run build` provide clean static/configuration verification.
- Git commit was not attempted because Git CLI is unavailable in this environment, as specified.

## Concerns

- Status is `DONE_WITH_CONCERNS`: browser installation and configuration completed, but the required smoke test is blocked by the running app's local HTTP behavior. The configured `127.0.0.1:3100` endpoint returns `421 Misdirected Request`, while `localhost:3100` returns `500` during rendering. Resolving that application/runtime issue is outside the owned files for this task.
- The smoke test therefore has no passing result to report yet.

## Follow-Up Amendment

The root cause was confirmed in production-mode `next start`: origin protection rejected the local test host, and the environment could require the Cloudflare origin secret. Only `playwright.config.ts` was amended. Its managed `webServer.env` now:

- Preserves existing `ALLOWED_REQUEST_HOSTS` entries and appends `127.0.0.1:3100` and `localhost:3100` without duplicates.
- Sets `REQUIRE_CLOUDFLARE_ORIGIN_SECRET=false` for the Playwright-managed test server only.

The stale server on port `3100` was stopped before verification. A fresh run of `npx playwright test tests/e2e/smoke.spec.ts --project=desktop-chromium` started its own server and completed with exit code `0`: `1 passed (4.9s)`. Port `3100` was clear after the run.

Updated status: `DONE`.

## Second Follow-Up Amendment

Review found two additional E2E hardening gaps:

- `mobile-safari` now explicitly uses a `390x844` viewport instead of relying on the iPhone 13 browser viewport descriptor.
- The Playwright-managed server now preloads `tests/e2e/block-external-network.cjs` through `NODE_OPTIONS`, blocking non-loopback outbound network access during E2E runs so live AI, OAuth, R2, Drive, or database-adjacent HTTP calls cannot accidentally run from browser tests.

The network guard was verified with:

- `node --require .\tests\e2e\block-external-network.cjs -e "...fetch('https://example.com')..."`
- Exit code `0`; printed `QA_EXTERNAL_NETWORK_BLOCKED`.

WebKit also exposed that production CSP `upgrade-insecure-requests` upgrades local `_next/static` assets to `https://127.0.0.1`. `lib/csp.ts` now supports `DISABLE_CSP_UPGRADE_INSECURE_REQUESTS=true`, and `playwright.config.ts` sets it only for the Playwright web server. Production behavior is unchanged unless that explicit test flag is set.
