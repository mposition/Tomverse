import assert from "node:assert/strict";
import test from "node:test";
import { readReviewProgress, REVIEW_STREAM_TYPE, withReviewProgress } from "../lib/comparisonReviewProgress";

const request = () => new Request("https://example.test/review", { headers: { accept: REVIEW_STREAM_TYPE } });
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};

test("a settled primary is visible before secondary completion; final save replaces it", async () => {
  const finish = deferred<void>();
  const primarySeen = deferred<unknown>();
  let finalized = false;
  const response = await withReviewProgress(request(), async publish => {
    publish({ result: { primary: "grounded", secondary: null }, persisted: false }, { "Set-Cookie": "guest=proof; HttpOnly" });
    await finish.promise;
    finalized = true;
    return Response.json({ result: { primary: "grounded", secondary: "independent" }, persisted: true });
  });
  assert.match(response.headers.get("set-cookie")!, /HttpOnly/);
  const final = readReviewProgress(response, primarySeen.resolve);
  assert.deepEqual(await primarySeen.promise, { result: { primary: "grounded", secondary: null }, persisted: false });
  assert.equal(finalized, false);
  finish.resolve();
  assert.deepEqual(await final, { result: { primary: "grounded", secondary: "independent" }, persisted: true });
});

test("disconnect does not abandon paid finalization", async () => {
  const finish = deferred<void>();
  const finalized = deferred<void>();
  const response = await withReviewProgress(request(), async publish => {
    publish({ primary: true });
    await finish.promise;
    finalized.resolve();
    return Response.json({ saved: true });
  });
  await response.body!.cancel();
  finish.resolve();
  await finalized.promise;
});

test("validation, cache hits and old clients keep JSON and HTTP status", async () => {
  const denied = await withReviewProgress(request(), async () => Response.json({ error: "denied" }, { status: 403 }));
  assert.equal(denied.status, 403);
  const cached = await withReviewProgress(request(), async () => Response.json({ cached: true }));
  assert.deepEqual(await readReviewProgress(cached, () => assert.fail()), { cached: true });
  const legacy = await withReviewProgress(new Request("https://example.test"), async publish => {
    publish({ incomplete: true });
    return Response.json({ complete: true });
  });
  assert.deepEqual(await legacy.json(), { complete: true });
});

test("a save failure remains an error after the first result; thrown errors are sanitized", async () => {
  for (const thrown of [false, true]) {
    const gate = deferred<void>();
    const response = await withReviewProgress(request(), async publish => {
      publish({ primary: true });
      await gate.promise;
      if (thrown) throw new Error("private database detail");
      return Response.json({ error: "save failed" }, { status: 500 });
    });
    gate.resolve();
    const final = await readReviewProgress(response, () => {}) as { error: string };
    assert.match(final.error, thrown ? /could not be finalized/ : /save failed/);
    assert.doesNotMatch(final.error, /private/);
  }
});

test("chunk boundaries and heartbeats preserve UTF-8; incomplete streams never succeed", async () => {
  const text = '\n{"type":"primary","data":"검토"}\n\n{"type":"complete","data":"완료"}\n';
  const bytes = new TextEncoder().encode(text);
  const stream = new ReadableStream({ start(controller) {
    for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
    controller.close();
  } });
  const seen: unknown[] = [];
  assert.equal(await readReviewProgress(new Response(stream, { headers: { "Content-Type": REVIEW_STREAM_TYPE } }), data => seen.push(data)), "완료");
  assert.deepEqual(seen, ["검토"]);
  for (const body of ['{"type":"primary","data":{}}\n', '{"type":"complete","data":{}}', '{"type":"unknown"}\n']) {
    await assert.rejects(readReviewProgress(new Response(body, { headers: { "Content-Type": REVIEW_STREAM_TYPE } }), () => {}));
  }
});
