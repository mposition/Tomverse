/**
 * Reconciles the two completely separate "default model" decisions this
 * application makes, and reports every place each of them is written down.
 *
 * They are constantly confused for each other, so the split is the whole point
 * of this module:
 *
 *   A. **A guest's first conversation.** `AppSetting["guestDefaultModelId"]`,
 *      read by `getPublicAppSettings()`, chooses which of the three brand-trio
 *      models *leads* the guest's default selection. It does not add a model,
 *      it does not remove one, and it has no bearing whatsoever on any signed-in
 *      account.
 *
 *   B. **A newly signed-in account.** `DEFAULT_MODEL_ID` ->
 *      `APP_DEFAULTS.defaultModelId` -> the `UserSettings.defaultModel` column
 *      default -> the row `app/api/user/settings/route.ts` creates on first
 *      read -> the fallback for a new conversation. Four spellings of one
 *      value, in code and in the schema, which drift apart silently because
 *      nothing reads both.
 *
 * Kept pure and injected so the same rules can be applied to the compiled
 * catalogue, to a live database, and to a fixture in a test. The script at
 * scripts/check-default-models.mjs supplies the real inputs.
 */

export type DefaultModelSource =
  | "app_setting"
  | "compiled_default"
  | "prisma_schema"
  | "runtime_catalogue";

export type DefaultModelValue<T> = {
  value: T;
  source: DefaultModelSource;
};

export type ModelStateSnapshot = {
  modelId: string;
  /** Absent from the runtime catalogue entirely. */
  known: boolean;
  enabled: boolean;
  publiclyListed: boolean;
  catalogDeleted: boolean;
  /** Whether a signed-out visitor's plan may select it. */
  guestEligible: boolean;
  /** The usage class the credit table prices it under, e.g. "Standard". */
  usageCategory: string | null;
};

/**
 * C. **A signed-in account's new-conversation combination.** The third,
 *    independent decision (docs/policy/default-model-luna-migration.md §1.2):
 *    `UserSettings.newConversationModelIds` (nullable JSON, no default, no
 *    backfill), interpreted only by lib/newConversationModels.ts. NULL means
 *    [defaultModel]; write paths persist the combination and its lead in one
 *    transaction; the read path never rewrites the stored value.
 *
 *    The booleans here are computed by the script -- source-text checks over
 *    the routes and the client, plus resolver fixtures run against the same
 *    catalogue as the rest of the audit -- and judged here so a test can
 *    exercise the rules without a filesystem.
 */
export type NewConversationAuditInput = {
  /** The schema contract of UserSettings.newConversationModelIds. */
  prismaColumn: { present: boolean; nullable: boolean; hasDefault: boolean };
  /** app/api/user/settings/route.ts goes through the shared resolver. */
  settingsRouteUsesResolver: boolean;
  /** The settings route still updates UserSettings during a read. */
  settingsRouteRewritesOnRead: boolean;
  /** The model-finder route persists newConversationModelIds. */
  modelFinderSavesCombination: boolean;
  /** The model-finder response echoes the request's modelIds back. */
  modelFinderEchoesRequest: boolean;
  /** POST /api/conversations falls back through the shared resolver. */
  conversationsRouteUsesResolver: boolean;
  /** The client still initialises a new chat from a single default model. */
  clientNewChatUsesSingleDefault: boolean;
  /** Resolver fixtures: null resolves to [defaultModel]. */
  resolverNullFallsBack: boolean;
  /** Resolver fixtures: a malformed stored value falls back, flagged. */
  resolverMalformedFallsBack: boolean;
  /** Resolver fixtures: more than the maximum stored ids are truncated. */
  resolverTruncatesToMax: boolean;
  /** Resolver fixtures: effectiveDefaultModelId === effectiveModelIds[0]. */
  resolverLeadMatchesEffectiveDefault: boolean;
};

export type DefaultModelAuditInput = {
  /** The raw AppSetting row, or null when no administrator has set one. */
  storedGuestDefaultModelId: string | null;
  /** What getPublicAppSettings() serves after validating the stored value. */
  normalizedGuestDefaultModelId: string;
  /** The guest selection the resolver actually produces, in order. */
  effectiveGuestSelectedModelIds: readonly string[];
  /** The three models a guest is always shown, in their declared order. */
  guestBrandTrioModelIds: readonly string[];
  /** lib/models.ts */
  defaultModelId: string;
  /** lib/appDefaults.ts */
  appDefaultsDefaultModelId: string;
  /** The `@default(...)` on UserSettings.defaultModel in schema.prisma. */
  prismaUserSettingsDefaultModel: string;
  /** The `@default(...)` on Conversation.selectedModels, parsed as JSON. */
  prismaConversationSelectedModels: readonly string[];
  /**
   * What app/api/user/settings/route.ts writes when it creates a row for an
   * account that has none. Must equal the compiled default, or the column
   * default and the application default disagree about the same new account.
   */
  userSettingsCreateDefaultModel: string;
  /** The guest selection rendered by the server, before hydration. */
  ssrGuestSelectedModelIds: readonly string[];
  /** The guest selection the client computes on its first render. */
  hydratedGuestSelectedModelIds: readonly string[];
  /** Runtime state for every model id mentioned above. */
  modelStates: readonly ModelStateSnapshot[];
  /** Section C: the signed-in new-conversation combination. */
  newConversation: NewConversationAuditInput;
};

