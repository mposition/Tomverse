// Owner-environment preflight only. Restricted input never leaves this process.
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { closeSync, constants, fsyncSync, openSync, unlinkSync,
  readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { createPromptRefinerVnextOneShotAdapter } from
  "../lib/promptRefinerVnextOneShotAdapter.ts";
import { readVerifiedPromptRefinerVnextOneShotOwnerCase } from
  "./prompt-refiner-vnext-one-shot-owner-case.mjs";

const SLOT_COUNT = 80;
const V5_STAGE_ID = "prompt-refiner-vnext-one-shot-v5";
const CODE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OWNER_KEY = /^(?:[0-9a-f]{2}){32,64}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const FORBIDDEN_DB_ENV = /(?:^|_)DATABASE_(?:[A-Z0-9]+_)*URL$|(?:^|_)DIRECT_URL(?:_|$)|^POSTGRES(?:_|$)|^PG(?:HOST|USER|PASSWORD|DATABASE|PORT|PASSFILE|SERVICEFILE)$|^DB_(?:HOST|USER|PASSWORD|DATABASE|PORT)$/i;
// Catch common accidental credentials; the owner still runs in a clean environment.
const FORBIDDEN_ENV = /(?:^|_)DATABASE_(?:[A-Z0-9]+_)*URL$|(?:^|_)DIRECT_URL(?:_|$)|^POSTGRES(?:_|$)|^PG(?:HOST|USER|PASSWORD|DATABASE|PORT|PASSFILE|SERVICEFILE)$|^DB_(?:HOST|USER|PASSWORD|DATABASE|PORT)$|(?:^|_)API_KEY$|^PROMPT_REFINER_VNEXT_ONE_SHOT_RUNNER_API_TOKEN$/i;
const refuse = () => { throw new Error("owner_runner_preflight_unavailable"); };

export function verifyPromptRefinerVnextOneShotRunnerBytes(path, expectedDigest) {
  if (typeof path !== "string" || !SHA256.test(expectedDigest ?? "")) return false;
  try {
    const actual = createHash("sha256").update(readFileSync(path)).digest();
    return timingSafeEqual(actual, Buffer.from(expectedDigest, "hex"));
  } catch {
    return false;
  }
}

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

const appOrigin = (value) => {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.origin !== value ||
        url.username || url.password || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
};

const readSmallJson = async (response) => {
  const body = await response.text();
  if (Buffer.byteLength(body, "utf8") > 2048) return null;
  try { return JSON.parse(body); } catch { return null; }
};
const admissionUnknown = (requestId, slotIndex) => Object.freeze({
  status: "admission_outcome_unknown", requestId, slotIndex,
  humanReviewRequired: true, retryAuthorized: false, dispatchAuthorized: false,
});

async function recordUnknownStop({ origin, headers, requestId, slotIndex,
  runApprovalAuditLogId, slotConsumptionAuditLogId, reason, stageId }) {
  try {
    const stopped = await globalThis.fetch(
      `${origin}/api/internal/prompt-refiner/vnext-one-shot-stop`, {
        method: "POST", headers, redirect: "error", cache: "no-store",
        body: JSON.stringify({ ...(stageId ? { stageId } : {}),
          requestId, slotIndex, runApprovalAuditLogId,
          slotConsumptionAuditLogId, reason }),
      });
    const receipt = stopped.status === 201 ? await readSmallJson(stopped) : null;
    return Boolean(receipt &&
      Object.keys(receipt).sort().join(",") ===
        "dispatchAuthorized,humanReviewRequired,reservationHeld,retryAuthorized,stopAuditLogId" &&
      typeof receipt.stopAuditLogId === "string" &&
      receipt.stopAuditLogId.length > 0 && receipt.stopAuditLogId.length <= 128 &&
      receipt.reservationHeld === true &&
      receipt.humanReviewRequired === true && receipt.retryAuthorized === false &&
      receipt.dispatchAuthorized === false);
  } catch {
    // The stop may have committed. The owner must read back the stage and audit.
    return false;
  }
}

/**
 * One slot's owner-only send path. The app, not an input boolean, confirms the
 * separately approved stage/run and consumes this slot before generation.
 * Resolve the SDK and model pin first, so a missing dependency or mismatched
 * model cannot consume a slot. The switches are absent by default.
 */
export async function runPromptRefinerVnextOneShotOwnerSlot(input, dependencies = {}) {
  const { manifestPath, bindingPath, sealPath, ownerKeyHex, slotIndex,
    runApprovalAuditLogId, stageId, now, env = process.env } = input ?? {};
  const origin = appOrigin(env?.PROMPT_REFINER_VNEXT_ONE_SHOT_APP_ORIGIN);
  const token = env?.PROMPT_REFINER_VNEXT_ONE_SHOT_RUNNER_API_TOKEN;
  const providerKey = env?.PROMPT_REFINER_VNEXT_ONE_SHOT_PROVIDER_API_KEY;
  const runnerDigest = env?.PROMPT_REFINER_VNEXT_ONE_SHOT_RUNNER_DIGEST;
  if (env?.PROMPT_REFINER_VNEXT_ONE_SHOT_DISPATCH_ENABLED !== "1" ||
      !origin || typeof token !== "string" || token.length < 32 ||
      token.length > 256 || typeof providerKey !== "string" ||
      providerKey.length < 32 || !SHA256.test(runnerDigest ?? "") ||
      (stageId !== undefined && stageId !== V5_STAGE_ID) ||
      !OWNER_KEY.test(ownerKeyHex ?? "") || !Number.isInteger(slotIndex) ||
      slotIndex < 0 || slotIndex >= SLOT_COUNT ||
      typeof runApprovalAuditLogId !== "string" ||
      runApprovalAuditLogId.length < 1 || runApprovalAuditLogId.length > 128 ||
      Object.entries(env).some(([key, value]) =>
        FORBIDDEN_DB_ENV.test(key) && typeof value === "string" && value.length > 0)) {
    return refuse();
  }

  const selected = readVerifiedPromptRefinerVnextOneShotOwnerCase({
    manifestPath, bindingPath, sealPath, ownerKeyHex, slotIndex, now: now ?? new Date(),
  });
  if (selected.dispatchAuthorized !== false || !SHA256.test(selected.manifestRoot)) {
    return refuse();
  }
  let adapter;
  try {
    let generate = dependencies.generate;
    let languageModel = { provider: "openai.responses", modelId: "gpt-5.6-luna" };
    if (!generate) {
      const [{ generateText }, { createOpenAI }] = await (
        dependencies.loadSdk?.() ?? Promise.all([
          import("ai"), import("@ai-sdk/openai"),
        ]));
      generate = generateText;
      languageModel = createOpenAI({ apiKey: providerKey }).responses("gpt-5.6-luna");
    }
    adapter = createPromptRefinerVnextOneShotAdapter({ generate, languageModel });
  } catch {
    return refuse();
  }
  const requestId = randomUUID();
  const fetchImpl = globalThis.fetch;
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  let grant;
  let refused = false;
  try {
    const response = await fetchImpl(`${origin}/api/internal/prompt-refiner/vnext-one-shot-slot`, {
      method: "POST", headers, redirect: "error", cache: "no-store",
      body: JSON.stringify({ ...(stageId ? { stageId } : {}),
        requestId, slotIndex, runApprovalAuditLogId,
        manifestRoot: selected.manifestRoot, runnerDigest }),
    });
    if (response.status === 409 || response.status === 400 ||
        response.status === 401 || response.status === 403 ||
        response.status === 404) refused = true;
    else if (response.status !== 201) return admissionUnknown(requestId, slotIndex);
    else grant = await readSmallJson(response);
  } catch {
    // A lost response may follow a committed consumption. Never ask again.
    return admissionUnknown(requestId, slotIndex);
  }
  if (refused) return refuse();
  if (!grant || Object.keys(grant).sort().join(",") !==
      "dispatchAuthorized,requestId,reservationConsumed,slotConsumptionAuditLogId,slotIndex" ||
      grant.requestId !== requestId || grant.slotIndex !== slotIndex ||
      grant.reservationConsumed !== true || grant.dispatchAuthorized !== true ||
      typeof grant.slotConsumptionAuditLogId !== "string" ||
      grant.slotConsumptionAuditLogId.length < 1 ||
      grant.slotConsumptionAuditLogId.length > 128) {
    return admissionUnknown(requestId, slotIndex);
  }

  // The app call can take time; rehash the sealed source once more immediately
  // before the provider boundary. The prepared provider client stays pinned to
  // the key read before admission. A consumed slot is never reused on drift.
  let outcome;
  try {
    const current = readVerifiedPromptRefinerVnextOneShotOwnerCase({
      manifestPath, bindingPath, sealPath, ownerKeyHex, slotIndex, now: now ?? new Date(),
    });
    if (current.caseId !== selected.caseId ||
        current.sourceText !== selected.sourceText ||
        current.manifestRoot !== selected.manifestRoot) {
      throw new Error("owner_source_changed_after_admission");
    }
    outcome = await adapter({ requestId, sourceText: current.sourceText });
  } catch {
    outcome = { status: "outcome_unknown", reason: "response_unverified" };
  }
  if (outcome.status === "bounded_response" ||
      outcome.status === "confirmed_failure") {
    return Object.freeze({ status: outcome.status, requestId, slotIndex,
      slotConsumptionAuditLogId: grant.slotConsumptionAuditLogId,
      ...(outcome.status === "bounded_response"
        ? { output: outcome.output } : { failureCode: outcome.failureCode }),
      costUpperBoundMicroUsd: outcome.costUpperBoundMicroUsd,
      usage: outcome.usage,
      intentToTerminalLatencyMs: outcome.intentToTerminalLatencyMs,
      dispatchAuthorized: false });
  }
  const stopRecorded = await recordUnknownStop({ origin, headers,
    stageId,
    requestId, slotIndex, runApprovalAuditLogId,
    slotConsumptionAuditLogId: grant.slotConsumptionAuditLogId,
    reason: outcome.reason });
  return Object.freeze({ status: "outcome_unknown", reason: outcome.reason,
    ...(outcome.diagnosticCode ? { diagnosticCode: outcome.diagnosticCode } : {}),
    requestId, slotIndex, slotConsumptionAuditLogId: grant.slotConsumptionAuditLogId,
    stopRecorded, humanReviewRequired: true, retryAuthorized: false,
    dispatchAuthorized: false });
}

/** One content-free settlement attempt. A lost response is never retried. */
export async function recordPromptRefinerVnextOneShotTerminalReceipt(result, input) {
  const origin = appOrigin(input?.origin);
  const token = input?.token;
  const runApprovalAuditLogId = input?.runApprovalAuditLogId;
  const stageId = input?.stageId;
  if (!origin || typeof token !== "string" || token.length < 32 ||
      (stageId !== undefined && stageId !== V5_STAGE_ID) ||
      token.length > 256 || typeof runApprovalAuditLogId !== "string" ||
      runApprovalAuditLogId.length < 1 || runApprovalAuditLogId.length > 128 ||
      !["bounded_response", "confirmed_failure"].includes(result?.status)) return false;
  try {
    const response = await globalThis.fetch(
      `${origin}/api/internal/prompt-refiner/vnext-one-shot-terminal`, {
        method: "POST", redirect: "error", cache: "no-store",
        headers: { authorization: `Bearer ${token}`,
          "content-type": "application/json" },
        body: JSON.stringify({ ...(stageId ? { stageId } : {}),
          requestId: result.requestId,
          slotIndex: result.slotIndex, runApprovalAuditLogId,
          slotConsumptionAuditLogId: result.slotConsumptionAuditLogId,
          resultKind: result.status === "confirmed_failure"
            ? "failed" : result.output.outcome,
          ...(result.status === "confirmed_failure"
            ? { failureCode: result.failureCode } : {}),
          usage: result.usage,
          observedCostMicroUsd: result.costUpperBoundMicroUsd,
          intentToTerminalLatencyMs: result.intentToTerminalLatencyMs }),
      });
    const receipt = response.status === 201 ? await readSmallJson(response) : null;
    return Boolean(receipt &&
      Object.keys(receipt).sort().join(",") ===
        "dispatchAuthorized,observedCostMicroUsd,requestId,slotIndex,terminalAuditLogId" &&
      receipt.requestId === result.requestId &&
      receipt.slotIndex === result.slotIndex &&
      receipt.observedCostMicroUsd === result.costUpperBoundMicroUsd &&
      typeof receipt.terminalAuditLogId === "string" &&
      receipt.terminalAuditLogId.length > 0 &&
      receipt.terminalAuditLogId.length <= 128 &&
      receipt.dispatchAuthorized === false);
  } catch { return false; }
}

async function main(args) {
  if (args[0] === "--dispatch-slot") {
    if (args.length !== 13 || args[1] !== "--manifest" ||
        args[3] !== "--binding" || args[5] !== "--seal" ||
        args[7] !== "--slot" || args[9] !== "--run-audit" ||
        args[11] !== "--result" || !args[12] ||
        !/^(?:0|[1-9][0-9]*)$/.test(args[8])) {
      process.stderr.write("usage_invalid\n");
      return 2;
    }
    if (!verifyPromptRefinerVnextOneShotRunnerBytes(
      fileURLToPath(import.meta.url),
      process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_RUNNER_DIGEST)) {
      process.stderr.write("owner_runner_dispatch_unavailable\n");
      return 1;
    }
    try {
      const resultPath = resolve(args[12]);
      if (resultPath === CODE_ROOT || resultPath.startsWith(`${CODE_ROOT}${sep}`) ||
          [args[2], args[4], args[6]].some((path) => resolve(path) === resultPath)) {
        return refuse();
      }
      const descriptor = openSync(resultPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0), 0o600);
      let keepResult = false;
      try {
        const result = await runPromptRefinerVnextOneShotOwnerSlot({
          manifestPath: args[2], bindingPath: args[4], sealPath: args[6],
          slotIndex: Number(args[8]), runApprovalAuditLogId: args[10],
          stageId: process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_STAGE_ID,
          ownerKeyHex: process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_OWNER_SEAL_KEY_HEX,
        });
        if (result.status !== "bounded_response" &&
            result.status !== "confirmed_failure") {
          process.stdout.write(JSON.stringify(result) + "\n");
          return 1;
        }
        try {
          writeFileSync(descriptor, JSON.stringify({ requestId: result.requestId,
            slotIndex: result.slotIndex,
            ...(result.status === "confirmed_failure"
              ? { resultKind: "failed", failureCode: result.failureCode }
              : { output: result.output }) }) + "\n", { encoding: "utf8" });
          fsyncSync(descriptor);
        } catch {
          const stopRecorded = await recordUnknownStop({
            stageId: process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_STAGE_ID,
            origin: appOrigin(process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_APP_ORIGIN),
            headers: { authorization:
              `Bearer ${process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_RUNNER_API_TOKEN}`,
              "content-type": "application/json" },
            requestId: result.requestId, slotIndex: result.slotIndex,
            runApprovalAuditLogId: args[10],
            slotConsumptionAuditLogId: result.slotConsumptionAuditLogId,
            reason: "response_unverified",
          });
          process.stdout.write(JSON.stringify({ status: "outcome_unknown",
            requestId: result.requestId, slotIndex: result.slotIndex,
            stopRecorded, humanReviewRequired: true, retryAuthorized: false,
            dispatchAuthorized: false }) + "\n");
          return 1;
        }
        keepResult = true;
        const terminalRecorded = await recordPromptRefinerVnextOneShotTerminalReceipt(
          result, { origin: process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_APP_ORIGIN,
            token: process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_RUNNER_API_TOKEN,
            runApprovalAuditLogId: args[10],
            stageId: process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_STAGE_ID });
        if (!terminalRecorded) {
          process.stdout.write(JSON.stringify({ status: "terminal_receipt_outcome_unknown",
            requestId: result.requestId, slotIndex: result.slotIndex,
            slotConsumptionAuditLogId: result.slotConsumptionAuditLogId,
            costUpperBoundMicroUsd: result.costUpperBoundMicroUsd,
            humanReviewRequired: true, retryAuthorized: false,
            dispatchAuthorized: false }) + "\n");
          return 1;
        }
        process.stdout.write(JSON.stringify({ status: result.status,
          requestId: result.requestId, slotIndex: result.slotIndex,
          slotConsumptionAuditLogId: result.slotConsumptionAuditLogId,
          costUpperBoundMicroUsd: result.costUpperBoundMicroUsd,
          terminalRecorded: true,
          dispatchAuthorized: false }) + "\n");
        return 0;
      } finally {
        closeSync(descriptor);
        if (!keepResult) unlinkSync(resultPath);
      }
    } catch {
      process.stderr.write("owner_runner_dispatch_unavailable\n");
      return 1;
    }
  }
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
