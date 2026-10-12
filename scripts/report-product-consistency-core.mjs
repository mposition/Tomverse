// Places where the running catalogue and the code disagree about what a user
// gets. Pure: no I/O, no lib imports. The entry script supplies the public
// catalogue and the code's web search register, so every rule here can be
// tested on fixtures and on the real register alike.
//
// Each finding is a question for the operator, not a defect verdict. A model
// on Brave may be there on purpose; a retirement with no named successor may
// be one nobody has got to yet. What the report guarantees is that the line is
// true of the catalogue it read.
//
// Rules:
//
// - `web_search_native_provider_on_app_backend`: an enabled model searches
//   through the application-managed backend (Brave) only because its id is not
//   in WEB_SEARCH_CAPABILITIES, while the register gives other models of the
//   same provider that provider's own search. Models adopted at runtime land
//   here silently -- lib/webSearchCapability.ts deliberately never infers a
//   native tool from the provider -- so a successor can search differently from
//   the model it replaced without anybody deciding that it should. Registering
//   one is a cost decision (docs/policy/credit-and-cost-limits.md), which is
//   why this is reported and not fixed.
//
// - `retired_model_names_no_successor`: a disabled model declares a
//   replacement, but the chat route would not name it. app/api/chat/route.ts
//   answers MODEL_RETIRED with the replacement only when that one model, one hop
//   away, is enabled, listed and not deleted; otherwise the user is told to
//   "select another model". The intent to send them somewhere was recorded and
//   is not delivered.

/** Larger than any real catalogue; a body past it is not one. */
export const CATALOGUE_MODEL_LIMIT = 2000;

/** How far a replacement chain is followed when suggesting a target. */
export const REPLACEMENT_CHAIN_LIMIT = 16;

export const RULES = Object.freeze({
  webSearchNativeProviderOnAppBackend: "web_search_native_provider_on_app_backend",
  retiredModelNamesNoSuccessor: "retired_model_names_no_successor",
});

const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const optionalString = (value) => value === undefined || value === null || typeof value === "string";
const optionalBoolean = (value) => value === undefined || value === null || typeof value === "boolean";

/**
 * The `/api/models/catalog` body, checked field by field for what the rules
 * read. Anything else is refused whole rather than read in part: a report over
 * the rows that happened to parse would look like a report over the catalogue.
 */
export const parseCatalogue = (raw) => {
  if (!isRecord(raw) || !Array.isArray(raw.models)) {
    return { problems: ["The catalogue is not an object with a models array."] };
  }
  if (raw.models.length === 0) return { problems: ["The catalogue lists no models."] };
  if (raw.models.length > CATALOGUE_MODEL_LIMIT) {
    return { problems: [`The catalogue lists ${raw.models.length} models, more than ${CATALOGUE_MODEL_LIMIT}.`] };
  }
  const problems = [];
  const seen = new Set();
  raw.models.forEach((model, index) => {
    const where = `models[${index}]`;
    if (!isRecord(model)) {
      problems.push(`${where} is not an object.`);
      return;
    }
    if (typeof model.id !== "string" || model.id.length === 0) problems.push(`${where}.id is not a string.`);
    else if (seen.has(model.id)) problems.push(`${where}.id ${model.id} appears twice.`);
    else seen.add(model.id);
    if (typeof model.provider !== "string" || model.provider.length === 0) {
      problems.push(`${where}.provider is not a string.`);
    }
    if (typeof model.enabled !== "boolean") problems.push(`${where}.enabled is not a boolean.`);
    for (const field of ["replacementModelId", "webSearchOverride", "name"]) {
      if (!optionalString(model[field])) problems.push(`${where}.${field} is not a string.`);
    }
    for (const field of ["publiclyListed", "catalogDeleted"]) {
      if (!optionalBoolean(model[field])) problems.push(`${where}.${field} is not a boolean.`);
    }
  });
  if (problems.length > 0) return { problems };
  return {
    models: raw.models.map((model) => ({
      id: model.id,
      name: typeof model.name === "string" ? model.name : model.id,
      provider: model.provider,
      enabled: model.enabled,
      publiclyListed: model.publiclyListed ?? undefined,
      catalogDeleted: model.catalogDeleted ?? undefined,
      replacementModelId: model.replacementModelId || undefined,
      webSearchOverride: model.webSearchOverride || undefined,
    })),
  };
};

