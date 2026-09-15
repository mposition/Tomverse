// CONT-SEARCH-01: how long message search takes on an account at the import
// ceiling, so the provisional 3-second budget for the imported read can be
// confirmed or replaced (docs/policy/external-conversation-continuation.md §8.2.1).
//
//   TEST_DATABASE_URL=postgresql://.../tomverse_test npm run measure:continuation-source-search
//   ... -- --repeats 20 --json
//
// WRITES to the database it is pointed at: it creates one synthetic account
// with 2,000 finalized snapshots, 100,000 imported messages (about 50 MiB of
// mixed Korean and English text) and a continuation for every snapshot, and
// deletes that account (cascade) when it finishes or fails. So it refuses any
// URL that is not a dedicated test database -- the same marker rule as
// scripts/run-db-integration-tests.mjs -- and it never reads DATABASE_URL.
//
// Three scenarios, each repeated: a query that matches nothing (the full scan
// with nothing to return), a query that matches almost every message (the
// window and ranking at their busiest), and 5 and 10 concurrent frequent-match
// searches (pool contention). For each it prints p50, p95, max and how many
// runs reported `sourceSearch: "timed_out"`, plus EXPLAIN (ANALYZE, BUFFERS)
// for the imported candidate statement. Output carries no message text, id or
// URL. It is evidence for a decision, not a gate: it exits 0 whatever the
// numbers are, and 2 only when it refuses to run.

import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

const argv = process.argv.slice(2);
const json = argv.includes("--json");
const repeatsIndex = argv.indexOf("--repeats");
const repeats = repeatsIndex >= 0 ? Number(argv[repeatsIndex + 1]) : 20;
if (!Number.isSafeInteger(repeats) || repeats < 1) {
  console.error("--repeats must be a positive whole number.");
  process.exit(2);
}

const rawUrl = process.env.TEST_DATABASE_URL?.trim();
if (!rawUrl) {
  console.error("TEST_DATABASE_URL is required and must be a dedicated test database.");
  process.exit(2);
}
let url;
try {
  url = new URL(rawUrl);
} catch {
  console.error("TEST_DATABASE_URL is not a valid URL.");
  process.exit(2);
}
const marker = `${decodeURIComponent(url.pathname.replace(/^\//, ""))}_${url.searchParams.get("schema") || ""}`;
if (!/(?:^|[_-])(?:test|testing|ci|e2e)(?:[_-]|$)/i.test(marker)) {
  console.error("The database name or schema must carry a test marker such as tomverse_test.");
  process.exit(2);
}
process.env.DATABASE_URL = rawUrl;
process.env.PRISMA_CLIENT_LOG = "";

const { prisma } = await import("../lib/prisma.ts");
const { searchConversationMessages, SOURCE_SEARCH_TIMEOUT_MS } = await import(
  "../lib/conversationSearch.ts"
);
const { CONTINUATION_SEED_VERSION } = await import("../lib/externalContinuationSeedCore.ts");

const SNAPSHOTS = 2_000;
const MESSAGES_PER_SNAPSHOT = 50;
const WORDS = [
  "배포", "일정", "금요일", "검토", "회의", "데이터베이스", "성능", "결과",
  "the", "release", "schedule", "review", "database", "latency", "result", "plan",
];
const bodyFor = (seed) => {
  // About 500 UTF-8 bytes, deterministic, and always containing "the".
  const parts = [];
  let i = seed;
  while (Buffer.byteLength(parts.join(" ")) < 480) {
    parts.push(WORDS[i % WORDS.length]);
    i = (i * 1103515245 + 12345) % 2147483648;
  }
  parts.push("the");
  return parts.join(" ");
};

const quantile = (values, q) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
};

const request = new Request("https://tomverse.test/api/conversations/search");

