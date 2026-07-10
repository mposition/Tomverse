# Tomverse AI User Flow QA Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add repeatable PC and mobile user-flow QA, fix the small usability issues it exposes, and finish with a controlled production smoke test.

**Architecture:** Playwright runs deterministic guest and authenticated flows against a production Next.js build while intercepting external AI, OAuth, storage, and database APIs. Shared fixtures define browser state and mock contracts; separate desktop and mobile specs verify shell-specific interaction, while manual checklists cover real Safari, Edge, OAuth, R2, and provider behavior.

**Tech Stack:** Next.js 16.2.10, React 19, TypeScript, Playwright, Chromium, WebKit, Tailwind CSS 4

## Global Constraints

- Stabilize locally before testing `https://tomverse.app`.
- Automated tests must not call paid AI providers, OAuth providers, production PostgreSQL, Google Drive, or R2; those integrations are covered only by the controlled production smoke checklist.
- Automated desktop viewports: 1920x1080 and 1366x768.
- Automated mobile viewports: iPhone Safari 390x844 and Android Chrome 412x915.
- Manual browser coverage: current Chrome, Edge, iPhone Safari, and Android Chrome.
- Preserve the shared state and handlers in `app/page.tsx`; test desktop and mobile shells separately.
- Keep Korean, English, and Chinese UI functional.
- Every defect fix must pass its focused Playwright test and `npm run check`.
- Production QA must use a dedicated test account and disposable QA conversations only.

---

## File Map

- `playwright.config.ts`: browser projects, production server, reports, traces, screenshots, and base URL.
- `tests/e2e/support/app-fixtures.ts`: guest initialization, authenticated API mocks, chat stream mocks, upload mocks, deterministic file buffers, and overflow assertion.
- `tests/e2e/smoke.spec.ts`: shell boot and viewport routing.
- `tests/e2e/guest-flow.spec.ts`: language, model selection, guest message, and immediate rendering.
- `tests/e2e/desktop-flow.spec.ts`: desktop panels, popovers, keyboard navigation, drag and drop, and overflow.
- `tests/e2e/mobile-flow.spec.ts`: drawer, tabs, swipe, virtual-keyboard-sized viewport, immediate rendering, and overflow.
- `tests/e2e/account-flow.spec.ts`: mocked authenticated settings, conversation actions, lock, share, revoke, and Private Mode.
- `tests/e2e/attachment-flow.spec.ts`: image and PDF selection, paste/drop, preview, upload finalization, and message rendering.
- `components/chat/DesktopChatShell.tsx`: stable desktop shell and model-panel test contracts.
- `components/chat/MobileChatShell.tsx`: stable mobile shell and model-tab test contracts.
- `components/chat/ChatInput.tsx`: accessible input label and stable input/drop-zone contracts.
- `components/chat/ChatMessageList.tsx`: stable message role/model contracts.
- `components/chat/ChatSidebar.tsx`: accessible conversation-menu and lock-dialog contracts.
- `docs/qa/manual-user-flow-checklist.md`: real-device and subjective friction checklist.
- `docs/qa/production-smoke-checklist.md`: controlled `tomverse.app` verification and cleanup.
- `.gitignore`: Playwright artifacts.
- `package.json` and `package-lock.json`: Playwright dependency and QA scripts.

---

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

### Task 2: Add Stable UI Test Contracts

**Files:**
- Modify: `components/chat/DesktopChatShell.tsx`
- Modify: `components/chat/MobileChatShell.tsx`
- Modify: `components/chat/ChatInput.tsx`
- Modify: `components/chat/ChatMessageList.tsx`
- Modify: `components/chat/ChatSidebar.tsx`
- Create: `tests/e2e/ui-contracts.spec.ts`

**Interfaces:**
- Consumes: current shell, model, input, and message props.
- Produces: stable `data-testid`, `data-model-id`, and `data-message-role` selectors plus accessible model options, menu triggers, and lock-dialog names without changing visible UI.

- [ ] **Step 1: Write the failing selector-contract test**

