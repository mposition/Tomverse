// Read-only audit of the two "default model" decisions and every place each
// one is written down.
//
//   npm run check:default-models
//
// It reads. It never writes: no AppSetting is touched, no UserSettings row is
// created or updated, no reconciliation is run. Point it at production with a
// read-only DATABASE_URL and it will tell you what production actually does.
//
// Without a DATABASE_URL it still runs, against the compiled catalogue alone,
// and says so -- the compiled-vs-schema half of the audit does not need a
// database, and that half is what CI is for.
//
// Exit code 1 on any finding, so it can gate a release.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  APP_DEFAULTS,
  createGuestEligibilityCheck,
  GUEST_BRAND_TRIO_MODEL_IDS,
  resolveGuestDefaultSelectedModels,
} from "../lib/appDefaults.ts";
import {
  auditDefaultModels,
  parsePrismaFieldContract,
  parsePrismaStringDefault,
} from "../lib/defaultModelAuditCore.ts";
import { resolveNewConversationModels } from "../lib/newConversationModels.ts";
import { resolveGuestInitialSelectedModels } from "../lib/guestChatInitialModels.ts";
import {
  AVAILABLE_MODELS,
  canUseModelWithPlan,
  DEFAULT_MODEL_ID,
  getModelUsageProfile,
  isPubliclySelectableModel,
} from "../lib/models.ts";

const json = process.argv.includes("--json");
const databaseUrl = process.env.DATABASE_URL?.trim();

// ---------------------------------------------------------------------------
// The catalogue. A live registry when one is reachable, the compiled one
// otherwise -- the runtime rows are what a deployment actually serves, and an
// admin may have disabled a model the checked-in catalogue still lists.
// ---------------------------------------------------------------------------
let catalogueSource = "compiled_default";
let models = AVAILABLE_MODELS;
let storedGuestDefaultModelId = null;
let databaseNote =
  "No DATABASE_URL: the compiled catalogue was audited and no AppSetting was read.";

if (databaseUrl) {
  try {
    const { prisma } = await import("../lib/prisma.ts");
    const [rows, setting] = await Promise.all([
      prisma.modelRegistryEntry.findMany(),
      prisma.appSetting.findUnique({
        where: { key: "guestDefaultModelId" },
        select: { value: true },
      }),
    ]);
    if (rows.length > 0) {
      const { registryRowToModel } = await import("../lib/modelRegistry.ts");
      models = rows.map((row) => registryRowToModel(row));
      catalogueSource = "runtime_catalogue";
    }
    storedGuestDefaultModelId = setting?.value ?? null;
    databaseNote = `Read ${rows.length} runtime model row(s) and AppSetting["guestDefaultModelId"].`;
    await prisma.$disconnect().catch(() => undefined);
  } catch (error) {
    // Never print the connection string: Prisma echoes it in some errors.
    const message = String(error?.message || error).replaceAll(
      databaseUrl,
      "[redacted]"
    );
    databaseNote = `DATABASE_URL was set but unreadable, so the compiled catalogue was audited instead: ${message.slice(0, 200)}`;
  }
}

const byId = new Map(models.map((model) => [model.id, model]));
const lookup = (modelId) => byId.get(modelId);
const isGuestEligible = createGuestEligibilityCheck(lookup);
const isEnabled = (modelId) => {
  const model = lookup(modelId);
  return model ? isPubliclySelectableModel(model) : false;
};

// getPublicAppSettings()'s own rule, reproduced against whichever catalogue
// answered: a stored value that fails it is discarded in favour of the
// compiled guest default.
const storedIsUsable =
  storedGuestDefaultModelId !== null &&
  (() => {
    const model = lookup(storedGuestDefaultModelId);
    return Boolean(
      model &&
        isPubliclySelectableModel(model) &&
        canUseModelWithPlan("Guest", model) &&
        getModelUsageProfile(model).category === "Standard"
    );
  })();
const normalizedGuestDefaultModelId = storedIsUsable
  ? storedGuestDefaultModelId
  : APP_DEFAULTS.guestDefaultModelId;

const effectiveGuestSelectedModelIds = resolveGuestDefaultSelectedModels({
  isEligible: isGuestEligible,
  leadModelId: normalizedGuestDefaultModelId,
});

// Hydration: the same function the server calls with no browser, and the same
// one the client's first render calls with an empty browser. They must agree,
// because the composer's credit estimate is summed from whichever it gets.
const catalogue = { isEnabledModelId: isEnabled, isGuestEligible };
const ssrGuestSelectedModelIds = resolveGuestInitialSelectedModels({
  catalogue,
  leadModelId: normalizedGuestDefaultModelId,
}).models;
const hydratedGuestSelectedModelIds = resolveGuestInitialSelectedModels({
  catalogue,
  leadModelId: normalizedGuestDefaultModelId,
  environment: { search: "", sessionStorage: null, localStorage: null },
}).models;

