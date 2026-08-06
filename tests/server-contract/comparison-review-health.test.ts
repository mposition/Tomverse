import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

// What an AI Review failure is evidence *of*.
//
// `attemptReview` wraps two very different kinds of failure in one catch: the
// provider rejecting or dropping the call, and Tomverse refusing to make it at
// all -- the user is out of credits, the review is longer than their plan
// allows, a concurrency slot was not free. Only the first says anything about
// the reviewer.
//
// The distinction had no test and both were recorded identically, which broke
// in both directions at once:
//
//   * `recordModelFailure` counts whatever it is given, so a run of credit
//     exhaustions marked a perfectly healthy reviewer as failing; and
//   * COMPARISON_REVIEW_FAILED was missing from PROVIDER_CALL_DIAGNOSTIC_ROOTS
//     -- the drift test listed route files by hand and this call lives in a
//     service -- so a genuine provider outage classified as a local rejection
//     and taught provider health nothing.
//
// These tests assert the two directions separately, because a change that
// fixes one by breaking the other would otherwise look green.

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relativePath: string) =>
  pathToFileURL(resolve(ROOT, relativePath)).href;
const require = createRequire(import.meta.url);

process.env.E2E_DISABLE_DATABASE = "true";
process.env.DATABASE_URL ||=
  "postgresql://e2e:e2e@127.0.0.1:1/e2e?connect_timeout=1";
process.env.DIRECT_URL ||= process.env.DATABASE_URL;
process.env.NEXTAUTH_SECRET ||= "server-contract-test-secret";

type Health = {
  providerFailures: string[];
  modelFailures: string[];
  generateTextCalls: number;
};

const health: Health = {
  providerFailures: [],
  modelFailures: [],
  generateTextCalls: 0,
};

/** What `generateText` does when it is reached. Set per test. */
let generateTextBehaviour: () => never = () => {
  throw new Error("PROVIDER_EXPLODED");
};
/** What `acquireChatAccess` does. Set per test. */
let acquireBehaviour: (() => never) | null = null;

const original = (relativePath: string) =>
  require(resolve(ROOT, relativePath)) as Record<string, unknown>;

const realChatSecurity = original("lib/chatSecurity.ts");
const realMonitoring = original("lib/providerMonitoring.ts");

// Mocks are installed once: mock.module replaces an ESM registry entry, and
// re-registering does not rebind the module instance the service already
// holds. Per-test behaviour therefore goes through the closures above.
// `createChatBudget` stays real -- it is what decides the figures the service
// then checks -- while everything that needs a database is stubbed. The
// subject under test is which failures reach the health counters, and a
// reservation that cannot be written would fail every case for the same
// uninteresting reason.
mock.module(mod("lib/chatSecurity.ts"), {
  namedExports: {
    ...realChatSecurity,
    acquireChatAccess: async () => {
      if (acquireBehaviour) acquireBehaviour();
      return {
        leaseId: "lease-health-test",
        usageReservation: { reservationId: "reservation-health-test" },
      };
    },
    releaseChatAccess: async () => undefined,
    settleChatUsage: async () => undefined,
    linkChatReservationProviderRequest: async () => undefined,
  },
});

mock.module(mod("lib/providerMonitoring.ts"), {
  namedExports: {
    ...realMonitoring,
    recordProviderFailure: async (
      _provider: unknown,
      code: string
    ) => {
      health.providerFailures.push(code);
    },
    recordModelFailure: async (
      _modelId: unknown,
      _provider: unknown,
      code: string
    ) => {
      health.modelFailures.push(code);
    },
    recordProviderSuccess: async () => undefined,
    recordModelSuccess: async () => undefined,
  },
});

mock.module("ai", {
  namedExports: {
    ...(require("ai") as Record<string, unknown>),
    generateText: async () => {
      health.generateTextCalls += 1;
      generateTextBehaviour();
    },
  },
});