```ts
import { expect, test } from "@playwright/test";

test("desktop exposes stable QA contracts", async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.goto("/");
  await expect(page.getByTestId("desktop-chat-shell")).toBeVisible();
  await expect(page.getByTestId("chat-input")).toBeVisible();
  await expect(page.getByTestId("chat-textarea")).toBeVisible();
  await expect(page.getByTestId("chat-message-list")).toBeVisible();
});

test("mobile exposes stable QA contracts", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByTestId("mobile-chat-shell")).toBeVisible();
  await expect(page.getByTestId("chat-input")).toBeVisible();
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run:

```powershell
npx playwright test tests/e2e/ui-contracts.spec.ts --project=desktop-chromium
```

Expected: FAIL because the test IDs do not exist.

- [ ] **Step 3: Add shell and model contracts**

In `DesktopChatShell.tsx`, add the shell ID and model ID:

```tsx
<main data-testid="desktop-chat-shell" className="...">
```

```tsx
<div key={modelId} data-testid="desktop-model-panel" data-model-id={modelId} className="...">
```

In `MobileChatShell.tsx`, add:

```tsx
<main data-testid="mobile-chat-shell" className="...">
```

```tsx
<button data-testid="mobile-model-tab" data-model-id={modelId} type="button" ...>
```

- [ ] **Step 4: Add input and message contracts**

In `ChatInput.tsx`, mark the existing input card and textarea:

```tsx
<div data-testid="chat-input" onDragEnter={handleDropZoneDragEnter} ...>
```

```tsx
<textarea
  data-testid="chat-textarea"
  aria-label={placeholderText}
  ref={textareaRef}
  ...
/>
```

Mark each model toggle button inside the selector:

```tsx
<button
  data-testid="model-option"
  data-model-id={model.id}
  type="button"
  disabled={unavailable}
  aria-pressed={isSelected}
  ...
>
```

In `ChatMessageList.tsx`, add:

```tsx
<div data-testid="chat-message-list" ref={containerRef} onScroll={handleScroll} ...>
```

In `ChatSidebar.tsx`, make each context-menu trigger uniquely accessible:

```tsx
<button
  data-testid="conversation-menu"
  data-conversation-id={conv.id}
  aria-label={`${t("chat.moreActions")}: ${conv.title}`}
  type="button"
  ...
>
```

Give the lock form a dialog name and connect the password label:

```tsx
<form
  role="dialog"
  aria-modal="true"
  aria-labelledby="conversation-lock-title"
  ...
>
  <h2 id="conversation-lock-title">{t("sidebar.lock")}</h2>
  <label htmlFor="conversation-lock-password">{t("sidebar.password")}</label>
  <input id="conversation-lock-password" type="password" ... />
</form>
```

```tsx
<div
  key={msg.id || idx}
  data-testid="chat-message"
  data-message-role={msg.role}
  data-model-id={msg.modelId || ""}
  className="..."
>
```

- [ ] **Step 5: Run both contract tests**

Run:

```powershell
npx playwright test tests/e2e/ui-contracts.spec.ts --project=desktop-chromium --project=mobile-safari
```

Expected: all contract tests pass in the applicable viewport.

- [ ] **Step 6: Commit**

```powershell
git add components/chat/DesktopChatShell.tsx components/chat/MobileChatShell.tsx components/chat/ChatInput.tsx components/chat/ChatMessageList.tsx components/chat/ChatSidebar.tsx tests/e2e/ui-contracts.spec.ts
git commit -m "test: expose stable chat UI contracts"
```

---

### Task 3: Build Deterministic Browser Fixtures

**Files:**
- Create: `tests/e2e/support/app-fixtures.ts`
- Create: `tests/e2e/fixtures.spec.ts`

**Interfaces:**
- Consumes: Playwright `Page` and the current API request shapes.
- Produces: `prepareGuestPage(page, language)`, `mockChatStream(page, text)`, `mockAuthenticatedApi(page)`, `mockAttachmentUpload(page)`, `createQaPngBuffer()`, `createQaPdfBuffer()`, and `expectNoHorizontalOverflow(page)`.

- [ ] **Step 1: Write a failing fixture verification test**

```ts
import { expect, test } from "@playwright/test";
import { mockChatStream, prepareGuestPage } from "./support/app-fixtures";

test("mock chat returns deterministic text", async ({ page }) => {
  await prepareGuestPage(page, "ko");
  await mockChatStream(page, "QA mock response");
  await page.goto("/");
  await page.getByTestId("chat-textarea").fill("QA message");
  await page.getByRole("button", { name: "전송" }).click();
  await expect(page.getByText("QA mock response", { exact: true })).toBeVisible();
});
```

- [ ] **Step 2: Run the test and confirm the missing module failure**

Run:

```powershell
npx playwright test tests/e2e/fixtures.spec.ts --project=desktop-chromium
```

Expected: FAIL because `support/app-fixtures.ts` does not exist.

- [ ] **Step 3: Create the shared fixture module**

Create `tests/e2e/support/app-fixtures.ts`:

```ts
import { expect, type Page } from "@playwright/test";

export type QaLanguage = "en" | "ko" | "zh";

