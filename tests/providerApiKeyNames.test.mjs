import assert from "node:assert/strict";
import test from "node:test";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

import {
  AI_PROVIDERS,
  PROVIDER_API_CONFIGURATION,
  PROVIDER_API_KEY_ENV_NAMES,
  isProviderApiKeyConfigured,
  resolveProviderApiKey,
} from "../lib/modelRegistryShared.ts";

// One answer to "which environment variable holds this provider's key".
//
// There used to be three, and they disagreed about Google:
//
//   * PROVIDER_API_CONFIGURATION read GOOGLE_GENERATIVE_AI_API_KEY only, so the
//     chat client went out with no key under any other name;
//   * the image adapter accepted GEMINI_API_KEY too, so image generation worked
//     where chat did not; and
//   * PROVIDER_API_KEY_ENV -- what /status, conversation titles, AI Review's
//     reviewer filter and provider usage sync all consult to decide whether a
//     provider is usable -- listed GOOGLE_API_KEY, which nothing read for a
//     call, and omitted GEMINI_API_KEY, which one caller did.
//
// The second direction is the damaging one: a deployment holding only
// GOOGLE_API_KEY was reported configured, offered Google reviewers and given
// Google titles, and every one of those calls left without a key. The release
// checklist has a manual step for exactly that contradiction, which is a sign
// it was never enforceable in code.

test("every provider has at least one accepted key name", () => {
  for (const provider of AI_PROVIDERS) {
    const names = PROVIDER_API_KEY_ENV_NAMES[provider];
    assert.ok(Array.isArray(names) && names.length > 0, `${provider} has none`);
    for (const name of names) {
      assert.match(name, /^[A-Z][A-Z0-9_]*$/, `${provider}: ${name}`);
    }
  }
});

// The canonical name is what the admin console shows and what a registry row
// is allowed to store, so it has to be the one the alias list consults first.
test("the canonical name is the first accepted name", () => {
  for (const provider of AI_PROVIDERS) {
    assert.equal(
      PROVIDER_API_KEY_ENV_NAMES[provider][0],
      PROVIDER_API_CONFIGURATION[provider].apiKeyEnvName,
      `${provider} disagrees about its canonical key name`
    );
  }
});

test("the accepted names are consulted in order", () => {
  const environment = {
    GOOGLE_GENERATIVE_AI_API_KEY: "canonical",
    GEMINI_API_KEY: "alias",
  };
  assert.equal(resolveProviderApiKey("google", environment), "canonical");
  assert.equal(
    resolveProviderApiKey("google", { GEMINI_API_KEY: "alias" }),
    "alias"
  );
  assert.equal(
    resolveProviderApiKey("google", { GOOGLE_API_KEY: "third" }),
    "third"
  );
});

// The bug in miniature: a key set under any accepted name has to make the
// provider both callable and *reported* as callable.
test("any accepted name counts as configured", () => {
  for (const name of PROVIDER_API_KEY_ENV_NAMES.google) {
    assert.equal(
      isProviderApiKeyConfigured("google", { [name]: "sk-test" }),
      true,
      `${name} was not accepted`
    );
  }
  assert.equal(isProviderApiKeyConfigured("google", {}), false);
});

test("blank and whitespace-only values are not a key", () => {
  assert.equal(resolveProviderApiKey("openai", { OPENAI_API_KEY: "   " }), undefined);
  assert.equal(resolveProviderApiKey("openai", { OPENAI_API_KEY: "" }), undefined);
  assert.equal(isProviderApiKeyConfigured("openai", { OPENAI_API_KEY: " \t " }), false);
});

test("a key is returned trimmed, so a stray newline never reaches a header", () => {
  assert.equal(
    resolveProviderApiKey("openai", { OPENAI_API_KEY: " sk-test\n" }),
    "sk-test"
  );
});

// The part a refactor can quietly undo. A second inline list is how the three
// answers appeared in the first place, so nothing outside the owning module may
// name a provider key variable directly.
test("no module resolves a provider key by naming the variable itself", () => {
  const owner = "lib/modelRegistryShared.ts";
  const files = execSync("git ls-files 'lib/*.ts' 'app/**/*.ts' 'app/**/*.tsx'", {
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .filter((file) => file !== owner);

  const names = new Set(
    AI_PROVIDERS.flatMap((provider) => PROVIDER_API_KEY_ENV_NAMES[provider])
  );
  // The one deliberate exception: a dedicated image project key that isolates
  // spend attribution, which is a different decision from "which name holds the
  // OpenAI key" and falls back to the shared resolver.
  const allowed = new Set(["OPENAI_IMAGE_API_KEY"]);

  const offenders = [];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(
      /process\.env(?:\.([A-Z][A-Z0-9_]*)|\[\s*["']([A-Z][A-Z0-9_]*)["'])/g
    )) {
      const name = match[1] ?? match[2];
      if (!names.has(name) || allowed.has(name)) continue;
      offenders.push(`${file}: ${name}`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `resolve these through resolveProviderApiKey():\n  ${offenders.join("\n  ")}`
  );
});