// ---------------------------------------------------------------------------
// The schema and the route, read as text. Both are the value's home in their
// own right, and neither can be imported without a database or a Next server.
// ---------------------------------------------------------------------------
const schema = readFileSync(join(process.cwd(), "prisma/schema.prisma"), "utf8");
const prismaUserSettingsDefaultModel =
  parsePrismaStringDefault(schema, "UserSettings", "defaultModel") ?? "";
const rawConversationDefault =
  parsePrismaStringDefault(schema, "Conversation", "selectedModels") ?? "[]";
let prismaConversationSelectedModels = [];
try {
  const parsed = JSON.parse(rawConversationDefault);
  if (Array.isArray(parsed)) prismaConversationSelectedModels = parsed;
} catch {
  prismaConversationSelectedModels = [`unparseable:${rawConversationDefault}`];
}

// app/api/user/settings/route.ts creates a missing row with
// `defaultModel: APP_DEFAULTS.defaultModelId`. Asserted from the source rather
// than assumed, because that literal is the only thing tying the row it
// creates to the column default beside it.
const settingsRoute = readFileSync(
  join(process.cwd(), "app/api/user/settings/route.ts"),
  "utf8"
);
const userSettingsCreateDefaultModel =
  /defaultModel:\s*APP_DEFAULTS\.defaultModelId/.test(settingsRoute)
    ? APP_DEFAULTS.defaultModelId
    : (/defaultModel:\s*"([^"]+)"/.exec(settingsRoute)?.[1] ??
      "unknown (app/api/user/settings/route.ts creates the row from something else)");

// ---------------------------------------------------------------------------
// C. The signed-in new-conversation combination: schema contract, the routes
//    and the client read as text, plus resolver fixtures run against the same
//    catalogue as the rest of the audit.
// ---------------------------------------------------------------------------
const modelFinderRoute = readFileSync(
  join(process.cwd(), "app/api/user/model-finder/route.ts"),
  "utf8"
);
// The conversation creation path, which POST /api/conversations delegates to
// since it was parameterised by product (decision record v1.2 §6). The two
// product-specific endpoints call the same handler, so reading it here covers
// all three rather than one.
const conversationsRoute = readFileSync(
  join(process.cwd(), "lib/conversationCreateHandler.ts"),
  "utf8"
);
const chatPageClient = readFileSync(
  join(process.cwd(), "app/(site)/(application)/chat/ChatPageClient.tsx"),
  "utf8"
);
// The one wrapper the create path is allowed to reach the resolver through.
//
// `lib/newConversationSelectedModels.ts` exists because external continuation
// starts a Review conversation from the same saved combination
// (docs/policy/external-conversation-continuation.md §8.3), and two writers
// each spelling out `resolveNewConversationModels` then `clampRuntimeSelectedModels`
// is exactly the drift this section checks for. So the wrapper is accepted --
// and is itself required to reach the resolver, or "shared" would mean nothing
// more than "imports a file with a promising name".
const sharedStartState = readFileSync(
  join(process.cwd(), "lib/newConversationSelectedModels.ts"),
  "utf8"
);
const sharedStartStateUsesResolver = /lib\/newConversationModels/.test(
  sharedStartState
);

const resolveFixture = (stored) =>
  resolveNewConversationModels({
    stored,
    defaultModel: DEFAULT_MODEL_ID,
    models,
    plan: "Free",
  });
const nullFixture = resolveFixture(null);
const malformedFixture = resolveFixture("not-an-array");
const truncationFixture = resolveFixture([
  ...GUEST_BRAND_TRIO_MODEL_IDS,
  "model-that-does-not-exist",
]);
const leadFixture = resolveFixture([...GUEST_BRAND_TRIO_MODEL_IDS]);