export async function prepareGuestPage(page: Page, language: QaLanguage = "ko") {
  await page.addInitScript((lang) => {
    localStorage.clear();
    localStorage.setItem("tomverse_language", lang);
    localStorage.setItem("guest_count", "0");
    localStorage.setItem("guest_date", new Date().toDateString());
  }, language);
}

export async function mockChatStream(page: Page, responseText: string) {
  await page.route("**/api/chat", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "text/plain; charset=utf-8",
      headers: { "X-Request-ID": "qa-trace-id" },
      body: responseText,
    });
  });
}

export async function mockAuthenticatedApi(page: Page) {
  const conversation = {
    id: "qa-conversation",
    title: "QA conversation",
    selectedModels: ["gpt-5-4-mini"],
    disabledPanels: [],
    isLocked: false,
    shareEnabled: false,
    shareExpiresAt: null,
  };

  await page.route("**/api/auth/session", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        user: { id: "qa-user", name: "QA User", email: "qa@tomverse.app", image: null },
        expires: "2099-01-01T00:00:00.000Z",
      }),
    })
  );
  await page.route("**/api/user/settings", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ theme: "dark", language: "ko", defaultModel: "gpt-5-4-mini" }),
    })
  );
  await page.route("**/api/conversations", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([conversation]) });
      return;
    }
    await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify(conversation) });
  });
  await page.route("**/api/conversations/qa-conversation**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/messages") && route.request().method() === "POST") {
      await route.fulfill({ status: 201, contentType: "application/json", body: "{}" });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ...conversation, messages: [] }),
    });
  });
}

export async function mockAttachmentUpload(page: Page) {
  await page.route("**/api/chat", async (route) => {
    const method = route.request().method();
    if (method === "PUT") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          key: "attachments/qa-file",
          uploadUrl: "http://127.0.0.1:3100/__qa_upload__",
          uploadHeaders: { "Content-Type": "application/octet-stream" },
        }),
      });
      return;
    }
    if (method === "PATCH") {
      const body = route.request().postDataJSON() as { size?: number };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ size: body.size || 1 }) });
      return;
    }
    await route.fallback();
  });
  await page.route("**/__qa_upload__", (route) => route.fulfill({ status: 200, body: "" }));
}

export function createQaPngBuffer() {
  return Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64"
  );
}

export function createQaPdfBuffer() {
  const stream = "BT /F1 12 Tf 20 100 Td (QA PDF) Tj ET";
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>\nendobj\n",
    `4 0 obj\n<< /Length ${Buffer.byteLength(stream, "ascii")} >>\nstream\n${stream}\nendstream\nendobj\n`,
    "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const object of objects) {
    offsets.push(Buffer.byteLength(pdf, "ascii"));
    pdf += object;
  }
  const xref = Buffer.byteLength(pdf, "ascii");
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  pdf += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, "ascii");
}

export async function expectNoHorizontalOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth,
  }));
  expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport + 1);
}
```

- [ ] **Step 4: Verify deterministic image and PDF buffers**

Extend `tests/e2e/fixtures.spec.ts`:

```ts
import { createQaPdfBuffer, createQaPngBuffer } from "./support/app-fixtures";

test("generated upload fixtures have valid signatures", () => {
  expect(createQaPngBuffer().subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  expect(createQaPdfBuffer().subarray(0, 5).toString("ascii")).toBe("%PDF-");
});
```

Expected: both fixtures are generated in memory, contain no personal data, and do not depend on a developer workstation path.

- [ ] **Step 5: Run the fixture test**

Run:

```powershell
npx playwright test tests/e2e/fixtures.spec.ts --project=desktop-chromium
```

Expected: the deterministic response appears and the test passes.

- [ ] **Step 6: Commit**

```powershell
git add tests/e2e/support tests/e2e/fixtures.spec.ts
git commit -m "test: add deterministic QA fixtures"
```

---

### Task 4: Automate the Shared Guest Flow

**Files:**
- Create: `tests/e2e/guest-flow.spec.ts`

**Interfaces:**
- Consumes: `prepareGuestPage`, `mockChatStream`, and stable UI contracts.
- Produces: regression coverage for language persistence, guest tier enforcement, message submission, and immediate rendering.

- [ ] **Step 1: Add the guest language test**

```ts
import { expect, test } from "@playwright/test";
import { mockChatStream, prepareGuestPage } from "./support/app-fixtures";

test.beforeEach(async ({ page }) => {
  await prepareGuestPage(page, "ko");
  await mockChatStream(page, "QA mock response");
});

test("guest can change and persist language", async ({ page }) => {
  await page.goto("/");
  const language = page.getByLabel("언어");
  await language.selectOption("en");
  await expect.poll(() => page.evaluate(() => localStorage.getItem("tomverse_language"))).toBe("en");
  await page.reload();
  await expect(page.getByLabel("Language")).toHaveValue("en");
  await page.getByLabel("Language").selectOption("zh");
  await expect.poll(() => page.evaluate(() => localStorage.getItem("tomverse_language"))).toBe("zh");
  await page.reload();
  await expect(page.locator("select").filter({ has: page.locator('option[value="zh"]') }).last()).toHaveValue("zh");
});
```

- [ ] **Step 2: Add model limit and immediate-render tests**

```ts
test("guest message appears immediately with mocked response", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("chat-textarea").fill("First QA message");
  await page.getByRole("button", { name: "전송" }).click();
  await expect(page.locator('[data-message-role="user"]').filter({ hasText: "First QA message" })).toBeVisible();
  await expect(page.getByText("QA mock response", { exact: true })).toBeVisible();
});

