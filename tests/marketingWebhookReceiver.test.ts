// The staging shadow receiver's decisions, in the order the plan fixes (S2e).

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import {
  MARKETING_WEBHOOK_MAX_BODY_BYTES,
  handleZernioWebhook,
  type MarketingWebhookReceiverDeps,
} from "@/lib/marketingWebhookReceiver";
import { marketingWebhookEventIdDigest } from "@/lib/marketingWebhookCore";
import type { MarketingPublishAdapter } from "@/lib/marketingPublishAdapter";

const SECRET = "whsec_" + "s".repeat(40);
const EVENT_ID = "1f0e8a52-4c1b-4f6a-9d2e-5c7e1a4b6d90";
const DIGEST = marketingWebhookEventIdDigest("zernio", EVENT_ID);

const payload = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    id: EVENT_ID,
    event: "post.published",
    timestamp: "2026-10-02T09:00:00.000Z",
    post: {
      id: "zpost_1",
      status: "published",
      platforms: [{ platform: "linkedin", status: "published", accountId: "acct_9" }],
    },
    ...overrides,
  });

const request = (
  body: string,
  options: { signature?: string | null; eventId?: string | null; secret?: string } = {},
) => {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const signature =
    options.signature === undefined
      ? createHmac("sha256", options.secret ?? SECRET).update(body).digest("hex")
      : options.signature;
  if (signature !== null) headers["x-zernio-signature"] = signature;
  const eventId = options.eventId === undefined ? EVENT_ID : options.eventId;
  if (eventId !== null) headers["x-zernio-event-id"] = eventId;
  return new Request("https://staging.test/api/webhooks/zernio", { method: "POST", headers, body });
};

const PIPELINE = "a".repeat(64);
const CONFIG = "b".repeat(64);

type Calls = { name: string; input?: unknown }[];

const deps = (
  overrides: Partial<MarketingWebhookReceiverDeps> = {},
  options: {
    status?: "live" | "removed" | "unknown" | Error;
    record?: "recorded" | "duplicate";
    shadow?: string | null;
    channels?: { id: string; externalAccountRef: string }[];
  } = {},
) => {
  const calls: Calls = [];
  const adapter = {
    lookupStatus: async (id: string) => {
      calls.push({ name: "lookupStatus", input: id });
      if (options.status instanceof Error) throw options.status;
      return { state: options.status ?? "live", externalUrl: "https://x.test" };
    },
  } as unknown as MarketingPublishAdapter;
  const value: MarketingWebhookReceiverDeps = {
    isStaging: () => true,
    killSwitchOn: () => false,
    secret: SECRET,
    pipelineFingerprint: PIPELINE,
    readSnapshot: async () => {
      calls.push({ name: "readSnapshot" });
      return {
        shadowValue: options.shadow === undefined ? "true" : options.shadow,
        channels: options.channels ?? [
          { id: "chn_1", externalAccountRef: "acct_9" },
          { id: "chn_B", externalAccountRef: "acct_B" },
        ],
        configDigest: CONFIG,
      };
    },
    adapter,
    consumeFaultArm: async (digest) => {
      calls.push({ name: "consumeFaultArm", input: digest });
      return { consumed: false };
    },
    recordShadow: async (input) => {
      calls.push({ name: "recordShadow", input });
      return options.record ?? "recorded";
    },
    ...overrides,
  };
  return { value, calls, names: () => calls.map((call) => call.name) };
};

const answer = async (response: Response) => ({
  status: response.status,
  body: (await response.json()) as Record<string, unknown>,
});

test("a signed event in staging is recorded in shadow, after the latch and the switch", async () => {
  const { value, calls, names } = deps();
  const { status, body } = await answer(await handleZernioWebhook(request(payload()), value));
  assert.equal(status, 200);
  assert.equal(body.status, "recorded");
  assert.deepEqual(names(), [
    "readSnapshot",
    "consumeFaultArm",
    "lookupStatus",
    "recordShadow",
  ]);
  assert.deepEqual(calls.at(-1)?.input, {
    eventIdDigest: DIGEST,
    eventType: "post.published",
    channelId: "chn_1",
    derivedStatus: "published",
    statusQueryMatch: true,
  });
});

