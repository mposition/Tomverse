import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

// Server-side contract for §14.0: binding an assistant profile to an existing
// conversation must not touch its model selection.
//
// `ProfileBindingPlan` carries the version's `modelIds`, and the create route
// applies them. PATCH deliberately does not: replacing an existing
// conversation's models would change its per-turn credit cost, its answer
// characteristics and its panel layout at once, and choosing an assistant is
// not a request for any of that (#643).
//
// This is also the boundary #632 broke from the other side. There the client
// applied `selectedModels` out of the PATCH *response*, which was never an
// adoption -- just the stored selection echoed back -- and a delayed response
// wrote one conversation's models onto another's. The fix removed that reader;
// this test pins the writer, so a later change cannot quietly reintroduce the
// adoption on the server and leave the same field moving again.
//
// Asserted on the Prisma update payload rather than on a response body,
// because "did not write" is the contract. A route that wrote the models and
// then happened to answer with the same values would pass a response check.

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relativePath: string) =>
  pathToFileURL(resolve(ROOT, relativePath)).href;

process.env.E2E_DISABLE_DATABASE = "true";
process.env.DATABASE_URL ||=
  "postgresql://e2e:e2e@127.0.0.1:1/e2e?connect_timeout=1";
process.env.DIRECT_URL ||= process.env.DATABASE_URL;
process.env.NEXTAUTH_SECRET ||= "server-contract-test-secret";
process.env.NEXTAUTH_URL ||= "http://127.0.0.1:3100";

const SESSION_USER_ID = "qa-user-1";
const CONVERSATION_ID = "qa-conversation-643";
const PROFILE_ID = "qa-profile";
const PROFILE_VERSION_ID = "qa-profile-version-3";
/** What the conversation already has, and must keep. */
const STORED_SELECTED_MODELS = ["gpt-5-4-mini", "claude-haiku-4-5"];
const STORED_DISABLED_PANELS = ["claude-haiku-4-5"];
/** What the profile version names -- deliberately different from the above. */
const PROFILE_MODEL_IDS = ["gemini-2-5-flash"];

type UpdateCall = { data: Record<string, unknown> };
const updateCalls: UpdateCall[] = [];

const conversationRow = {
  id: CONVERSATION_ID,
  userId: SESSION_USER_ID,
  title: "QA conversation",
  password: null,
  selectedModels: JSON.stringify(STORED_SELECTED_MODELS),
  disabledPanels: JSON.stringify(STORED_DISABLED_PANELS),
  webSearchMode: "off",
  memoryMode: "inherit",
  assistantProfileVersionId: "qa-other-version",
  assistantProfileVersion: { profileId: "qa-other-profile" },
  projectId: null,
  shareEnabled: false,
  shareExpiresAt: null,
  shareRevokedAt: null,
  routerModelId: null,
  routerChallengerTurns: 0,
  selectionMode: "manual",
};

let mocksInstalled = false;