export type DefaultModelFinding = {
  code:
    | "guest_setting_not_applied"
    | "guest_default_not_selectable"
    | "guest_default_not_standard"
    | "default_model_unusable"
    | "compiled_defaults_disagree"
    | "prisma_schema_default_disagrees"
    | "user_settings_create_disagrees"
    | "guest_hydration_mismatch"
    | "new_conversation_column_missing"
    | "new_conversation_column_not_nullable"
    | "new_conversation_column_has_default"
    | "new_conversation_read_path_rewrites"
    | "new_conversation_resolver_not_shared"
    | "new_conversation_write_paths_desynced"
    | "new_conversation_response_echoes_request"
    | "new_conversation_client_single_model_init"
    | "new_conversation_fallback_broken";
  message: string;
};

export type DefaultModelAuditReport = {
  guest: {
    storedGuestDefaultModelId: DefaultModelValue<string | null>;
    normalizedGuestDefaultModelId: DefaultModelValue<string>;
    effectiveGuestSelectedModelIds: DefaultModelValue<readonly string[]>;
    /**
     * Whether the stored setting reaches the guest's screen. False means the
     * row exists, validates and is served, and changes nothing.
     */
    storedSettingApplied: boolean;
    leadModelId: string | null;
  };
  authenticated: {
    compiledAuthenticatedDefaultModelId: DefaultModelValue<string>;
    appDefaultsDefaultModelId: DefaultModelValue<string>;
    prismaUserSettingsDefaultModel: DefaultModelValue<string>;
    prismaConversationSelectedModels: DefaultModelValue<readonly string[]>;
    userSettingsCreateDefaultModel: DefaultModelValue<string>;
  };
  newConversation: NewConversationAuditInput;
  modelStates: readonly ModelStateSnapshot[];
  findings: readonly DefaultModelFinding[];
  ok: boolean;
};

const sameOrder = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((value, index) => value === b[index]);

const stateFor = (
  states: readonly ModelStateSnapshot[],
  modelId: string
): ModelStateSnapshot =>
  states.find((state) => state.modelId === modelId) ?? {
    modelId,
    known: false,
    enabled: false,
    publiclyListed: false,
    catalogDeleted: true,
    guestEligible: false,
    usageCategory: null,
  };

