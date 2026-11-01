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
      };
      transport.verifyEmailCode = async (email, code, signup) => {
        window.loginVerifies = (window.loginVerifies || 0) + 1;
        if (code !== "123456") throw { code: "EMAIL_CODE_INVALID" };
        if (window.newEmail && !signup) throw { code: "EMAIL_ACCOUNT_NOT_FOUND" };
        if (signup) {
          window.signupRequests = [...(window.signupRequests || []), { email, code, ...signup }];
          if (window.signupExpired) throw { code: "EMAIL_CODE_INVALID" };
          if (window.signupUnavailable) throw { code: "MOBILE_SIGNUP_UNAVAILABLE" };
          if (signup.intent !== "signup" || signup.termsAccepted !== true) throw { code: "MOBILE_SIGNUP_TERMS_REQUIRED" };
        }
        await completeSession();
      };
    `;
    await route.fulfill({ response, body: source.replace(anchor, injected + anchor) });
  });
});

test("a verified new email creates an account inside the app only after explicit terms acceptance", async ({ page }) => {
  await page.setViewportSize({ width: 810, height: 1080 });
  await page.addInitScript(() => { (window as unknown as { newEmail: boolean }).newEmail = true; });
  await page.goto("/");
  await page.getByRole("button", { name: "앱에서 이메일 코드로 로그인" }).click();
  await page.getByLabel("이메일 주소").fill("new@example.com");
  await page.getByRole("button", { name: "인증 코드 받기", exact: true }).click();
  await page.getByLabel("6자리 인증 코드").fill("123456");
  await page.getByRole("button", { name: "확인하고 시작하기" }).click();
  const signup = page.getByRole("dialog", { name: "Tomverse 계정 만들기", exact: true });
  await expect(signup).toBeVisible();
  await expect(signup.getByLabel("이메일 주소")).toHaveValue("new@example.com");
  await expect(signup.getByRole("checkbox")).not.toBeChecked();
  await expect(signup.getByRole("button", { name: "무료 계정 만들기", exact: true })).toBeDisabled();
  await expect(signup.getByRole("link", { name: "이용약관", exact: true })).toHaveAttribute("href", "https://tomverse.app/terms");
  await expect(signup.getByRole("link", { name: "개인정보 처리방침", exact: true })).toHaveAttribute("href", "https://tomverse.app/privacy");
  await signup.getByRole("checkbox").check();
  await page.screenshot({ path: test.info().outputPath("ipad-email-signup.png"), fullPage: true });
  await signup.getByRole("button", { name: "무료 계정 만들기", exact: true }).click();
  await expect(page.locator(".composer textarea")).toBeVisible();
  const activity = await page.evaluate(() => {
    const state = window as unknown as { loginRequests: number; loginVerifies: number; signupRequests: unknown[] };
    return { requests: state.loginRequests, verifies: state.loginVerifies, signups: state.signupRequests };
  });
  expect(activity).toEqual({ requests: 1, verifies: 2, signups: [{ email: "new@example.com", code: "123456", intent: "signup", termsAccepted: true }] });
  expect(await page.evaluate(() => Object.values(localStorage).some(value => value.includes("123456")))).toBe(false);
});

for (const failure of ["signupExpired", "signupUnavailable"] as const) test(`${failure} does not retry signup or create a local session`, async ({ page }) => {
  await page.addInitScript((failure) => { Object.assign(window, { newEmail: true, [failure]: true }); }, failure);
  await page.goto("/");
  await page.getByRole("button", { name: "앱에서 이메일 코드로 로그인" }).click();
  await page.getByLabel("이메일 주소").fill("new@example.com");
  await page.getByRole("button", { name: "인증 코드 받기", exact: true }).click();
  await page.getByLabel("6자리 인증 코드").fill("123456");
  await page.getByRole("button", { name: "확인하고 시작하기" }).click();
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "무료 계정 만들기", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(failure === "signupExpired" ? "만료" : "회원가입을 지원하지 않습니다");
  await expect(page.getByLabel("6자리 인증 코드")).toHaveValue("");
  expect(await page.evaluate(() => (window as unknown as { signupRequests: unknown[] }).signupRequests.length)).toBe(1);
});

test("changing a verified new address clears its held signup and unchecked consent", async ({ page }) => {
  await page.addInitScript(() => { (window as unknown as { newEmail: boolean }).newEmail = true; });
  await page.goto("/");
  await page.getByRole("button", { name: "앱에서 이메일 코드로 로그인" }).click();
  await page.getByLabel("이메일 주소").fill("new@example.com");
  await page.getByRole("button", { name: "인증 코드 받기", exact: true }).click();
  await page.getByLabel("6자리 인증 코드").fill("123456");
  await page.getByRole("button", { name: "확인하고 시작하기" }).click();
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "다른 이메일 사용", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Tomverse에 로그인", exact: true })).toBeVisible();
  await expect(page.getByRole("checkbox")).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { signupRequests?: unknown[] }).signupRequests ?? [])).toEqual([]);
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