test("every staging answer names its build, and a signed one its configuration", async () => {
  const signedAnswer = await answer(await handleZernioWebhook(request(payload()), deps().value));
  assert.equal(signedAnswer.body.pipeline, PIPELINE);
  assert.equal(signedAnswer.body.config, CONFIG);

  // Refused before the signature: the build only, no configuration read.
  let configRead = false;
  const refused = await answer(
    await handleZernioWebhook(
      request(payload(), { signature: "0".repeat(64) }),
      deps({
        readSnapshot: async () => {
          configRead = true;
          throw new Error("not reached");
        },
      }).value,
    ),
  );
  assert.equal(refused.status, 401);
  assert.equal(refused.body.pipeline, PIPELINE);
  assert.equal("config" in refused.body, false);
  assert.equal(configRead, false);

  // An unreadable configuration is not guessed: nothing is consumed or recorded,
  // and the delivery fails so Zernio retries it.
  const unreadable = deps({
    readSnapshot: async () => {
      throw new Error("down");
    },
  });
  await assert.rejects(handleZernioWebhook(request(payload()), unreadable.value));
  assert.deepEqual(unreadable.names(), []);

  // Outside staging nothing is said, not even the build.
  const outside = await answer(
    await handleZernioWebhook(request(payload()), deps({ isStaging: () => false }).value),
  );
  assert.equal("pipeline" in outside.body, false);
});

test("outside staging nothing is read, nothing is consumed and nothing is recorded", async () => {
  const { value, calls } = deps({ isStaging: () => false });
  const { status } = await answer(await handleZernioWebhook(request(payload()), value));
  assert.equal(status, 404);
  assert.deepEqual(calls, []);
});

test("a signature that does not verify is refused before anything else", async () => {
  for (const options of [
    { signature: null },
    { signature: "0".repeat(64) },
    { secret: "another-secret" },
  ]) {
    const { value, calls } = deps();
    const { status, body } = await answer(
      await handleZernioWebhook(request(payload(), options), value),
    );
    assert.equal(status, 401, JSON.stringify(options));
    assert.equal(body.code, "signature_invalid");
    assert.deepEqual(calls, []);
  }
  // No secret configured is the same refusal, never an open door.
  const { value } = deps({ secret: undefined });
  assert.equal((await handleZernioWebhook(request(payload()), value)).status, 401);
});

test("an event outside the recorded list is acknowledged and nothing more", async () => {
  const { value, calls } = deps();
  const { status, body } = await answer(
    await handleZernioWebhook(request(payload({ event: "comment.received" })), value),
  );
  assert.equal(status, 200);
  assert.equal(body.status, "ignored");
  assert.deepEqual(calls, []);
});

test("a malformed or mismatched envelope is a 400", async () => {
  for (const [body, options, code] of [
    ["{", {}, "body_not_json"],
    [payload({ id: "not-a-uuid" }), {}, "envelope_invalid"],
    [payload(), { eventId: "another" }, "event_id_header_mismatch"],
  ] as const) {
    const { value, calls } = deps();
    const result = await answer(await handleZernioWebhook(request(body, options), value));
    assert.equal(result.status, 400);
    assert.equal(result.body.code, code);
    assert.deepEqual(calls, []);
  }
});

test("a consumed latch answers 5xx once, before the switch or any storage", async () => {
  const { value, names } = deps({
    consumeFaultArm: async () => ({ consumed: true }),
  });
  const { status, body } = await answer(await handleZernioWebhook(request(payload()), value));
  assert.equal(status, 503);
  assert.equal(body.code, "deliberate_fault");
  // The configuration was read (the answer carries it); nothing else ran.
  assert.equal(body.config, CONFIG);
  assert.deepEqual(names(), ["readSnapshot"]);
});

test("the retry after a consumed latch goes on normally and is recorded", async () => {
  // The latch is spent, so the second delivery of the same event is not failed
  // again; it is the shadow index that decides whether it is a duplicate.
  let first = true;
  const { value } = deps({
    consumeFaultArm: async () => {
      const consumed = first;
      first = false;
      return { consumed };
    },
  });
  assert.equal((await handleZernioWebhook(request(payload()), value)).status, 503);
  const retry = await answer(await handleZernioWebhook(request(payload()), value));
  assert.equal(retry.status, 200);
  assert.equal(retry.body.status, "recorded");
});

test("a duplicate delivery is answered as already recorded", async () => {
  const { value } = deps({}, { record: "duplicate" });
  const { status, body } = await answer(await handleZernioWebhook(request(payload()), value));
  assert.equal(status, 200);
  assert.equal(body.status, "duplicate");
});

test("with the shadow off nothing is resolved or recorded", async () => {
  for (const shadow of [null, "false", "TRUE"]) {
    const { value, names } = deps({}, { shadow });
    const { body } = await answer(await handleZernioWebhook(request(payload()), value));
    assert.equal(body.status, "shadow_off", String(shadow));
    assert.deepEqual(names(), ["readSnapshot", "consumeFaultArm"]);
  }
});

