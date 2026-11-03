import { expect, test, type Page } from "@playwright/test";

const providers = {
  apple: { id: "apple", name: "Apple", type: "oauth", signinUrl: "/api/auth/signin/apple", callbackUrl: "/api/auth/callback/apple" },
  google: { id: "google", name: "Google", type: "oauth", signinUrl: "/api/auth/signin/google", callbackUrl: "/api/auth/callback/google" },
  "azure-ad": { id: "azure-ad", name: "Azure Active Directory", type: "oauth", signinUrl: "/api/auth/signin/azure-ad", callbackUrl: "/api/auth/callback/azure-ad" },
};

async function prepare(page: Page, apple = true) {
  await page.route("**/api/auth/session**", route => route.fulfill({ json: null }));
  await page.route("**/api/auth/providers", route => route.fulfill({ json: apple ? providers : { google: providers.google, "azure-ad": providers["azure-ad"] } }));
  await page.route("**/api/auth/csrf", route => route.fulfill({ json: { csrfToken: "synthetic-apple-ui-csrf" } }));
  await page.addInitScript(() => { window.localStorage.clear(); window.localStorage.setItem("tomverse_language", "en"); });
}

test("Apple appears only when the server advertises a configured provider", async ({ page }) => {
  await prepare(page, false);
  await page.goto("/auth/signin");
  await expect(page.getByRole("button", { name: "Continue with Apple" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Continue with Google" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue with Microsoft" })).toBeVisible();
});

for (const mode of ["signin", "signup"]) test(`Apple ${mode} preserves the explicit account-creation choice`, async ({ page }) => {
  await prepare(page);
  const methods: string[] = [];
  await page.route("**/api/auth/signup-intent", async route => {
    methods.push(route.request().method());
    if (route.request().method() === "POST") expect(route.request().postDataJSON()).toEqual({ provider: "apple" });
    await route.fulfill({ json: { ok: true } });
  });
  await page.route("**/api/auth/signin/apple**", async route => {
    const url = new URL(route.request().url());
    expect(url.searchParams.has("prompt")).toBe(false);
    const body = new URLSearchParams(route.request().postData() ?? "");
    expect(body.get("csrfToken")).toBe("synthetic-apple-ui-csrf");
    expect(body.get("callbackUrl")).toContain("/pricing");
    await route.fulfill({ json: { url: new URL("/auth/signin?apple=started", url.origin).toString() } });
  });
  await page.goto(`/auth/${mode}?reason=account_switch&callbackUrl=%2Fpricing`);
  await page.getByRole("button", { name: "Continue with Apple" }).click();
  await expect(page).toHaveURL(/apple=started/);
  expect(methods).toEqual([mode === "signup" ? "POST" : "DELETE"]);
});
