// Calls the account-languages route with the shared mutation wrapper and the
// store stood in for, and prints the spec the route handed the wrapper. Needs
// --experimental-test-module-mocks (tests/marketingAccountLocalesRoute.test.mjs).

import { mock } from "node:test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const mod = (path) => pathToFileURL(resolve(path)).href;

class MarketingChannelLocalesRefusedError extends Error {
  constructor(code, status, message) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

let captured = null;
const storeCalls = [];

mock.module(mod("lib/marketingAdminMutations.ts"), {
  namedExports: {
    runMarketingAdminMutation: async (spec) => {
      captured = spec;
      return new Response(null, { status: 204 });
    },
  },
});

mock.module(mod("lib/marketingStore.ts"), {
  namedExports: {
    MARKETING_ACCOUNT_LOCALES_ACTION: "marketing_account.locales_changed",
    MarketingChannelLocalesRefusedError,
    changeMarketingChannelLocales: async (tx, input) => {
      storeCalls.push({ tx, input });
      return { defaultLocale: input.defaultLocale, allowedLocales: input.allowedLocales, droppedLocales: ["ko"] };
    },
  },
});

const { POST } = await import(mod("app/api/admin/marketing/accounts/[channelId]/locales/route.ts"));
await POST(new Request("https://tomverse.app/api/admin/marketing/accounts/channel-1/locales", { method: "POST" }), {
  params: Promise.resolve({ channelId: "channel-1" }),
});

const valid = {
  expectedDefaultLocale: "en",
  expectedAllowedLocales: ["ko", "en", "zh-Hant"],
  defaultLocale: "en",
  allowedLocales: ["en"],
};
const parses = (body) => captured.schema.safeParse(body).success;
const refusal = (error) => captured.refusal(error);
const tx = { marker: "tx" };
const runResult = await captured.run(tx, { body: valid, auditLogId: "audit-1", session: {} });

const results = {
  action: captured.action,
  targetType: captured.targetType,
  targetId: captured.targetId,
  gate: captured.gate,
  bucket: captured.bucket,
  metadata: captured.metadata(valid),
  parses: {
    valid: parses(valid),
    unknownLocale: parses({ ...valid, allowedLocales: ["en", "fr"] }),
    noLocales: parses({ ...valid, allowedLocales: [] }),
    extraKey: parses({ ...valid, status: "approval_mode" }),
    missingExpected: parses({ defaultLocale: "en", allowedLocales: ["en"] }),
  },
  refusal: {
    own: refusal(new MarketingChannelLocalesRefusedError("locales_change_conflict", 409, "moved")),
    other: refusal(new Error("boom")),
  },
  run: { result: runResult, sameTx: storeCalls[0]?.tx === tx, input: storeCalls[0]?.input },
};

console.log(`MARKETING_ACCOUNT_LOCALES_ROUTE=${JSON.stringify(results)}`);
