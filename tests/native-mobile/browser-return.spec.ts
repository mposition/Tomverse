import { expect, test, type Page } from "@playwright/test";
import { resolve } from "node:path";

const challenge = "c".repeat(43);
const state = "s".repeat(43);
const grant = "g".repeat(43);

async function mountCompletion(page: Page, reply: { status?: number; body?: object; hold?: boolean } = {}) {
  let requests = 0;
  let release: (() => Promise<void>) | undefined;
  await page.route("https://tomverse.app/**", route => route.abort());
  await page.route("**/api/auth/mobile/login-grant", async route => {
    requests++;
    expect(route.request().method()).toBe("POST");
    expect(route.request().postDataJSON()).toEqual({ codeChallengeMethod: "S256", codeChallenge: challenge });
    const finish = () => route.fulfill({ status: reply.status ?? 200, json: reply.body ?? { grant, expiresIn: 60 } });
    if (reply.hold) release = finish; else await finish();
  });
  await page.route("**/auth/mobile/callback*", route => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Native HTTPS callback</title>" }));
  // Serve the actual web completion component through the existing Vite test
  // server. Its network and callback landing are synthetic; no OAuth or mail runs.
  await page.route("**/src/main.tsx", async route => {
    const response = await route.fetch(); const source = await response.text();
    const anchor = source.indexOf("createRoot(container).render(");
    const react = source.match(/["']([^"']*\/react\.js[^"']*)["']/)?.[1];
    expect(anchor).toBeGreaterThan(0); expect(react).toBeTruthy();
    const root = resolve(__dirname, "../..").replaceAll("\\", "/");
    // Match Vite's canonical /@fs URL on both POSIX and Windows. A second
    // slash on POSIX loads another copy of the language context.
    const fsRoot = `/@fs${root.startsWith("/") ? "" : "/"}${root}`;
    const imports = `import React from ${JSON.stringify(react)};
      const createElement = React.createElement;
      import { LanguageProvider } from ${JSON.stringify(`${fsRoot}/components/LanguageProvider.tsx`)};
      import { MobileLoginContent } from ${JSON.stringify(`${fsRoot}/app/(site)/(application)/auth/mobile/MobileLoginContent.tsx`)};`;
    await route.fulfill({ response, body: imports + source.slice(0, anchor) + `
      createRoot(container).render(createElement(StrictMode, null,
        createElement(LanguageProvider, { initialLang: "ko", forceInitialLang: true },
          createElement(MobileLoginContent, { challenge: ${JSON.stringify(challenge)}, state: ${JSON.stringify(state)} }))));` });
  });
  await page.goto("/");
  return { count: () => requests, finish: async () => { await expect.poll(() => Boolean(release)).toBe(true); await release!(); } };
}

test("the authenticated web return automatically issues one grant and navigates without a click", async ({ page }) => {
  const calls = await mountCompletion(page, { hold: true });
  await expect(page.getByRole("status")).toBeVisible();
  await expect(page.getByRole("button")).toHaveCount(0);
  await expect(page.getByRole("link")).toHaveCount(0);
  await calls.finish();
  await expect(page).toHaveURL(new RegExp(`/auth/mobile/callback#grant=${grant}&state=${state}$`));
  expect(calls.count()).toBe(1);
  expect(new URL(page.url()).search).toBe("");
});

for (const reply of [
  { status: 503, body: { code: "NOT_AVAILABLE" } },
  { status: 401, body: { code: "UNAUTHORIZED" } },
  { status: 200, body: { grant: "invalid" } },
  { status: 200, body: { grant: "" } },
]) test(`a ${reply.status} response with ${JSON.stringify(reply.body)} never returns credentials or retries`, async ({ page }) => {
  const calls = await mountCompletion(page, reply);
  await expect(page.getByRole("alert")).toBeVisible();
  expect(page.url()).not.toContain("/auth/mobile/callback");
  expect(calls.count()).toBe(1);
  await expect(page.getByRole("button")).toHaveCount(0);
});
