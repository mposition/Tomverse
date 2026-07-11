### Task 1: Install and Configure Playwright

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `playwright.config.ts`
- Create: `tests/e2e/smoke.spec.ts`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: existing `npm run build` and `npm run start` commands.
- Produces: `npm run test:e2e`, `npm run test:e2e:quick`, and four named Playwright projects.

- [ ] **Step 1: Install the test runner without changing production dependencies**

Run:

```powershell
npm install --save-dev @playwright/test
npx playwright install chromium webkit
```

Expected: `@playwright/test` appears in `devDependencies`; Chromium and WebKit install successfully.

- [ ] **Step 2: Add QA scripts to `package.json`**

Add these entries under `scripts`:

```json
"start:e2e": "next start -H 127.0.0.1 -p 3100",
"test:e2e": "npm run build && playwright test",
"test:e2e:quick": "npm run build && playwright test --project=desktop-chromium",
"test:e2e:ui": "npm run build && playwright test --ui"
```

- [ ] **Step 3: Create `playwright.config.ts`**

```ts
import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:3100";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [["list"], ["html", { open: "never" }]],
  outputDir: "test-results",
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  webServer: {
    command: "npm run start:e2e",
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  projects: [
    {
      name: "desktop-chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1920, height: 1080 } },
    },
    {
      name: "desktop-compact",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1366, height: 768 } },
    },
    {
      name: "mobile-safari",
      use: { ...devices["iPhone 13"] },
    },
    {
      name: "mobile-chromium",
      use: {
        ...devices["Pixel 5"],
        viewport: { width: 412, height: 915 },
      },
    },
  ],
});
```

- [ ] **Step 4: Write the first smoke test**

Create `tests/e2e/smoke.spec.ts`:

```ts
import { expect, test } from "@playwright/test";

test("home renders one application shell", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("main")).toBeVisible();
  await expect(page.locator("main")).toHaveCount(1);
});
```

- [ ] **Step 5: Ignore generated Playwright artifacts**

Append to `.gitignore`:

```gitignore
/playwright-report/
/test-results/
/blob-report/
```

- [ ] **Step 6: Build and run the smoke test**

Run:

```powershell
npm run build
npx playwright test tests/e2e/smoke.spec.ts --project=desktop-chromium
```

Expected: build succeeds and one smoke test passes.

- [ ] **Step 7: Commit**

```powershell
git add package.json package-lock.json playwright.config.ts tests/e2e/smoke.spec.ts .gitignore
git commit -m "test: add Playwright user-flow harness"
```

---

