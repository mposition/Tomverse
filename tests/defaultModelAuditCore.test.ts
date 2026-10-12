import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  APP_DEFAULTS,
  createGuestEligibilityCheck,
  GUEST_BRAND_TRIO_MODEL_IDS,
  GUEST_FALLBACK_MODEL_IDS,
  GUEST_LINEUP_PROVIDERS,
  resolveGuestDefaultSelectedModels,
} from "@/lib/appDefaults";
import {
  auditDefaultModels,
  parsePrismaFieldContract,
  parsePrismaStringDefault,
  type DefaultModelAuditInput,
  type NewConversationAuditInput,
} from "@/lib/defaultModelAuditCore";
import { DEFAULT_MODEL_ID, getModel, getModelUsageProfile } from "@/lib/models";

// Two decisions that get mistaken for each other constantly:
//
//   A. AppSetting["guestDefaultModelId"] -- which brand-trio model leads a
//      guest's first comparison. Touches no account.
//   B. DEFAULT_MODEL_ID -- what a newly signed-in account gets, spelled out
//      in three places in code that nothing else reads together, and in no
//      column default (dropped 2026-10-12).
//
// These lock down the audit that keeps them apart, and then apply it to the
// real catalogue so the repository itself has to stay consistent.

const isGuestEligible = createGuestEligibilityCheck(getModel);

const stateFor = (modelId: string) => {
  const model = getModel(modelId);
  return {
    modelId,
    known: Boolean(model),
    enabled: Boolean(model?.enabled),
    publiclyListed: model?.publiclyListed !== false,
    catalogDeleted: model?.catalogDeleted === true,
    guestEligible: isGuestEligible(modelId),
    usageCategory: model ? getModelUsageProfile(model).category : null,
  };
};

const healthyNewConversation = (
  overrides: Partial<NewConversationAuditInput> = {}
): NewConversationAuditInput => ({
  prismaColumn: { present: true, nullable: true, hasDefault: false },
  settingsRouteUsesResolver: true,
  settingsRouteRewritesOnRead: false,
  modelFinderSavesCombination: true,
  modelFinderEchoesRequest: false,
  conversationsRouteUsesResolver: true,
  clientNewChatUsesSingleDefault: false,
  resolverNullFallsBack: true,
  resolverMalformedFallsBack: true,
  resolverTruncatesToMax: true,
  resolverLeadMatchesEffectiveDefault: true,
  ...overrides,
});

const healthyInput = (
  overrides: Partial<DefaultModelAuditInput> = {}
): DefaultModelAuditInput => {
  const selection = resolveGuestDefaultSelectedModels({
    isEligible: isGuestEligible,
  });
  return {
    newConversation: healthyNewConversation(),
    storedGuestDefaultModelId: null,
    normalizedGuestDefaultModelId: APP_DEFAULTS.guestDefaultModelId,
    effectiveGuestSelectedModelIds: selection,
    guestBrandTrioModelIds: GUEST_BRAND_TRIO_MODEL_IDS,
    defaultModelId: DEFAULT_MODEL_ID,
    appDefaultsDefaultModelId: APP_DEFAULTS.defaultModelId,
    prismaUserSettingsDefaultModel: null,
    prismaConversationSelectedModels: null,
    userSettingsCreateDefaultModel: APP_DEFAULTS.defaultModelId,
    ssrGuestSelectedModelIds: selection,
    hydratedGuestSelectedModelIds: selection,
    modelStates: Array.from(
      new Set([...selection, DEFAULT_MODEL_ID, ...GUEST_BRAND_TRIO_MODEL_IDS])
    ).map(stateFor),
    ...overrides,
  };
};

const codes = (input: DefaultModelAuditInput) =>
  auditDefaultModels(input).findings.map((finding) => finding.code);

test("the repository as it stands passes the audit", () => {
  const report = auditDefaultModels(healthyInput());
  assert.deepEqual(report.findings, []);
  assert.equal(report.ok, true);
  assert.equal(report.guest.storedSettingApplied, true);
});

test("an AppSetting inside the trio is reported as applied when it leads", () => {
  const lead = GUEST_BRAND_TRIO_MODEL_IDS[1];
  const selection = resolveGuestDefaultSelectedModels({
    isEligible: isGuestEligible,
    leadModelId: lead,
  });
  const report = auditDefaultModels(
    healthyInput({
      storedGuestDefaultModelId: lead,
      normalizedGuestDefaultModelId: lead,
      effectiveGuestSelectedModelIds: selection,
      ssrGuestSelectedModelIds: selection,
      hydratedGuestSelectedModelIds: selection,
    })
  );
  assert.equal(report.guest.leadModelId, lead);
  assert.equal(report.guest.storedSettingApplied, true);
  assert.deepEqual(report.findings, []);
});

