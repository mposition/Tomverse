// Owner-environment preflight only. Restricted input never leaves this process.
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createPromptRefinerVnextOneShotAdapter } from
  "../lib/promptRefinerVnextOneShotAdapter.ts";
import { readVerifiedPromptRefinerVnextOneShotOwnerCase } from
  "./prompt-refiner-vnext-one-shot-owner-case.mjs";

const SLOT_COUNT = 80;
const OWNER_KEY = /^(?:[0-9a-f]{2}){32,64}$/;
const FORBIDDEN_ENV = /(?:^|_)DATABASE_(?:[A-Z0-9]+_)*URL$|(?:^|_)DIRECT_URL(?:_|$)|^POSTGRES(?:_|$)|^PG(?:HOST|USER|PASSWORD|DATABASE|PORT|PASSFILE|SERVICEFILE)$|^DB_(?:HOST|USER|PASSWORD|DATABASE|PORT)$|(?:^|_)API_KEY$|^PROMPT_REFINER_VNEXT_ONE_SHOT_RUNNER_API_TOKEN$/i;
const refuse = () => { throw new Error("owner_runner_preflight_unavailable"); };

export const isForbiddenOwnerRunnerEnvironmentKey = (key) =>
  FORBIDDEN_ENV.test(key);

const syntheticResponse = () => ({
  text: JSON.stringify({
    outcome: "abstained", refinedPrompt: null,
    abstentionReason: "unsafe_to_rewrite",
  }),
  finishReason: "stop", warnings: [], toolCalls: [], toolResults: [],
  steps: [{ toolCalls: [], toolResults: [] }],
  usage: {
    inputTokens: 1, outputTokens: 1,
    inputTokenDetails: { cacheReadTokens: 0, cacheWriteTokens: 0 },
    outputTokenDetails: { reasoningTokens: 0 },
  },
});

/**
 * Re-read and rehash the entire sealed manifest immediately before every
 * case's synthetic transport preflight. This entrypoint has no app or provider
 * transport, and its only return value is a content-free aggregate.
 */
export async function runPromptRefinerVnextOneShotOwnerPreflight(input) {
  const { manifestPath, bindingPath, sealPath, ownerKeyHex,
    now, env = process.env } = input ?? {};
  if (![manifestPath, bindingPath, sealPath].every((path) =>
      typeof path === "string" && path.length > 0) ||
      new Set([manifestPath, bindingPath, sealPath]
        .map((path) => resolve(path))).size !== 3 ||
      !OWNER_KEY.test(ownerKeyHex ?? "") ||
      (now !== undefined && (!(now instanceof Date) ||
        !Number.isFinite(now.getTime()))) ||
      !env || typeof env !== "object" ||
      Object.entries(env).some(([key, value]) =>
        isForbiddenOwnerRunnerEnvironmentKey(key) &&
        typeof value === "string" && value.length > 0)) {
    return refuse();
  }

  let syntheticCalls = 0;
  try {
    const preflight = createPromptRefinerVnextOneShotAdapter({
      languageModel: { provider: "openai.responses", modelId: "gpt-5.6-luna" },
      generate: async () => {
        syntheticCalls++;
        return syntheticResponse();
      },
    });
    const seen = new Set();
    for (let slotIndex = 0; slotIndex < SLOT_COUNT; slotIndex++) {
      const selected = readVerifiedPromptRefinerVnextOneShotOwnerCase({
        manifestPath, bindingPath, sealPath, ownerKeyHex,
        slotIndex, now: now ?? new Date(),
      });
      if (seen.has(selected.caseId) || selected.dispatchAuthorized !== false) {
        return refuse();
      }
      seen.add(selected.caseId);
      const outcome = await preflight({
        requestId: randomUUID(), sourceText: selected.sourceText,
      });
      if (outcome.status !== "bounded_response" ||
          outcome.dispatchAuthorized !== false ||
          outcome.cacheWriteInputTokens !== 0 || outcome.toolCallCount !== 0 ||
          syntheticCalls !== slotIndex + 1) return refuse();
    }
    if (seen.size !== SLOT_COUNT) return refuse();
    return Object.freeze({
      preflight: "passed", caseCount: SLOT_COUNT,
      syntheticTransportCalls: syntheticCalls, dispatchAuthorized: false,
    });
  } catch {
    // Never expose parser, adapter, path, case, root, or source details.
    return refuse();
  }
}

async function main(args) {
  if (args.length !== 6 || args[0] !== "--manifest" ||
      args[2] !== "--binding" || args[4] !== "--seal" ||
      !args[1] || !args[3] || !args[5]) {
    process.stderr.write("usage_invalid\n");
    return 2;
  }
  try {
    const result = await runPromptRefinerVnextOneShotOwnerPreflight({
      manifestPath: args[1], bindingPath: args[3], sealPath: args[5],
      ownerKeyHex: process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_OWNER_SEAL_KEY_HEX,
    });
    process.stdout.write(JSON.stringify(result) + "\n");
    return 0;
  } catch {
    process.stderr.write("owner_runner_preflight_unavailable\n");
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
