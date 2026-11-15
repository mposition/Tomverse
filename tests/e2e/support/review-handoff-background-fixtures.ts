import type { Page } from "@playwright/test";
import { AVAILABLE_MODELS } from "@/lib/models";
import { toPublicCatalogModel } from "@/lib/publicModelCatalog";

/** Keep unrelated preparation synthetic; each journey owns its handoff and send routes. */
export async function mockReviewHandoffBackground(page: Page) {
  // Specific page/context mocks registered by the journey take precedence.
  await page.context().route("**/api/**", route => route.abort("blockedbyclient"));
  await page.route("**/api/models/catalog", route => route.fulfill({ json: { models: AVAILABLE_MODELS.map(toPublicCatalogModel) } }));
  await page.route("**/api/build-info", route => route.fulfill({ json: {
    environment: "development", commitSha: null, shortCommitSha: null, builtAt: null,
    deploymentId: null, deploymentStartedAt: null, deployedAt: null, deploymentStatus: "unknown",
  } }));
  await page.route("**/api/assistant-profiles", route => route.fulfill({ json: { profiles: [] } }));
  await page.route("**/api/mcp/connections", route => route.fulfill({ json: { enabled: false, servers: [], connections: [], invocations: [] } }));
  await page.route("**/api/chat/research-preview/runs**", route => route.fulfill({ json: { runs: [] } }));
  await page.route("**/api/chat/context", route => route.fulfill({ json: { ok: true, contextBundle: null, memoryUsedCount: 0 } }));
  await page.route("**/api/chat/availability", route => route.fulfill({ json: {
    runnable: true, plan: "Free", blockCode: null,
    estimate: { requiredCredits: 1, models: [] },
    entitlement: { dailyCreditLimit: 300, creditsAvailableNow: 300, creditShortfall: 0 },
  } }));
}
