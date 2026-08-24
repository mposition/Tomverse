// Ask each provider what its own context window is, by asking for too much.
//
//   npm run report:model-context-window-probe                 # dry run
//   npm run report:model-context-window-probe -- --send       # actually asks
//   npm run report:model-context-window-probe -- --send --model=glm-5.2
//
// Ten enabled models declare no context window, and no provider list endpoint
// answers for them (`npm run report:model-context-window-evidence` shows
// which). docs/policy/tomverse-chat-context-window-register.yaml forbids the
// shortcuts -- a window is "never estimated, inferred from a sibling model, or
// copied from a provider's marketing page" -- so the remaining source is the
// provider itself.
//
// Ask for an impossible number of completion tokens and it refuses, naming the
// limit it refused against. One request per model, rejected before any
// inference runs, so it costs nothing to speak of and produces no tokens.
//
// ## This sends real requests with real credentials
//
// Which is why it does nothing without `--send`. The default prints exactly
// what it would send, to whom, so the decision is made on the request rather
// than on a description of it. Keys are read from the environment and never
// printed; only the variable name is.
//
// ## It reports; it does not decide
//
// The output is evidence for a person to weigh, exactly like the evidence
// report. It writes nothing to lib/models.ts and nothing to the register --
// the register requires `sourceUrl`, `sourceTitle`, `verifiedAt` and
// `verifiedBy` before a row may carry a number, and whether an API rejection
// satisfies that is the register owner's call. `contextWindowIncludesOutput`
// is the same kind of question: a refusal about *completion* tokens does not
// always say whether the figure names the whole window or the answer's share.

import {
  IMPOSSIBLE_COMPLETION_TOKENS,
  errorMessageFrom,
  parseLimitCandidates,
  probeRequestFor,
} from "./report-model-context-window-probe-core.mjs";
import { AVAILABLE_MODELS } from "../lib/models.ts";
import { PROVIDER_API_CONFIGURATION } from "../lib/modelRegistryShared.ts";

const args = process.argv.slice(2);
const send = args.includes("--send");
const json = args.includes("--json");
const only = args.find((arg) => arg.startsWith("--model="))?.slice("--model=".length);
const timeoutMs = Number(process.env.PROBE_TIMEOUT_MS || 30_000);

const targets = AVAILABLE_MODELS.filter(
  (model) =>
    model.enabled &&
    !model.catalogDeleted &&
    !model.contextWindowTokens &&
    (!only || model.id === only)
);

if (targets.length === 0) {
  console.error(
    only
      ? `No enabled model "${only}" without a declared context window.`
      : "Every enabled model already declares a context window; there is nothing to probe."
  );
  process.exit(1);
}

// Two model ids can share one upstream model (gpt-5-5 and gpt-5-5-thinking
// both send `gpt-5.5`). Probing each would ask the same question twice and
// invite a reader to treat two identical answers as two observations.
const byUpstream = new Map();
for (const model of targets) {
  const key = JSON.stringify([model.provider, model.apiModel]);
  byUpstream.set(key, [...(byUpstream.get(key) ?? []), model]);
}

const plan = [];
for (const models of byUpstream.values()) {
  const [first] = models;
  const configuration = PROVIDER_API_CONFIGURATION[first.provider];
  if (!configuration) {
    plan.push({ models, error: `No API configuration for provider "${first.provider}".` });
    continue;
  }
  try {
    const request = probeRequestFor({
      provider: first.provider,
      apiModel: first.apiModel,
      baseUrl: configuration.baseUrl,
      protocol: configuration.protocol,
    });
    plan.push({
      models,
      provider: first.provider,
      apiModel: first.apiModel,
      apiKeyEnvName: configuration.apiKeyEnvName,
      hasKey: Boolean(process.env[configuration.apiKeyEnvName]),
      request,
    });
  } catch (error) {
    plan.push({ models, error: error instanceof Error ? error.message : String(error) });
  }
}

const label = (entry) => entry.models.map((model) => model.id).join(" + ");

