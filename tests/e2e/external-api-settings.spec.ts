import { expect, test, type Page } from "@playwright/test";
import { prepareGuestPage } from "./support/app-fixtures";

// Settings > API keys (docs/policy/external-api.md). The server routes are
// mocked here; their behaviour is covered by tests/integration/external-api.db.test.mjs.

const model = {
    id: "gpt-6-luna",
    name: "GPT 6 Luna",
    provider: "openai",
    tools: true,
    vision: true,
    reasoning: false,
    contextWindowTokens: 216000,
    maxOutputTokens: 16000,
    creditWeight: 1,
};
const baseUrl = "https://tomverse.app/api/v1";
const asideConfig = (apiKey: string) => ({
    providers: {
        tomverse: {
            name: "Tomverse",
            api: "openai-completions",
            baseUrl,
            apiKey,
            authHeader: true,
            models: [{ id: model.id, name: "GPT 6 Luna (Tomverse)", reasoning: false, input: ["text", "image"], contextWindow: 216000, maxTokens: 16000 }],
        },
    },
});
const vscodeConfig = [
    { name: "Tomverse", vendor: "customendpoint", apiKey: "${input:tomverseApiKey}", apiType: "chat-completions", models: [{ id: model.id, url: `${baseUrl}/chat/completions` }] },
];
const SECRET = ["tvk", "ab12cd34", "S".repeat(43)].join("_");

const mockKeys = async (page: Page, options: { enabled: boolean; keys?: Array<Record<string, unknown>> }) => {
    const keys: Array<Record<string, unknown>> = options.keys ?? [];
    const calls: string[] = [];
    await page.route(
        (url) => url.pathname === "/api/user/api-keys",
        async (route) => {
            const request = route.request();
            calls.push(`${request.method()} /api/user/api-keys`);
            if (!options.enabled) return route.fulfill({ json: { enabled: false, keys } });
            if (request.method() === "POST") {
                const body = request.postDataJSON();
                const summary = {
                    id: "key_1",
                    name: body.name,
                    keyPrefix: ["tvk", "ab12cd34"].join("_"),
                    creditCap: body.creditCap,
                    committedCredits: 0,
                    heldCredits: 0,
                    requestCount: 0,
                    state: "active",
                    expiresAt: null,
                    revokedAt: null,
                    lastUsedAt: null,
                    createdAt: "2026-11-17T00:00:00.000Z",
                };
                keys.push(summary);
                return route.fulfill({ status: 201, json: { key: SECRET, summary, clientConfig: { aside: asideConfig(SECRET), vscode: vscodeConfig } } });
            }
            return route.fulfill({
                json: {
                    enabled: true,
                    baseUrl,
                    limits: { maxKeys: 10, maxCreditCap: 1000000, expiryDays: [7, 30, 90, 365] },
                    models: [model],
                    keys,
                    clientConfig: { aside: asideConfig("<YOUR_TOMVERSE_API_KEY>"), vscode: vscodeConfig },
                },
            });
        }
    );
    await page.route(
        (url) => url.pathname.startsWith("/api/user/api-keys/"),
        async (route) => {
            const request = route.request();
            calls.push(`${request.method()} ${new URL(request.url()).pathname}`);
            if (request.method() === "DELETE") {
                for (const key of keys) key.state = "revoked";
                return route.fulfill({ json: { revoked: true, alreadyRevoked: false } });
            }
            if (request.method() === "PATCH") {
                const body = request.postDataJSON();
                for (const key of keys) Object.assign(key, body);
                return route.fulfill({ json: { key: keys[0] } });
            }
            return route.fulfill({
                json: {
                    requests: [
                        { requestId: "req_held", modelId: model.id, createdAt: "2026-11-17T01:00:00.000Z", status: "held", outcome: null, heldCredits: 1, chargedCredits: null, usage: null, errorCode: null },
                        { requestId: "req_done", modelId: model.id, createdAt: "2026-11-17T00:30:00.000Z", status: "settled", outcome: "completed", heldCredits: 0, chargedCredits: 1, usage: { inputTokens: 120, outputTokens: 30 }, errorCode: null },
                    ],
                },
            });
        }
    );
    return calls;
};

