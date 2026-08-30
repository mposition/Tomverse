import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mock, test } from "node:test";

/**
 * Server-side contract for `POST /api/chat/voice-transcription`.
 *
 * Contract: docs/policy/voice-input.md.
 *
 * Like the other files in this lane, most of this is about what the endpoint
 * *refuses*, and about what it does not do on the way to refusing: a request
 * that is turned away must not have reached the provider, must not have spent
 * the caller's operational budget, and must not have logged anything about
 * the audio.
 *
 * Only the session, the rate limiter, the feature flag, the budget and the
 * provider are replaced. The container inspection is the real one, driven with
 * the real recordings in `tests/fixtures/voice/` — a stubbed inspector would
 * make the size, type and length assertions below meaningless.
 */

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relative: string) => pathToFileURL(resolve(ROOT, relative)).href;

process.env.E2E_DISABLE_DATABASE = "true";
process.env.DATABASE_URL ||= "postgresql://e2e:e2e@127.0.0.1:1/e2e?connect_timeout=1";
process.env.DIRECT_URL ||= process.env.DATABASE_URL;
process.env.NEXTAUTH_SECRET ||= "voice-transcription-contract-secret";
process.env.NEXTAUTH_URL ||= "http://127.0.0.1:3100";

const fixture = (name: string) =>
  new Uint8Array(readFileSync(resolve(ROOT, "tests/fixtures/voice", name)));

const WEBM_2500MS = fixture("chromium-webm-opus-2500ms.webm");
const MP4_3000MS = fixture("chromium-mp4-aac-3000ms.mp4");
const WEBM_400MS = fixture("chromium-webm-opus-400ms.webm");

type ProviderCall = {
  mediaType: string;
  extension: string;
  byteLength: number;
  languageHint: string | null;
};

type World = {
  enabled: boolean;
  userId: string | null;
  rateLimitScopes: string[];
  rateLimitShouldFail: boolean;
  reserved: Array<{ userId: string; seconds: number }>;
  settled: Array<{ reservedSeconds: number; actualSeconds: number | null }>;
  budgetShouldRefuse: boolean;
  providerCalls: ProviderCall[];
  providerResult: unknown;
  logs: string[];
};

const freshWorld = (): World => ({
  enabled: true,
  userId: "user_voice_contract",
  rateLimitScopes: [],
  rateLimitShouldFail: false,
  reserved: [],
  settled: [],
  budgetShouldRefuse: false,
  providerCalls: [],
  providerResult: { ok: true, text: "  hello   there  ", durationSeconds: 2.4 },
  logs: [],
});

let world = freshWorld();
let mocksInstalled = false;