type Service = {
  runComparisonReview: (
    subject: unknown,
    input: unknown,
    options: { traceId: string; candidates?: unknown[] }
  ) => Promise<unknown>;
};
type ChatSecurityModule = {
  ChatAccessError: new (status: number, code: string, message: string) => Error;
};
type ModelsModule = { getModel: (id: string) => unknown };

// Loaded lazily rather than at the top level: this file is transformed to CJS,
// where top-level await is not available.
let loaded: {
  service: Service;
  chatSecurity: ChatSecurityModule;
  reviewer: unknown;
} | null = null;

const load = async () => {
  if (loaded) return loaded;
  const service = (await import(
    `${mod("lib/comparisonReviewService.ts")}?health=cached`
  )) as Service;
  const chatSecurity = (await import(
    mod("lib/chatSecurity.ts")
  )) as ChatSecurityModule;
  const models = (await import(mod("lib/models.ts"))) as ModelsModule;
  loaded = { service, chatSecurity, reviewer: models.getModel("gpt-5-6-luna") };
  return loaded;
};

const subject = {
  access: {
    kind: "guest" as const,
    subjectKey: "guest:health-test",
    ipKey: "127.0.0.1",
  },
  reviewerPlan: "Free" as const,
};

const input = {
  question: "Which answer is better?",
  responses: [
    {
      messageId: "m1",
      modelId: "gpt-5-6-luna",
      modelName: "GPT-5.6 Luna",
      provider: "openai" as const,
      content: "The first answer explains the trade-off in two sentences.",
    },
    {
      messageId: "m2",
      modelId: "gpt-5-4-mini",
      modelName: "GPT-5.4 mini",
      provider: "openai" as const,
      content: "The second answer lists the same trade-off as bullet points.",
    },
  ],
  reviewMode: "quick" as const,
  includeSynthesis: false,
  language: "en",
};

const run = async () => {
  const { service, reviewer } = await load();
  return service.runComparisonReview(subject, input, {
    traceId: "health-test",
    candidates: [reviewer],
  });
};

const reset = () => {
  health.providerFailures = [];
  health.modelFailures = [];
  health.generateTextCalls = 0;
  acquireBehaviour = null;
};

test("a credit refusal is not recorded against the reviewer's health", async () => {
  reset();
  const { chatSecurity } = await load();
  acquireBehaviour = () => {
    throw new chatSecurity.ChatAccessError(
      402,
      "CREDIT_BALANCE_INSUFFICIENT",
      "Not enough credits."
    );
  };

  await assert.rejects(run());

  // Nothing was sent, so there is nothing for either counter to learn. The
  // model counter is the one that matters here: it does not filter what it is
  // given, so this used to mark a healthy reviewer as failing.
  assert.deepEqual(health.modelFailures, []);
  assert.deepEqual(health.providerFailures, []);
  assert.equal(health.generateTextCalls, 0);
});

test("a concurrency refusal is likewise not the reviewer's fault", async () => {
  reset();
  const { chatSecurity } = await load();
  acquireBehaviour = () => {
    throw new chatSecurity.ChatAccessError(
      429,
      "CHAT_CONCURRENCY_EXCEEDED",
      "A response is already being generated."
    );
  };

  await assert.rejects(run());
  assert.deepEqual(health.modelFailures, []);
  assert.deepEqual(health.providerFailures, []);
});

test("a real provider failure is still recorded, on both counters", async () => {
  reset();
  generateTextBehaviour = () => {
    throw new Error("PROVIDER_EXPLODED");
  };

  await assert.rejects(run());

  // The call went out and failed. Suppressing this to fix the case above would
  // have left AI Review's outages invisible to provider health.
  assert.ok(health.generateTextCalls > 0, "the provider was never called");
  assert.deepEqual(health.providerFailures, ["COMPARISON_REVIEW_FAILED"]);
  assert.deepEqual(health.modelFailures, ["COMPARISON_REVIEW_FAILED"]);
});
