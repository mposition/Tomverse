// Voice transcription goes to one host, chosen in code, and stays there.
//
// Contract: docs/policy/voice-input.md §11.3.
//
// These were written for a pin to `us.api.openai.com` and now hold the global
// host instead, because the provider refused the regional one for this
// organization (§10 of the 2026-09-10 record). **The property under test did
// not change with the value.** What a privacy notice can say about where a
// recording goes is only as stable as the thing that decides it, so the
// destination must come from code and nothing in a deployment may move it.
//
// That is why these are fail-closed rather than one happy-path assertion. A
// change that let the environment pick the host would not break a feature —
// it would make a published legal statement unverifiable, and nothing else in
// the system would notice.
//
// So each test fails if the property is lost, not merely if today's value is
// absent.

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

const GLOBAL_ENDPOINT = "https://api.openai.com/v1/audio/transcriptions";

/** Any `xx.api.openai.com`. The provider documents ten of them. */
const REGIONAL_HOST = /https:\/\/[a-z]{2}\.api\.openai\.com/;

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

test("a transcription with no injected host goes to the global endpoint", async () => {
  // The whole URL, not a substring. A base that merely *contains*
  // `api.openai.com` — every regional host does — would pass a looser check
  // while sending the request somewhere the notice does not describe.
  const captured = await runTranscription();
  assert.equal(captured.url, GLOBAL_ENDPOINT);
});

test("the host and the region identifier cannot disagree", () => {
  assert.equal(VOICE_TRANSCRIPTION_OPENAI_BASE_URL, "https://api.openai.com");
  assert.equal(VOICE_TRANSCRIPTION_PROVIDER_REGION, "global");
  // The two are checked against each other, not just against their literals.
  // Two independent strings is how a record comes to say one thing about a
  // request that went somewhere else — which is the failure this file exists
  // for, and it does not care which direction the drift runs.
  const host = VOICE_TRANSCRIPTION_OPENAI_BASE_URL;
  const isRegional = REGIONAL_HOST.test(host);
  assert.equal(
    isRegional,
    VOICE_TRANSCRIPTION_PROVIDER_REGION !== "global",
    "a regional host must carry a region identifier, and a global host must not"
  );
  if (isRegional) {
    assert.equal(
      new URL(host).hostname.split(".")[0],
      VOICE_TRANSCRIPTION_PROVIDER_REGION
    );
  }
});

test("no Voice runtime source hard-codes a regional host", () => {
  // Inverted when the pin was lifted, and worth keeping in the new direction:
  // a stray `us.`/`eu.` literal would send some requests to a host the notice
  // does not describe, and — as the provider proved — one that refuses this
  // organization outright. Comments are stripped first, because the doc
  // comment on the constant quotes the regional host to explain why it is
  // gone.
  const offenders = [];
  for (const path of VOICE_RUNTIME_SOURCES) {
    const source = withoutComments(read(path));
    if (REGIONAL_HOST.test(source)) offenders.push(path);
  }
  assert.deepEqual(
    offenders,
    [],
    "a regional-host literal in Voice runtime code bypasses the single constant"
  );
});

test("the production binding names the host constant itself", () => {
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
  // the destination a deployment setting, and the notice would then describe a
  // configuration rather than the code. This is the test that outlived the
  // pin: it is what lets the notice be checked by reading one line.
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
    "the destination must not be selectable from the environment"
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
    GLOBAL_ENDPOINT
  );
});

test("moving the host changed nothing about the multipart surface", async () => {
  // Changing origin is exactly when somebody adds a header or a field "for
  // routing" -- in either direction. The parts are the same, and the only
  // header is the bearer.
  const captured = await runTranscription();
  const form = captured.init.body;
  assert.deepEqual([...form.keys()].sort(), ["file", "model", "response_format"]);
  assert.equal(form.get("file").name, "voice.webm");
  assert.deepEqual(Object.keys(captured.init.headers), ["Authorization"]);

  const withLanguage = await runTranscription();
  assert.ok(![...withLanguage.init.body.keys()].includes("region"));
});

test("other OpenAI callers were never moved by the Voice decision", () => {
  // The decision was Voice-only in both directions. Chat and image adapters
  // keep whatever host they had; a sweep that pinned them, or that later
  // unpinned something it had pinned, would have changed products nobody made
  // a data-residency decision about.
  const others = [
    "lib/imageProviderAdapter.ts",
    "lib/modelRegistryShared.ts",
  ];
  for (const path of others) {
    const source = read(path);
    assert.ok(
      !REGIONAL_HOST.test(source),
      `${path} must not have been swept into a Voice region decision`
    );
  }
});