test("guest cannot activate a paid model", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "모델 선택" }).click();
  const paidModel = page.locator('[data-testid="model-option"][disabled]').filter({ hasText: "Pro" }).first();
  await expect(paidModel).toBeDisabled();
});
```

- [ ] **Step 3: Run the shared flow in desktop and mobile projects**

Run:

```powershell
npx playwright test tests/e2e/guest-flow.spec.ts --project=desktop-chromium --project=mobile-safari
```

Expected: all guest flows pass. If selectors reveal ambiguous accessible names, improve the component ARIA label instead of adding text-dependent CSS selectors.

- [ ] **Step 4: Commit**

```powershell
git add tests/e2e/guest-flow.spec.ts
git commit -m "test: cover shared guest chat flow"
```

---

### Task 5: Automate Desktop-Specific Interaction

**Files:**
- Create: `tests/e2e/desktop-flow.spec.ts`
- Modify if a failure is reproduced: `components/chat/DesktopChatShell.tsx`
- Modify if a failure is reproduced: `components/chat/ChatInput.tsx`

**Interfaces:**
- Consumes: desktop shell contracts and `expectNoHorizontalOverflow`.
- Produces: desktop panel, popover, keyboard, compact viewport, and drag/drop regression coverage.

- [ ] **Step 1: Write desktop layout and overflow tests**

```ts
import { expect, test } from "@playwright/test";
import { expectNoHorizontalOverflow, prepareGuestPage } from "./support/app-fixtures";

test.beforeEach(async ({ page }) => {
  await prepareGuestPage(page, "ko");
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.goto("/");
});

test("desktop shell fits compact viewport", async ({ page }) => {
  await expect(page.getByTestId("desktop-chat-shell")).toBeVisible();
  await expectNoHorizontalOverflow(page);
  const inputBox = await page.getByTestId("chat-input").boundingBox();
  expect(inputBox).not.toBeNull();
  expect(inputBox!.y + inputBox!.height).toBeLessThanOrEqual(768);
});
```

- [ ] **Step 2: Add popover keyboard tests**

```ts
test("action and model popovers remain visible and keyboard closable", async ({ page }) => {
  const actions = page.getByRole("button", { name: "더 많은 작업" });
  await actions.click();
  const dialog = page.getByRole("dialog", { name: "더 많은 작업" });
  await expect(dialog).toBeVisible();
  const box = await dialog.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(768);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(actions).toBeFocused();
});
```

- [ ] **Step 3: Add file-drag navigation prevention test**

```ts
test("dropping a file does not navigate the browser", async ({ page }) => {
  const before = page.url();
  const transfer = await page.evaluateHandle(() => {
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(new File(["qa"], "qa.txt", { type: "text/plain" }));
    return dataTransfer;
  });
  await page.getByTestId("chat-input").dispatchEvent("dragover", { dataTransfer: transfer });
  await page.getByTestId("chat-input").dispatchEvent("drop", { dataTransfer: transfer });
  await expect(page).toHaveURL(before);
});
```

- [ ] **Step 4: Run tests and fix only reproduced defects**

Run:

```powershell
npx playwright test tests/e2e/desktop-flow.spec.ts --project=desktop-chromium --project=desktop-compact
```

Expected: both desktop projects pass. For each failure, make the smallest component change, rerun only the failed test, then rerun the file.

- [ ] **Step 5: Commit**

```powershell
git add tests/e2e/desktop-flow.spec.ts components/chat/DesktopChatShell.tsx components/chat/ChatInput.tsx
git commit -m "test: verify desktop chat interactions"
```

---

### Task 6: Automate Mobile-Specific Interaction

**Files:**
- Create: `tests/e2e/mobile-flow.spec.ts`
- Modify if a failure is reproduced: `components/chat/MobileChatShell.tsx`
- Modify if a failure is reproduced: `components/chat/ChatInput.tsx`

**Interfaces:**
- Consumes: mobile shell contracts, deterministic chat stream, and overflow assertion.
- Produces: drawer, model tab, swipe, immediate-render, reduced viewport, and safe-width coverage.

- [ ] **Step 1: Write mobile shell and drawer tests**

```ts
import { expect, test } from "@playwright/test";
import { expectNoHorizontalOverflow, mockChatStream, prepareGuestPage } from "./support/app-fixtures";

