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
  const language = page.getByLabel("ì–¸ì–´");
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
  await page.getByRole("button", { name: "ì „ì†¡" }).click();
  await expect(page.locator('[data-message-role="user"]').filter({ hasText: "First QA message" })).toBeVisible();
  await expect(page.getByText("QA mock response", { exact: true })).toBeVisible();
});

test("guest cannot activate a paid model", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "ëª¨ë¸ ì„ íƒ" }).click();
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
