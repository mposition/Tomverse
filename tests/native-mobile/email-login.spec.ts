import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => { localStorage.setItem("tomverse-language", "ko"); localStorage.setItem("tomverse-theme", "light"); });
  await page.route("https://tomverse.app/**", (route) => route.abort());
  // Mount the real app and form with a credential-free synthetic native port.
  // No production source branch or mail/provider request is added for the test.
  await page.route("**/src/main.tsx", async (route) => {
    const response = await route.fetch();
    const source = await response.text();
    const anchor = "createRoot(container).render(";
    expect(source).toContain(anchor);
    const injected = `
      transport.requestEmailCode = async () => {
        window.loginRequests = (window.loginRequests || 0) + 1;
        if (window.loginUnavailable) throw { code: "MOBILE_LOGIN_UNAVAILABLE" };
      };
      transport.verifyEmailCode = async (email, code) => {
        window.loginVerifies = (window.loginVerifies || 0) + 1;
        if (code !== "123456") throw { code: "EMAIL_CODE_INVALID" };
        await transport.signIn();
      };
    `;
    await route.fulfill({ response, body: source.replace(anchor, injected + anchor) });
  });
});
test("email and code stay in the app; wrong code can be corrected without automatic retry", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Tomverse로 계속" }).click();
  await expect(page.getByRole("dialog", { name: "Tomverse에 로그인" })).toBeVisible();
  await page.getByLabel("이메일 주소").fill("user@example.com");
  await page.getByRole("button", { name: "인증 코드 받기", exact: true }).click();
  await expect(page.getByRole("button", { name: /새 코드 받기/ })).toBeDisabled();
  await page.getByLabel("6자리 인증 코드").fill("000000");
  await page.getByRole("button", { name: "확인하고 시작하기" }).click();
  await expect(page.getByRole("alert")).toContainText("만료");
  await expect(page.getByLabel("6자리 인증 코드")).toHaveValue("");
  await page.getByLabel("6자리 인증 코드").fill("123456");
  await page.getByRole("button", { name: "확인하고 시작하기" }).click();
  await expect(page.locator(".composer textarea")).toBeVisible();
  expect(await page.evaluate(() => ({ requests: (window as unknown as { loginRequests: number }).loginRequests, verifies: (window as unknown as { loginVerifies: number }).loginVerifies }))).toEqual({ requests: 1, verifies: 2 });
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain("user@example.com");
});
test("unavailable server remains an app error with no browser navigation", async ({ page, context }) => {
  await page.addInitScript(() => { (window as unknown as { loginUnavailable: boolean }).loginUnavailable = true; });
  await page.goto("/");
  await page.getByRole("button", { name: "Tomverse로 계속" }).click();
  await page.getByLabel("이메일 주소").fill("user@example.com");
  await page.getByRole("button", { name: "인증 코드 받기", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("아직 앱 로그인을 지원하지 않습니다");
  await expect(page.getByLabel("6자리 인증 코드")).toHaveCount(0);
  expect(context.pages()).toHaveLength(1);
  await page.screenshot({ path: ".tmp/native-01/email-login-unavailable.png" });
});