test.beforeEach(async ({ page }) => {
  await prepareGuestPage(page, "ko");
  await mockChatStream(page, "Mobile QA response");
  await page.goto("/");
});

test("mobile shell and drawer stay inside viewport", async ({ page }) => {
  await expect(page.getByTestId("mobile-chat-shell")).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.getByRole("button", { name: "더 많은 작업" }).first().click();
  const drawer = page.getByRole("dialog", { name: "Tomverse AI" });
  await expect(drawer).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
});
```

- [ ] **Step 2: Add immediate rendering and reduced-height tests**

```ts
test("sent message renders without leaving the active model", async ({ page }) => {
  await page.getByTestId("chat-textarea").fill("Mobile immediate message");
  await page.getByRole("button", { name: "전송" }).click();
  await expect(page.locator('[data-message-role="user"]').filter({ hasText: "Mobile immediate message" })).toBeVisible();
  await expect(page.getByText("Mobile QA response", { exact: true })).toBeVisible();
});

test("input remains reachable at virtual-keyboard height", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 520 });
  await page.getByTestId("chat-textarea").focus();
  const box = await page.getByTestId("chat-input").boundingBox();
  expect(box).not.toBeNull();
  expect(box!.y + box!.height).toBeLessThanOrEqual(520);
  await expectNoHorizontalOverflow(page);
});
```

- [ ] **Step 3: Add model-tab state test**

```ts
test("model tab changes the visible chat panel", async ({ page }) => {
  await page.getByRole("button", { name: "모델 선택" }).click();
  const unselected = page.locator('[role="dialog"] button[aria-pressed="false"]:not([disabled])');
  await unselected.first().click();
  await page.keyboard.press("Escape");
  const tabs = page.getByTestId("mobile-model-tab");
  await expect(tabs).toHaveCount(2);
  await tabs.nth(1).click();
  await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
});
```

- [ ] **Step 4: Run WebKit and Android-sized Chromium**

Run:

```powershell
npx playwright test tests/e2e/mobile-flow.spec.ts --project=mobile-safari --project=mobile-chromium
```

Expected: both projects pass with no horizontal overflow and no delayed message rendering.

- [ ] **Step 5: Commit**

```powershell
git add tests/e2e/mobile-flow.spec.ts components/chat/MobileChatShell.tsx components/chat/ChatInput.tsx
git commit -m "test: verify mobile chat interactions"
```

---

### Task 7: Automate Authenticated Conversation Actions

**Files:**
- Create: `tests/e2e/account-flow.spec.ts`
- Modify: `tests/e2e/support/app-fixtures.ts`
- Modify only for reproduced defects: `app/page.tsx`
- Modify only for reproduced defects: `components/chat/ChatSidebar.tsx`
- Modify only for reproduced defects: `components/auth/AuthButton.tsx`

**Interfaces:**
- Consumes: `mockAuthenticatedApi` and current REST request contracts.
- Produces: regression coverage for settings, Private Mode, lock, share, revoke, delete confirmation, and toast feedback.

- [ ] **Step 1: Extend the authenticated fixture with mutable state**

Replace the static conversation mock with a returned controller:

```ts
export type AuthenticatedQaState = {
  locked: boolean;
  shared: boolean;
};

