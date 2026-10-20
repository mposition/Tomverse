import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const mod = (file: string) => pathToFileURL(resolve(root, file)).href;
const require = createRequire(import.meta.url);
process.env.E2E_DISABLE_DATABASE = "true";
process.env.NEXTAUTH_URL = "http://127.0.0.1:3100";
process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:1/test";
let imagesEnabled = true;
let entitled = true;
let routes = 0;
let catalogs = 0;
let installed = false;

async function load() {
  if (!installed) {
    installed = true;
    const security = require(resolve(root, "lib/apiSecurity.ts"));
    const { AVAILABLE_MODELS } = require(resolve(root, "lib/models.ts"));
    mock.module("next-auth/next", { namedExports: { getServerSession: async () => ({ user: { id: "qa-review-router" } }) } });
    mock.module(mod("lib/apiSecurity.ts"), { namedExports: { ...security, consumeApiRateLimit: async () => undefined } });
    mock.module(mod("lib/appSettings.ts"), { namedExports: { isImageGenerationEnabledCached: async () => imagesEnabled } });
    mock.module(mod("lib/billingEntitlements.ts"), { namedExports: {
      getUserBillingPlan: async () => ({ tier: "Max" }), effectivePlanModelLimit: () => 3,
      planAllowsFeature: () => entitled,
    } });
    mock.module(mod("lib/chatSecurity.ts"), { namedExports: { assertUserOperationalAccess: async () => undefined } });
    mock.module(mod("lib/modelRegistry.ts"), { namedExports: { getRuntimeModels: async () => AVAILABLE_MODELS } });
    mock.module(mod("lib/modelCatalog.ts"), { namedExports: { refreshImageModelCatalog: async () => { catalogs++; return []; } } });
    mock.module(mod("lib/reviewRouting.ts"), { namedExports: {
      reviewEasyEnabled: () => true,
      routeReviewPrompt: async () => { routes++; return { kind: "text", preset: "standard", choices: [{ provider: "openai", modelId: "gpt-6-luna" }] }; },
    } });
  }
  return import(mod("app/api/review/route/route.ts"));
}

async function post(requestedKind?: "image") {
  const { POST } = await load();
  return POST(new Request("http://127.0.0.1:3100/api/review/route", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "A mountain", providers: ["openai"], requestedKind }),
  }));
}

test("explicit image requests cannot spend routing cost when the feature or entitlement is unavailable", async () => {
  for (const [flag, plan] of [[false, true], [true, false]]) {
    imagesEnabled = flag; entitled = plan; routes = catalogs = 0;
    const response = await post("image");
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error, "IMAGE_UNAVAILABLE");
    assert.equal(routes, 0); assert.equal(catalogs, 0);
  }
});

test("ordinary text still uses the shared router when image generation is disabled", async () => {
  imagesEnabled = false; entitled = false; routes = 0;
  const response = await post();
  assert.equal(response.status, 200); assert.equal(routes, 1);
  assert.equal((await response.json()).kind, "text");
});