async function loadRoute(): Promise<{ POST: (request: Request) => Promise<Response> }> {
  if (!mocksInstalled) {
    mocksInstalled = true;

    mock.module(mod("lib/auth.ts"), {
      namedExports: { authOptions: {} },
    });
    mock.module("next-auth/next", {
      namedExports: {
        getServerSession: async () =>
          world.userId ? { user: { id: world.userId } } : null,
      },
    });

    mock.module(mod("lib/appSettings.ts"), {
      namedExports: { isVoiceInputEnabled: async () => world.enabled },
    });

    mock.module(mod("lib/apiSecurity.ts"), {
      namedExports: {
        consumeApiRateLimit: async (
          _request: unknown,
          _userId: string,
          scope: string
        ) => {
          world.rateLimitScopes.push(scope);
          if (world.rateLimitShouldFail) {
            const error = new Error("Too many requests.") as Error & {
              status: number;
              code: string;
            };
            error.name = "ApiSecurityError";
            error.status = 429;
            error.code = "API_RATE_LIMITED";
            throw error;
          }
        },
        apiSecurityResponse: (error: unknown) =>
          (error as { code?: string })?.code === "API_RATE_LIMITED"
            ? Response.json({ code: "API_RATE_LIMITED" }, { status: 429 })
            : null,
      },
    });

    const realBudget = (await import(mod("lib/voiceInputBudget.ts"))) as Record<
      string,
      unknown
    >;
    mock.module(mod("lib/voiceInputBudget.ts"), {
      namedExports: {
        ...realBudget,
        reserveVoiceSeconds: async (input: { userId: string; seconds: number }) => {
          if (world.budgetShouldRefuse) {
            const { VoiceBudgetError } = realBudget as {
              VoiceBudgetError: new (
                status: number,
                code: string,
                message: string,
                retryAfter?: number
              ) => Error;
            };
            throw new VoiceBudgetError(
              429,
              "VOICE_OPERATIONAL_LIMIT_REACHED",
              "limit",
              3600
            );
          }
          world.reserved.push(input);
          return { reservedSeconds: input.seconds };
        },
        settleVoiceSeconds: async (input: {
          reservedSeconds: number;
          actualSeconds: number | null;
        }) => {
          world.settled.push({
            reservedSeconds: input.reservedSeconds,
            actualSeconds: input.actualSeconds,
          });
        },
        releaseVoiceSeconds: async (input: { reservedSeconds: number }) => {
          world.settled.push({
            reservedSeconds: input.reservedSeconds,
            actualSeconds: 0,
          });
        },
      },
    });

    mock.module(mod("lib/voiceTranscriptionPort.ts"), {
      namedExports: {
        voiceTranscriptionKeySource: () => "dedicated",
        voiceTranscriptionProvider: () => ({
          transcribe: async (request: {
            audio: Uint8Array;
            mediaType: string;
            extension: string;
            languageHint: string | null;
          }) => {
            world.providerCalls.push({
              mediaType: request.mediaType,
              extension: request.extension,
              byteLength: request.audio.byteLength,
              languageHint: request.languageHint,
            });
            return world.providerResult;
          },
        }),
      },
    });

    for (const method of ["log", "warn", "error"] as const) {
      const original = console[method].bind(console);
      console[method] = (...args: unknown[]) => {
        world.logs.push(args.map((value) => String(value)).join(" "));
        if (process.env.VOICE_CONTRACT_VERBOSE) original(...args);
      };
    }
  }

  return (await import(
    mod("app/api/chat/voice-transcription/route.ts")
  )) as { POST: (request: Request) => Promise<Response> };
}

const post = async (
  bytes: Uint8Array,
  contentType = "audio/webm",
  headers: Record<string, string> = {}
) => {
  const { POST } = await loadRoute();
  return POST(
    new Request("http://127.0.0.1:3100/api/chat/voice-transcription", {
      method: "POST",
      headers: { "Content-Type": contentType, ...headers },
      body: bytes,
      // Node's fetch Request requires this for a body on some runtimes.
      duplex: "half",
    } as RequestInit)
  );
};

const reset = () => {
  world = freshWorld();
};

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

test("a disabled feature refuses before the session or the body is touched", async () => {
  reset();
  world.enabled = false;
  const response = await post(WEBM_2500MS);

  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, "VOICE_INPUT_DISABLED");
  assert.deepEqual(world.providerCalls, []);
  assert.deepEqual(world.reserved, []);
  assert.deepEqual(
    world.rateLimitScopes,
    [],
    "a disabled feature must not even consume a rate-limit slot"
  );
});

test("a guest is refused with its own code, not a generic failure", async () => {
  reset();
  world.userId = null;
  const response = await post(WEBM_2500MS);

  assert.equal(response.status, 401);
  assert.equal((await response.json()).code, "VOICE_AUTHENTICATION_REQUIRED");
  assert.deepEqual(world.providerCalls, []);
  assert.deepEqual(world.reserved, []);
});

// ---------------------------------------------------------------------------
// The clip
// ---------------------------------------------------------------------------

test("a real recording is transcribed and the transcript is normalised", async () => {
  reset();
  const response = await post(WEBM_2500MS, "audio/webm");

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { transcript: "hello there" });
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(world.providerCalls.length, 1);
  assert.deepEqual(world.providerCalls[0], {
    mediaType: "audio/webm",
    extension: "webm",
    byteLength: WEBM_2500MS.byteLength,
    // Automatic detection: docs/policy/voice-input.md §12.
    languageHint: null,
  });
});