export async function mockAuthenticatedApi(page: Page): Promise<AuthenticatedQaState> {
  const state: AuthenticatedQaState = { locked: false, shared: false };
  const conversation = () => ({
    id: "qa-conversation",
    title: "QA conversation",
    selectedModels: ["gpt-5-4-mini"],
    disabledPanels: [],
    isLocked: state.locked,
    shareEnabled: state.shared,
    shareExpiresAt: state.shared ? "2099-01-01T00:00:00.000Z" : null,
  });
  const json = (body: unknown, status = 200) => ({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });

  await page.route("**/api/auth/session", (route) =>
    route.fulfill(json({
      user: { id: "qa-user", name: "QA User", email: "qa@tomverse.app", image: null },
      expires: "2099-01-01T00:00:00.000Z",
    }))
  );
  await page.route("**/api/user/settings", (route) =>
    route.fulfill(json({ theme: "dark", language: "ko", defaultModel: "gpt-5-4-mini" }))
  );
  await page.route("**/api/conversations", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill(json([conversation()]));
      return;
    }
    await route.fulfill(json(conversation(), 201));
  });
  await page.route("**/api/conversations/qa-conversation**", async (route) => {
    if (route.request().method() === "PATCH") {
      const body = route.request().postDataJSON() as { password?: string | null };
      if (typeof body.password === "string") state.locked = true;
    }
    if (route.request().method() === "DELETE") {
      await route.fulfill({ status: 204, body: "" });
      return;
    }
    await route.fulfill(json({ ...conversation(), messages: [] }));
  });
  await page.route("**/api/conversations/qa-conversation/messages**", (route) =>
    route.fulfill(json({}, route.request().method() === "POST" ? 201 : 200))
  );
  await page.route("**/api/conversations/qa-conversation/verify", (route) =>
    route.fulfill(json({ success: true }))
  );
  await page.route("**/api/conversations/qa-conversation/share", async (route) => {
    if (route.request().method() === "POST") {
      state.shared = true;
      await route.fulfill(json({
        url: "https://tomverse.app/share/qa-share-token-1234567890",
        expiresAt: "2099-01-01T00:00:00.000Z",
      }));
      return;
    }
    state.shared = false;
    await route.fulfill({ status: 204, body: "" });
  });
  return state;
}
```

- [ ] **Step 2: Write settings and Private Mode tests**

```ts
import { expect, test } from "@playwright/test";
import { mockAuthenticatedApi, prepareGuestPage } from "./support/app-fixtures";

test.beforeEach(async ({ page }) => {
  await prepareGuestPage(page, "ko");
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          (window as typeof window & { __qaClipboard?: string }).__qaClipboard = value;
        },
        readText: async () =>
          (window as typeof window & { __qaClipboard?: string }).__qaClipboard || "",
      },
    });
  });
  await mockAuthenticatedApi(page);
  await page.goto("/");
});

async function openSidebarOnMobile(page: import("@playwright/test").Page) {
  if (await page.getByTestId("mobile-chat-shell").isVisible()) {
    await page.getByRole("button", { name: "더 많은 작업" }).first().click();
  }
}

test("authenticated user opens settings and starts Private Mode", async ({ page }) => {
  await openSidebarOnMobile(page);
  await page.getByRole("button", { name: "설정" }).click();
  await expect(page.getByRole("dialog", { name: "사용자 설정" })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: /Private Mode/ }).click();
  await expect(page.getByText(/Private Mode/).first()).toBeVisible();
});
```

- [ ] **Step 3: Write share feedback test with clipboard permission**

Add the authenticated maximum-model test before the share test:

```ts
test("authenticated selector blocks a fourth model", async ({ page }) => {
  await page.getByRole("button", { name: "모델 선택" }).click();
  const unselected = page.locator('[data-testid="model-option"][aria-pressed="false"]:not([disabled])');
  await unselected.nth(0).click();
  await unselected.nth(0).click();
  await expect(page.locator('[data-testid="model-option"][aria-pressed="true"]')).toHaveCount(3);
  await unselected.nth(0).click();
  await expect(page.getByRole("status")).toContainText("최대 3개");
  await expect(page.locator('[data-testid="model-option"][aria-pressed="true"]')).toHaveCount(3);
});
```

```ts
test("share uses product toast and copies canonical URL", async ({ page }) => {
  await openSidebarOnMobile(page);
  await page.getByTestId("conversation-menu").first().click();
  await page.getByRole("button", { name: /공유/ }).click();
  await expect(page.getByRole("status")).toContainText("복사");
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(
    "https://tomverse.app/share/qa-share-token-1234567890"
  );
});
```

- [ ] **Step 4: Write lock and confirmation tests**

```ts
test("lock and delete actions use product dialogs", async ({ page }) => {
  await openSidebarOnMobile(page);
  await page.getByTestId("conversation-menu").first().click();
  await page.getByRole("button", { name: "대화 잠금" }).click();
  const lockDialog = page.getByRole("dialog", { name: "대화 잠금" });
  await expect(lockDialog).toBeVisible();
  await lockDialog.getByLabel(/비밀번호/).fill("qa-password-123");
  await lockDialog.getByRole("button", { name: "확인" }).click();
  await page.getByTestId("conversation-menu").first().click();
  await page.getByRole("button", { name: "삭제" }).click();
  await expect(page.getByRole("dialog", { name: "삭제" })).toBeVisible();
});
```

- [ ] **Step 5: Run authenticated flows in desktop and mobile projects**

Run:

```powershell
npx playwright test tests/e2e/account-flow.spec.ts --project=desktop-chromium --project=mobile-safari
```

Expected: settings, Private Mode, lock, share, and confirmation flows pass using the Korean locale strings defined in `locales/ko.ts`.

- [ ] **Step 6: Commit**

```powershell
git add tests/e2e/account-flow.spec.ts tests/e2e/support/app-fixtures.ts app/page.tsx components/chat/ChatSidebar.tsx components/auth/AuthButton.tsx
git commit -m "test: cover authenticated conversation actions"
```

---

### Task 8: Automate Attachment UX

**Files:**
- Create: `tests/e2e/attachment-flow.spec.ts`
- Modify: `tests/e2e/support/app-fixtures.ts`
- Modify only for reproduced defects: `components/chat/ChatInput.tsx`
- Modify only for reproduced defects: `components/chat/ChatMessageList.tsx`
- Modify only for reproduced defects: `app/api/chat/route.ts`

**Interfaces:**
- Consumes: attachment upload and chat mocks plus valid image/PDF fixtures.
- Produces: regression coverage for selection, paste, drag/drop, preview, finalization, message rendering, and browser navigation prevention.

- [ ] **Step 1: Write image-selection and preview test**

```ts
import { expect, test } from "@playwright/test";
import { createQaPdfBuffer, createQaPngBuffer, mockAttachmentUpload, mockAuthenticatedApi, mockChatStream, prepareGuestPage } from "./support/app-fixtures";

