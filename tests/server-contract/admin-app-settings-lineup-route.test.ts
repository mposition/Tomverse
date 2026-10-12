import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mock, test } from "node:test";

/**
 * `PATCH /api/admin/app-settings` with `guestBrandTrioModelIds` -- the default
 * lineup a guest's and a new account's first comparison open on.
 *
 * The storage layer is replaced; the route's own decisions are what is under
 * test. A refused lineup answers 400 with the reason before anything is
 * audited or written, the way a refused lead already does. An accepted one is
 * audited under its own action, before and after, and stored together with the
 * lead it was sent with. And a lineup never rides along with the feature
 * flags: those are a different save with a different audit row.
 */

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relative: string) => pathToFileURL(resolve(ROOT, relative)).href;

type World = {
  session: unknown;
  isAdmin: boolean;
  canWrite: boolean;
  lineupRejection: string | null;
  lineupWrites: Array<{ modelIds: readonly string[]; leadModelId?: string }>;
  leadWrites: string[];
  rejectionCalls: Array<{ modelIds: readonly string[]; leadModelId?: string }>;
  audits: string[];
};

let world: World;
let installed = false;

const SETTINGS = {
  guestDefaultModelId: "gpt-6-luna",
  guestBrandTrioModelIds: ["gpt-6-luna", "claude-haiku-5-5", "gemini-flash-lite-latest"],
  aiChatEnabled: true,
  attachmentsEnabled: true,
  publicSharingEnabled: true,
};

async function loadRoute(): Promise<{ PATCH: (request: Request) => Promise<Response> }> {
  if (!installed) {
    installed = true;
    mock.module(mod("node_modules/next-auth/next/index.js"), {
      namedExports: { getServerSession: async () => world.session },
    });
    mock.module(mod("lib/adminAuth.ts"), {
      namedExports: {
        isAdminSession: () => world.isAdmin,
        hasAdminPermission: () => world.canWrite,
      },
    });
    mock.module(mod("lib/adminAudit.ts"), {
      namedExports: {
        writeAdminAuditLog: async (entry: { action: string }) => {
          world.audits.push(entry.action);
        },
      },
    });
    const { createRequire } = await import("node:module");
    const require = createRequire(import.meta.url);
    const realReauthentication = require(resolve(ROOT, "lib/adminReauthentication.ts")) as Record<string, unknown>;
    mock.module(mod("lib/adminReauthentication.ts"), {
      namedExports: { ...realReauthentication, assertRecentAdminAuthentication: async () => {} },
    });
    const realApiSecurity = require(resolve(ROOT, "lib/apiSecurity.ts")) as Record<string, unknown>;
    mock.module(mod("lib/apiSecurity.ts"), {
      namedExports: { ...realApiSecurity, consumeApiRateLimit: async () => {} },
    });
    mock.module(mod("lib/guestLeadFacts.ts"), {
      namedExports: {
        readGuestLeadFacts: async () => ({ stored: null, effective: SETTINGS.guestDefaultModelId, trio: SETTINGS.guestBrandTrioModelIds }),
      },
    });
    const off = async () => false;
    const noop = async () => {};
    mock.module(mod("lib/appSettings.ts"), {
      namedExports: {
        getMemoryExtractionRevokedPairs: async () => ({ kind: "none" }),
        getPublicAppSettings: async () => SETTINGS,
        isAssistantKnowledgeEnabled: off,
        isAssistantProfilesEnabled: off,
        isExternalContinuationEnabled: off,
        isExternalImportEnabled: off,
        isImageGenerationEnabled: off,
        isMemoryExtractionEnabled: off,
        isMemoryInjectionEnabled: off,
        isChatStarterEnabled: off,
        guestDefaultLineupRejection: async (request: { modelIds: readonly string[]; leadModelId?: string }) => {
          world.rejectionCalls.push(request);
          return world.lineupRejection;
        },
        guestDefaultModelRejection: async () => null,
        setAssistantKnowledgeEnabled: noop,
        setAssistantProfilesEnabled: noop,
        setExternalContinuationEnabled: noop,
        setExternalImportEnabled: noop,
        setChatStarterEnabled: noop,
        setImageGenerationEnabled: noop,
        updateGuestDefaultLineup: async (request: { modelIds: readonly string[]; leadModelId?: string }) => {
          world.lineupWrites.push(request);
          return { guestBrandTrioModelIds: [...request.modelIds], guestDefaultModelId: request.leadModelId ?? null };
        },
        updateGuestDefaultModel: async (modelId: string) => {
          world.leadWrites.push(modelId);
          return modelId;
        },
        updateOperationalFeatureFlags: noop,
        updatePublicAppSettings: noop,
      },
    });
  }
  return import(mod("app/api/admin/app-settings/route.ts"));
}