let userId;
const report = { repeats, sourceTimeoutMs: SOURCE_SEARCH_TIMEOUT_MS, scenarios: [], explain: null };
try {
  const user = await prisma.user.create({ data: { email: `measure-${randomUUID()}@example.test` } });
  userId = user.id;
  const seedStarted = performance.now();
  for (let s = 0; s < SNAPSHOTS; s += 1) {
    const importRow = await prisma.externalImport.create({
      data: { userId, provider: "chatgpt", status: "completed", digestVersion: 1, parserVersion: "measure" },
    });
    const snapshot = await prisma.externalConversation.create({
      data: {
        userId,
        importId: importRow.id,
        provider: "chatgpt",
        externalStableId: `m-${s}`,
        title: `synthetic ${s}`,
        conversationDigest: `measure-${randomUUID()}`,
        digestVersion: 1,
        messageCount: MESSAGES_PER_SNAPSHOT,
        contentBytes: BigInt(500 * MESSAGES_PER_SNAPSHOT),
        finalized: true,
      },
    });
    await prisma.externalMessage.createMany({
      data: Array.from({ length: MESSAGES_PER_SNAPSHOT }, (_, m) => ({
        userId,
        externalConversationId: snapshot.id,
        externalStableId: `m-${s}`,
        role: m % 2 === 0 ? "user" : "assistant",
        content: bodyFor(s * MESSAGES_PER_SNAPSHOT + m),
        contentDigest: `c-${s}-${m}`,
        digestVersion: 1,
        ordinal: m,
      })),
    });
    const conversation = await prisma.conversation.create({
      data: { userId, title: `continuation ${s}`, productKey: "review" },
    });
    await prisma.conversationContinuationBridge.create({
      data: {
        userId,
        conversationId: conversation.id,
        externalConversationId: snapshot.id,
        provider: "chatgpt",
        sourceImportedAt: new Date(),
        sourceConversationDigest: `d-${randomUUID()}`,
        sourceDigestVersion: 1,
        sourceMessageCount: MESSAGES_PER_SNAPSHOT,
        seedFromOrdinal: 0,
        seedToOrdinal: MESSAGES_PER_SNAPSHOT - 1,
        seedMessageCount: MESSAGES_PER_SNAPSHOT,
        seedTruncatedMessageCount: 0,
        seedOmittedMessageCount: 0,
        contextSeedVersion: CONTINUATION_SEED_VERSION,
        idempotencyKey: randomUUID(),
      },
    });
  }
  await prisma.$executeRawUnsafe(`ANALYZE "ExternalMessage"`);
  report.seedSeconds = Math.round((performance.now() - seedStarted) / 1000);

  const once = async (query) => {
    const started = performance.now();
    const answer = await searchConversationMessages({ request, userId, query, displayTimeZone: "UTC" });
    return { ms: performance.now() - started, timedOut: answer.sourceSearch === "timed_out" };
  };
  const scenario = async (name, query, concurrency) => {
    const runs = [];
    for (let r = 0; r < repeats; r += 1) {
      runs.push(...(await Promise.all(Array.from({ length: concurrency }, () => once(query)))));
    }
    const ms = runs.map((run) => run.ms);
    report.scenarios.push({
      name,
      concurrency,
      runs: runs.length,
      p50Ms: Math.round(quantile(ms, 0.5)),
      p95Ms: Math.round(quantile(ms, 0.95)),
      maxMs: Math.round(Math.max(...ms)),
      timedOut: runs.filter((run) => run.timedOut).length,
    });
  };
  await scenario("no match", "zzqx-nomatch", 1);
  await scenario("frequent match", "the", 1);
  await scenario("frequent match (korean)", "배포", 1);
  await scenario("frequent match, concurrent", "the", 5);
  await scenario("frequent match, concurrent", "the", 10);

  // The imported candidate statement, as lib/conversationSearch.ts issues it.
  const snapshotIds = (
    await prisma.externalConversation.findMany({ where: { userId }, select: { id: true } })
  ).map((row) => row.id);
  const plan = await prisma.$queryRawUnsafe(
    `EXPLAIN (ANALYZE, BUFFERS)
     SELECT ranked.id FROM (
       SELECT m.id, m."externalConversationId", m.ordinal,
              row_number() OVER (PARTITION BY m."externalConversationId" ORDER BY m.ordinal DESC) AS rn
       FROM "ExternalMessage" m
       WHERE m."userId" = $1 AND m."externalConversationId" = ANY($2::text[]) AND m.content ILIKE $3
     ) ranked
     WHERE ranked.rn <= 6
     ORDER BY array_position($2::text[], ranked."externalConversationId"), ranked.rn
     LIMIT 186`,
    userId,
    snapshotIds,
    "%zzqx-nomatch%"
  );
  // Plan lines name tables and operators only; the user id is a bind value.
  report.explain = plan.map((row) => row["QUERY PLAN"]);
} finally {
  if (userId) await prisma.user.delete({ where: { id: userId } }).catch(() => {});
  await prisma.$disconnect();
}

if (json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`Seeded in ${report.seedSeconds}s. Source budget ${report.sourceTimeoutMs} ms, ${repeats} repeats.`);
  for (const s of report.scenarios) {
    console.log(
      `${s.name.padEnd(28)} x${String(s.concurrency).padStart(2)}  p50 ${s.p50Ms} ms  p95 ${s.p95Ms} ms  max ${s.maxMs} ms  timed out ${s.timedOut}/${s.runs}`
    );
  }
  console.log("\nEXPLAIN (ANALYZE, BUFFERS), imported candidates, no-match query:");
  for (const line of report.explain ?? []) console.log(`  ${line}`);
}