test("an account this system does not have is acknowledged, not recorded", async () => {
  // None holds the account, and two hold it: neither is one channel.
  for (const channels of [
    [],
    [
      { id: "chn_1", externalAccountRef: "acct_9" },
      { id: "chn_2", externalAccountRef: "acct_9" },
    ],
  ]) {
    const { value, names } = deps({}, { channels });
    const { body } = await answer(await handleZernioWebhook(request(payload()), value));
    assert.equal(body.status, "channel_unknown");
    assert.equal(names().includes("recordShadow"), false);
  }
});

test("a status query that cannot answer is recorded as not agreeing", async () => {
  for (const [options, overrides] of [
    [{ status: new Error("timeout") }, {}],
    [{ status: "unknown" as const }, {}],
    [{}, { adapter: null }],
  ] as const) {
    const { value, calls } = deps(overrides as Partial<MarketingWebhookReceiverDeps>, options);
    await handleZernioWebhook(request(payload()), value);
    const recorded = calls.find((call) => call.name === "recordShadow")?.input as {
      statusQueryMatch: boolean;
    };
    assert.equal(recorded.statusQueryMatch, false);
  }
});

test("a removal by the platform is recorded with the status it implies", async () => {
  const { value, calls } = deps({}, { status: "unknown" });
  await handleZernioWebhook(
    request(payload({ event: "post.platform.deleted", account: { accountId: "acct_9" } })),
    value,
  );
  const recorded = calls.find((call) => call.name === "recordShadow")?.input as {
    derivedStatus: string;
  };
  assert.equal(recorded.derivedStatus, "removed_by_platform");
});

test("a body over the limit is refused without being verified", async () => {
  const { value, calls } = deps();
  const big = "x".repeat(MARKETING_WEBHOOK_MAX_BODY_BYTES + 1);
  const { status } = await answer(await handleZernioWebhook(request(big), value));
  assert.equal(status, 413);
  assert.deepEqual(calls, []);
});

// ---------------------------------------------------------------------------
// Round-1 review
// ---------------------------------------------------------------------------

test("the kill switch stops everything before the body is read", async () => {
  const { value, calls } = deps({ killSwitchOn: () => true });
  const stream = new ReadableStream();
  const response = await handleZernioWebhook(
    new Request("https://staging.test/api/webhooks/zernio", {
      method: "POST",
      body: stream,
      // Node's fetch needs this for a streamed body.
      duplex: "half",
    } as RequestInit),
    value,
  );
  const { status, body } = await answer(response);
  assert.equal(status, 200);
  assert.equal(body.status, "kill_switch");
  // No latch consumed, nothing resolved, queried or recorded.
  assert.deepEqual(calls, []);
});

test("a per-platform event resolves the channel by the account it names", async () => {
  const raw = JSON.stringify({
    id: EVENT_ID,
    event: "post.platform.deleted",
    timestamp: "2026-10-02T09:00:00.000Z",
    account: { accountId: "acct_B" },
    post: {
      id: "zpost_1",
      platforms: [
        { platform: "linkedin", accountId: "acct_A" },
        { platform: "linkedin", accountId: "acct_B" },
      ],
    },
  });
  const { value, calls } = deps({}, { status: "unknown" });
  await handleZernioWebhook(request(raw), value);
  assert.equal(
    (calls.find((call) => call.name === "recordShadow")?.input as { channelId?: string })?.channelId,
    "chn_B",
  );
});

test("a body with no declared length is cut off at the limit, not buffered whole", async () => {
  // A chunked body that would go on for ever: the reader must stop pulling
  // once the limit is passed, and the request is refused.
  const chunk = new Uint8Array(64 * 1024);
  let pulled = 0;
  const endless = new ReadableStream({
    pull(controller) {
      pulled += 1;
      controller.enqueue(chunk);
    },
  });
  const { value, calls } = deps();
  const response = await handleZernioWebhook(
    new Request("https://staging.test/api/webhooks/zernio", {
      method: "POST",
      body: endless,
      // Node's fetch needs this for a streamed body.
      duplex: "half",
    } as RequestInit),
    value,
  );
  assert.equal(response.status, 413);
  assert.deepEqual(calls, []);
  // Four 64 KiB chunks reach the limit; the fifth passes it and stops the read.
  assert.ok(pulled <= 6, `read ${pulled} chunks`);
});