test("a retired lead that was succeeded in its slot is applied, not ignored", () => {
  // The stored lead was a lineup member; it was retired and its successor now
  // leads. That is the setting doing its job, so the audit must not call it
  // "saved and then silently ignored".
  const stored = GUEST_BRAND_TRIO_MODEL_IDS[1];
  const successor = "claude-haiku-4-5";
  assert.equal(isGuestEligible(successor), true, "the fixture successor must be guest-usable");
  const selection = [successor, GUEST_BRAND_TRIO_MODEL_IDS[0], GUEST_BRAND_TRIO_MODEL_IDS[2]];
  const input = healthyInput({
    storedGuestDefaultModelId: stored,
    normalizedGuestDefaultModelId: stored,
    effectiveGuestSelectedModelIds: selection,
    ssrGuestSelectedModelIds: selection,
    hydratedGuestSelectedModelIds: selection,
    modelStates: [...selection, DEFAULT_MODEL_ID, stored].map(stateFor),
  });

  const succeeded = auditDefaultModels({ ...input, storedGuestLeadExpectedId: successor });
  assert.equal(succeeded.guest.storedSettingApplied, true);
  assert.ok(!succeeded.findings.some((finding) => finding.code === "guest_setting_not_applied"));

  // Without the expected id the same selection reads as ignored -- the defect.
  assert.ok(codes(input).includes("guest_setting_not_applied"));
  // A different expected lead is still a finding, and names the successor.
  const wrong = auditDefaultModels({ ...input, storedGuestLeadExpectedId: "gpt-5-6-luna" });
  const finding = wrong.findings.find((entry) => entry.code === "guest_setting_not_applied");
  assert.ok(finding);
  assert.match(finding.message, /succeeded by "gpt-5-6-luna"/);
});

test("a guest selection without one model from each provider is reported", () => {
  const required = [...GUEST_LINEUP_PROVIDERS];
  assert.ok(
    !codes(
      healthyInput({ guestLineupProviders: { required, effective: ["openai", "anthropic", "google"] } })
    ).includes("guest_lineup_provider_missing")
  );
  const report = auditDefaultModels(
    healthyInput({ guestLineupProviders: { required, effective: ["openai", "google", "deepseek"] } })
  );
  const finding = report.findings.find((entry) => entry.code === "guest_lineup_provider_missing");
  assert.ok(finding);
  assert.match(finding.message, /missing or doubling anthropic/);
  // Absent input skips the check rather than guessing providers.
  assert.ok(!codes(healthyInput()).includes("guest_lineup_provider_missing"));
});

test("a stored value outside the trio is a silent no-op, and is reported as one", () => {
  // The whole reason this check exists: the write succeeded, the value reads
  // back, /api/app-settings serves it, and the guest screen never changes.
  const outsider = GUEST_FALLBACK_MODEL_IDS[0];
  assert.equal(
    isGuestEligible(outsider),
    true,
    "the fixture must be a model that passes every eligibility rule"
  );
  const selection = resolveGuestDefaultSelectedModels({
    isEligible: isGuestEligible,
    leadModelId: outsider,
  });
  assert.notEqual(selection[0], outsider);

  const report = auditDefaultModels(
    healthyInput({
      storedGuestDefaultModelId: outsider,
      normalizedGuestDefaultModelId: outsider,
      effectiveGuestSelectedModelIds: selection,
      ssrGuestSelectedModelIds: selection,
      hydratedGuestSelectedModelIds: selection,
      modelStates: [...selection, DEFAULT_MODEL_ID, outsider].map(stateFor),
    })
  );
  assert.equal(report.guest.storedSettingApplied, false);
  assert.deepEqual(
    report.findings.map((finding) => finding.code),
    ["guest_setting_not_applied"]
  );
  assert.match(report.findings[0].message, /saved and then silently ignored/);
});

test("a disabled, delisted or catalogue-deleted guest lead fails", () => {
  for (const broken of [
    { enabled: false },
    { publiclyListed: false },
    { catalogDeleted: true },
    { known: false },
    { guestEligible: false },
  ]) {
    const lead = GUEST_BRAND_TRIO_MODEL_IDS[0];
    const report = auditDefaultModels(
      healthyInput({
        modelStates: [
          { ...stateFor(lead), ...broken },
          stateFor(DEFAULT_MODEL_ID),
        ],
      })
    );
    assert.ok(
      report.findings.some(
        (finding) => finding.code === "guest_default_not_selectable"
      ),
      JSON.stringify(broken)
    );
  }
});