test.beforeEach(async ({ page }) => {
  await prepareGuestPage(page, "ko");
  await mockAuthenticatedApi(page);
  await mockAttachmentUpload(page);
  await mockChatStream(page, "Attachment QA response");
  await page.goto("/");
});

test("selected image previews before and after send", async ({ page }) => {
  await page.getByRole("button", { name: "더 많은 작업" }).click();
  const chooser = page.waitForEvent("filechooser");
  await page.getByText("파일 첨부", { exact: true }).click();
  await (await chooser).setFiles({ name: "test-image.png", mimeType: "image/png", buffer: createQaPngBuffer() });
  await expect(page.getByAltText("test-image.png")).toBeVisible();
  await page.getByTestId("chat-textarea").fill("Image QA");
  await page.getByRole("button", { name: "전송" }).click();
  await expect(page.locator('[data-message-role="user"] img[alt="test-image.png"]')).toBeVisible();
});
```

- [ ] **Step 2: Write PDF attachment card test**

```ts
test("PDF remains a friendly file card and sends successfully", async ({ page }) => {
  await page.getByRole("button", { name: "더 많은 작업" }).click();
  const chooser = page.waitForEvent("filechooser");
  await page.getByText("파일 첨부", { exact: true }).click();
  await (await chooser).setFiles({ name: "test-file.pdf", mimeType: "application/pdf", buffer: createQaPdfBuffer() });
  await expect(page.getByText("test-file.pdf", { exact: true })).toBeVisible();
  await expect(page.getByText("PDF", { exact: true })).toBeVisible();
  await page.getByTestId("chat-textarea").fill("PDF QA");
  await page.getByRole("button", { name: "전송" }).click();
  await expect(page.locator('[data-message-role="user"]').filter({ hasText: "test-file.pdf" })).toBeVisible();
  await expect(page.getByText("Attachment QA response", { exact: true })).toBeVisible();
});
```

- [ ] **Step 3: Add clipboard and drag/drop tests**

Use `DataTransfer` to dispatch `paste`, `dragover`, and `drop` with `test-image.png` bytes. Assert that the preview appears, the page URL does not change, and exactly one upload prepare/finalize pair is recorded by the fixture.

The event creation used in both tests is:

```ts
const bytes = Array.from(createQaPngBuffer());
const transfer = await page.evaluateHandle(({ bytes }) => {
  const dataTransfer = new DataTransfer();
  dataTransfer.items.add(new File([new Uint8Array(bytes)], "clipboard.png", { type: "image/png" }));
  return dataTransfer;
}, { bytes });
```

- [ ] **Step 4: Run attachment tests**

Run:

```powershell
npx playwright test tests/e2e/attachment-flow.spec.ts --project=desktop-chromium --project=mobile-safari
```

Expected: image and PDF cards render, sending succeeds with mocked providers, and dropped files never navigate the page.

- [ ] **Step 5: Commit**

```powershell
git add tests/e2e/attachment-flow.spec.ts tests/e2e/support/app-fixtures.ts components/chat/ChatInput.tsx components/chat/ChatMessageList.tsx app/api/chat/route.ts
git commit -m "test: cover attachment user experience"
```

---

### Task 9: Create Manual and Production QA Runbooks

**Files:**
- Create: `docs/qa/manual-user-flow-checklist.md`
- Create: `docs/qa/production-smoke-checklist.md`

**Interfaces:**
- Consumes: automated test results and the approved QA design.
- Produces: repeatable real-device and production sign-off records.

- [ ] **Step 1: Create the manual user-flow checklist**

Use this exact structure for each browser/device section:

```markdown
## Environment

