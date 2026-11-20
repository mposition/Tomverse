import assert from "node:assert/strict";
import test from "node:test";

import { IMAGE_GENERATION_SIGNAL_KINDS } from "@/lib/imageRoutingCore";
import {
  IMAGE_GENERATION_CANCELLABLE_SIGNAL_KINDS,
  IMAGE_GENERATION_USER_SIGNAL_KINDS,
  applyImageSignalToState,
  isImageGenerationUserSignalKind,
  sendImageGenerationSignal,
} from "@/lib/imageGenerationSignalsCore";

test("a browser may send every stored kind except download", () => {
  assert.deepEqual(
    [...IMAGE_GENERATION_SIGNAL_KINDS].filter(
      (kind) => !(IMAGE_GENERATION_USER_SIGNAL_KINDS as readonly string[]).includes(kind)
    ),
    ["download"]
  );
  assert.equal(isImageGenerationUserSignalKind("download"), false);
  assert.equal(isImageGenerationUserSignalKind("helpful"), true);
  // What can be taken back is a subset of what can be sent.
  for (const kind of IMAGE_GENERATION_CANCELLABLE_SIGNAL_KINDS) assert.ok(isImageGenerationUserSignalKind(kind));
});

test("the on-screen state keeps helpful and not_helpful exclusive", () => {
  assert.deepEqual(applyImageSignalToState([], "helpful", true), ["helpful"]);
  assert.deepEqual(applyImageSignalToState(["helpful", "wanted_text"], "not_helpful", true), [
    "wanted_text",
    "not_helpful",
  ]);
  assert.deepEqual(applyImageSignalToState(["helpful"], "helpful", false), []);
  assert.deepEqual(applyImageSignalToState(["helpful"], "helpful", true), ["helpful"]);
});

test("sending a signal is a POST, taking it back a DELETE, and any failure is false", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const respond = (ok: boolean) =>
    (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return { ok } as Response;
    }) as unknown as typeof fetch;

  assert.equal(await sendImageGenerationSignal("gen 1", "helpful", true, respond(true)), true);
  assert.equal(calls[0].url, "/api/images/generations/gen%201/signal");
  assert.equal(calls[0].init?.method, "POST");
  assert.equal(calls[0].init?.body, JSON.stringify({ kind: "helpful" }));

  assert.equal(await sendImageGenerationSignal("gen1", "helpful", false, respond(true)), true);
  assert.equal(calls[1].url, "/api/images/generations/gen1/signal?kind=helpful");
  assert.equal(calls[1].init?.method, "DELETE");

  assert.equal(await sendImageGenerationSignal("gen1", "selected", true, respond(false)), false);
  const throwing = (async () => {
    throw new Error("offline");
  }) as unknown as typeof fetch;
  assert.equal(await sendImageGenerationSignal("gen1", "selected", true, throwing), false);
});

test("the download route records a download signal that can never fail the download", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync("app/api/images/generations/[generationId]/download/route.ts", "utf8");
  const call = source.indexOf("recordImageGenerationSignal(");
  assert.ok(call > 0, "The download route must record a download signal.");
  // Awaited, caught and logged, and placed before the response is built.
  assert.match(source.slice(call, call + 200), /kind: "download"/);
  assert.match(source.slice(call, call + 300), /\.catch\(/);
  assert.match(source.slice(call - 20, call), /await\s*$/);
  assert.ok(call < source.indexOf("return new Response(new Uint8Array(bytes)"));
});
