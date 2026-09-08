import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  VOICE_TRANSCRIPTION_PORT_SURFACE,
  transcribeWithOpenAi,
} from "../lib/voiceTranscriptionPortCore.ts";
import { OpenAiVoiceTranscriptionProvider } from "../lib/voiceTranscriptionPort.ts";
import { PROVIDER_API_KEY_ENV_NAMES } from "../lib/modelRegistryShared.ts";

/**
 * The promise the whole feature is arranged around: docs/policy/voice-input.md
 * §11.
 *
 * A recording is held in memory for the length of one request and then it is
 * gone. Not deleted later by a sweeper — never written anywhere in the first
 * place. And nothing derived from the audio or the transcript reaches a log,
 * an error, or an error tracker.
 *
 * ## Why some of this is a source scan
 *
 * "This code never writes the audio to a database" is a claim about *every*
 * path through the handler, including the ones no test drives. A behavioural
 * test proves the paths it exercises; the scan proves the absence. Both are
 * here, and the scan is deliberately narrow — it names the specific calls that
 * would break the promise, so it fails on a real regression rather than on
 * ordinary editing.
 */

const read = (relative) =>
  readFileSync(fileURLToPath(new URL(`../${relative}`, import.meta.url)), "utf8");

const VOICE_SOURCES = [
  "app/api/chat/voice-transcription/route.ts",
  "lib/voiceTranscriptionPort.ts",
  "lib/voiceTranscriptionPortCore.ts",
  "lib/voiceClipDuration.ts",
  "lib/voiceTranscript.ts",
  "lib/voiceInputBudget.ts",
];

/** Comments explain why something is absent; they are not the thing itself. */
const withoutComments = (source) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");

test("no voice module persists anything", () => {
  // `lib/voiceInputBudget.ts` is the one exception and is exempted by name: it
  // writes a *counter*, and the counter holds a number of seconds keyed by a
  // hash of the user id. Nothing about the audio is in it.
  const persisting = [
    // Object storage
    /writeR2Object|putObject|PutObjectCommand|getSignedUrl/,
    // Rows carrying content
    /prisma\.\w*[Aa]ttachment|prisma\.message|prisma\.conversation|prisma\.generatedArtifact/,
    // The filesystem
    /writeFileSync|createWriteStream|fs\.promises\.writeFile/,
  ];

  for (const path of VOICE_SOURCES) {
    const source = withoutComments(read(path));
    for (const pattern of persisting) {
      assert.ok(
        !pattern.test(source),
        `${path} matches ${pattern} — a voice module must not persist audio (docs/policy/voice-input.md §11.1)`
      );
    }
  }
});

test("the log scanner can actually fail", () => {
  // A scan that reports nothing is indistinguishable from a scan that finds
  // nothing, and the first version of this file's scanner was broken in
  // exactly that direction. So it is pointed at a source that does the thing.
  const offending = `
    console.warn(JSON.stringify({ event: "voice", transcript: result.text }));
    console.log("fine");
  `;
  const found = consoleArguments(offending);
  assert.equal(found.length, 2);
  assert.ok(found[0].includes("transcript"));
  assert.ok(!found[1].includes("transcript"));
});

test("the endpoint has no read-back surface", () => {
  const source = read("app/api/chat/voice-transcription/route.ts");
  // A `GET` would imply something is stored to get. There is nothing to get.
  assert.ok(!/export async function GET/.test(source));
  assert.ok(!/export async function PUT/.test(source));
  assert.ok(!/export async function DELETE/.test(source));
  assert.ok(/export async function POST/.test(source));
});

test("nothing logs the audio, the transcript or a key", () => {
  const forbiddenInLogs = [
    // The bytes, under any of the names they go by in these files.
    "body.bytes",
    "audio",
    // The text, whole or measured. A character count is a fact about what was
    // said, and a prefix is a quotation.
    "transcript",
    "result.text",
    "apiKey",
    "Authorization",
  ];

  for (const path of VOICE_SOURCES) {
    const source = withoutComments(read(path));
    for (const argumentList of consoleArguments(source)) {
      for (const term of forbiddenInLogs) {
        assert.ok(
          !argumentList.includes(term),
          `${path} logs ${term} (docs/policy/voice-input.md §11.2)\n  in: ${argumentList}`
        );
      }
    }
  }
});

