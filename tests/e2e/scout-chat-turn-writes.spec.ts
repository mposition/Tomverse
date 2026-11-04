import { expect, test } from "@playwright/test";
import { buildArtifactProgressChunk } from "@/lib/generatedArtifactProgressSignal";
import { AVAILABLE_MODELS } from "@/lib/models";
import { scoutTurnWrites } from "@/lib/productResearchScoutBrowserPolicy.mjs";
import { toPublicCatalogModel } from "@/lib/publicModelCatalog";
import { buildChatStreamTrailerChunk } from "@/lib/webSearchStreamTrailer";
import { mockAuthenticatedApi, prepareGuestPage } from "./support/app-fixtures";

// The Scout makes a real file by typing into this composer with its browser
// shut to every POST except what one chat turn makes (scoutTurnWrites,
// docs/policy/product-research-agent.md §14). This sends through the real page
// under the same rule, with the walker's own timing: nothing may write until
// send is pressed. If the send path gains a call the rule does not know, this
// fails here instead of costing the Scout every file in production.

const MODEL_ID = "gpt-5-6-luna";

test("a file turn through the real composer needs only what the Scout's rule allows", async ({ page }) => {
  await prepareGuestPage(page, "ko");
  await mockAuthenticatedApi(page, {
    selectedModels: [MODEL_ID],
    assistantProfiles: [],
    webSearchMode: "off",
    productKey: "chat",
  });
  await page.route("**/api/models/catalog", (route) => route.fulfill({ json: { models: AVAILABLE_MODELS.map(toPublicCatalogModel) } }));
  await page.route("**/api/chat/context", (route) => route.fulfill({ json: { ok: true, contextBundle: null, memoryUsedCount: 0 } }));
  const bytes = Buffer.from("%PDF-1.4 synthetic\n", "utf8");
  await page.route("**/api/artifacts/art_scout_turn", (route) =>
    route.fulfill({
      status: 200,
      headers: { "Content-Type": "application/pdf", "Content-Disposition": 'attachment; filename="scout.pdf"' },
      body: bytes,
    }),
  );
  await page.route("**/api/chat", (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    return route.fulfill({
      status: 200,
      contentType: "text/plain; charset=utf-8",
      headers: { "X-Request-ID": "synthetic-scout-turn" },
      body:
        buildArtifactProgressChunk("pdf") +
        "Synthetic file prepared." +
        buildChatStreamTrailerChunk({
          searchMetadata: null,
          completion: { status: "normal" },
          artifacts: [
            {
              id: "art_scout_turn",
              ordinal: 0,
              format: "pdf",
              filename: "scout.pdf",
              mediaType: "application/pdf",
              byteSize: bytes.length,
              status: "ready",
              modelId: MODEL_ID,
            },
          ],
        }),
    });
  });

  let allowWrite: ((url: string) => boolean) | null = null;
  const beforeTheTurn: string[] = [];
  const refusedInTheTurn: string[] = [];
  const madeInTheTurn: string[] = [];
  // Registered last, so it sees every POST before the mocks above, as the
  // walker's CDP rule sees it before it leaves the browser.
  await page.route("**/*", (route) => {
    const request = route.request();
    if (request.method() !== "POST") return route.fallback();
    const { pathname } = new URL(request.url());
    if (!allowWrite) {
      beforeTheTurn.push(pathname);
      return route.abort("blockedbyclient");
    }
    if (!allowWrite(request.url())) {
      refusedInTheTurn.push(pathname);
      return route.abort("blockedbyclient");
    }
    madeInTheTurn.push(pathname);
    return route.fallback();
  });

  await page.goto("/chat");
  await page.getByTestId("chat-textarea").fill("한 쪽짜리 보고서를 PDF 파일로 만들어 주세요.");
  allowWrite = scoutTurnWrites();
  await page.getByTestId("chat-send-button").click();

  const settled = page.locator('[data-testid="generated-artifact-download"], [data-testid="generated-artifact-failure"]').first();
  await expect(settled).toBeVisible();
  allowWrite = null;
  await test.info().attach("scout-chat-turn-writes", {
    body: JSON.stringify({ beforeTheTurn, madeInTheTurn, refusedInTheTurn }, null, 2),
    contentType: "application/json",
  });

  expect(refusedInTheTurn).toEqual([]);
  expect(madeInTheTurn).toContain("/api/products/chat/conversations");
  expect(madeInTheTurn).toContain("/api/chat");

  // The walker reads the file the way the card's own button does: a GET, with the turn closed.
  const download = page.getByTestId("generated-artifact-download").first();
  const [response] = await Promise.all([
    page.waitForResponse((candidate) => new URL(candidate.url()).pathname.startsWith("/api/artifacts/")),
    download.click(),
  ]);
  expect(response.ok()).toBe(true);
});
