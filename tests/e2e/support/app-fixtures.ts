import { expect, type Page } from "@playwright/test";

export type QaLanguage = "en" | "ko" | "zh";

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

const json = (body: JsonValue, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

export async function prepareGuestPage(page: Page, language: QaLanguage = "ko") {
  await page.route("**/api/auth/session", (route) =>
    route.fulfill(json({ user: null, expires: null }))
  );

  await page.addInitScript((lang) => {
    const callbacks = new Map<string, (token: string) => void>();
    window.turnstile = {
      render: (_container, options) => {
        const widgetId = "qa-turnstile-widget";
        const callback = options.callback;
        if (typeof callback === "function") {
          callbacks.set(widgetId, callback as (token: string) => void);
        }
        return widgetId;
      },
      execute: (widgetId) => {
        queueMicrotask(() => {
          callbacks.get(widgetId)?.("qa-turnstile-token");
        });
      },
      reset: () => {},
      remove: (widgetId) => {
        callbacks.delete(widgetId);
      },
    };
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
    route.fulfill(
      json({
        user: {
          id: "qa-user",
          name: "QA User",
          email: "qa@tomverse.app",
          image: null,
        },
        expires: "2099-01-01T00:00:00.000Z",
      })
    )
  );

  await page.route("**/api/user/settings", (route) =>
    route.fulfill(
      json({ theme: "dark", language: "ko", defaultModel: "gpt-5-4-mini" })
    )
  );

  await page.route("**/api/conversations", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill(json([conversation]));
      return;
    }

    await route.fulfill(json(conversation, 201));
  });

  await page.route("**/api/conversations/qa-conversation**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/messages")) {
      await route.fulfill(json({}, route.request().method() === "POST" ? 201 : 200));
      return;
    }

    await route.fulfill(json({ ...conversation, messages: [] }));
  });
}

export async function mockAttachmentUpload(page: Page) {
  await page.route("**/api/chat", async (route) => {
    const method = route.request().method();

    if (method === "PUT") {
      await route.fulfill(
        json({
          key: "attachments/qa-file",
          uploadUrl: "http://127.0.0.1:3100/__qa_upload__",
          uploadHeaders: { "Content-Type": "application/octet-stream" },
        })
      );
      return;
    }

    if (method === "PATCH") {
      const body = route.request().postDataJSON() as { size?: number };
      await route.fulfill(json({ size: body.size || 1 }));
      return;
    }

    await route.fallback();
  });

  await page.route("**/__qa_upload__", (route) =>
    route.fulfill({ status: 200, body: "" })
  );
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
    `4 0 obj\n<< /Length ${Buffer.byteLength(
      stream,
      "ascii"
    )} >>\nstream\n${stream}\nendstream\nendobj\n`,
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
  pdf += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  pdf += `trailer\n<< /Size ${
    objects.length + 1
  } /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

  return Buffer.from(pdf, "ascii");
}

export async function expectNoHorizontalOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth,
  }));

  expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport + 1);
}
