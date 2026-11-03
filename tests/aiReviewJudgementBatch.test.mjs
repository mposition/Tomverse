import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { buildCase, layOutRun } from "./fixtures/aiReviewJudgedRun.mjs";
const invoke = (script, args) =>
  spawnSync(
    process.execPath,
    [
      "--conditions=react-server",
      "--import",
      "tsx",
      `scripts/${script}.mjs`,
      ...args,
    ],
    { encoding: "utf8" },
  );

test("batch preparation preserves signed records and checks every case without auto-confirmation", (t) => {
  const root = mkdtempSync(join(tmpdir(), "judgement-batch-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cases = [
    buildCase({ id: "finished" }),
    buildCase({ id: "pending", reports: false }),
  ];
  for (const item of cases) {
    mkdirSync(join(root, item.id));
    for (const file of [
      "case.json",
      "observation.json",
      ...(item.id === "finished" ? ["record.json"] : []),
    ])
      writeFileSync(
        join(root, item.id, file),
        JSON.stringify(item.bundle[file]),
      );
  }
  const original = readFileSync(join(root, "finished/record.json"));
  let result = invoke("draft-ai-review-judgement-batch", [
    "--dir",
    root,
    "--check",
  ]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(existsSync(join(root, "pending/record.json")), false);
  result = invoke("draft-ai-review-judgement-batch", [`--dir=${root}`]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const pending = JSON.parse(readFileSync(join(root, "pending/record.json")));
  assert.equal(pending.reviewedBy, "");
  assert.deepEqual(pending.claims, []);
  assert.deepEqual(readFileSync(join(root, "finished/record.json")), original);
  delete pending._rules;
  writeFileSync(join(root, "pending/record.json"), JSON.stringify(pending));
  result = invoke("draft-ai-review-judgement-batch", [
    `--dir=${root}`,
    "--check",
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /nobody has signed the record/);
  assert.equal(existsSync(join(root, "pending/artifact.json")), false);
});

test("catalog CLI uses the Admin reader and reports actual evidence, never an approval", (t) => {
  const root = mkdtempSync(join(tmpdir(), "judged-catalog-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "run"));
  layOutRun(join(root, "run"), [buildCase({ id: "one" })]);
  const before = readFileSync(join(root, "run/run.json"));
  let result = invoke("report-ai-review-judged-catalog", [`--dir=${root}`]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /run: verified, aggregable/);
  assert.match(result.stdout, /not promotion approval/);
  assert.deepEqual(readFileSync(join(root, "run/run.json")), before);
  writeFileSync(join(root, "run/judgements/one/record.json"), "{}");
  result = invoke("report-ai-review-judged-catalog", [`--dir=${root}`]);
  assert.match(result.stdout, /not aggregable/);
  assert.doesNotMatch(result.stdout, /run: verified/);
});
