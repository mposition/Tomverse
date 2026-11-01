import { expect, test } from "@playwright/test";
import { mobileSignupCopy } from "../../locales/mobileSignup";

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
      const completeSession = transport.signIn;
      transport.signIn = async () => {
        window.browserLoginCalls = (window.browserLoginCalls || 0) + 1;
        if (window.browserLoginFailure) throw { code: window.browserLoginFailure };
        if (window.holdBrowserLogin) await new Promise(resolve => { window.finishBrowserLogin = resolve; });
        await completeSession();
      };
      transport.requestEmailCode = async () => {
        window.loginRequests = (window.loginRequests || 0) + 1;
        if (window.loginUnavailable) throw { code: "MOBILE_LOGIN_UNAVAILABLE" };
        if (window.loginDeliveryFailed) throw { code: "SEND_FAILED" };
        if (window.loginRequestFailed) throw { code: "MOBILE_LOGIN_FAILED" };
        return window.nativeSignupDisabled ? undefined : { signup: true };
      };
      transport.verifyEmailCode = async (email, code, signup) => {
        window.loginVerifies = (window.loginVerifies || 0) + 1;
        if (code !== "123456") throw { code: "EMAIL_CODE_INVALID" };
        if (window.newEmail && !signup) throw { code: "EMAIL_ACCOUNT_NOT_FOUND" };
        if (signup) {
          window.signupCalls = (window.signupCalls || 0) + 1;
          window.signupAction = signup;
          if (window.signupFailure) throw { code: window.signupFailure };
          if (window.holdSignup) await new Promise(resolve => { window.finishSignup = resolve; });
        }
        await completeSession();
      };
    `;
    await route.fulfill({ response, body: source.replace(anchor, injected + anchor) });
  });
});
test("email and code stay in the app; wrong code can be corrected without automatic retry", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "앱에서 이메일 코드로 로그인" }).click();
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
  await page.getByRole("button", { name: "앱에서 이메일 코드로 로그인" }).click();
  await page.getByLabel("이메일 주소").fill("user@example.com");
  await page.getByRole("button", { name: "인증 코드 받기", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("아직 앱 로그인을 지원하지 않습니다");
  await expect(page.getByLabel("6자리 인증 코드")).toHaveCount(0);
  expect(context.pages()).toHaveLength(1);
  await page.screenshot({ path: ".tmp/native-01/email-login-unavailable.png" });
});
test("the existing browser sign-in method is reachable without requesting email", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "앱에서 이메일 코드로 로그인" }).click();
  await expect(page.locator('.email-login a[href*="/auth/signin"]')).toHaveCount(0);
  await page.getByRole("button", { name: "다른 로그인 방법 사용" }).click();
  await expect(page.locator(".composer textarea")).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { loginRequests?: number }).loginRequests ?? 0)).toBe(0);
});
for (const failure of ["loginDeliveryFailed", "loginRequestFailed"]) test(failure + " does not tell the user a code was sent or already verified", async ({ page }) => {
  await page.addInitScript((key) => { (window as unknown as Record<string, boolean>)[key] = true; }, failure);
  await page.goto("/");
  await page.getByRole("button", { name: "앱에서 이메일 코드로 로그인" }).click();
  await page.getByLabel("이메일 주소").fill("user@example.com");
  await page.getByRole("button", { name: "인증 코드 받기", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(failure === "loginDeliveryFailed" ? "보내지 못했습니다" : "요청하지 못했습니다");
  await expect(page.getByRole("alert")).not.toContainText("이미 코드");
  await expect(page.getByLabel("6자리 인증 코드")).toHaveCount(0);
});

test("primary sign-in waits for the native browser return without requesting an email code", async ({ page }) => {
  await page.addInitScript(() => { (window as unknown as { holdBrowserLogin: boolean }).holdBrowserLogin = true; });
  await page.goto("/");
  const signIn = page.getByRole("button", { name: "Tomverse로 계속" });
  await signIn.click();
  await expect(signIn).toBeDisabled();
  await expect(page.locator(".composer textarea")).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: "Tomverse에 로그인" })).toHaveCount(0);
  await page.waitForFunction(() => typeof (window as unknown as { finishBrowserLogin?: () => void }).finishBrowserLogin === "function");
  await page.evaluate(() => (window as unknown as { finishBrowserLogin: () => void }).finishBrowserLogin());
  await expect(page.locator(".composer textarea")).toBeVisible();
  expect(await page.evaluate(() => ({ browser: (window as unknown as { browserLoginCalls: number }).browserLoginCalls,
    email: (window as unknown as { loginRequests?: number }).loginRequests ?? 0 }))).toEqual({ browser: 1, email: 0 });
});

for (const [code, message] of [
  ["MOBILE_LOGIN_UNAVAILABLE", "브라우저 로그인을 아직 사용할 수 없습니다"],
  ["LOGIN_UNAVAILABLE", "이 기기에서 브라우저 로그인을 사용할 수 없습니다"],
  ["LOGIN_VERIFICATION_FAILED", "앱에서 브라우저 로그인을 확인할 수 없습니다"],
  ["LOGIN_IN_PROGRESS", "이전 로그인 창을 닫은 뒤"],
]) test(code + " keeps in-app email sign-in usable with the appropriate recovery message", async ({ page }) => {
  await page.addInitScript((code) => { (window as unknown as { browserLoginFailure: string }).browserLoginFailure = code; }, code);
  await page.goto("/");
  await page.getByRole("button", { name: "Tomverse로 계속" }).click();
  await expect(page.getByRole("alert")).toContainText(message);
  await page.getByRole("button", { name: "앱에서 이메일 코드로 로그인" }).click();
  await page.getByLabel("이메일 주소").fill("user@example.com");
  await page.getByRole("button", { name: "인증 코드 받기", exact: true }).click();
  await page.getByLabel("6자리 인증 코드").fill("123456");
  await page.getByRole("button", { name: "확인하고 시작하기" }).click();
  await expect(page.locator(".composer textarea")).toBeVisible();
});

for (const code of ["LOGIN_CANCELLED", "LOGIN_EXPIRED"]) test(code + " permits a fresh browser sign-in without sending email", async ({ page }) => {
  await page.addInitScript((code) => { (window as unknown as { browserLoginFailure: string }).browserLoginFailure = code; }, code);
  await page.goto("/");
  await page.getByRole("button", { name: "Tomverse로 계속" }).click();
  await expect(page.getByRole("alert")).toContainText(code === "LOGIN_CANCELLED" ? "취소" : "만료");
  await page.evaluate(() => { (window as unknown as { browserLoginFailure: string }).browserLoginFailure = ""; });
  await page.getByRole("button", { name: "Tomverse로 계속" }).click();
  await expect(page.locator(".composer textarea")).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { loginRequests?: number }).loginRequests ?? 0)).toBe(0);
});

test("the email form reports browser failures as browser sign-in errors", async ({ page }) => {
  await page.addInitScript(() => { (window as unknown as { browserLoginFailure: string }).browserLoginFailure = "MOBILE_LOGIN_UNAVAILABLE"; });
  await page.goto("/");
  await page.getByRole("button", { name: "앱에서 이메일 코드로 로그인" }).click();
  await page.getByRole("button", { name: "다른 로그인 방법 사용" }).click();
  await expect(page.getByRole("alert")).toContainText("브라우저 로그인을 아직 사용할 수 없습니다");
  await expect(page.getByLabel("6자리 인증 코드")).toHaveCount(0);
});

async function verifyNewEmail(page: import("@playwright/test").Page) {
  await page.goto("/"); await page.getByRole("button", { name: "앱에서 이메일 코드로 로그인" }).click();
  await page.getByLabel("이메일 주소").fill("new@example.com"); await page.getByRole("button", { name: "인증 코드 받기", exact: true }).click();
  await page.getByLabel("6자리 인증 코드").fill("123456"); await page.getByRole("button", { name: "확인하고 시작하기" }).click();
}

for (const theme of ["light", "dark"]) test("verified new email requires explicit signup in " + theme, async ({ page }) => {
  if (theme === "dark") await page.setViewportSize({ width: 320, height: 780 });
  await page.addInitScript((theme) => { localStorage.setItem("tomverse-theme", theme); Object.assign(window, { newEmail: true }); }, theme);
  await verifyNewEmail(page);
  await expect(page.getByRole("dialog", { name: "Tomverse 회원가입" })).toBeVisible(); await expect(page.locator(".composer textarea")).toHaveCount(0);
  await expect(page.getByLabel("6자리 인증 코드")).toHaveCount(0); await expect(page.getByRole("checkbox")).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { signupCalls?: number }).signupCalls ?? 0)).toBe(0);
  await page.screenshot({ path: `.tmp/native-email-signup/registration-${theme}.png` });
  await page.getByRole("button", { name: "가입하고 시작하기", exact: true }).click(); await expect(page.locator(".composer textarea")).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { signupAction: unknown }).signupAction)).toBe(true);
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain("new@example.com");
});

test("closing signup creates no account and discards its proof", async ({ page }) => {
  await page.addInitScript(() => { Object.assign(window, { newEmail: true }); }); await verifyNewEmail(page);
  await page.getByRole("button", { name: "닫기", exact: true }).click(); await page.getByRole("button", { name: "앱에서 이메일 코드로 로그인" }).click();
  await expect(page.getByLabel("이메일 주소")).toHaveValue(""); await expect(page.getByLabel("6자리 인증 코드")).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { signupCalls?: number }).signupCalls ?? 0)).toBe(0);
});
test("signup stays single-flight while creating the account", async ({ page }) => {
  await page.addInitScript(() => { Object.assign(window, { newEmail: true, holdSignup: true }); }); await verifyNewEmail(page);
  await page.getByRole("button", { name: "가입하고 시작하기", exact: true }).click(); await expect(page.locator('.email-login button[type="submit"]')).toBeDisabled();
  await page.getByRole("button", { name: "닫기", exact: true }).click(); await expect(page.getByRole("dialog")).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { signupCalls: number }).signupCalls)).toBe(1);
  await page.evaluate(() => (window as unknown as { finishSignup: () => void }).finishSignup()); await expect(page.locator(".composer textarea")).toBeVisible();
});

for (const code of ["EMAIL_CODE_INVALID", "EMAIL_SIGNUP_UNAVAILABLE", "MOBILE_LOGIN_FAILED"]) test(code + " never replays signup and clears its proof", async ({ page }) => {
  await page.addInitScript((code) => { Object.assign(window, { newEmail: true, signupFailure: code }); }, code); await verifyNewEmail(page);
  await page.getByRole("button", { name: "가입하고 시작하기", exact: true }).click(); await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByLabel("6자리 인증 코드")).toHaveValue(""); await expect(page.getByRole("button", { name: "가입하고 시작하기", exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { signupCalls: number }).signupCalls)).toBe(1);
});

test("unsupported server does not promise or enter native signup", async ({ page }) => {
  await page.addInitScript(() => { Object.assign(window, { newEmail: true, nativeSignupDisabled: true }); });
  await page.goto("/"); await page.getByRole("button", { name: "앱에서 이메일 코드로 로그인" }).click(); await expect(page.getByText(mobileSignupCopy.ko.intro, { exact: true })).toBeVisible();
  await page.getByLabel("이메일 주소").fill("new@example.com"); await page.getByRole("button", { name: "인증 코드 받기", exact: true }).click(); await page.getByLabel("6자리 인증 코드").fill("123456"); await page.getByRole("button", { name: "확인하고 시작하기" }).click();
  await expect(page.getByRole("alert")).toContainText("Tomverse 웹사이트"); await expect(page.getByRole("button", { name: "가입하고 시작하기", exact: true })).toHaveCount(0);
});

for (const language of ["en", "ko", "zh", "de", "fr", "es", "pt"] as const) test("signup follows the " + language + " app language", async ({ page }) => {
  await page.addInitScript((language) => { localStorage.setItem("tomverse-language", language); Object.assign(window, { newEmail: true }); }, language);
  await page.goto("/"); await page.locator(".sign-in-email").click(); await page.locator('.email-login input[type="email"]').fill("new@example.com"); await page.locator('.email-login button[type="submit"]').click(); await page.locator(".email-code").fill("123456"); await page.locator('.email-login button[type="submit"]').click();
  await expect(page.getByRole("dialog", { name: mobileSignupCopy[language].title })).toBeVisible(); await expect(page.getByRole("button", { name: mobileSignupCopy[language].create, exact: true })).toBeVisible();
});
