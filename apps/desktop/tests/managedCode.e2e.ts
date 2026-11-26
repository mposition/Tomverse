import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, type ElectronApplication } from "@playwright/test";

const require = createRequire(import.meta.url);
const executablePath: string = process.env.TOMVERSE_DESKTOP_TEST_ELECTRON ?? require("electron");
const desktopDir = resolve(fileURLToPath(new URL("../", import.meta.url)));
const authOrigin = process.env.DESKTOP_E2E_AUTH_ORIGIN;

type Body = { action?: string; terminalReason?: string; approvedCredits?: number; reservationId?: string };
type Request = { method: string; path: string; cookie: string | null; origin: string | null; code: string | null; authorization: string | null; body: Body };
type Host = typeof globalThis & {
  managedEnabled: boolean; requests: Request[];
  /** The next /api/code/managed answer is this refusal instead of the contract's answer. */
  refuseNext: { status: number; error: string } | null;
  reservation: null | { id: string; reserved: number; settled: number; released: number; status: string };
  /** Test levers: what the server does on its own, outside any Desktop request. */
  settle(credits: number): void; interrupt(): void; receipt(): unknown;
};

test("Desktop shows the cloud and managed credits section only when the server offers it, and reserves, keeps alive and releases as the server's receipts say", {
  timeout: 240_000, skip: !authOrigin,
}, async () => {
  assert.ok(authOrigin);
  const profile = await mkdtemp(join(tmpdir(), "tomverse-managed-code-"));
  let application: ElectronApplication | undefined;
  try {
    await writeFile(join(profile, "language.txt"), "en");
    application = await electron.launch({ executablePath, args: [desktopDir, `--user-data-dir=${profile}`], timeout: 20_000 });
    await application.evaluate(async ({ shell }, { origin }) => {
      const host = globalThis as Host;
      host.managedEnabled = false;
      host.requests = [];
      host.refuseNext = null;
      host.reservation = null;
      host.settle = (credits) => { host.reservation!.settled += credits; };
      host.interrupt = () => {
        const held = host.reservation!;
        held.status = "interrupted";
        held.released = held.reserved - held.settled;
      };
      const realFetch = globalThis.fetch;
      shell.openExternal = async (href) => {
        const target = new URL(href);
        const callback = new URL(target.searchParams.get("redirect_uri")!);
        callback.search = new URLSearchParams({ state: target.searchParams.get("state")!, grant: "a".repeat(43) }).toString();
        if (!(await realFetch(callback)).ok) throw new Error("Unable to connect the test account.");
      };
      const rows = [
        { modelId: "alpha", name: "ALPHA", provider: "openai", minimumPlan: "Free", channels: ["code"], capabilities: { structuredOutput: "native" } },
        { modelId: "beta", name: "BETA", provider: "anthropic", minimumPlan: "Free", channels: ["code"], capabilities: { structuredOutput: "native" } },
        { modelId: "gamma", name: "GAMMA", provider: "openai", minimumPlan: "Free", channels: ["code"], capabilities: { structuredOutput: "native" } },
        { modelId: "chat-only", name: "CHAT ONLY", provider: "google", minimumPlan: "Free", channels: ["chat"], capabilities: { structuredOutput: "native" } },
      ];
      // A property, not a named function: evaluated code runs without the test bundler helpers.
      host.receipt = () => {
        const held = host.reservation!;
        const heldNow = held.reserved - held.settled - held.released;
        return { reservationId: held.id, state: held.status, leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(), heartbeatIntervalMs: 1_000,
          modelPair: { executor: rows[0], reviewer: rows[1] },
          billing: { reservedCredits: held.reserved, settledCredits: held.settled, releasedCredits: held.released, heldCredits: heldNow,
            unknownHeldCredits: 0, availableCredits: heldNow } };
      };
      globalThis.fetch = async (url, options) => {
        const target = new URL(String(url));
        if (target.origin !== origin) throw new Error("Unexpected Desktop request.");
        const method = options?.method ?? "GET";
        if (target.pathname === "/api/auth/desktop/exchange") {
          return Response.json({ ok: true, accessToken: "fixture-access", refreshToken: "fixture-refresh", expiresIn: 600 });
        }
        if (target.pathname === "/api/auth/desktop/session") {
          return Response.json({ ok: true, account: { id: "managed-account", name: "Managed Fixture", email: null } });
        }
        if (target.pathname === "/api/auth/desktop/logout") return Response.json({ ok: true });
        if (target.pathname === "/api/auth/desktop/settings-session") {
          return Response.json({ token: "fixture..managed.web.session", expiresAt: Date.now() + 300_000 });
        }
        if (target.pathname === "/api/products/chat/capabilities") {
          return Response.json({ autoSelection: { offered: false }, desktopManagedCode: host.managedEnabled });
        }
        if (!target.pathname.startsWith("/api/code/")) return Response.json({}, { status: 404 });
        const headers = new Headers(options?.headers);
        const body: Body = options?.body ? JSON.parse(String(options.body)) : {};
        host.requests.push({ method, path: target.pathname, cookie: headers.get("cookie"), origin: headers.get("origin"),
          code: headers.get("x-tomverse-code"), authorization: headers.get("authorization"), body });
        if (target.pathname === "/api/code/model-catalog") {
          return Response.json({ version: 7, contentHash: "hash-7", coverageUntil: "2027-01-01T00:00:00.000Z", publishedAt: "2026-11-01T00:00:00.000Z", models: rows });
        }
        if (target.pathname !== "/api/code/managed" || method !== "POST") return Response.json({}, { status: 404 });
        if (host.refuseNext) {
          const { status, error } = host.refuseNext;
          host.refuseNext = null;
          return Response.json({ error, message: "refused", dispatchState: "not_dispatched" }, { status });
        }
        if (body.action === "reserve") {
          host.reservation = { id: "11111111-1111-4111-8111-111111111111", reserved: Number(body.approvedCredits), settled: 0, released: 0, status: "active" };
          return Response.json(host.receipt());
        }
        if (!host.reservation || body.reservationId !== host.reservation.id) {
          return Response.json({ error: "CODE_RESERVATION_NOT_FOUND", dispatchState: "not_dispatched" }, { status: 404 });
        }
        if (body.action === "release" && host.reservation.status === "active") {
          host.reservation.status = "closed";
          host.reservation.released = host.reservation.reserved - host.reservation.settled;
        }
        return Response.json(host.receipt());
      };
    }, { origin: authOrigin });

    const page = await application.firstWindow();
    const rail = page.getByRole("navigation", { name: "Workspaces" });
    const requests = () => application!.evaluate(() => (globalThis as Host).requests);
    const managedPosts = async (action: string) => (await requests()).filter((request) =>
      request.path === "/api/code/managed" && request.body.action === action);
    await rail.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.getByRole("button", { name: "Sign in with your browser", exact: true }).click();
    await expect.poll(() => page.evaluate(async () => (await window.desktop.state()).account.stage)).toBe("connected");
    const openExecution = async () => {
      if (!(await page.getByRole("button", { name: "Execution and limits", exact: true }).isVisible())) {
        await rail.getByRole("button", { name: "Settings", exact: true }).click();
      }
      await page.getByRole("button", { name: "Execution and limits", exact: true }).click();
    };

    // Off by default: nothing is shown, the main process refuses the action, and no Code route was called.
    await openExecution();
    await expect(page.getByTestId("code-sandbox")).toBeVisible();
    await expect(page.getByTestId("managed-code")).toHaveCount(0);
    await assert.rejects(page.evaluate(() => window.desktop.managedCode({ action: "read" })), /unavailable/);
    assert.deepEqual(await requests(), []);

    // On: the section appears with where Code can run, and cloud says plainly that it cannot.
    await application.evaluate(() => { (globalThis as Host).managedEnabled = true; });
    await page.evaluate(() => window.desktop.signOut());
    await page.evaluate(() => window.desktop.signIn());
    await expect.poll(() => page.evaluate(async () => (await window.desktop.state()).capabilities?.managedCode)).toBe(true);
    await openExecution();
    const section = page.getByTestId("managed-code");
    await expect(section.getByRole("heading", { name: "Cloud and managed credits" })).toBeVisible();
    const state = (id: string) => section.getByTestId(`execution-location-${id}`);
    await expect(state("local")).toHaveAttribute("data-available", "true");
    await expect(state("worktree")).toHaveAttribute("data-available", "true");
    await expect(state("ssh")).toHaveAttribute("data-available", "false");
    await expect(state("cloud")).toHaveAttribute("data-available", "false");
    await expect(state("cloud")).toContainText("needs server infrastructure that does not exist yet");
    await expect(section.getByTestId("managed-no-runner")).toContainText("No managed runner is connected in this build");

    // Only models the managed path can use are offered. Two models from one company are not a valid pair.
    const executor = section.getByLabel("Executor model");
    const reviewer = section.getByLabel("Reviewer model");
    await expect(executor.locator("option")).toHaveText(["Choose a model", "ALPHA", "BETA", "GAMMA"]);
    await executor.selectOption({ label: "ALPHA" });
    await reviewer.selectOption({ label: "GAMMA" });
    await section.getByLabel("Credits to hold").fill("100");
    await expect(section.getByText("The two models must come from different companies.")).toBeVisible();
    await expect(section.getByRole("button", { name: "Review reservation" })).toBeDisabled();
    assert.equal((await managedPosts("reserve")).length, 0);

    // The person sees what is being held before anything is held, and confirms it.
    await reviewer.selectOption({ label: "BETA" });
    await section.getByRole("button", { name: "Review reservation" }).click();
    await expect(section.getByTestId("managed-confirm")).toContainText("Hold up to 100 credits for ALPHA and BETA?");
    assert.equal((await managedPosts("reserve")).length, 0);
    await section.getByTestId("managed-confirm-reserve").click();
    const reservation = section.getByTestId("managed-reservation");
    await expect(section.getByTestId("managed-state")).toHaveText("Active");
    await expect(reservation.getByTestId("managed-credits-reserved")).toContainText("100");
    await expect(reservation.getByTestId("managed-credits-held")).toContainText("100");
    await expect(reservation.getByTestId("managed-credits-available")).toContainText("100");
    const [reserveRequest] = await managedPosts("reserve");
    assert.equal(reserveRequest.cookie, "next-auth.session-token=fixture..managed.web.session");
    assert.equal(reserveRequest.origin, authOrigin);
    assert.equal(reserveRequest.code, "1");
    assert.equal(reserveRequest.authorization, null);
    assert.deepEqual({ ...reserveRequest.body, taskId: undefined }, { action: "reserve", taskId: undefined, catalogVersion: 7, contentHash: "hash-7",
      executorModelId: "alpha", reviewerModelId: "beta", approvedCredits: 100 });

    // The main process keeps it alive without the settings page, and later numbers are the server's.
    await expect.poll(async () => (await managedPosts("heartbeat")).length, { timeout: 15_000 }).toBeGreaterThan(0);
    await application.evaluate(() => (globalThis as Host).settle(30));
    await expect(reservation.getByTestId("managed-credits-settled")).toContainText("30", { timeout: 20_000 });
    await expect(reservation.getByTestId("managed-credits-available")).toContainText("70");

    // Ending it returns only what was not used, and says so.
    await section.getByRole("button", { name: "Release unused credits" }).click();
    await expect(section.getByTestId("managed-state")).toHaveText("Closed");
    await expect(reservation.getByTestId("managed-credits-returned")).toContainText("70");
    await expect(section.getByTestId("managed-ended")).toHaveText("Released as finished. The unused credits were returned.");
    assert.equal((await managedPosts("release")).at(-1)?.body.terminalReason, "completed");
    await section.getByRole("button", { name: "Done" }).click();
    await expect(section.getByTestId("managed-form")).toBeVisible();
    // The form starts empty again.
    await expect(section.getByRole("button", { name: "Review reservation" })).toBeDisabled();
    await executor.selectOption({ label: "ALPHA" });
    await reviewer.selectOption({ label: "BETA" });
    await section.getByLabel("Credits to hold").fill("100");

    // A server refusal is shown in words and holds nothing.
    await application.evaluate(() => { (globalThis as Host).refuseNext = { status: 402, error: "CREDIT_BALANCE_INSUFFICIENT" }; });
    await section.getByRole("button", { name: "Review reservation" }).click();
    await section.getByTestId("managed-confirm-reserve").click();
    await expect(section.getByTestId("managed-refusal")).toHaveAttribute("data-reason", "insufficientCredits");
    await expect(section.getByTestId("managed-refusal")).toContainText("does not have enough credits");
    await expect(section.getByTestId("managed-reservation")).toHaveCount(0);

    // When the server closes a reservation by itself, the window shows that, not a release it never made.
    await section.getByRole("button", { name: "Review reservation" }).click();
    await section.getByTestId("managed-confirm-reserve").click();
    await expect(section.getByTestId("managed-state")).toHaveText("Active");
    await application.evaluate(() => (globalThis as Host).interrupt());
    await expect(section.getByTestId("managed-state")).toHaveText("Interrupted", { timeout: 20_000 });
    await expect(section.getByTestId("managed-ended")).toContainText("Tomverse closed it and returned the unused credits");
    await expect(reservation.getByTestId("managed-credits-returned")).toContainText("100");
    assert.equal((await requests()).some((request) => request.authorization !== null), false);
  } finally {
    await application?.close().catch(() => {});
    await rm(profile, { recursive: true, force: true });
  }
});