- Build/commit:
- Browser and version:
- Device and viewport:
- Tester:
- Date:

| Flow | Expected result | Result | Severity | Evidence |
|---|---|---|---|---|
| First load | Correct shell, no horizontal overflow | Not run | - | - |
| New conversation | Default model and empty input are ready | Not run | - | - |
| Multi-model send | User message appears in every active model | Not run | - | - |
| Model-only follow-up | Only the selected model receives the follow-up | Not run | - | - |
| Attachment | Preview/card appears and send succeeds | Not run | - | - |
| Lock/share/download | Correct dialog, toast, and permission behavior | Not run | - | - |
| Cross-device continuation | A PC conversation opens and continues on mobile, and vice versa | Not run | - | - |
| State consistency | Title, selected models, lock, and share state match across devices | Not run | - | - |
| Keyboard/touch | No focus loss, trapped dialog, or accidental action | Not run | - | - |
```

Include dedicated sections for Chrome 1920x1080, Edge 1366x768, iPhone Safari 390x844, Android Chrome 412x915, and the `md` breakpoint at 767/768px.

- [ ] **Step 2: Create the production smoke checklist**

```markdown
# Production Smoke Checklist

- [ ] Use only the dedicated QA account.
- [ ] Confirm OAuth callback remains on `https://tomverse.app`.
- [ ] Upload one image and one small valid PDF through R2.
- [ ] Send one short prompt to every enabled production model.
- [ ] Confirm provider errors show only a safe message and trace ID.
- [ ] Create a share URL and confirm the `https://tomverse.app/share/` origin.
- [ ] Confirm the share is read-only and `noindex`.
- [ ] Revoke the share and confirm it becomes unavailable.
- [ ] Lock a QA conversation and verify read/share/download enforcement.
- [ ] Confirm CSP, HSTS, `nosniff`, referrer, permissions, and frame headers.
- [ ] Delete QA conversations and uploaded QA objects.
- [ ] Record Blocker, High, Medium, and Low findings separately.
```

- [ ] **Step 3: Review the runbooks against the completion criteria**

Expected:

- Blocker and High findings must be zero.
- Medium findings are fixed or explicitly accepted before launch.
- PC, mobile, cross-device, and production sections all have an owner and result.

- [ ] **Step 4: Commit**

```powershell
git add docs/qa/manual-user-flow-checklist.md docs/qa/production-smoke-checklist.md
git commit -m "docs: add launch QA runbooks"
```

---

### Task 10: Run the Full Local Release Gate

**Files:**
- Modify only if required by a reproduced failure: files named by the failing test.
- Record: `docs/qa/manual-user-flow-checklist.md`

**Interfaces:**
- Consumes: all automated specs and runbooks.
- Produces: a locally validated release candidate ready for production smoke testing.

- [ ] **Step 1: Run static and production checks**

Run:

```powershell
npm run check
npm run security:regression
```

Expected: both commands exit with code 0 and no warnings promoted to failures.

- [ ] **Step 2: Run the full browser matrix**

Run:

```powershell
npm run test:e2e
```

Expected: desktop Chromium, compact desktop, mobile WebKit, and mobile Chromium projects all pass.

- [ ] **Step 3: Review failure artifacts before changing code**

For any failure, open:

```powershell
npx playwright show-report
```

Use the trace, screenshot, console, network log, and reproduction steps to identify one root cause. Add or tighten the focused failing assertion before changing production code.

- [ ] **Step 4: Perform real-browser manual QA**

Run the manual checklist in current Chrome, Edge, iPhone Safari, and Android Chrome. Record exact device/browser versions and attach screenshots only for failures or visual sign-off points.

- [ ] **Step 5: Re-run the full gate after all fixes**

Run:

```powershell
npm run check
npm run security:regression
npm run test:e2e
```

Expected: all commands exit with code 0; the manual checklist has no unresolved Blocker or High item.

- [ ] **Step 6: Commit the local QA result**

```powershell
git add tests components app docs package.json package-lock.json playwright.config.ts .gitignore
git commit -m "test: complete local launch QA gate"
```

- [ ] **Step 7: Execute the controlled production smoke checklist**

Deploy the validated commit, complete `docs/qa/production-smoke-checklist.md`, clean up all QA data, and record any environment-only finding with its Railway trace ID and browser evidence.
