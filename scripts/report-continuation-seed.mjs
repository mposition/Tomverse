// CONT-01: how much of an imported conversation would reach the model under
// the shipped seed rule and under each candidate a policy decision is weighing.
//
//   npm run report:continuation-seed                          # fixtures only, no credentials
//   npm run report:continuation-seed -- --json
//   npm run report:continuation-seed -- --database            # also stored conversations, read-only
//   npm run report:continuation-seed -- --database --max-snapshots 2000
//   npm run report:continuation-seed -- --database --include-locked
//
// Writes nothing, anywhere. Exits 0 whatever it finds -- this is evidence for a
// decision (docs/policy/external-conversation-continuation.md §4.1), not a gate.
//
// Fixture mode runs the candidates over the representative conversations in
// report-continuation-seed-core.mjs, each with planted facts, and says which
// facts each candidate carries.
//
// Database mode reads finalized imported conversations that have been continued
// at least once -- their newest 200 messages, the scan the loader uses, one
// query per page of 50 -- and evaluates every candidate in memory. It prints
// shares and quantiles per script class, weighted both per snapshot and per
// assistant turn of the continued conversations (a proxy for seeded requests
// whose biases the output states). Nothing is exact enough to solve back to a
// group's size: counts and shares are bands, token figures are rounded to 100,
// groups under 20 snapshots are suppressed, and a share resting on fewer than
// five snapshots on either side says only that (aggregateSeedSamples in the
// core module explains why each of those is needed).
// A --max-snapshots value that is not a positive whole number exits 2.
// No message text, title, ordinal, snapshot id or user id is printed, logged or
// written; identifiers exist only to join the reads.
//
// --include-locked. A password-locked snapshot's seed reaches the model only
// after its owner unlocks it, and whether they did cannot be read from the
// database. Excluding them biases the sample; including them reads, in memory,
// text the owner locked. The default excludes them and counts how many were
// skipped; including them is a choice the operator types.
//
// The --database flag is required even when DATABASE_URL is set, so a run
// against a production URL is a decision rather than a side effect. Prisma's
// own logging is switched off for the run: it would print a connection error,
// host and all, before this script could redact it.

import {
  SEED_CANDIDATES,
  SEED_SOURCE_MESSAGE_SCAN_LIMIT,
  databaseErrorNote,
  evaluatePlan,
  factsRetained,
  measureStoredConversations,
  representativeSeedFixtures,
  scriptClass,
} from "./report-continuation-seed-core.mjs";

const argv = process.argv.slice(2);
const json = argv.includes("--json");
const useDatabase = argv.includes("--database");
const includeLocked = argv.includes("--include-locked");
// A mistyped limit must not quietly become "no limit" and read every snapshot.
let maxSnapshots = Number.POSITIVE_INFINITY;
if (argv.includes("--max-snapshots")) {
  const value = argv[argv.indexOf("--max-snapshots") + 1] ?? "";
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    process.stderr.write("--max-snapshots needs a positive whole number, for example --max-snapshots 2000\n");
    process.exit(2);
  }
  maxSnapshots = Number(value);
}

// ------------------------------------------------------------------ fixtures

const FIXTURE_CONTEXT = { provider: "chatgpt", importedAt: "2026-09-01T00:00:00.000Z" };

const fixtureRows = representativeSeedFixtures().map((fixture) => ({
  id: fixture.id,
  description: fixture.description,
  script: scriptClass(fixture.messages.map((message) => message.content).join("\n")),
  candidates: Object.fromEntries(
    SEED_CANDIDATES.map((candidate) => {
      const plan = candidate.plan(fixture.messages, fixture.messages.length);
      return [
        candidate.id,
        {
          ...evaluatePlan(plan, fixture.messages, FIXTURE_CONTEXT),
          facts: factsRetained(plan, fixture.facts),
        },
      ];
    })
  ),
}));

// ------------------------------------------------------------------ database

let database = {
  source: "not_read",
  note: useDatabase
    ? "DATABASE_URL is not set, so no stored conversation was read."
    : "Pass --database to also measure stored conversations (read-only).",
};

