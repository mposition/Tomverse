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
  await page.getByRole("button", { name: "ì „ì†¡" }).click();
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