if (!send) {
  console.log(
    `Context window probe — DRY RUN. ${targets.length} model(s) over ${plan.length} upstream model(s).\n`
  );
  for (const entry of plan) {
    if (entry.error) {
      console.log(`  ${label(entry).padEnd(38)} SKIPPED: ${entry.error}`);
      continue;
    }
    console.log(`  ${label(entry)}`);
    console.log(`      POST ${entry.request.url}`);
    console.log(
      `      {"model":"${entry.apiModel}","messages":[{"role":"user","content":"hi"}],` +
        `"${entry.request.capField}":${IMPOSSIBLE_COMPLETION_TOKENS}}`
    );
    console.log(
      `      key from ${entry.apiKeyEnvName}: ${entry.hasKey ? "present" : "MISSING — this one would fail on auth, not on the limit"}`
    );
  }
  console.log(
    "\nNothing was sent. Re-run with --send to ask the providers.\n" +
      "Each request is refused before any inference runs, so it produces no tokens."
  );
  process.exit(0);
}

const results = [];
for (const entry of plan) {
  if (entry.error) {
    results.push({ models: entry.models.map((m) => m.id), skipped: entry.error });
    continue;
  }
  if (!entry.hasKey) {
    results.push({
      models: entry.models.map((m) => m.id),
      skipped: `${entry.apiKeyEnvName} is not set in this environment.`,
    });
    continue;
  }

  const headers = { "Content-Type": "application/json" };
  headers.Authorization = `Bearer ${process.env[entry.apiKeyEnvName]}`;

  let status = null;
  let message = null;
  let transportError = null;
  try {
    const response = await fetch(entry.request.url, {
      method: "POST",
      headers,
      body: JSON.stringify(entry.request.body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    status = response.status;
    const text = await response.text();
    let parsed = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Left as text: a provider that answers with HTML or a bare string is
      // still telling us something, and hiding it behind "unparseable" would
      // send the reader to the wrong problem.
    }
    message = errorMessageFrom(parsed) ?? (typeof text === "string" ? text.slice(0, 400) : null);
  } catch (error) {
    transportError = error instanceof Error ? error.message : String(error);
  }

  results.push({
    models: entry.models.map((model) => model.id),
    provider: entry.provider,
    apiModel: entry.apiModel,
    url: entry.request.url,
    status,
    transportError,
    message,
    candidates: parseLimitCandidates(message),
  });
}

if (json) {
  console.log(JSON.stringify({ probedAt: new Date().toISOString(), results }, null, 2));
} else {
  console.log(`Context window probe — asked ${results.length} upstream model(s)\n`);
  for (const result of results) {
    console.log(`${result.models.join(" + ")}`);
    if (result.skipped) {
      console.log(`  skipped: ${result.skipped}\n`);
      continue;
    }
    if (result.transportError) {
      console.log(`  no answer: ${result.transportError}\n`);
      continue;
    }
    console.log(`  ${result.provider} ${result.apiModel} -> HTTP ${result.status}`);
    if (result.status === 200) {
      // The one outcome that means the probe failed rather than the request:
      // the provider accepted a billion completion tokens, so it validates
      // this somewhere else, or not at all.
      console.log(
        "  ACCEPTED. The provider did not refuse an impossible cap, so it does not\n" +
          "  check this field up front and this probe cannot learn its window here."
      );
    }
    if (result.candidates.length === 0) {
      console.log("  no token-sized number in the answer:");
      console.log(`    ${(result.message ?? "(no message)").slice(0, 300)}`);
    } else {
      for (const candidate of result.candidates) {
        console.log(`    ${candidate.tokens.toLocaleString("en-US").padStart(13)}  ...${candidate.phrase}...`);
      }
    }
    console.log("");
  }
  console.log(
    "Every number above is a candidate, not a finding: a refusal often names both\n" +
      "what was asked for and what is allowed. Read the phrase beside each one.\n\n" +
      "Nothing was written. docs/policy/tomverse-chat-context-window-register.yaml\n" +
      "wants sourceUrl, sourceTitle, verifiedAt and verifiedBy before a row may carry\n" +
      "a number, and contextWindowIncludesOutput stated explicitly -- a refusal about\n" +
      "completion tokens does not always settle that. Both are decisions for the\n" +
      "register's owner."
  );
}