test("a guest lead that is not Standard fails -- a guest cannot pay for it", () => {
  const lead = GUEST_BRAND_TRIO_MODEL_IDS[0];
  const report = auditDefaultModels(
    healthyInput({
      modelStates: [
        { ...stateFor(lead), usageCategory: "Premium" },
        stateFor(DEFAULT_MODEL_ID),
      ],
    })
  );
  assert.ok(
    report.findings.some(
      (finding) => finding.code === "guest_default_not_standard"
    )
  );
});

test("the code spellings of the signed-in default must agree, and no column default may name a model", () => {
  assert.deepEqual(
    codes(healthyInput({ appDefaultsDefaultModelId: "gpt-5-4-mini" })),
    ["compiled_defaults_disagree"]
  );
  // Even a column default equal to DEFAULT_MODEL_ID is refused: it is a
  // second copy that only a migration can move.
  assert.deepEqual(
    codes(healthyInput({ prismaUserSettingsDefaultModel: DEFAULT_MODEL_ID })),
    ["prisma_column_default_names_model"]
  );
  assert.deepEqual(
    codes(healthyInput({ prismaConversationSelectedModels: [DEFAULT_MODEL_ID] })),
    ["prisma_column_default_names_model"]
  );
  assert.deepEqual(
    codes(healthyInput({ userSettingsCreateDefaultModel: "gpt-5-4-mini" })),
    ["user_settings_create_disagrees"]
  );
});

test("a signed-in default that cannot be offered fails", () => {
  const report = auditDefaultModels(
    healthyInput({
      modelStates: [{ ...stateFor(DEFAULT_MODEL_ID), enabled: false }],
    })
  );
  assert.ok(
    report.findings.some((finding) => finding.code === "default_model_unusable")
  );
});

test("a guest selection that changes across hydration fails", () => {
  const selection = resolveGuestDefaultSelectedModels({
    isEligible: isGuestEligible,
  });
  assert.deepEqual(
    codes(
      healthyInput({
        hydratedGuestSelectedModelIds: [...selection].reverse(),
      })
    ),
    ["guest_hydration_mismatch"]
  );
});

test("changing the guest AppSetting cannot change any account's default", () => {
  // Structural, not incidental: the audit's authenticated half is computed
  // from inputs the guest half never feeds, so no stored guest value can move
  // it. Asserted by varying the guest setting across every trio member and an
  // outsider and watching the account side stay put.
  const baseline = auditDefaultModels(healthyInput()).authenticated;
  for (const lead of [...GUEST_BRAND_TRIO_MODEL_IDS, GUEST_FALLBACK_MODEL_IDS[0]]) {
    const selection = resolveGuestDefaultSelectedModels({
      isEligible: isGuestEligible,
      leadModelId: lead,
    });
    const report = auditDefaultModels(
      healthyInput({
        storedGuestDefaultModelId: lead,
        normalizedGuestDefaultModelId: lead,
        effectiveGuestSelectedModelIds: selection,
        ssrGuestSelectedModelIds: selection,
        hydratedGuestSelectedModelIds: selection,
        modelStates: [...selection, DEFAULT_MODEL_ID, lead].map(stateFor),
      })
    );
    assert.deepEqual(report.authenticated, baseline, lead);
  }
});

test("the schema is read from schema.prisma, not assumed, and names no default model", () => {
  const schema = readFileSync(
    join(process.cwd(), "prisma/schema.prisma"),
    "utf8"
  );
  for (const [model, field] of [
    ["UserSettings", "defaultModel"],
    ["Conversation", "selectedModels"],
  ]) {
    assert.deepEqual(
      parsePrismaFieldContract(schema, model, field),
      { present: true, nullable: false, hasDefault: false },
      `${model}.${field} must stay NOT NULL with no column default`
    );
    assert.equal(parsePrismaStringDefault(schema, model, field), null);
  }
  // A field with no default is not read together with the next field: the
  // parser once took disabledPanels' @default("[]") for selectedModels'.
  const noDefaultThenDefault = `model Conversation {
  selectedModels String
  disabledPanels String @default("[]")
}`;
  assert.equal(parsePrismaStringDefault(noDefaultThenDefault, "Conversation", "selectedModels"), null);
  assert.equal(
    parsePrismaFieldContract(noDefaultThenDefault, "Conversation", "selectedModels").hasDefault,
    false
  );
  assert.equal(parsePrismaStringDefault(noDefaultThenDefault, "Conversation", "disabledPanels"), "[]");
  // The parser still reads a default when there is one.
  const withDefault = `model UserSettings {
  defaultModel String @default("gpt-6-luna")
}`;
  assert.equal(parsePrismaStringDefault(withDefault, "UserSettings", "defaultModel"), "gpt-6-luna");
  assert.equal(parsePrismaFieldContract(withDefault, "UserSettings", "defaultModel").hasDefault, true);
  assert.equal(
    parsePrismaStringDefault(schema, "UserSettings", "notAField"),
    null
  );
  assert.equal(
    parsePrismaStringDefault(schema, "NotAModel", "defaultModel"),
    null
  );
});