const patch = (body: unknown) =>
  new Request("https://tomverse.app/api/admin/app-settings", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const reset = (overrides: Partial<World> = {}) => {
  world = {
    session: { user: { id: "admin_1", email: "ops@tomverse.app" } },
    isAdmin: true,
    canWrite: true,
    lineupRejection: null,
    lineupWrites: [],
    leadWrites: [],
    rejectionCalls: [],
    audits: [],
    ...overrides,
  };
};

const LINEUP = ["gpt-6-luna", "claude-sonnet-5", "gemini-flash-lite-latest"];

test("an accepted lineup is audited under its own action and stored with its lead", async () => {
  reset();
  const { PATCH } = await loadRoute();
  const response = await PATCH(patch({ guestBrandTrioModelIds: LINEUP, guestDefaultModelId: LINEUP[0] }));
  assert.equal(response.status, 200);
  assert.deepEqual(world.rejectionCalls, [{ modelIds: LINEUP, leadModelId: LINEUP[0] }]);
  assert.deepEqual(world.lineupWrites, [{ modelIds: LINEUP, leadModelId: LINEUP[0] }]);
  assert.deepEqual(world.leadWrites, [], "the lead travels with the lineup, not as a second write");
  assert.deepEqual(world.audits, [
    "app_settings.guest_default_lineup.update_started",
    "app_settings.guest_default_lineup.update_completed",
  ]);
});

test("a refused lineup answers 400 with the reason, before any audit or write", async () => {
  reset({ lineupRejection: '"claude-sonnet-5" is priced as Advanced, not Standard, so a guest could not pay for it.' });
  const { PATCH } = await loadRoute();
  const response = await PATCH(patch({ guestBrandTrioModelIds: LINEUP }));
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /not Standard/);
  assert.deepEqual(world.lineupWrites, []);
  assert.deepEqual(world.audits, []);
});

test("a lineup is never saved together with the feature flags", async () => {
  reset();
  const { PATCH } = await loadRoute();
  const response = await PATCH(
    patch({
      guestBrandTrioModelIds: LINEUP,
      aiChatEnabled: true,
      attachmentsEnabled: true,
      publicSharingEnabled: true,
      imageGenerationEnabled: false,
      externalConversationImportEnabled: false,
      externalConversationContinuationEnabled: false,
      chatStarterEnabled: false,
      assistantProfilesEnabled: false,
      assistantKnowledgeEnabled: false,
    })
  );
  assert.equal(response.status, 400);
  assert.deepEqual(world.lineupWrites, []);
  assert.deepEqual(world.audits, []);
});

test("a lineup that is not exactly three ids is refused by the schema", async () => {
  reset();
  const { PATCH } = await loadRoute();
  for (const lineup of [LINEUP.slice(0, 2), [...LINEUP, "mistral-small-4"]]) {
    const response = await PATCH(patch({ guestBrandTrioModelIds: lineup }));
    assert.equal(response.status, 400);
  }
  assert.deepEqual(world.rejectionCalls, []);
  assert.deepEqual(world.lineupWrites, []);
});

test("a lead-only save keeps its own path and action", async () => {
  reset();
  const { PATCH } = await loadRoute();
  const response = await PATCH(patch({ guestDefaultModelId: "claude-haiku-5-5" }));
  assert.equal(response.status, 200);
  assert.deepEqual(world.leadWrites, ["claude-haiku-5-5"]);
  assert.deepEqual(world.lineupWrites, []);
  assert.deepEqual(world.audits, [
    "app_settings.guest_default_model.update_started",
    "app_settings.guest_default_model.update_completed",
  ]);
});

test("a reader without ops:write cannot change the lineup", async () => {
  reset({ canWrite: false });
  const { PATCH } = await loadRoute();
  const response = await PATCH(patch({ guestBrandTrioModelIds: LINEUP }));
  assert.equal(response.status, 403);
  assert.deepEqual(world.lineupWrites, []);
});
