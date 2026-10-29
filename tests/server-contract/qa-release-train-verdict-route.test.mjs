import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mock, test } from "node:test";

// The train route's verdict phases (lib/qaReleaseTrainRoutes.ts): the queue
// lists what Admin offers before any verdict, and the verdicts phase stores
// only a body the schema accepts. Display only, so the store is mocked.
const root = resolve(import.meta.dirname, "..", "..");
const mod = (path) => pathToFileURL(resolve(root, path)).href;
const SECRET = "s".repeat(40);
const SHA = "a".repeat(40);
const recorded = [];
let stored = null;

const candidate = (number, status, extra = {}) => ({
  number,
  title: `#${number}`,
  author: "a",
  mergedAt: "2026-10-20T00:00:00Z",
  status,
  mainPullRequest: status === "mentioned" ? 900 : null,
  mergeCommitSha: String(number % 10).repeat(40),
  ...extra,
});

mock.module(mod("lib/qaReleaseTrainCargoRead.ts"), {
  namedExports: {
    readQaReleaseTrainCargoCandidates: async () => ({
      status: "ok",
      readAt: "2026-10-29T00:00:00Z",
      candidates: [
        candidate(1, "available"),
        candidate(2, "mentioned"),
        candidate(3, "changes_workflows"),
        candidate(4, "on_main"),
        candidate(5, "back_merge"),
        // Read before merge commits were kept: left for the next read.
        candidate(6, "available", { mergeCommitSha: undefined }),
      ],
    }),
  },
});
mock.module(mod("lib/qaReleaseTrainStore.ts"), {
  namedExports: {
    admitQaReleaseTrain: async () => ({ admitted: true }),
    readQaReleaseTrainSelection: async () => ({ numbers: [], emergency: { pending: null } }),
    recordQaReleaseTrainSchedule: async () => {},
    reportQaReleaseTrain: async () => ({ recorded: true }),
    readQaReleaseTrainVerdicts: async () => stored,
    recordQaReleaseTrainVerdicts: async (verdicts) => {
      recorded.push(verdicts);
    },
  },
});

const { handleQaReleaseTrain } = await import(mod("lib/qaReleaseTrainRoutes.ts"));
const env = { QA_RELEASE_MERGE_LANE_SECRET: SECRET };
const call = (body, secret = SECRET) =>
  handleQaReleaseTrain(
    new Request("https://example.test/api/internal/qa-release/train", {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    env,
  );

const verdict = (number) => ({
  number,
  content: { state: "differs", lines: 3, missing: 2, leftOnMain: 1, files: [{ path: "lib/a.ts", lines: 3 }], fileCount: 1 },
  mainSha: SHA,
  checkedAt: "2026-10-29T00:00:00Z",
  gapDigest: "b".repeat(32),
  model: { decision: "not_needed", why: { ko: "주석만 다릅니다.", en: "Only comments differ." }, evidence: [900] },
});

test("the queue lists what Admin offers or leaves to a hand release, with merge commits, and the verdicts held", async () => {
  stored = { mainSha: SHA, at: "2026-10-29T00:00:00Z", verdicts: [] };
  const answer = await call({ phase: "verdict_queue" });
  assert.equal(answer.status, 200);
  assert.deepEqual(
    answer.body.candidates.map((c) => [c.number, c.mainPullRequest]),
    [
      [1, null],
      [2, 900],
      [3, null],
    ],
  );
  assert.equal(answer.body.candidates[0].mergeCommitSha, "1".repeat(40));
  assert.deepEqual(answer.body.stored, stored);
  assert.equal((await call({ phase: "verdict_queue" }, "x".repeat(40))).status, 401);
});

test("verdicts are stored only as the schema allows; only they may be a large body", async () => {
  const ok = await call({ phase: "verdicts", mainSha: SHA, at: "2026-10-29T00:00:00Z", verdicts: [verdict(1)] });
  assert.equal(ok.status, 200);
  assert.deepEqual(recorded.at(-1).verdicts, [verdict(1)]);

  const before = recorded.length;
  const bad = (change) => call({ phase: "verdicts", mainSha: SHA, at: "2026-10-29T00:00:00Z", verdicts: [change(verdict(1))] });
  assert.equal((await bad((v) => ({ ...v, model: { ...v.model, decision: "ship" } }))).status, 400);
  assert.equal((await bad((v) => ({ ...v, model: { ...v.model, why: { ko: "x".repeat(301), en: "x" } } }))).status, 400);
  assert.equal((await bad((v) => ({ ...v, content: { state: "maybe" } }))).status, 400);
  assert.equal((await bad((v) => ({ ...v, extra: true }))).status, 400);
  assert.equal(recorded.length, before);

  // Five hundred verdicts are far above 16 KiB and still accepted.
  const many = await call({ phase: "verdicts", mainSha: SHA, at: "2026-10-29T00:00:00Z", verdicts: Array.from({ length: 500 }, (_, i) => verdict(i + 1)) });
  assert.equal(many.status, 200);
  // Any other phase over 16 KiB is refused.
  const padded = `{${" ".repeat(17 * 1024)}${JSON.stringify({ phase: "selection" }).slice(1)}`;
  assert.equal((await call(padded)).status, 400);
});