export const auditDefaultModels = (
  input: DefaultModelAuditInput
): DefaultModelAuditReport => {
  const findings: DefaultModelFinding[] = [];
  const lead = input.effectiveGuestSelectedModelIds[0] ?? null;

  // A. The guest setting either reaches the screen or it does not. Being a
  //    valid model is not the same as being an applied one -- a lead outside
  //    the brand trio is dropped by the resolver, and the write that stored it
  //    reported success.
  const stored = input.storedGuestDefaultModelId;
  const storedSettingApplied = stored === null ? true : lead === stored;
  if (stored !== null && !storedSettingApplied) {
    findings.push({
      code: "guest_setting_not_applied",
      message:
        `AppSetting["guestDefaultModelId"] is "${stored}" but the guest selection leads with ` +
        `"${lead ?? "nothing"}". ` +
        (input.guestBrandTrioModelIds.includes(stored)
          ? "The stored model is in the brand trio, so the resolver should have led with it."
          : `The setting only reorders the brand trio (${input.guestBrandTrioModelIds.join(", ")}), ` +
            "so this value was saved and then silently ignored."),
    });
  }

  // The lead a guest actually gets has to be a model a guest can actually
  // use, and one the Standard credit tier prices -- a guest cannot pay for
  // anything else, so a dearer default would reject the first message.
  const leadState = lead ? stateFor(input.modelStates, lead) : null;
  if (leadState) {
    if (
      !leadState.known ||
      !leadState.enabled ||
      leadState.catalogDeleted ||
      !leadState.publiclyListed ||
      !leadState.guestEligible
    ) {
      findings.push({
        code: "guest_default_not_selectable",
        message:
          `The guest default "${lead}" is not offerable: known=${leadState.known} ` +
          `enabled=${leadState.enabled} publiclyListed=${leadState.publiclyListed} ` +
          `catalogDeleted=${leadState.catalogDeleted} guestEligible=${leadState.guestEligible}.`,
      });
    }
    if (leadState.usageCategory !== "Standard") {
      findings.push({
        code: "guest_default_not_standard",
        message: `The guest default "${lead}" is priced as ${leadState.usageCategory ?? "unknown"}, not Standard. A guest cannot pay for it.`,
      });
    }
  }

  // B. One value, four places. Any disagreement means a new account gets a
  //    different model depending on which path created its row.
  if (input.defaultModelId !== input.appDefaultsDefaultModelId) {
    findings.push({
      code: "compiled_defaults_disagree",
      message: `DEFAULT_MODEL_ID is "${input.defaultModelId}" but APP_DEFAULTS.defaultModelId is "${input.appDefaultsDefaultModelId}".`,
    });
  }
  if (input.defaultModelId !== input.prismaUserSettingsDefaultModel) {
    findings.push({
      code: "prisma_schema_default_disagrees",
      message: `DEFAULT_MODEL_ID is "${input.defaultModelId}" but UserSettings.defaultModel defaults to "${input.prismaUserSettingsDefaultModel}" in schema.prisma.`,
    });
  }
  if (
    !sameOrder(input.prismaConversationSelectedModels, [input.defaultModelId])
  ) {
    findings.push({
      code: "prisma_schema_default_disagrees",
      message: `Conversation.selectedModels defaults to ${JSON.stringify(input.prismaConversationSelectedModels)} but the compiled default is "${input.defaultModelId}".`,
    });
  }
  if (input.userSettingsCreateDefaultModel !== input.defaultModelId) {
    findings.push({
      code: "user_settings_create_disagrees",
      message: `A new UserSettings row is created with "${input.userSettingsCreateDefaultModel}" while the column default is "${input.prismaUserSettingsDefaultModel}".`,
    });
  }

  const defaultState = stateFor(input.modelStates, input.defaultModelId);
  if (
    !defaultState.known ||
    !defaultState.enabled ||
    defaultState.catalogDeleted ||
    !defaultState.publiclyListed
  ) {
    findings.push({
      code: "default_model_unusable",
      message:
        `The signed-in default "${input.defaultModelId}" is not offerable: known=${defaultState.known} ` +
        `enabled=${defaultState.enabled} publiclyListed=${defaultState.publiclyListed} ` +
        `catalogDeleted=${defaultState.catalogDeleted}.`,
    });
  }

  // C. The signed-in new-conversation combination. The column is additive
  //    and nullable with no default; every interpreter is the shared
  //    resolver; write paths persist the combination with its lead; the read
  //    path reports drift instead of rewriting it.
  const nc = input.newConversation;
  if (!nc.prismaColumn.present) {
    findings.push({
      code: "new_conversation_column_missing",
      message:
        "UserSettings.newConversationModelIds is missing from schema.prisma.",
    });
  } else {
    if (!nc.prismaColumn.nullable) {
      findings.push({
        code: "new_conversation_column_not_nullable",
        message:
          "UserSettings.newConversationModelIds must stay nullable: NULL is the [defaultModel] fallback for every existing account.",
      });
    }
    if (nc.prismaColumn.hasDefault) {
      findings.push({
        code: "new_conversation_column_has_default",
        message:
          "UserSettings.newConversationModelIds must not carry a schema default; unset stays NULL and resolves to [defaultModel].",
      });
    }
  }
  if (nc.settingsRouteRewritesOnRead) {
    findings.push({
      code: "new_conversation_read_path_rewrites",
      message:
        "GET /api/user/settings updates UserSettings during a read. The read path reports stored/effective drift; only an explicit save or an approved reconciliation persists a change.",
    });
  }
  if (!nc.settingsRouteUsesResolver || !nc.conversationsRouteUsesResolver) {
    findings.push({
      code: "new_conversation_resolver_not_shared",
      message:
        `The shared resolver (lib/newConversationModels.ts) is not used by ` +
        `${nc.settingsRouteUsesResolver ? "" : "app/api/user/settings/route.ts "}` +
        `${nc.conversationsRouteUsesResolver ? "" : "app/api/conversations/route.ts "}` +
        `-- per-route fallbacks drift.`,
    });
  }
  if (!nc.modelFinderSavesCombination) {
    findings.push({
      code: "new_conversation_write_paths_desynced",
      message:
        "app/api/user/model-finder/route.ts does not persist newConversationModelIds; saving a combination would fall back to a single defaultModel again.",
    });
  }
  if (nc.modelFinderEchoesRequest) {
    findings.push({
      code: "new_conversation_response_echoes_request",
      message:
        "app/api/user/model-finder/route.ts echoes the request's modelIds back as a save result instead of reporting the canonical persisted combination.",
    });
  }
  if (nc.clientNewChatUsesSingleDefault) {
    findings.push({
      code: "new_conversation_client_single_model_init",
      message:
        "ChatPageClient still initialises a new chat from a single default model instead of the saved combination.",
    });
  }
  const fixtureFailures: Array<[boolean, string]> = [
    [nc.resolverNullFallsBack, "null does not resolve to [defaultModel]"],
    [
      nc.resolverMalformedFallsBack,
      "a malformed stored value does not fall back with a diagnostic",
    ],
    [
      nc.resolverTruncatesToMax,
      "more than the maximum stored models are not truncated",
    ],
    [
      nc.resolverLeadMatchesEffectiveDefault,
      "effectiveDefaultModelId is not the effective combination's first item",
    ],
  ];
  for (const [passed, description] of fixtureFailures) {
    if (!passed) {
      findings.push({
        code: "new_conversation_fallback_broken",
        message: `resolveNewConversationModels fixture failed: ${description}.`,
      });
    }
  }

  // Hydration. The credit estimate is summed from the guest selection, so a
  // server render and a first client render that disagree charge two
  // different prices for the same screen.
  if (
    !sameOrder(input.ssrGuestSelectedModelIds, input.hydratedGuestSelectedModelIds)
  ) {
    findings.push({
      code: "guest_hydration_mismatch",
      message: `The server renders ${JSON.stringify(input.ssrGuestSelectedModelIds)} and the first client render produces ${JSON.stringify(input.hydratedGuestSelectedModelIds)}.`,
    });
  }

  return {
    guest: {
      storedGuestDefaultModelId: {
        value: input.storedGuestDefaultModelId,
        source: "app_setting",
      },
      normalizedGuestDefaultModelId: {
        value: input.normalizedGuestDefaultModelId,
        source: input.storedGuestDefaultModelId ? "app_setting" : "compiled_default",
      },
      effectiveGuestSelectedModelIds: {
        value: input.effectiveGuestSelectedModelIds,
        source: "runtime_catalogue",
      },
      storedSettingApplied,
      leadModelId: lead,
    },
    authenticated: {
      compiledAuthenticatedDefaultModelId: {
        value: input.defaultModelId,
        source: "compiled_default",
      },
      appDefaultsDefaultModelId: {
        value: input.appDefaultsDefaultModelId,
        source: "compiled_default",
      },
      prismaUserSettingsDefaultModel: {
        value: input.prismaUserSettingsDefaultModel,
        source: "prisma_schema",
      },
      prismaConversationSelectedModels: {
        value: input.prismaConversationSelectedModels,
        source: "prisma_schema",
      },
      userSettingsCreateDefaultModel: {
        value: input.userSettingsCreateDefaultModel,
        source: "compiled_default",
      },
    },
    newConversation: input.newConversation,
    modelStates: input.modelStates,
    findings,
    ok: findings.length === 0,
  };
};