/**
 * Providers whose models the register gives a native search tool, read from
 * the register itself. Google is absent because no Google model is registered
 * native (grounding has no enforceable ceiling), not because this file says so.
 */
export const nativeSearchProviders = (register) =>
  new Set(
    Object.values(register)
      .filter((capability) => capability.support === "native" && capability.provider)
      .map((capability) => capability.provider)
  );

/**
 * Whether the chat route would name this model as a replacement. Mirrors the
 * condition in app/api/chat/route.ts's MODEL_RETIRED branch; a change there is a
 * change here.
 */
export const isNameableReplacement = (model) =>
  Boolean(model) && model.enabled === true && model.publiclyListed !== false && model.catalogDeleted !== true;

export const webSearchRouteFindings = ({ models, register, capabilityOf }) => {
  const natives = nativeSearchProviders(register);
  const findings = [];
  for (const model of models) {
    if (!model.enabled || model.catalogDeleted) continue;
    if (!natives.has(model.provider)) continue;
    if (Object.hasOwn(register, model.id)) continue;
    // An administrator's override is a decision someone made, not a default
    // nobody looked at.
    if (model.webSearchOverride) continue;
    const capability = capabilityOf(model);
    if (capability.support !== "app-managed") continue;
    const nativePredecessors = models
      .filter((other) => other.replacementModelId === model.id && register[other.id]?.support === "native")
      .map((other) => other.id)
      .sort();
    findings.push({
      rule: RULES.webSearchNativeProviderOnAppBackend,
      modelId: model.id,
      provider: model.provider,
      searchBackend: capability.searchBackend ?? null,
      nativePredecessors,
    });
  }
  return findings.sort((a, b) => a.provider.localeCompare(b.provider) || a.modelId.localeCompare(b.modelId));
};

/** The first model along the replacement chain the chat route could name. */
const firstNameableSuccessor = (start, byId) => {
  const seen = new Set([start.id]);
  let current = start;
  for (let hop = 0; hop < REPLACEMENT_CHAIN_LIMIT; hop += 1) {
    const nextId = current.replacementModelId;
    if (!nextId || seen.has(nextId)) return null;
    seen.add(nextId);
    const next = byId.get(nextId);
    if (!next) return null;
    if (isNameableReplacement(next)) return next.id;
    current = next;
  }
  return null;
};

const replacementState = (model) => {
  if (!model) return "absent";
  if (model.catalogDeleted) return "deleted";
  if (!model.enabled) return "disabled";
  if (model.publiclyListed === false) return "unlisted";
  return "nameable";
};

export const retiredReplacementFindings = ({ models }) => {
  const byId = new Map(models.map((model) => [model.id, model]));
  const findings = [];
  for (const model of models) {
    // The route answers MODEL_RETIRED for any catalogue row that is not enabled.
    if (model.enabled || !model.replacementModelId) continue;
    const replacement = byId.get(model.replacementModelId);
    if (isNameableReplacement(replacement)) continue;
    findings.push({
      rule: RULES.retiredModelNamesNoSuccessor,
      modelId: model.id,
      provider: model.provider,
      replacementModelId: model.replacementModelId,
      replacementState: replacementState(replacement),
      firstNameableSuccessor: firstNameableSuccessor(model, byId),
    });
  }
  return findings.sort((a, b) => a.modelId.localeCompare(b.modelId));
};

export const productConsistencyReport = ({ models, register, capabilityOf }) => {
  const webSearch = webSearchRouteFindings({ models, register, capabilityOf });
  const retired = retiredReplacementFindings({ models });
  return {
    catalogue: {
      models: models.length,
      enabled: models.filter((model) => model.enabled && !model.catalogDeleted).length,
    },
    findings: [...webSearch, ...retired],
    counts: {
      [RULES.webSearchNativeProviderOnAppBackend]: webSearch.length,
      [RULES.retiredModelNamesNoSuccessor]: retired.length,
    },
  };
};