if (useDatabase && process.env.DATABASE_URL?.trim()) {
  process.env.PRISMA_CLIENT_LOG = "";
  let prisma;
  try {
    ({ prisma } = await import("../lib/prisma.ts"));
    const { Prisma } = await import("@prisma/client");
    const measured = await measureStoredConversations(
      {
        fetchSnapshotPage: async (cursor, take) =>
          (
            await prisma.externalConversation.findMany({
              where: { finalized: true, continuationBridges: { some: {} } },
              orderBy: { id: "asc" },
              take,
              ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
              select: { id: true, provider: true, importedAt: true, messageCount: true, password: true },
            })
          ).map(({ password, ...snapshot }) => ({ ...snapshot, locked: password !== null })),
        fetchNewestMessages: async (ids) => {
          const rows = await prisma.$queryRaw`
            SELECT "externalConversationId" AS "sourceId", "role", "ordinal", "content", "truncated"
            FROM (
              SELECT "externalConversationId", "role", "ordinal", "content", "truncated",
                     ROW_NUMBER() OVER (PARTITION BY "externalConversationId" ORDER BY "ordinal" DESC) AS "rank"
              FROM "ExternalMessage"
              WHERE "externalConversationId" IN (${Prisma.join(ids)})
            ) AS ranked
            WHERE "rank" <= ${SEED_SOURCE_MESSAGE_SCAN_LIMIT}
          `;
          const byId = new Map();
          for (const { sourceId, ...message } of rows) {
            const list = byId.get(sourceId) ?? [];
            list.push(message);
            byId.set(sourceId, list);
          }
          return byId;
        },
        fetchAssistantTurnCounts: async (ids) => {
          const rows = await prisma.$queryRaw`
            SELECT b."externalConversationId" AS "sourceId", count(m."id")::bigint AS "turns"
            FROM "ConversationContinuationBridge" b
            JOIN "Message" m ON m."conversationId" = b."conversationId" AND m."role" = 'assistant'
            WHERE b."externalConversationId" IN (${Prisma.join(ids)})
            GROUP BY b."externalConversationId"
          `;
          return new Map(rows.map((row) => [row.sourceId, Number(row.turns)]));
        },
        countDeletedSourceContinuations: () =>
          prisma.conversationContinuationBridge.count({ where: { externalConversationId: null } }),
      },
      {
        includeLocked,
        maxSnapshots,
        // Counts only, to stderr, so a long run shows it is alive.
        onProgress: (seen) => {
          if (seen % 500 === 0) process.stderr.write(`scanned ${seen} snapshots\n`);
        },
      }
    );
    database = {
      source: "database",
      note:
        "Read-only. Counts and shares are bands; token figures are rounded to 100; groups under 20 " +
        "snapshots are suppressed; a share resting on fewer than 5 snapshots on either side says only that." +
        (includeLocked ? " Locked snapshots were included (--include-locked)." : " Locked snapshots were not read."),
      ...measured,
    };
  } catch (error) {
    database = { source: "unreadable", note: databaseErrorNote(error) };
  } finally {
    await prisma?.$disconnect().catch(() => undefined);
  }
}

// ------------------------------------------------------------------ output

if (json) {
  console.log(
    JSON.stringify({ candidates: SEED_CANDIDATES.map((c) => c.id), fixtures: fixtureRows, database }, null, 2)
  );
} else {
  console.log("Continuation seed candidates (CONT-01) -- evidence for a policy decision, not a gate\n");
  console.log(
    "  current = shipped rule; B6000/B8000 = larger budget; C-head/C-tail = cut the boundary turn to the remaining budget.\n"
  );
  for (const row of fixtureRows) {
    console.log(`  ${row.id} [${row.script}] ${row.description}`);
    for (const id of SEED_CANDIDATES.map((c) => c.id)) {
      const result = row.candidates[id];
      const facts = result.facts.map((fact) => `${fact.id}:${fact.retained ? "yes" : "no"}`).join(" ");
      console.log(
        `    ${id.padEnd(8)} messages ${String(result.includedMessages).padStart(3)}  ` +
          `rendered tokens ${String(result.renderedTokens).padStart(5)}  newest ${result.newest.padEnd(10)} ${facts}`
      );
    }
    console.log("");
  }
  console.log(`  Stored conversations: ${database.note}`);
  if (database.source === "database") {
    console.log(`  Scope (bands): ${JSON.stringify(database.scopeBands)}${database.stoppedAtLimit ? " -- stopped at --max-snapshots" : ""}`);
    console.log(`  ${database.assistantTurnWeight}`);
    for (const [script, group] of Object.entries(database.byScript)) {
      if (group.suppressed) {
        console.log(`    ${script}: suppressed (${group.reason})`);
        continue;
      }
      console.log(`    ${script}: ${group.snapshotsBand} snapshot(s), ${group.assistantTurnsBand} assistant turn(s)`);
      for (const [id, figures] of Object.entries(group.byCandidate)) {
        console.log(`      ${id.padEnd(8)} ${JSON.stringify(figures)}`);
      }
    }
  }
}
