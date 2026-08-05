// Keeps the context-window register honest and in step with the catalogue.
//
// Filling lib/models.ts is not a no-op. The chat route's guard reads
// `modelConfig.contextWindowTokens && ...`, so declaring a window switches on a
// check that was previously skipped, and long requests that used to pass start
// being rejected. Values are therefore verified and recorded in
// docs/policy/tomverse-chat-context-window-register.yaml first, measured in a
// shadow analysis, and only then connected to runtime.
//
// The rule this check exists for: a number without provenance is not a
// verification. An unverified row may not carry a window, and a verified row
// may not exist without a source, a date and a verifier. That is what stops the
// register filling up with plausible-looking values nobody checked -- the same
// discipline lib/webSearchCapability.ts already applies by leaving
// unconfirmed models "unverified" rather than assuming support.
//
// It also pins catalogueDeclaredTokens against lib/models.ts, so a window added
// straight to the catalogue fails here until its evidence is recorded.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";

import { AVAILABLE_MODELS } from "../lib/models.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REGISTER = path.join(repoRoot, "docs", "policy", "tomverse-chat-context-window-register.yaml");
const REGISTER_RELATIVE = "docs/policy/tomverse-chat-context-window-register.yaml";

const ALLOWED_STATUSES = new Set(["verified", "unverified"]);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const REQUIRED_WHEN_VERIFIED = ["sourceUrl", "sourceTitle", "verifiedAt", "verifiedBy"];

const errors = [];
const fail = (message) => errors.push(message);

let register;
try {
  register = parse(readFileSync(REGISTER, "utf8"));
} catch (cause) {
  console.error(`FAIL ${REGISTER_RELATIVE}: unreadable or invalid YAML -- ${cause.message}`);
  process.exit(1);
}

if (register?.schemaVersion !== 1) fail(`unsupported schemaVersion ${register?.schemaVersion}`);
if (!Array.isArray(register?.models) || register.models.length === 0) {
  console.error(`FAIL ${REGISTER_RELATIVE}: models must be a non-empty list`);
  process.exit(1);
}

// Same reachable set the runtime guard cares about: publiclyListed only decides
// whether a model is offered, not whether a request can still reach it.
const catalogue = AVAILABLE_MODELS.filter((model) => model.enabled && !model.catalogDeleted);
const catalogueById = new Map(catalogue.map((model) => [model.id, model]));
const registerById = new Map();

for (const row of register.models) {
  const id = row?.modelId;
  if (typeof id !== "string" || id === "") {
    fail("a row has no modelId");
    continue;
  }
  if (registerById.has(id)) {
    fail(`${id}: duplicate row`);
    continue;
  }
  registerById.set(id, row);

  const model = catalogueById.get(id);
  if (!model) {
    fail(`${id}: row has no enabled catalogue model. Remove it, or re-enable the model.`);
    continue;
  }

  // Drift guards. A renamed apiModel silently invalidates the verification,
  // because what was verified is the upstream model, not the Tomverse id.
  if (row.apiModel !== model.apiModel) {
    fail(`${id}: apiModel is "${row.apiModel}" but the catalogue says "${model.apiModel}". Re-verify against the new upstream model.`);
  }
  if (row.provider !== model.provider) {
    fail(`${id}: provider is "${row.provider}" but the catalogue says "${model.provider}".`);
  }

  const declared = model.contextWindowTokens ?? null;
  if ((row.catalogueDeclaredTokens ?? null) !== declared) {
    fail(
      `${id}: catalogueDeclaredTokens is ${row.catalogueDeclaredTokens ?? "null"} but lib/models.ts declares ` +
        `${declared ?? "null"}. A window added to the catalogue needs its evidence recorded here first.`
    );
  }

  if (!ALLOWED_STATUSES.has(row.status)) {
    fail(`${id}: status "${row.status}" must be one of ${[...ALLOWED_STATUSES].join(", ")}.`);
    continue;
  }

  if (row.status === "unverified") {
    // The whole point: no value without evidence.
    for (const field of ["contextWindowTokens", "maxInputTokens", "maxOutputTokens"]) {
      if (row[field] !== null && row[field] !== undefined) {
        fail(`${id}: unverified rows may not carry ${field}. Verify it, or leave it null.`);
      }
    }
    if (row.contextWindowIncludesOutput !== null && row.contextWindowIncludesOutput !== undefined) {
      fail(`${id}: unverified rows may not claim contextWindowIncludesOutput.`);
    }
    continue;
  }

  // status === "verified"
  if (!Number.isSafeInteger(row.contextWindowTokens) || row.contextWindowTokens <= 0) {
    fail(`${id}: verified rows need a positive integer contextWindowTokens.`);
  }
  if (typeof row.contextWindowIncludesOutput !== "boolean") {
    fail(
      `${id}: contextWindowIncludesOutput must be true or false. Providers differ on whether the ` +
        "published window covers output, and the guard needs to know which."
    );
  }
  for (const field of REQUIRED_WHEN_VERIFIED) {
    if (typeof row[field] !== "string" || row[field].trim() === "") {
      fail(`${id}: verified rows need ${field}. A number without provenance is not a verification.`);
    }
  }
  if (typeof row.verifiedAt === "string" && !ISO_DATE.test(row.verifiedAt)) {
    fail(`${id}: verifiedAt must be YYYY-MM-DD.`);
  }
  if (typeof row.aliasOrLatest !== "boolean") {
    fail(`${id}: aliasOrLatest must be stated for a verified row -- an alias can move behind a fixed name.`);
  }
  for (const field of ["maxInputTokens", "maxOutputTokens"]) {
    const value = row[field];
    if (value !== null && value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
      fail(`${id}: ${field} must be null or a positive integer.`);
    }
  }
}

// Every reachable model needs a row, or the register is not an inventory.
for (const model of catalogue) {
  if (!registerById.has(model.id)) {
    fail(
      `${model.id} (${model.provider}) is enabled but missing from the register. Add a row with ` +
        `apiModel: "${model.apiModel}", provider: ${model.provider}, status: unverified, ` +
        `catalogueDeclaredTokens: ${model.contextWindowTokens ?? "null"}.`
    );
  }
}

const rows = [...registerById.values()];
const verified = rows.filter((row) => row.status === "verified");
const declaredButUnverified = rows.filter(
  (row) => row.status !== "verified" && (row.catalogueDeclaredTokens ?? null) !== null
);

if (errors.length > 0) {
  console.error(`FAIL ${REGISTER_RELATIVE} (${errors.length} problem${errors.length === 1 ? "" : "s"})`);
  for (const message of errors) console.error(`  - ${message}`);
  process.exit(1);
}

console.log(
  `OK ${REGISTER_RELATIVE}: ${rows.length} enabled models, ${verified.length} verified, ` +
    `${rows.length - verified.length} unverified (${declaredButUnverified.length} of those already declare a ` +
    "window in the catalogue with no recorded source)."
);