/**
 * Every `console.*` call's argument list, delimited by balanced parentheses.
 *
 * A regular expression cannot do this: `console.log(line)` followed later by
 * an unrelated multi-line call makes any non-greedy `\n\s*\);` pattern swallow
 * everything between them, and the scan then reports terms from code that is
 * nowhere near a log. That is not a stricter test, it is a test that fails for
 * the wrong reason — and it did, which is how this function came to exist.
 */
function consoleArguments(source) {
  const calls = [];
  const pattern = /console\.\w+\(/g;
  for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
    let depth = 1;
    let index = match.index + match[0].length;
    const start = index;
    while (index < source.length && depth > 0) {
      const character = source[index];
      if (character === "(") depth++;
      else if (character === ")") depth--;
      index++;
    }
    calls.push(source.slice(start, index - 1));
  }
  return calls;
}

test("the endpoint's structured event carries only outcome fields", () => {
  const source = read("app/api/chat/voice-transcription/route.ts");
  const report = source.match(/const report = \(fields: \{([\s\S]*?)\}\) =>/);
  assert.ok(report, "the report helper moved; re-check what it can carry");

  const fields = [...report[1].matchAll(/^\s*(\w+)\??:/gm)].map((match) => match[1]);
  assert.deepEqual(
    fields.sort(),
    [
      "disposition",
      "durationSeconds",
      "durationSource",
      "mediaType",
      "outcome",
      "providerFailure",
      "providerStatus",
      "releasedSeconds",
      "reservedSeconds",
      "settlementBasis",
      "usageKind",
    ],
    "a new log field was added; every one of these must be a code this file chose or a number measured from the container"
  );
});

test("the port surface is exactly one method", () => {
  assert.deepEqual([...VOICE_TRANSCRIPTION_PORT_SURFACE], ["transcribe"]);

  const implemented = Object.getOwnPropertyNames(
    OpenAiVoiceTranscriptionProvider.prototype
  ).filter((name) => name !== "constructor");
  assert.deepEqual(
    implemented.sort(),
    [...VOICE_TRANSCRIPTION_PORT_SURFACE].sort(),
    "the provider grew a method the port does not describe (docs/policy/voice-input.md §10)"
  );
});

test("a provider failure is reported as a code, never as its body", async () => {
  // The failure this prevents: a provider error body reaching an error tracker.
  // Some providers echo the request in it, and the request is the audio.
  const result = await transcribeWithOpenAi(
    {
      audio: new Uint8Array([1, 2, 3]),
      mediaType: "audio/webm",
      extension: "webm",
      languageHint: null,
    },
    {
      apiKey: "test-key",
      model: "test-model",
      fetchImpl: async () =>
        new Response(JSON.stringify({ error: { message: "a secret" } }), {
          status: 400,
        }),
    }
  );

  assert.equal(result.ok, false);
  assert.equal(result.code, "provider_rejected_audio");
  assert.equal(result.status, 400);
  assert.ok(!JSON.stringify(result).includes("a secret"));
});

test("the log names the usage *shape* but never the token counts", () => {
  // `output_tokens` is a proxy for how long the transcript is, and §11.2
  // forbids the transcript's length as firmly as the transcript itself.
  const source = read("app/api/chat/voice-transcription/route.ts");
  assert.ok(!/inputTokens/.test(source));
  assert.ok(!/outputTokens/.test(source));
  assert.ok(/usageKind/.test(source), "the billing unit is still reported");
});

test("a network failure is reported without the thrown error", async () => {
  const result = await transcribeWithOpenAi(
    {
      audio: new Uint8Array([1, 2, 3]),
      mediaType: "audio/webm",
      extension: "webm",
      languageHint: null,
    },
    {
      apiKey: "test-key",
      model: "test-model",
      fetchImpl: async () => {
        throw new Error("POST https://api.openai.com/v1/audio/transcriptions failed");
      },
    }
  );

  assert.deepEqual(result, {
    ok: false,
    code: "provider_unreachable",
    status: null,
    disposition: "indeterminate",
  });
});

