import { test, expect } from "@playwright/test";
import { prepareGuestPage, mockAuthenticatedApi, expectNoHorizontalOverflow } from "./support/app-fixtures";
import { installChatModelStub, restoreActiveConversation } from "./support/chat-state-fixtures";

test.setTimeout(120_000);
const tools = [{ name: "search", mode: "read" }, { name: "create_note", mode: "confirm" }];
test.beforeEach(async ({ page, baseURL }) => {
  await prepareGuestPage(page, "ko", "studio", "studio"); await mockAuthenticatedApi(page);
  await page.context().addCookies([{ name: "__tomverse_e2e_auth", value: "1", url: baseURL! },
    { name: "__tomverse_e2e_chat_workspace", value: "1", url: baseURL! }]);
});
test("@ui-risk Chat sends a connector only after an explicit conversation selection", async ({ page }) => {
  await mockAuthenticatedApi(page, { productKey: "chat", selectedModels: ["gpt-5-6-luna"], selectionMode: "manual", messages: [] });
  await restoreActiveConversation(page);
  await installChatModelStub(page, { "gpt-5-6-luna": { kind: "success", chunks: ["Synthetic connector answer."] } });
  await page.route("**/api/mcp/connections", route => route.fulfill({ json: { enabled: true, servers: [], invocations: [],
    connections: [{ id: "explicit-connection", serverId: "synthetic", name: "Synthetic workspace", status: "connected", version: 1, grants: tools, catalog: tools }] } }));
  await page.route("**/api/chat/context", route => route.fulfill({ json: { ok: true, contextBundle: null, memoryUsedCount: 0 } }));
  await page.goto("/chat?lang=ko");
  await expect(page.getByTestId("chat-textarea")).toBeVisible();
  await page.getByTestId("chat-plugin-picker").click();
  await page.getByTestId("chat-plugin-select").selectOption("explicit-connection");
  await page.keyboard.press("Escape");
  await page.getByTestId("chat-textarea").fill("Find the synthetic release owner.");
  await page.getByTestId("chat-send-button").click();
  await expect(page.getByText("Synthetic connector answer.", { exact: true })).toBeVisible();
  const requests = await page.evaluate(() => (window as unknown as { __chatModelStubRequests: Array<{ body: Record<string, unknown> }> }).__chatModelStubRequests);
  expect(JSON.stringify(requests)).toContain("explicit-connection");
  await expectNoHorizontalOverflow(page);
});
test("@ui-risk plugin inventory shows logos, explicit permissions and one-action approval", async ({ page }) => {
  let connection = { id: "local-connection", serverId: "github", name: "GitHub", status: "connected", version: 1, catalog: tools, grants: tools };
  let pending = true, approvals = 0;
  await page.route("**/api/mcp/**", async route => {
    const req = route.request();
    if (req.method() === "POST" && req.url().includes("/invocations/")) { approvals++; pending = false; return route.fulfill({ json: { status: "ok" } }); }
    if (req.method() === "DELETE") connection = { ...connection, status: "disconnected", grants: [] };
    if (req.method() === "PATCH") connection = { ...connection, version: 2, grants: req.postDataJSON().tools.map((name: string) => tools.find(t => t.name === name)) };
    if (req.method() !== "GET") return route.fulfill({ json: { status: "saved" } });
    return route.fulfill({ json: { enabled: true, servers: [{ id: "github", name: "GitHub", auth: "bearer", origin: "https://api.githubcopilot.com" }], connections: [connection],
      invocations: pending ? [{ id: "local-approval", connectionId: connection.id, toolName: "create_note", state: "pending", arguments: { text: "Synthetic note only" }, expiresAt: "2099-01-01" }] : [] } });
  });
  await page.goto("/plugins?lang=ko");
  await expect(page.getByRole("heading", { name: "플러그인", level: 1, exact: true })).toBeVisible();
  const nav = page.getByTestId("navigation-plugins"); await expect(nav).toHaveAttribute("aria-current", "page");
  await expect(page.locator('[data-testid="plugin-card"] img[src="/plugins/github.svg"]')).toBeVisible();
  await page.getByTestId("plugin-card").filter({ hasText: "GitHub" }).getByRole("button", { name: "권한 관리" }).click();
  await expect(page.getByRole("checkbox").first()).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: test.info().outputPath("plugins-connected.png"), fullPage: true });
  const tabs = page.viewportSize()!.width < 768 ? page.locator('nav[aria-label="플러그인"]').last() : page.locator('aside nav').first();
  await tabs.getByRole("button", { name: /승인 대기/ }).click();
  await expect(page.getByTestId("plugin-approval")).toContainText("Synthetic note only");
  await page.getByRole("button", { name: "이 작업 실행 승인" }).click();
  expect(approvals).toBe(1); await expect(page.getByRole("button", { name: "이 작업 실행 승인" })).toHaveCount(0);
  await page.getByRole("button", { name: "연결 해제", exact: true }).click();
  await expect(page.getByRole("checkbox").first()).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
});
test("@ui-risk add dialog clears a cancelled credential and supports dark mode", async ({ page }) => {
  await page.route("**/api/mcp/connections", route => route.fulfill({ json: { enabled: true,
    servers: [{ id: "github", name: "GitHub", auth: "bearer", origin: "https://api.githubcopilot.com" }], connections: [], invocations: [] } }));
  await page.goto("/plugins?lang=ko");
  await page.getByRole("button", { name: "MCP 연결 추가" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByTestId("plugin-credential").fill("synthetic-not-a-real-token");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "MCP 연결 추가" }).click();
  await expect(page.getByTestId("plugin-credential")).toHaveValue("");
  await page.keyboard.press("Escape");
  await page.evaluate(() => document.documentElement.classList.add("dark"));
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: test.info().outputPath("plugins-dark.png"), fullPage: true });
});

test("@ui-risk OAuth requires an explicit connect action and never asks for a token", async ({ page }) => {
  let starts = 0;
  await page.route("**/api/mcp/connections", route => route.fulfill({ json: { enabled: true,
    servers: [{ id: "github", name: "GitHub", auth: "oauth", origin: "https://api.githubcopilot.com" }], connections: [], invocations: [] } }));
  await page.route("**/api/mcp/oauth/start", route => { starts++; return route.fulfill({ json: { status: "authorization_required", authorizationUrl: "https://oauth.example/authorize?state=synthetic" } }); });
  await page.route("https://oauth.example/**", route => route.fulfill({ contentType: "text/html", body: "Synthetic authorization page" }));
  await page.goto("/plugins?lang=ko");
  expect(starts).toBe(0);
  await page.getByRole("button", { name: "MCP 연결 추가" }).click();
  await expect(page.getByTestId("plugin-credential")).toHaveCount(0);
  await expect(page.getByRole("dialog")).toContainText("서비스로 이동해");
  await page.getByRole("dialog").getByRole("button", { name: "연결", exact: true }).click();
  await page.waitForURL("https://oauth.example/authorize?state=synthetic"); expect(starts).toBe(1);
});
test("@ui-risk disabled preview and add dialog remain accessible without exposing credentials", async ({ page }) => {
  await page.route("**/api/mcp/connections", route => route.fulfill({ json: { enabled: false, servers: [], connections: [], invocations: [] } }));
  await page.goto("/plugins?lang=ko");
  await expect(page.getByRole("button", { name: "MCP 연결 추가" })).toBeDisabled();
  await expect(page.getByText("현재 환경에서는 Connector Preview가 꺼져 있습니다.")).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: test.info().outputPath("plugins-disabled.png"), fullPage: true });
});