test("an MP4 recording takes the MP4 branch of the table", async () => {
  reset();
  const response = await post(MP4_3000MS, "audio/mp4");

  assert.equal(response.status, 200);
  assert.equal(world.providerCalls[0].mediaType, "audio/mp4");
  assert.equal(world.providerCalls[0].extension, "mp4");
});

test("a media type the table does not carry is refused before the body is read", async () => {
  reset();
  const response = await post(WEBM_2500MS, "audio/ogg");

  assert.equal(response.status, 415);
  assert.equal((await response.json()).code, "VOICE_CLIP_UNSUPPORTED_TYPE");
  assert.deepEqual(world.providerCalls, []);
});

test("a clip that is only container headers is refused as empty", async () => {
  reset();
  const response = await post(WEBM_400MS, "audio/webm");

  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, "VOICE_CLIP_EMPTY");
  assert.deepEqual(world.providerCalls, []);
  assert.deepEqual(world.reserved, []);
});

test("a declared length over the ceiling is refused without reading the body", async () => {
  reset();
  const response = await post(WEBM_2500MS, "audio/webm", {
    "Content-Length": String(64 * 1024 * 1024),
  });

  assert.equal(response.status, 413);
  assert.equal((await response.json()).code, "VOICE_CLIP_TOO_LARGE");
  assert.deepEqual(world.providerCalls, []);
});

test("bytes that disagree with the declared type are refused", async () => {
  reset();
  const response = await post(MP4_3000MS, "audio/webm");

  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, "VOICE_CLIP_TYPE_MISMATCH");
  assert.deepEqual(world.providerCalls, []);
});

test("bytes that are not a container at all are refused", async () => {
  reset();
  const noise = new Uint8Array(4096).fill(0x41);
  const response = await post(noise, "audio/webm");

  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, "VOICE_CLIP_UNREADABLE");
  assert.deepEqual(world.providerCalls, []);
});

test("a clip longer than the limit is refused before the provider is paid", async () => {
  reset();
  // A real WebM header whose Info declares a two-hour Duration. Built from the
  // real recording so everything except the length is genuine.
  const bytes = Uint8Array.from(WEBM_2500MS);
  // The Duration element in the fixture is a 4-byte float at a known offset;
  // located rather than hard-coded so a regenerated fixture still works.
  let durationOffset = -1;
  for (let index = 0; index < 512; index++) {
    if (bytes[index] === 0x44 && bytes[index + 1] === 0x89 && bytes[index + 2] === 0x84) {
      durationOffset = index + 3;
      break;
    }
  }
  assert.ok(durationOffset > 0, "the fixture no longer carries a 4-byte Duration");
  // TimecodeScale is 1 ms, so this is 7,200,000 ms = two hours.
  new DataView(bytes.buffer).setFloat32(durationOffset, 7_200_000);

  const response = await post(bytes, "audio/webm");
  assert.equal(response.status, 413);
  assert.equal((await response.json()).code, "VOICE_CLIP_TOO_LONG");
  assert.deepEqual(world.providerCalls, [], "the provider bills per second");
  assert.deepEqual(world.reserved, []);
});

// ---------------------------------------------------------------------------
// The operational guardrail
// ---------------------------------------------------------------------------

test("seconds are reserved before the provider call and settled to what it billed", async () => {
  reset();
  world.providerResult = { ok: true, text: "hello", durationSeconds: 2.4 };
  await post(WEBM_2500MS, "audio/webm");

  // The container declared about 2.4s, rounded up to 3 for the reservation.
  assert.deepEqual(world.reserved, [{ userId: "user_voice_contract", seconds: 3 }]);
  assert.deepEqual(world.settled, [{ reservedSeconds: 3, actualSeconds: 2.4 }]);
});

test("a refused budget stops the request before the provider", async () => {
  reset();
  world.budgetShouldRefuse = true;
  const response = await post(WEBM_2500MS, "audio/webm");

  assert.equal(response.status, 429);
  assert.equal((await response.json()).code, "VOICE_OPERATIONAL_LIMIT_REACHED");
  assert.equal(response.headers.get("Retry-After"), "3600");
  assert.deepEqual(world.providerCalls, []);
});