/**
 * Reads a field's presence, nullability and default from a schema.prisma
 * model block, string-based for the same reason as parsePrismaStringDefault.
 */
export const parsePrismaFieldContract = (
  schema: string,
  model: string,
  field: string
): { present: boolean; nullable: boolean; hasDefault: boolean } => {
  const block = new RegExp(`model\\s+${model}\\s*\\{([\\s\\S]*?)\\n\\}`).exec(
    schema
  );
  if (!block) return { present: false, nullable: false, hasDefault: false };
  const line = new RegExp(`^\\s*${field}\\s+(\\S+)(.*)$`, "m").exec(block[1]);
  if (!line) return { present: false, nullable: false, hasDefault: false };
  return {
    present: true,
    nullable: line[1].endsWith("?"),
    hasDefault: /@default\(/.test(line[2]),
  };
};

/**
 * Pulls a single-quoted `@default(...)` out of a schema.prisma field line.
 * Deliberately string-based: adding a Prisma DMMF dependency to a check that
 * has to run before `prisma generate` would defeat the point of the check.
 */
export const parsePrismaStringDefault = (
  schema: string,
  model: string,
  field: string
): string | null => {
  const block = new RegExp(`model\\s+${model}\\s*\\{([\\s\\S]*?)\\n\\}`).exec(
    schema
  );
  if (!block) return null;
  const line = new RegExp(
    `^\\s*${field}\\s+\\S+\\s+.*@default\\("((?:[^"\\\\]|\\\\.)*)"\\)`,
    "m"
  ).exec(block[1]);
  if (!line) return null;
  return line[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
};