test("API keys: the page says so when the API is not offered to the account", async ({ page }) => {
    await prepareGuestPage(page, "en");
    await mockKeys(page, { enabled: false });
    await page.goto("/settings/api");
    await expect(page.getByTestId("external-api-unavailable")).toBeVisible();
    await expect(page.getByTestId("external-api-create")).toHaveCount(0);
});

test("API keys: an account the API was switched off for can still revoke its keys", async ({ page }) => {
    await prepareGuestPage(page, "en");
    const calls = await mockKeys(page, {
        enabled: false,
        keys: [{ id: "key_old", name: "Old laptop", keyPrefix: ["tvk", "zz99yy88"].join("_"), creditCap: null, committedCredits: 3, heldCredits: 0, requestCount: 3, state: "active", expiresAt: null, revokedAt: null, lastUsedAt: null, createdAt: "2026-11-01T00:00:00.000Z" }],
    });
    await page.goto("/settings/api");
    await expect(page.getByTestId("external-api-unavailable")).toBeVisible();
    const row = page.getByTestId("external-api-key");
    await expect(row).toContainText("Old laptop");
    await expect(row.getByRole("button", { name: "Rename" })).toHaveCount(0);
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByTestId("external-api-key-revoke").click();
    await expect(row).toHaveAttribute("data-key-state", "revoked");
    expect(calls).toContain("DELETE /api/user/api-keys/key_old");
});

test("API keys: create shows the secret once with a ready config, then revoke @ui-risk", async ({ page, isMobile }) => {
    await page.setViewportSize({ width: isMobile ? 320 : 1280, height: 900 });
    await prepareGuestPage(page, "ko");
    const calls = await mockKeys(page, { enabled: true });
    await page.goto("/settings/api");

    await expect(page.getByRole("heading", { name: "API 키" })).toBeVisible();
    await expect(page.getByTestId("external-api-models")).toContainText("GPT 6 Luna");
    await expect(page.getByTestId("external-api-aside-config")).toContainText("<YOUR_TOMVERSE_API_KEY>");
    await expect(page.getByTestId("external-api-vscode-config")).toContainText("customendpoint");
    await expect(page.getByTestId("settings-detail-nav")).toBeVisible();

    await page.getByTestId("external-api-name").fill("회사 노트북");
    await page.getByTestId("external-api-cap").fill("500");
    await page.getByTestId("external-api-create").click();

    const created = page.getByTestId("external-api-created");
    await expect(created).toBeVisible();
    await expect(page.getByTestId("external-api-created-key")).toHaveText(SECRET);
    await expect(page.getByTestId("external-api-created-aside")).toContainText(SECRET);
    await expect(page.getByTestId("external-api-created-vscode")).not.toContainText(SECRET);
    await expect(page.getByTestId("external-api-key")).toHaveCount(1);
    await expect(page.getByTestId("external-api-key")).toContainText("500");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);

    await page.getByTestId("external-api-created-done").click();
    await expect(created).toHaveCount(0);
    await expect(page.getByText(SECRET)).toHaveCount(0);

    // Rename and change the limit; each is one PATCH of only that field.
    const row = page.getByTestId("external-api-key");
    await row.getByRole("button", { name: "이름 변경" }).click();
    await row.getByRole("textbox").fill("집 데스크톱");
    await row.getByRole("button", { name: "저장" }).click();
    await expect(row).toContainText("집 데스크톱");
    await row.getByRole("button", { name: "한도 변경" }).click();
    await row.getByRole("textbox").fill("");
    await row.getByRole("button", { name: "저장" }).click();
    await expect(row).toContainText("키 한도 없음");
    expect(calls.filter((call) => call === "PATCH /api/user/api-keys/key_1")).toHaveLength(2);

    // Receipts: an unresolved request is shown as held, never as zero credits.
    await row.getByRole("button", { name: "최근 요청" }).click();
    const usage = page.getByTestId("external-api-key-usage");
    await expect(usage).toContainText("진행 중이거나 아직 확정되지 않음");
    await expect(usage).toContainText("입력 120 · 출력 30");
    await expect(usage).toContainText("req_done");

    page.once("dialog", (dialog) => dialog.accept());
    await page.getByTestId("external-api-key-revoke").click();
    await expect(page.getByTestId("external-api-key")).toHaveAttribute("data-key-state", "revoked");
    expect(calls).toContain("DELETE /api/user/api-keys/key_1");
});
