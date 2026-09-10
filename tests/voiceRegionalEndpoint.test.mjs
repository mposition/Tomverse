// Voice transcription is pinned to the United States, and stays pinned.
//
// Contract: docs/policy/voice-input.md §11.3.
//
// The reason these are fail-closed rather than a single happy-path assertion:
// the region is not a performance choice, it is the country named in an
// overseas-transfer notice under Korean privacy law. A change that quietly
// restored global routing would not break a feature — it would make a
// published legal statement false, and nothing else in the system would
// notice.
//
// So each test below fails if the *previous* behaviour comes back, not merely
// if the new one is absent.

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  VOICE_TRANSCRIPTION_OPENAI_BASE_URL,
  VOICE_TRANSCRIPTION_PROVIDER_REGION,
  transcribeWithOpenAi,
  voiceTranscriptionEndpoint,
} from "../lib/voiceTranscriptionPortCore.ts";

const read = (relative) =>
  readFileSync(fileURLToPath(new URL(`../${relative}`, import.meta.url)), "utf8");

/** Comments say why the old host is gone; they are not the old host. */
const withoutComments = (source) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, (match, lead) => lead);

const US_ENDPOINT = "https://us.api.openai.com/v1/audio/transcriptions";

/** Every Voice module that could originate or configure the provider call. */
const VOICE_RUNTIME_SOURCES = [
  "lib/voiceTranscriptionPortCore.ts",
  "lib/voiceTranscriptionPort.ts",
  "app/api/chat/voice-transcription/route.ts",
];

const runTranscription = async (config = {}) => {
  let captured = null;
  await transcribeWithOpenAi(
    {
      audio: new Uint8Array([1, 2, 3, 4]),
      mediaType: "audio/webm",
      extension: "webm",
      languageHint: null,
    },
    {
      apiKey: "test-key",
      model: "gpt-4o-mini-transcribe",
      fetchImpl: async (url, init) => {
        captured = { url, init };
        return new Response(JSON.stringify({ text: "hello" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
      ...config,
    }
  );
  return captured;
};

test("a transcription with no injected host goes to the US endpoint", async () => {
  // The one that fails if the global default returns. It asserts the whole
  // URL rather than a substring: a base of `https://api.openai.com` with the
  // right path would pass a looser check and be the exact regression.
  const captured = await runTranscription();
  assert.equal(captured.url, US_ENDPOINT);
});

test("the pinned host and region come from one place", () => {
  assert.equal(VOICE_TRANSCRIPTION_OPENAI_BASE_URL, "https://us.api.openai.com");
  assert.equal(VOICE_TRANSCRIPTION_PROVIDER_REGION, "us");
  // The region identifier is the host's own subdomain rather than a second
  // string that agrees with it today. Two independent literals is how a record
  // comes to say "us" about a request that went somewhere else.
  assert.equal(
    new URL(VOICE_TRANSCRIPTION_OPENAI_BASE_URL).hostname.split(".")[0],
    VOICE_TRANSCRIPTION_PROVIDER_REGION
  );
});

test("no Voice runtime source can still reach the global endpoint", () => {
  const offenders = [];
  for (const path of VOICE_RUNTIME_SOURCES) {
    const source = withoutComments(read(path));
    if (source.includes("https://api.openai.com")) offenders.push(path);
  }
  assert.deepEqual(
    offenders,
    [],
    "a global-endpoint literal in Voice runtime code is a path out of the pinned region"
  );
});

test("the production binding names the pinned host itself", () => {
  const source = withoutComments(read("lib/voiceTranscriptionPort.ts"));
  assert.match(
    source,
    /baseUrl:\s*VOICE_TRANSCRIPTION_OPENAI_BASE_URL/,
    "the binding must pass the constant, not rely on a default it does not state"
  );
});

test("no environment variable can move the endpoint", () => {
  // Not a scan for one variable name -- a scan for the *shape*. `VOICE_X_URL`,
  // `VOICE_REGION`, a base URL read from `env` at all: any of them would make
  // the country a deployment setting, and the notice would then describe a
  // configuration rather than the code.
  const offenders = [];
  for (const path of VOICE_RUNTIME_SOURCES) {
    const source = withoutComments(read(path));
    for (const match of source.matchAll(
      /(?:process\.env|env)\s*(?:\.\s*|\[\s*["'])([A-Za-z_][A-Za-z0-9_]*)/g
    )) {
      const name = match[1];
      if (/BASE_URL|_URL|_HOST|REGION|GEOGRAPHY|ENDPOINT/i.test(name)) {
        offenders.push(`${path}: ${name}`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "the pinned region must not be selectable from the environment"
  );
});

test("an injected host is honoured only when explicitly given", async () => {
  const captured = await runTranscription({ baseUrl: "https://example.test" });
  assert.equal(captured.url, "https://example.test/v1/audio/transcriptions");
});

test("joining a host that ends in a slash does not double the separator", () => {
  assert.equal(
    voiceTranscriptionEndpoint("https://example.test/"),
    "https://example.test/v1/audio/transcriptions"
  );
  assert.equal(
    voiceTranscriptionEndpoint("https://example.test///"),
    "https://example.test/v1/audio/transcriptions"
  );
  assert.equal(
    voiceTranscriptionEndpoint(VOICE_TRANSCRIPTION_OPENAI_BASE_URL),
    US_ENDPOINT
  );
});

test("pinning the region changed nothing about the multipart surface", async () => {
  // The regional host is a different origin, and a different origin is exactly
  // when somebody adds a header or a field "for routing". The parts are the
  // same four, and the only header is the bearer.
  const captured = await runTranscription();
  const form = captured.init.body;
  assert.deepEqual([...form.keys()].sort(), ["file", "model", "response_format"]);
  assert.equal(form.get("file").name, "voice.webm");
  assert.deepEqual(Object.keys(captured.init.headers), ["Authorization"]);

  const withLanguage = await runTranscription();
  assert.ok(![...withLanguage.init.body.keys()].includes("region"));
});

test("other OpenAI callers are untouched by the Voice pin", () => {
  // The decision is Voice-only. Chat and image adapters keep whatever host
  // they had, and a sweep that moved them would have changed products nobody
  // made a data-residency decision about.
  const others = [
    "lib/imageProviderAdapter.ts",
    "lib/modelRegistryShared.ts",
  ];
  for (const path of others) {
    const source = read(path);
    assert.ok(
      !source.includes("us.api.openai.com"),
      `${path} must not have been swept into the Voice region pin`
    );
  }
});
