import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, type ElectronApplication, type Page } from "@playwright/test";

const require = createRequire(import.meta.url);
const executablePath: string = process.env.TOMVERSE_DESKTOP_TEST_ELECTRON ?? require("electron");
const desktopDir = fileURLToPath(new URL("../", import.meta.url)).replace(/[\\/]$/, "");

export const columnsOrigin = process.env.DESKTOP_E2E_AUTH_ORIGIN;
export const columnModels = [
  { id: "gpt-5-6-terra", name: "GPT 6.1 Terra", provider: "openai" },
  { id: "gemini-3-7-flash", name: "Gemini 3.7 Flash", provider: "google" },
  { id: "grok-4-5", name: "Grok 4.5", provider: "xai" },
];
export const columnsReview = { id: "review-columns", title: "Which framework should a small team pick?", kind: "chat", surface: "workspace", productKey: "review" };
export const columnsQuestion = "Which web framework should a small team pick for a dashboard, and why?";

export type ColumnsState = {
  saves: Array<{ clientRequestId: string; content: string; modelId?: string }>;
  dispatches: Array<{ modelId: string; sourceUserMessageId: string; transcript: string[]; admissionToken?: string }>;
  models: string[];
};

/** A saved Review with one question and three answers behind a faked server; nothing leaves this computer. */
export async function launchReviewColumns(options: { width?: number; height?: number } = {}) {
  if (!columnsOrigin) throw new Error("DESKTOP_E2E_AUTH_ORIGIN is not set.");
  const profile = await mkdtemp(join(tmpdir(), "tomverse-review-columns-"));
  await writeFile(join(profile, "language.txt"), "en");
  const app = await electron.launch({ executablePath, args: [desktopDir, "--user-data-dir=" + profile], timeout: 20_000 });
  try {
    await app.evaluate(({ shell }, fixture) => {
      const host = globalThis as typeof globalThis & { columns: ColumnsState };
      type ColumnsState = {
        saves: Array<{ clientRequestId: string; content: string; modelId?: string }>;
        dispatches: Array<{ modelId: string; sourceUserMessageId: string; transcript: string[]; admissionToken?: string }>;
        models: string[];
      };
      const table = "| Option | Best for | Cost |\n| --- | --- | --- |\n| Next.js | Full-stack apps | Hosting |\n| Vite + React | Fast client dashboards | Low |\n| SvelteKit | Small bundles | Low |";
      const answers: Record<string, string> = {
        "gpt-5-6-terra": "For a small team a **dashboard** is mostly client work, so start with a lean setup.\n\n" + table + "\n\nPick Vite + React when you have an API already; pick Next.js when you also need server rendering.",
        "gemini-3-7-flash": "Choose the framework your team already knows. Both React and Svelte ship dashboards quickly.\n\n- Fewer moving parts beat benchmarks.\n- Keep the data layer separate so the UI can change later.",
        "grok-4-5": "Short answer: Vite + React. It is fast to build, hard to get wrong and easy to hire for.\n\n```ts\nnpm create vite@latest dashboard -- --template react-ts\n```",
      };
      const messages: Array<Record<string, unknown>> = [{ id: "question-1", role: "user", content: fixture.question, status: "normal", createdAt: new Date(1_000).toISOString() }];
      fixture.models.forEach((model, index) => messages.push({
        id: "answer-" + index, role: "assistant", modelId: model.id, content: answers[model.id], status: "normal",
        createdAt: new Date(2_000 + index).toISOString(),
        searchMetadata: index === 0 ? { requested: true, supported: true, executed: true, citations: [
          { url: "https://vite.dev/guide/", title: "Getting Started | Vite" }, { url: "https://nextjs.org/docs", title: "Next.js Docs" },
        ] } : { requested: false, supported: true, executed: false, citations: [] },
      }));
      // An answer saved before answers carried their model: it has no column to go to.
      messages.push({ id: "answer-legacy", role: "assistant", content: "An older answer saved without its model.", status: "normal",
        createdAt: new Date(2_500).toISOString() });
      host.columns = { saves: [], dispatches: [], models: fixture.models.map((model) => model.id) } satisfies ColumnsState;
      const realFetch = globalThis.fetch;
      shell.openExternal = async (href) => {
        const target = new URL(href);
        if (target.origin !== fixture.origin || target.pathname !== "/auth/desktop") throw new Error("Unexpected browser destination.");
        const callback = new URL(target.searchParams.get("redirect_uri")!);
        callback.search = new URLSearchParams({ state: target.searchParams.get("state")!, grant: "a".repeat(43) }).toString();
        if (!(await realFetch(callback)).ok) throw new Error("Unable to connect the fixture account.");
      };
      globalThis.fetch = async (input, init) => {
        const url = new URL(String(input));
        if (url.origin !== fixture.origin) return new Response(null, { status: 404 });
        const path = "/api/conversations/" + fixture.review.id;
        if (url.pathname === "/api/auth/desktop/exchange") return Response.json({ ok: true, accessToken: "fixture-access", refreshToken: "fixture-refresh", expiresIn: 600 });
        if (url.pathname === "/api/auth/desktop/session") return Response.json({ ok: true, account: { id: "columns-fixture", name: "Columns Fixture", email: "columns@example.test" } });
        if (url.pathname === "/api/products/chat/capabilities") {
          return Response.json({ autoSelection: { offered: false }, desktopReview: { easy: true, modelLimit: 3, plan: "Max" }, desktopReviewAnalysis: true });
        }
        if (url.pathname === "/api/models/catalog") {
          return Response.json({ models: fixture.models.map((model) => ({ ...model, minimumPlan: "Free", publiclyListed: true, status: "enabled", enabled: true })) });
        }
        if (url.pathname === "/api/conversations") return Response.json([{ ...fixture.review, selectedModels: host.columns.models }]);
        if (url.pathname === path && init?.method === "PATCH") {
          host.columns.models = JSON.parse(String(init.body)).selectedModels;
          return Response.json({ id: fixture.review.id });
        }
        if (url.pathname === path) {
          return Response.json({ ...fixture.review, messages, selectedModels: host.columns.models, messagePage: { nextCursor: null },
            selectionMode: "manual", autoSelection: { offered: false }, webSearchMode: "off" });
        }
        if (url.pathname === path + "/messages") {
          const [saved] = JSON.parse(String(init?.body)).messages;
          host.columns.saves.push({ clientRequestId: saved.clientRequestId, content: saved.content, ...(saved.modelId ? { modelId: saved.modelId } : {}) });
          const id = "saved-" + messages.length;
          messages.push({ id, role: "user", content: saved.content, status: "normal", ...(saved.modelId ? { modelId: saved.modelId } : {}),
            createdAt: new Date(10_000 + messages.length).toISOString() });
          return Response.json({ messageMappings: [{ requestId: saved.clientRequestId, messageId: id }] });
        }
        if (url.pathname === "/api/chat/preflight") return Response.json({ ok: true, admissionToken: "columns-comparison", contextBundle: null });
        if (url.pathname === "/api/chat") {
          const body = JSON.parse(String(init?.body));
          host.columns.dispatches.push({ modelId: body.modelId, sourceUserMessageId: body.sourceUserMessageId, admissionToken: body.admissionToken,
            transcript: body.messages.map((message: { role: string; content: string }) => message.role + ": " + message.content) });
          const reply = "Follow-up answer from " + body.modelId;
          messages.push({ id: body.assistantMessageId, role: "assistant", modelId: body.modelId, content: reply, status: "normal",
            createdAt: new Date(20_000 + messages.length).toISOString() });
          return new Response(reply);
        }
        return new Response(null, { status: 404 });
      };
    }, { origin: columnsOrigin, review: columnsReview, models: columnModels, question: columnsQuestion });
    if (options.width) {
      await app.evaluate(({ BrowserWindow }, size) => { BrowserWindow.getAllWindows()[0]?.setSize(size.width, size.height); },
        { width: options.width, height: options.height ?? 1000 });
    }
    const desktop = await app.firstWindow();
    await desktop.getByRole("button", { name: "Settings", exact: true }).click();
    await desktop.getByRole("button", { name: "Sign in with your browser", exact: true }).click();
    await expect.poll(() => desktop.evaluate(async () => (await window.desktop.state()).account)).toMatchObject({ stage: "connected" });
    await desktop.getByRole("button", { name: "Review", exact: true }).click();
    await desktop.getByRole("button", { name: columnsReview.title }).click();
    await expect(desktop.getByTestId("review-column")).toHaveCount(3);
    return { app, desktop, profile };
  } catch (error) {
    await app.close().catch(() => {});
    await rm(profile, { recursive: true, force: true, maxRetries: 5 });
    throw error;
  }
}

export async function closeReviewColumns(session: { app: ElectronApplication; profile: string }) {
  await session.app.close();
  await rm(session.profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

export const columnsState = (app: ElectronApplication) =>
  app.evaluate(() => (globalThis as typeof globalThis & { columns: ColumnsState }).columns) as Promise<ColumnsState>;

export const columnOrder = (desktop: Page) =>
  desktop.getByTestId("review-column").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-model-id")));
