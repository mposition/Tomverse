import assert from "node:assert/strict";
import test from "node:test";

import {
  QA_RELEASE_TRAIN_RESOLVE_ENDPOINT,
  QA_RELEASE_TRAIN_RESOLVE_MAX_INPUT_CHARS,
  QA_RELEASE_TRAIN_RESOLVE_MODEL,
  createQaReleaseTrainResolver,
  qaReleaseTrainApplyHunks,
  qaReleaseTrainDiff3Hunks,
  qaReleaseTrainResolutionFrom,
} from "../lib/qaReleaseTrainResolve.ts";

const marked = ["a", "<<<<<<< HEAD", "main", "||||||| base", "base", "=======", "pick", ">>>>>>> 1234 (Merge pull request #1)", "b", "c"];
const conflict = {
  number: 2726,
  title: "marketing settings",
  diff: "-x\n+y",
  files: [{ path: "x.ts", hunks: qaReleaseTrainDiff3Hunks(marked, 1) }],
};

test("diff3 hunks are read with the lines around them, and replaced in order", () => {
  assert.deepEqual(conflict.files[0].hunks, [{ before: ["a"], main: ["main"], base: ["base"], pick: ["pick"], after: ["b"] }]);
  assert.deepEqual(qaReleaseTrainApplyHunks(marked, [["main", "pick"]]), ["a", "main", "pick", "b", "c"]);
  // An unclosed hunk, or one without a base side, is not read.
  assert.equal(qaReleaseTrainDiff3Hunks(["<<<<<<< HEAD", "main", "=======", "pick"]), null);
  assert.equal(qaReleaseTrainDiff3Hunks(["<<<<<<< HEAD", "main", "=======", "pick", ">>>>>>> x"]), null);
  assert.deepEqual(qaReleaseTrainDiff3Hunks(["plain"]), []);
});

test("an answer is used only when it covers every hunk in order and holds no marker", () => {
  const files = (hunks, path = "x.ts") => [{ path, hunks }];
  assert.deepEqual(qaReleaseTrainResolutionFrom(conflict, { resolved: true, why: " kept  main's\nline ", files: files([{ lines: ["main", "pick"] }]) }), {
    resolved: true,
    why: "kept main's line",
    files: [{ path: "x.ts", hunks: [["main", "pick"]] }],
  });
  assert.equal(qaReleaseTrainResolutionFrom(conflict, { resolved: true, why: "w", files: files([]) }).resolved, false);
  assert.equal(qaReleaseTrainResolutionFrom(conflict, { resolved: true, why: "w", files: files([{ lines: ["m"] }], "y.ts") }).resolved, false);
  assert.equal(qaReleaseTrainResolutionFrom(conflict, { resolved: true, why: "w", files: files([{ lines: ["<<<<<<< HEAD"] }]) }).resolved, false);
  assert.equal(qaReleaseTrainResolutionFrom(conflict, { resolved: true, why: "w", files: files([{ lines: [1] }]) }).resolved, false);
  assert.equal(qaReleaseTrainResolutionFrom(conflict, null).resolved, false);
  // A decline keeps what the model said, cut to fit Admin and the pull request.
  const declined = qaReleaseTrainResolutionFrom(conflict, { resolved: false, why: "x".repeat(500), files: [] });
  assert.equal(declined.resolved, false);
  assert.equal(declined.why.length, 300);
});

test("the resolver asks the model once with structured output and reads its answer; any failure is not resolved", async () => {
  const sent = [];
  const answer = (status, message) => async (request) => {
    sent.push(request);
    return { status, text: JSON.stringify(message) };
  };
  const ok = {
    stop_reason: "end_turn",
    content: [
      { type: "thinking", thinking: "" },
      { type: "text", text: JSON.stringify({ resolved: true, why: "Applied the pick to main's line.", files: [{ path: "x.ts", hunks: [{ lines: ["main", "pick"] }] }] }) },
    ],
  };
  const resolved = await createQaReleaseTrainResolver({ http: answer(200, ok), apiKey: "train-key" })(conflict);
  assert.deepEqual(resolved, { resolved: true, why: "Applied the pick to main's line.", files: [{ path: "x.ts", hunks: [["main", "pick"]] }] });
  const [request] = sent;
  assert.equal(request.url, QA_RELEASE_TRAIN_RESOLVE_ENDPOINT);
  assert.equal(request.headers["x-api-key"], "train-key");
  const body = JSON.parse(request.body);
  assert.equal(body.model, QA_RELEASE_TRAIN_RESOLVE_MODEL);
  assert.equal(body.output_config.format.type, "json_schema");
  assert.equal("temperature" in body, false);
  assert.match(body.messages[0].content, /^Pull request #2726: marketing settings$/m);
  assert.match(body.messages[0].content, /<<<<<<< main\nmain\n\|\|\|\|\|\|\| base\nbase\n=======\npick\n>>>>>>> pick/);

  assert.equal((await createQaReleaseTrainResolver({ http: answer(529, {}), apiKey: "k" })(conflict)).why, "The model call failed (HTTP 529).");
  assert.equal((await createQaReleaseTrainResolver({ http: answer(200, { ...ok, stop_reason: "max_tokens" }), apiKey: "k" })(conflict)).resolved, false);
  const thrown = createQaReleaseTrainResolver({ http: async () => { throw new Error("timeout"); }, apiKey: "k" });
  assert.equal((await thrown(conflict)).why, "The model could not be reached.");

  // Too large to send: never asked.
  sent.length = 0;
  const huge = { ...conflict, diff: "x".repeat(QA_RELEASE_TRAIN_RESOLVE_MAX_INPUT_CHARS) };
  assert.equal((await createQaReleaseTrainResolver({ http: answer(200, ok), apiKey: "k" })(huge)).resolved, false);
  assert.equal(sent.length, 0);
});