test("the request carries the audio, the model and nothing that identifies a user", async () => {
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
        return new Response(JSON.stringify({ text: "hello", duration: 1.5 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    }
  );

  assert.equal(captured.url, "https://api.openai.com/v1/audio/transcriptions");
  const form = captured.init.body;
  assert.deepEqual(
    [...form.keys()].sort(),
    ["file", "model", "response_format"],
    "an extra part would be data leaving this system that nothing decided to send"
  );
  // The filename is generated. There is no filename in this flow, and deriving
  // one from an account or a transcript would put content in a MIME header.
  assert.equal(form.get("file").name, "voice.webm");
  // `json`, not `verbose_json`: the latter returns a second, segmented copy of
  // the transcript for a number we can do without.
  assert.equal(form.get("response_format"), "json");
});

test("a successful response yields the text and the reported usage", async () => {
  const result = await transcribeWithOpenAi(
    {
      audio: new Uint8Array([1]),
      mediaType: "audio/mp4",
      extension: "mp4",
      languageHint: "ko",
    },
    {
      apiKey: "k",
      model: "m",
      fetchImpl: async () =>
        new Response(JSON.stringify({ text: "안녕하세요", duration: 2.25 }), {
          status: 200,
        }),
    }
  );

  assert.deepEqual(result, {
    ok: true,
    text: "안녕하세요",
    usage: { kind: "duration", seconds: 2.25 },
  });
});

test("a 2xx that is not the expected shape is a failure, not an empty transcript", async () => {
  for (const body of ["{}", '{"text":42}', "not json"]) {
    const result = await transcribeWithOpenAi(
      {
        audio: new Uint8Array([1]),
        mediaType: "audio/webm",
        extension: "webm",
        languageHint: null,
      },
      {
        apiKey: "k",
        model: "m",
        fetchImpl: async () => new Response(body, { status: 200 }),
      }
    );
    assert.equal(result.ok, false);
    assert.equal(result.code, "provider_response_unreadable");
  }
});

test("credentials, rate limits and refusals are classified apart", async () => {
  const classify = async (status) => {
    const result = await transcribeWithOpenAi(
      {
        audio: new Uint8Array([1]),
        mediaType: "audio/webm",
        extension: "webm",
        languageHint: null,
      },
      {
        apiKey: "k",
        model: "m",
        fetchImpl: async () => new Response("{}", { status }),
      }
    );
    return result.code;
  };

  assert.equal(await classify(401), "provider_rejected_credentials");
  assert.equal(await classify(403), "provider_rejected_credentials");
  assert.equal(await classify(429), "provider_rate_limited");
  assert.equal(await classify(503), "provider_unavailable");
  assert.equal(await classify(400), "provider_rejected_audio");
  assert.equal(await classify(415), "provider_rejected_audio");
});

test("a missing key is reported rather than thrown", async () => {
  // Every name the shared resolver accepts for OpenAI, not just the canonical
  // one: clearing only `OPENAI_API_KEY` would leave an alias standing and this
  // test would pass for the wrong reason on a machine that has one set.
  const cleared = new Map(
    ["VOICE_TRANSCRIPTION_API_KEY", ...PROVIDER_API_KEY_ENV_NAMES.openai].map(
      (name) => [name, process.env[name]]
    )
  );
  for (const name of cleared.keys()) delete process.env[name];
  try {
    const result = await new OpenAiVoiceTranscriptionProvider().transcribe({
      audio: new Uint8Array([1]),
      mediaType: "audio/webm",
      extension: "webm",
      languageHint: null,
    });
    assert.deepEqual(result, {
      ok: false,
      code: "provider_not_configured",
      status: null,
      disposition: "not_sent",
      notConfigured: true,
    });
  } finally {
    for (const [name, value] of cleared) {
      if (value !== undefined) process.env[name] = value;
    }
  }
});