const newConversation = {
  prismaColumn: parsePrismaFieldContract(
    schema,
    "UserSettings",
    "newConversationModelIds"
  ),
  settingsRouteUsesResolver: /lib\/newConversationModels/.test(settingsRoute),
  settingsRouteRewritesOnRead: /userSettings\.update\(/.test(settingsRoute),
  modelFinderSavesCombination: /newConversationModelIds:/.test(modelFinderRoute),
  modelFinderEchoesRequest: /modelIds:\s*body\.modelIds/.test(modelFinderRoute),
  conversationsRouteUsesResolver:
    /lib\/newConversationModels/.test(conversationsRoute) ||
    (/lib\/newConversationSelectedModels/.test(conversationsRoute) &&
      sharedStartStateUsesResolver),
  clientNewChatUsesSingleDefault:
    /setSelectedModels\(\[userDefaultEngine\]\)/.test(chatPageClient),
  resolverNullFallsBack:
    nullFixture.storedModelIds === null &&
    nullFixture.effectiveModelIds.length === 1 &&
    nullFixture.effectiveModelIds[0] === DEFAULT_MODEL_ID,
  resolverMalformedFallsBack:
    malformedFixture.storedModelIds === null &&
    malformedFixture.reasons.includes("stored_value_malformed") &&
    malformedFixture.effectiveModelIds[0] === DEFAULT_MODEL_ID,
  resolverTruncatesToMax:
    truncationFixture.reasons.includes("over_limit_truncated") &&
    truncationFixture.effectiveModelIds.length <= 3,
  resolverLeadMatchesEffectiveDefault:
    leadFixture.effectiveDefaultModelId === leadFixture.effectiveModelIds[0],
};

const interesting = Array.from(
  new Set([
    ...GUEST_BRAND_TRIO_MODEL_IDS,
    ...effectiveGuestSelectedModelIds,
    ...(storedGuestDefaultModelId ? [storedGuestDefaultModelId] : []),
    normalizedGuestDefaultModelId,
    DEFAULT_MODEL_ID,
    APP_DEFAULTS.defaultModelId,
    prismaUserSettingsDefaultModel,
    ...prismaConversationSelectedModels,
  ])
).filter(Boolean);

const modelStates = interesting.map((modelId) => {
  const model = lookup(modelId);
  return {
    modelId,
    known: Boolean(model),
    enabled: Boolean(model?.enabled),
    publiclyListed: model?.publiclyListed !== false,
    catalogDeleted: model?.catalogDeleted === true,
    guestEligible: isGuestEligible(modelId),
    usageCategory: model ? getModelUsageProfile(model).category : null,
  };
});

const report = auditDefaultModels({
  storedGuestDefaultModelId,
  normalizedGuestDefaultModelId,
  effectiveGuestSelectedModelIds,
  guestBrandTrioModelIds: GUEST_BRAND_TRIO_MODEL_IDS,
  defaultModelId: DEFAULT_MODEL_ID,
  appDefaultsDefaultModelId: APP_DEFAULTS.defaultModelId,
  prismaUserSettingsDefaultModel,
  prismaConversationSelectedModels,
  userSettingsCreateDefaultModel,
  ssrGuestSelectedModelIds,
  hydratedGuestSelectedModelIds,
  modelStates,
  newConversation,
});

if (json) {
  console.log(
    JSON.stringify(
      { catalogueSource, databaseNote, ...report, ok: report.ok },
      null,
      2
    )
  );
} else {
  const line = (label, value, source) =>
    `  ${label.padEnd(38)} ${JSON.stringify(value)}   [${source}]`;

  console.log("Default model audit\n");
  console.log(`  catalogue: ${catalogueSource}`);
  console.log(`  ${databaseNote}\n`);

  console.log("A. Guest first conversation");
  console.log(
    line(
      "storedGuestDefaultModelId",
      report.guest.storedGuestDefaultModelId.value,
      report.guest.storedGuestDefaultModelId.source
    )
  );
  console.log(
    line(
      "normalizedGuestDefaultModelId",
      report.guest.normalizedGuestDefaultModelId.value,
      report.guest.normalizedGuestDefaultModelId.source
    )
  );
  console.log(
    line(
      "effectiveGuestSelectedModelIds",
      report.guest.effectiveGuestSelectedModelIds.value,
      report.guest.effectiveGuestSelectedModelIds.source
    )
  );
  console.log(
    `  ${"storedSettingApplied".padEnd(38)} ${report.guest.storedSettingApplied}` +
      (report.guest.storedGuestDefaultModelId.value === null
        ? "   (no AppSetting row; the compiled default leads)"
        : "")
  );
  console.log(`  ${"guestBrandTrio".padEnd(38)} ${JSON.stringify(GUEST_BRAND_TRIO_MODEL_IDS)}   [compiled_default]`);

  console.log("\nB. Newly signed-in account");
  for (const [label, entry] of Object.entries(report.authenticated)) {
    console.log(line(label, entry.value, entry.source));
  }

  console.log("\nC. Signed-in new conversation combination");
  console.log(
    line(
      "prismaColumn",
      report.newConversation.prismaColumn,
      "prisma_schema"
    )
  );
  for (const [label, value] of Object.entries(report.newConversation)) {
    if (label === "prismaColumn") continue;
    console.log(`  ${label.padEnd(38)} ${value}`);
  }

  console.log("\nRuntime state");
  for (const state of report.modelStates) {
    console.log(
      `  ${state.modelId.padEnd(24)} known=${state.known} enabled=${state.enabled} ` +
        `publiclyListed=${state.publiclyListed} catalogDeleted=${state.catalogDeleted} ` +
        `guestEligible=${state.guestEligible} usage=${state.usageCategory ?? "-"}`
    );
  }

  console.log("\nHydration");
  console.log(line("ssrGuestSelectedModelIds", ssrGuestSelectedModelIds, "runtime_catalogue"));
  console.log(
    line("hydratedGuestSelectedModelIds", hydratedGuestSelectedModelIds, "runtime_catalogue")
  );
}

if (!report.ok) {
  console.error(`\n${report.findings.length} finding(s):`);
  for (const finding of report.findings) {
    console.error(`  - [${finding.code}] ${finding.message}`);
  }
  console.error(
    "\nA guest AppSetting and a signed-in account's default are separate decisions;\n" +
      "see docs/policy/default-model-luna-migration.md before changing either."
  );
  process.exit(1);
}

console.log("\nDefault model audit passed.");
