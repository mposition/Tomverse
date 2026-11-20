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
// Smart Adaptive's weight is the most a request can cost, so above the cheapest model.
const smartAdaptive = { ...model, id: "smart-adaptive", name: "Smart Adaptive", provider: "tomverse", creditWeight: 4 };
const baseUrl = "https://tomverse.app/api/v1";
// Synthetic key shape, assembled so no line reads like a credential.
const FIXTURE_PREFIX = ["tvk", "ab12cd34"].join("_");
const SECRET = [FIXTURE_PREFIX, "S".repeat(43)].join("_");

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
                    keyPrefix: FIXTURE_PREFIX,
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
                return route.fulfill({ status: 201, json: { key: SECRET, summary } });
            }
            return route.fulfill({
                json: {
                    enabled: true,
                    baseUrl,
                    limits: { maxKeys: 10, maxCreditCap: 1000000, expiryDays: [7, 30, 90, 365] },
                    models: [smartAdaptive, model],
                    keys,
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

test("API keys: a signed-out visitor is asked to sign in, not told the load failed", async ({ page }) => {
    await prepareGuestPage(page, "en");
    await page.route("**/api/user/api-keys", (route) => route.fulfill({ status: 401, json: { error: "Sign in required." } }));
    await page.goto("/settings/api");
    const signIn = page.getByTestId("external-api-signin");
    await expect(signIn).toBeVisible();
    await expect(signIn.getByRole("link")).toHaveAttribute("href", "/auth/signin?callbackUrl=%2Fsettings%2Fapi");
    await expect(page.getByText("Your keys could not be loaded. Try again.")).toHaveCount(0);
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
    await row.getByTestId("external-api-key-menu").click();
    await expect(row.getByRole("menuitem", { name: "Rename" })).toHaveCount(0);
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByTestId("external-api-key-revoke").click();
    await expect(row).toHaveAttribute("data-key-state", "revoked");
    expect(calls).toContain("DELETE /api/user/api-keys/key_old");
});

test("API keys: a key is made in a dialog, shown once in another, then filled into one tool's setup @ui-risk", async ({ page, isMobile }) => {
    await page.setViewportSize({ width: isMobile ? 320 : 1280, height: 900 });
    await prepareGuestPage(page, "ko");
    const calls = await mockKeys(page, { enabled: true });
    await page.goto("/settings/api");

    await expect(page.getByRole("heading", { name: "API 키", exact: true })).toBeVisible();
    await expect(page.getByTestId("settings-detail-nav")).toBeVisible();
    // Nothing tool-specific is on the page until a tool is picked.
    await expect(page.getByTestId("external-api-tool-aside")).toHaveCount(0);
    await expect(page.getByTestId("external-api-name")).toHaveCount(0);

    await page.getByTestId("external-api-new").click();
    const dialog = page.getByTestId("external-api-create-dialog");
    await expect(dialog).toBeVisible();
    await page.getByTestId("external-api-name").fill("회사 노트북");
    await page.getByTestId("external-api-cap").fill("5OO");
    await page.getByTestId("external-api-create").click();
    await expect(dialog.getByText("1부터 1000000 사이의 정수")).toBeVisible();
    expect(calls).not.toContain("POST /api/user/api-keys");
    await page.getByTestId("external-api-cap").fill("500");
    await page.getByTestId("external-api-create").click();

    const created = page.getByTestId("external-api-created");
    await expect(created).toBeVisible();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId("external-api-created-key")).toHaveText(SECRET);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.getByTestId("external-api-created-done").click();
    await expect(created).toHaveCount(0);
    await expect(page.getByTestId("external-api-key-filled")).toBeVisible();

    // Aside: the new key is filled in; Smart Adaptive alone by default, its id
    // surviving catalogue changes. Ticking a model pins it; the last one stays.
    await page.getByTestId("external-api-platform-aside").click();
    const aside = page.getByTestId("external-api-aside-config");
    await expect(aside).toContainText(SECRET);
    await expect(aside).toContainText('"smart-adaptive"');
    await expect(aside).not.toContainText('"gpt-6-luna"');
    await page.getByTestId("external-api-pick-gpt-6-luna").check();
    await expect(aside).toContainText('"gpt-6-luna"');
    await page.getByTestId("external-api-pick-smart-adaptive").uncheck();
    await expect(aside).not.toContainText('"smart-adaptive"');
    await page.getByTestId("external-api-pick-gpt-6-luna").click();
    await expect(page.getByTestId("external-api-pick-gpt-6-luna")).toBeChecked();
    // VS Code stores the key itself, so it is never written into its file.
    await page.getByTestId("external-api-platform-vscode").click();
    await expect(page.getByTestId("external-api-tool-aside")).toHaveCount(0);
    const vscode = page.getByTestId("external-api-vscode-config");
    await expect(vscode).toContainText(`${baseUrl}/chat/completions`);
    await expect(vscode).not.toContainText(SECRET);
    await page.getByTestId("external-api-platform-other").click();
    await expect(page.getByTestId("external-api-generic-config")).toContainText("Model: smart-adaptive");

    // The allowed models are searchable.
    await expect(page.getByRole("heading", { name: "API 허용 모델" })).toBeVisible();
    await page.getByTestId("external-api-models-search").fill("luna");
    await expect(page.getByTestId("external-api-models")).toContainText("GPT 6 Luna");
    await expect(page.getByTestId("external-api-models")).not.toContainText("Smart Adaptive");
    // Smart Adaptive shows a range: it is charged as the model that answers.
    await page.getByTestId("external-api-models-search").fill("smart");
    await expect(page.getByTestId("external-api-models")).toContainText("답한 모델 기준");
    await page.getByTestId("external-api-models-search").fill("zzz");
    await expect(page.getByTestId("external-api-models")).toContainText("맞는 모델이 없습니다");

    // Rename and change the limit from the row's menu; each is one PATCH of only that field.
    const row = page.getByTestId("external-api-key");
    await expect(row).toHaveCount(1);
    await expect(row).toContainText("500");
    await row.getByTestId("external-api-key-menu").click();
    await row.getByRole("menuitem", { name: "이름 변경" }).click();
    await row.getByRole("textbox").fill("집 데스크톱");
    await row.getByRole("button", { name: "저장" }).click();
    await expect(row).toContainText("집 데스크톱");
    await row.getByTestId("external-api-key-menu").click();
    await row.getByRole("menuitem", { name: "한도 변경" }).click();
    // Anything but a whole number in range is refused before it is sent; it
    // can never turn into "no limit". Only an empty field clears the limit.
    for (const bad of ["abc", "   ", "1e400", "99999999999999999999", "0", "1.5"]) {
        await row.getByRole("textbox").fill(bad);
        await row.getByRole("button", { name: "저장" }).click();
        await expect(row).toContainText("1부터 1000000 사이의 정수");
    }
    await row.getByRole("textbox").fill("");
    await row.getByRole("button", { name: "저장" }).click();
    await expect(row).toContainText("키 한도 없음");
    expect(calls.filter((call) => call === "PATCH /api/user/api-keys/key_1")).toHaveLength(2);

    // Receipts: an unresolved request is shown as held, never as zero credits.
    await row.getByTestId("external-api-key-menu").click();
    await row.getByRole("menuitem", { name: "최근 요청" }).click();
    const usage = page.getByTestId("external-api-key-usage");
    await expect(usage).toContainText("진행 중이거나 아직 확정되지 않음");
    await expect(usage).toContainText("입력 120 · 출력 30");
    await expect(usage).toContainText("req_done");

    await row.getByTestId("external-api-key-menu").click();
    page.once("dialog", (prompt) => prompt.accept());
    await page.getByTestId("external-api-key-revoke").click();
    await expect(row).toHaveAttribute("data-key-state", "revoked");
    expect(calls).toContain("DELETE /api/user/api-keys/key_1");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});

test("API keys: Claude Code, Codex and Cursor each get their own configuration @ui-risk", async ({ page, isMobile }) => {
    await page.setViewportSize({ width: isMobile ? 320 : 1280, height: 900 });
    await prepareGuestPage(page, "ko");
    const sonnet = { ...model, id: "claude-sonnet-5", name: "Claude Sonnet 5", provider: "anthropic", maxOutputTokens: 64000, protocols: ["chat_completions", "anthropic_messages"], providerModelId: "claude-sonnet-5" };
    const haiku = { ...sonnet, id: "claude-haiku-4-5", name: "Claude Haiku 4.5", creditWeight: 0, providerModelId: "claude-haiku-4-5-20251001" };
    const luna = { ...model, id: "gpt-5-6-luna", name: "GPT-5.6 Luna", protocols: ["chat_completions", "responses"], providerModelId: "gpt-5.6-luna" };
    await page.route(
        (url) => url.pathname === "/api/user/api-keys",
        (route) =>
            route.fulfill({
                json: {
                    enabled: true,
                    baseUrl,
                    limits: { maxKeys: 10, maxCreditCap: 1000000, expiryDays: [7, 30, 90, 365] },
                    models: [{ ...smartAdaptive, protocols: ["chat_completions", "anthropic_messages", "responses"] }, sonnet, haiku, luna],
                    keys: [],
                },
            })
    );
    await page.goto("/settings/api");
    const connect = page.getByTestId("external-api-connect");
    await expect(connect.getByRole("heading", { name: "도구 연결" })).toBeVisible();

    // Claude Code: the Anthropic namespace, Smart Adaptive among Anthropic
    // models by default, background work on the cheapest fixed model.
    await page.getByTestId("external-api-platform-claude-code").click();
    const claude = page.getByTestId("external-api-claude-code-powershell");
    await expect(claude).toContainText('ANTHROPIC_BASE_URL = "https://tomverse.app/api/anthropic"');
    await expect(claude).toContainText('ANTHROPIC_MODEL = "smart-adaptive"');
    await expect(claude).toContainText('ANTHROPIC_DEFAULT_HAIKU_MODEL = "claude-haiku-4-5"');
    await expect(claude).toContainText("<YOUR_TOMVERSE_API_KEY>");
    await expect(page.getByTestId("external-api-native-smart-hint")).toBeVisible();
    await page.getByTestId("external-api-claude-code-model").selectOption("claude-sonnet-5");
    await expect(claude).toContainText('ANTHROPIC_MODEL = "claude-sonnet-5"');
    await expect(page.getByTestId("external-api-native-smart-hint")).toHaveCount(0);
    await page.getByTestId("external-api-claude-code-model").selectOption("claude-haiku-4-5");
    await expect(claude).toContainText('ANTHROPIC_MODEL = "claude-haiku-4-5"');
    // One block at a time: the other shell, then the VS Code extension.
    await page.getByTestId("external-api-shell-posix").click();
    await expect(claude).toHaveCount(0);
    await expect(page.getByTestId("external-api-claude-code-posix")).toContainText("export ANTHROPIC_BASE_URL");
    await page.getByTestId("external-api-surface-extension").click();
    await expect(page.getByTestId("external-api-claude-code-vscode")).toContainText("claudeCode.environmentVariables");

    // Codex: its own provider and profile; Smart Adaptive among OpenAI models, or a fixed model by the provider's model id.
    await page.getByTestId("external-api-platform-codex").click();
    await expect(page.getByTestId("external-api-tool-claude-code")).toHaveCount(0);
    await page.getByTestId("external-api-surface-terminal").click();
    await expect(page.getByTestId("external-api-codex-provider")).toContainText('wire_api = "responses"');
    await expect(page.getByTestId("external-api-codex-provider")).toContainText("request_max_retries = 0");
    const profile = page.getByTestId("external-api-codex-profile");
    await expect(profile).toContainText('model = "smart-adaptive"');
    await page.getByTestId("external-api-codex-model").selectOption("gpt-5-6-luna");
    await expect(profile).toContainText('model = "gpt-5.6-luna"');
    await expect(profile).toContainText('web_search = "disabled"');
    await expect(page.getByTestId("external-api-codex-model").locator("option")).toHaveCount(2);

    // Cursor: the Chat Completions base URL with a fixed model.
    await page.getByTestId("external-api-platform-cursor").click();
    const cursor = page.getByTestId("external-api-cursor-config");
    await expect(cursor).toContainText(`Override OpenAI Base URL: ${baseUrl}`);
    await expect(cursor).not.toContainText("smart-adaptive");
    // GPT models come from Cursor's own list; anything else is added once.
    await expect(page.getByTestId("external-api-cursor-models")).toContainText("Add Custom Model");
    // The model list says which tools take each model.
    await page.getByTestId("external-api-models-search").fill("sonnet");
    await expect(page.getByTestId("external-api-models")).toContainText("Claude Code · Cursor");
    // The Tomverse CLI choice stays hidden until the package is published.
    await expect(page.getByTestId("external-api-platform-tomverse-cli")).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});

test("API keys: the Tomverse CLI choice, once enabled, shows install and a key for this terminal only @ui-risk", async ({ page, isMobile }) => {
    await page.setViewportSize({ width: isMobile ? 320 : 1280, height: 900 });
    await prepareGuestPage(page, "ko");
    await page.route(
        (url) => url.pathname === "/api/user/api-keys",
        (route) =>
            route.fulfill({
                json: {
                    enabled: true,
                    baseUrl,
                    limits: { maxKeys: 10, maxCreditCap: 1000000, expiryDays: [7, 30, 90, 365] },
                    models: [smartAdaptive, model],
                    keys: [],
                    tomverseCli: {
                        install: "npm install -g @tomverse/cli",
                        powershell: '$env:TOMVERSE_API_KEY = "<YOUR_TOMVERSE_API_KEY>"\ntomverse doctor',
                        posix: 'export TOMVERSE_API_KEY="<YOUR_TOMVERSE_API_KEY>"\ntomverse doctor',
                    },
                },
            })
    );
    await page.goto("/settings/api");
    await page.getByTestId("external-api-platform-tomverse-cli").click();
    const panel = page.getByTestId("external-api-tool-tomverse-cli");
    await expect(page.getByTestId("external-api-connect").getByRole("heading", { name: "Tomverse CLI" })).toBeVisible();
    await expect(page.getByTestId("external-api-tomverse-cli-install")).toContainText("npm install -g @tomverse/cli");
    await expect(page.getByTestId("external-api-tomverse-cli-powershell")).toContainText("$env:TOMVERSE_API_KEY");
    await page.getByTestId("external-api-shell-posix").click();
    await expect(page.getByTestId("external-api-tomverse-cli-powershell")).toHaveCount(0);
    await expect(page.getByTestId("external-api-tomverse-cli-posix")).toContainText("export TOMVERSE_API_KEY");
    await expect(panel).toContainText("격리(sandbox)되지 않습니다");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});