test("app/api/user/settings/route.ts creates a row from the compiled default", () => {
  // The column default and the row the application creates are two separate
  // writes of the same value; only this literal ties them together.
  const route = readFileSync(
    join(process.cwd(), "app/api/user/settings/route.ts"),
    "utf8"
  );
  assert.match(route, /defaultModel:\s*APP_DEFAULTS\.defaultModelId/);
  assert.equal(APP_DEFAULTS.defaultModelId, DEFAULT_MODEL_ID);
});

// ---------------------------------------------------------------------------
// C. The signed-in new-conversation combination (policy §1.2).
// ---------------------------------------------------------------------------

test("a healthy section C produces no findings", () => {
  assert.deepEqual(codes(healthyInput()), []);
});

test("the combination column must exist, stay nullable and carry no default", () => {
  assert.deepEqual(
    codes(
      healthyInput({
        newConversation: healthyNewConversation({
          prismaColumn: { present: false, nullable: false, hasDefault: false },
        }),
      })
    ),
    ["new_conversation_column_missing"]
  );
  assert.deepEqual(
    codes(
      healthyInput({
        newConversation: healthyNewConversation({
          prismaColumn: { present: true, nullable: false, hasDefault: true },
        }),
      })
    ),
    [
      "new_conversation_column_not_nullable",
      "new_conversation_column_has_default",
    ]
  );
});

test("a read path that rewrites the row is a finding", () => {
  assert.deepEqual(
    codes(
      healthyInput({
        newConversation: healthyNewConversation({
          settingsRouteRewritesOnRead: true,
        }),
      })
    ),
    ["new_conversation_read_path_rewrites"]
  );
});

test("every interpreter must go through the shared resolver", () => {
  assert.deepEqual(
    codes(
      healthyInput({
        newConversation: healthyNewConversation({
          settingsRouteUsesResolver: false,
        }),
      })
    ),
    ["new_conversation_resolver_not_shared"]
  );
  assert.deepEqual(
    codes(
      healthyInput({
        newConversation: healthyNewConversation({
          conversationsRouteUsesResolver: false,
        }),
      })
    ),
    ["new_conversation_resolver_not_shared"]
  );
});

test("the model finder must persist the combination and never echo the request", () => {
  assert.deepEqual(
    codes(
      healthyInput({
        newConversation: healthyNewConversation({
          modelFinderSavesCombination: false,
          modelFinderEchoesRequest: true,
        }),
      })
    ),
    [
      "new_conversation_write_paths_desynced",
      "new_conversation_response_echoes_request",
    ]
  );
});

test("a client that still starts new chats from one model is a finding", () => {
  assert.deepEqual(
    codes(
      healthyInput({
        newConversation: healthyNewConversation({
          clientNewChatUsesSingleDefault: true,
        }),
      })
    ),
    ["new_conversation_client_single_model_init"]
  );
});

test("each broken resolver fixture is its own finding", () => {
  assert.deepEqual(
    codes(
      healthyInput({
        newConversation: healthyNewConversation({
          resolverNullFallsBack: false,
          resolverTruncatesToMax: false,
        }),
      })
    ),
    ["new_conversation_fallback_broken", "new_conversation_fallback_broken"]
  );
});

test("parsePrismaFieldContract reads the real column's contract", () => {
  const schema = readFileSync(
    join(process.cwd(), "prisma/schema.prisma"),
    "utf8"
  );
  assert.deepEqual(
    parsePrismaFieldContract(schema, "UserSettings", "newConversationModelIds"),
    { present: true, nullable: true, hasDefault: false }
  );
  // A non-nullable defaulted column for contrast. (It was defaultModel until
  // that column's default was dropped on 2026-10-12.)
  assert.deepEqual(
    parsePrismaFieldContract(schema, "UserSettings", "theme"),
    { present: true, nullable: false, hasDefault: true }
  );
  assert.deepEqual(
    parsePrismaFieldContract(schema, "UserSettings", "notAField"),
    { present: false, nullable: false, hasDefault: false }
  );
});