test("the rate limiter is consumed under the voice scope, not a chat one", async () => {
  reset();
  await post(WEBM_2500MS, "audio/webm");
  assert.deepEqual(world.rateLimitScopes, ["voice-transcription"]);
});

test("a rate-limited caller is refused before the provider", async () => {
  reset();
  world.rateLimitShouldFail = true;
  const response = await post(WEBM_2500MS, "audio/webm");

  assert.equal(response.status, 429);
  assert.deepEqual(world.providerCalls, []);
  assert.deepEqual(world.reserved, []);
});

// ---------------------------------------------------------------------------
// Provider outcomes
// ---------------------------------------------------------------------------

test("a provider failure gives the reservation back", async () => {
  reset();
  world.providerResult = { ok: false, code: "provider_unavailable", status: 503 };
  const response = await post(WEBM_2500MS, "audio/webm");

  assert.equal(response.status, 502);
  assert.equal((await response.json()).code, "VOICE_PROVIDER_UNAVAILABLE");
  assert.deepEqual(
    world.settled,
    [{ reservedSeconds: 3, actualSeconds: 0 }],
    "a provider that refused the clip did not bill for it"
  );
});

test("a provider that refused the audio is distinguished from one that is down", async () => {
  reset();
  world.providerResult = { ok: false, code: "provider_rejected_audio", status: 400 };
  const response = await post(WEBM_2500MS, "audio/webm");

  assert.equal(response.status, 422);
  assert.equal((await response.json()).code, "VOICE_TRANSCRIPTION_FAILED");
});

test("a missing provider key reads as unavailable, not as the user's fault", async () => {
  reset();
  world.providerResult = {
    ok: false,
    code: "provider_not_configured",
    status: null,
    notConfigured: true,
  };
  const response = await post(WEBM_2500MS, "audio/webm");

  assert.equal(response.status, 502);
  assert.equal((await response.json()).code, "VOICE_PROVIDER_UNAVAILABLE");
});

test("a clip with no speech gets its own code", async () => {
  reset();
  world.providerResult = { ok: true, text: "   ", durationSeconds: 1.2 };
  const response = await post(WEBM_2500MS, "audio/webm");

  assert.equal(response.status, 422);
  assert.equal(
    (await response.json()).code,
    "VOICE_TRANSCRIPT_EMPTY",
    "'try again' is right here and wrong for most of this endpoint's other refusals"
  );
  // Still settled: the provider did the work and billed for it.
  assert.deepEqual(world.settled, [{ reservedSeconds: 3, actualSeconds: 1.2 }]);
});

test("an impossibly long transcript is refused rather than truncated", async () => {
  reset();
  world.providerResult = {
    ok: true,
    text: "a".repeat(10_000),
    durationSeconds: 2,
  };
  const response = await post(WEBM_2500MS, "audio/webm");

  assert.equal(response.status, 422);
  assert.equal((await response.json()).code, "VOICE_TRANSCRIPT_EMPTY");
});

// ---------------------------------------------------------------------------
// What is never written down
// ---------------------------------------------------------------------------

test("no log line from any outcome contains the transcript or the audio", async () => {
  reset();
  world.providerResult = {
    ok: true,
    text: "my bank password is hunter2",
    durationSeconds: 2,
  };
  await post(WEBM_2500MS, "audio/webm");

  world.providerResult = { ok: false, code: "provider_rejected_audio", status: 400 };
  await post(WEBM_2500MS, "audio/webm");

  world.userId = null;
  await post(WEBM_2500MS, "audio/webm");

  assert.ok(world.logs.length > 0, "the endpoint should report each request");
  const everything = world.logs.join("\n");
  assert.ok(!everything.includes("hunter2"));
  assert.ok(!everything.includes("password"));
  // Not the raw bytes either, in any obvious encoding.
  assert.ok(!everything.includes(Buffer.from(WEBM_2500MS).toString("base64").slice(0, 32)));
  // And every line is parseable structured output with a known event name.
  for (const line of world.logs) {
    const parsed = JSON.parse(line);
    assert.equal(parsed.event, "voice_transcription");
    assert.equal(typeof parsed.outcome, "string");
  }
});
