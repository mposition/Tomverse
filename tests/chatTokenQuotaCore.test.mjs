import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  findRetiredUserTokenLimitEnvNames,
  GUEST_IP_TOKEN_MULTIPLIER,
  GUEST_TOKENS_PER_DAY_DEFAULT,
  GUEST_TOKENS_PER_MONTH_DEFAULT,
  guestTokenLimits,
  RETIRED_USER_TOKEN_LIMIT_ENV,
  tokenQuotaRefusalDetails,
} from "../lib/chatTokenQuotaCore.ts";

const chatSecurity = readFileSync(
  new URL("../lib/chatSecurity.ts", import.meta.url),
  "utf8"
);

test("the retired account token caps are named and detectable", () => {
  assert.deepEqual(
    [...RETIRED_USER_TOKEN_LIMIT_ENV],
    ["CHAT_USER_TOKENS_PER_DAY", "CHAT_USER_TOKENS_PER_MONTH"]
  );
  assert.deepEqual(findRetiredUserTokenLimitEnvNames({}), []);
  assert.deepEqual(
    findRetiredUserTokenLimitEnvNames({
      CHAT_USER_TOKENS_PER_DAY: "1000000",
      CHAT_USER_TOKENS_PER_MONTH: "",
      CHAT_GUEST_TOKENS_PER_DAY: "40000",
    }),
    ["CHAT_USER_TOKENS_PER_DAY"]
  );
});

test("an account's token caps are not read anywhere in the admission path", () => {
  for (const name of RETIRED_USER_TOKEN_LIMIT_ENV) {
    assert.equal(
      chatSecurity.includes(`process.env.${name}`),
      false,
      `${name} must stay unread`
    );
  }
});

test("guests keep their day and month token quota", () => {
  assert.deepEqual(guestTokenLimits({}), {
    day: GUEST_TOKENS_PER_DAY_DEFAULT,
    month: GUEST_TOKENS_PER_MONTH_DEFAULT,
  });
  assert.deepEqual(
    guestTokenLimits({
      CHAT_GUEST_TOKENS_PER_DAY: "50000",
      CHAT_GUEST_TOKENS_PER_MONTH: "250000",
    }),
    { day: 50_000, month: 250_000 }
  );
  // An unusable override falls back rather than lifting or zeroing the quota.
  assert.deepEqual(
    guestTokenLimits({
      CHAT_GUEST_TOKENS_PER_DAY: "0",
      CHAT_GUEST_TOKENS_PER_MONTH: "lots",
    }),
    { day: GUEST_TOKENS_PER_DAY_DEFAULT, month: GUEST_TOKENS_PER_MONTH_DEFAULT }
  );
  assert.equal(GUEST_IP_TOKEN_MULTIPLIER, 3);
});

test("a token refusal says when it resets and by how much the request missed", () => {
  const resetAt = new Date("2026-09-16T00:00:00.000Z");
  assert.deepEqual(
    tokenQuotaRefusalDetails({
      scope: "day",
      used: 36_000,
      limit: 40_000,
      requiredTokens: 8_460,
      resetAt,
      timeZone: "UTC",
    }),
    {
      scope: "day",
      requiredTokens: 8_460,
      availableTokens: 4_000,
      resetAt: "2026-09-16T00:00:00.000Z",
      timeZone: "UTC",
    }
  );
  // A bucket already past its limit reports nothing left, never a negative.
  assert.equal(
    tokenQuotaRefusalDetails({
      scope: "month",
      used: 210_000,
      limit: 200_000,
      requiredTokens: 1,
      resetAt,
      timeZone: "UTC",
    }).availableTokens,
    0
  );
});