async function loadRoute() {
  if (!mocksInstalled) {
    mocksInstalled = true;

    mock.module("next-auth/next", {
      namedExports: {
        getServerSession: async () => ({
          user: { id: SESSION_USER_ID, email: "qa@tomverse.app" },
        }),
      },
    });

    mock.module(mod("lib/prisma.ts"), {
      namedExports: {
        prisma: {
          conversation: {
            findUnique: async () => ({ ...conversationRow }),
            update: async ({ data }: { data: Record<string, unknown> }) => {
              updateCalls.push({ data });
              return { ...conversationRow, ...data };
            },
          },
          assistantProfile: {
            findFirst: async () => ({
              id: PROFILE_ID,
              currentVersionId: PROFILE_VERSION_ID,
              currentVersion: { revision: 3, models: PROFILE_MODEL_IDS },
            }),
          },
          userSettings: {
            findUnique: async () => ({ defaultModel: "gpt-5-4-mini" }),
          },
          // The profiles feature flag, read by resolveProfileBinding.
          appSetting: {
            findUnique: async () => ({ value: "true" }),
          },
        },
      },
    });

    // Feature flags short-circuit to false whenever the database is disabled,
    // which would refuse the binding as `flag_off` long before the branch this
    // test is about.
    mock.module(mod("lib/appSettings.ts"), {
      namedExports: {
        ...(await import(mod("lib/appSettings.ts"))),
        isAssistantProfilesEnabled: async () => true,
      },
    });

    // Rate limiting and the lock/audit side-effects are not what this asserts.
    const realApiSecurity = await import(mod("lib/apiSecurity.ts"));
    mock.module(mod("lib/apiSecurity.ts"), {
      namedExports: {
        ...realApiSecurity,
        consumeApiRateLimit: async () => undefined,
      },
    });

    // Runtime model clamping reads the registry from the database; the stored
    // selection is already valid for this fixture.
    // The account's plan decides the model limit; read without a database.
    mock.module(mod("lib/billingEntitlements.ts"), {
      namedExports: {
        ...(await import(mod("lib/billingEntitlements.ts"))),
        getUserBillingPlan: async () => ({ id: "free", modelLimit: 3 }),
      },
    });

    mock.module(mod("lib/modelRegistry.ts"), {
      namedExports: {
        clampRuntimeSelectedModels: async (ids: string[]) => ids,
        isEnabledRuntimeModelId: async () => true,
      },
    });

    mock.module(mod("lib/conversationProfileService.ts"), {
      namedExports: {
        ...(await import(mod("lib/conversationProfileService.ts"))),
        readConversationProfile: async () => ({
          profileId: PROFILE_ID,
          name: "QA profile",
          icon: null,
          revision: 3,
          latestRevision: 3,
          status: "current" as const,
        }),
      },
    });
  }

  return (await import(mod("app/api/conversations/[conversationId]/route.ts"))) as {
    PATCH: (
      req: Request,
      context: { params: Promise<{ conversationId: string }> }
    ) => Promise<Response>;
  };
}

const patch = async (body: unknown) => {
  const { PATCH } = await loadRoute();
  return PATCH(
    new Request(`http://127.0.0.1:3100/api/conversations/${CONVERSATION_ID}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ conversationId: CONVERSATION_ID }) }
  );
};

test("binding a profile writes the profile version and no model settings", async () => {
  updateCalls.length = 0;
  const response = await patch({ assistantProfileId: PROFILE_ID });
  assert.equal(response.status, 200);

  assert.equal(updateCalls.length, 1, "exactly one conversation update");
  const { data } = updateCalls[0];

  assert.ok(
    "assistantProfileVersion" in data,
    "the binding itself must be written"
  );
  // The whole point: the profile's own models are known here and are not used.
  assert.equal(
    "selectedModels" in data,
    false,
    "binding must not write selectedModels"
  );
  assert.equal(
    "disabledPanels" in data,
    false,
    "binding must not write disabledPanels"
  );
});

test("the response reports the conversation's own selection, not the profile's", async () => {
  updateCalls.length = 0;
  const response = await patch({ assistantProfileId: PROFILE_ID });
  const body = (await response.json()) as {
    selectedModels: string[];
    disabledPanels: string[];
  };

  // A client that reads this field must see what the conversation already had.
  // #632 is what happens when this is mistaken for an adoption.
  assert.deepEqual(body.selectedModels, STORED_SELECTED_MODELS);
  assert.deepEqual(body.disabledPanels, STORED_DISABLED_PANELS);
  assert.equal(
    body.selectedModels.includes(PROFILE_MODEL_IDS[0]),
    false,
    "the profile's model must not appear in the answer"
  );
});

test("detaching a profile also leaves the model selection alone", async () => {
  updateCalls.length = 0;
  const response = await patch({ assistantProfileId: null });
  assert.equal(response.status, 200);

  assert.equal(updateCalls.length, 1);
  const { data } = updateCalls[0];
  assert.ok("assistantProfileVersion" in data, "the detach must be written");
  assert.equal("selectedModels" in data, false);
  assert.equal("disabledPanels" in data, false);
});

test("a request that does name models still writes them", async () => {
  // Guards the assertion above from becoming vacuous: the route has not simply
  // stopped writing model settings, it stops writing them *for a binding*.
  updateCalls.length = 0;
  const response = await patch({ selectedModels: ["gemini-2-5-flash"] });
  assert.equal(response.status, 200);

  assert.equal(updateCalls.length, 1);
  assert.ok("selectedModels" in updateCalls[0].data);
});
