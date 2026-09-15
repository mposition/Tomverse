// CONT-01: how much of an imported conversation would reach the model under
// the shipped seed rule and under each candidate a policy decision is weighing.
//
//   npm run report:continuation-seed                 # representative fixtures only
//   npm run report:continuation-seed -- --json
//   npm run report:continuation-seed -- --database   # also read DATABASE_URL, read-only
//
// Writes nothing, anywhere. Exits 0 whatever it finds -- this is evidence for a
// decision (docs/policy/external-conversation-continuation.md §4.1), not a gate.
//
// Fixture mode needs no credentials: it runs the candidates over the
// representative conversations in report-continuation-seed-core.mjs, each with
// planted facts, and says which facts each candidate carries.
//
// Database mode reads, for every finalized imported conversation that has been
// continued at least once and is not locked, its newest 200 messages -- the same
// scan the real loader uses -- and evaluates every candidate in memory. What it
// prints is counts and quantiles per script class, with groups under five
// snapshots suppressed. It never prints or stores message text, titles, ordinals,
// snapshot ids or user ids; they do not leave the process. Locked sources,
// deleted sources and continuations are counted but not read, because a seed is
// not built from them either and they are not budget defects.
//
// The flag is required even when DATABASE_URL is set, so a local run against a
// production URL is a decision someone typed rather than a side effect.

import {
  SEED_CANDIDATES,
  SEED_SOURCE_MESSAGE_SCAN_LIMIT,
  aggregateSeedSamples,
  evaluatePlan,
  evaluateSeedCandidates,
  factsRetained,
  representativeSeedFixtures,
  scriptClass,
} from "./report-continuation-seed-core.mjs";

const json = process.argv.includes("--json");
const useDatabase = process.argv.includes("--database");
const databaseUrl = process.env.DATABASE_URL?.trim();

// ------------------------------------------------------------------ fixtures

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
          ...evaluatePlan(plan, fixture.messages),
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

if (useDatabase && databaseUrl) {
  try {
    const { prisma } = await import("../lib/prisma.ts");
    const samples = [];
    let lockedSnapshots = 0;
    let noEligibleText = 0;
    let cursor;
    for (;;) {
      const page = await prisma.externalConversation.findMany({
        where: { finalized: true, continuationBridges: { some: {} } },
        orderBy: { id: "asc" },
        take: 50,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        select: {
          id: true,
          password: true,
          messageCount: true,
          _count: { select: { continuationBridges: true } },
        },
      });
      if (page.length === 0) break;
      cursor = page.at(-1).id;
      for (const snapshot of page) {
        if (snapshot.password !== null) {
          lockedSnapshots += 1;
          continue;
        }
        const messages = await prisma.externalMessage.findMany({
          where: { externalConversationId: snapshot.id },
          orderBy: { ordinal: "desc" },
          take: SEED_SOURCE_MESSAGE_SCAN_LIMIT,
          select: { role: true, ordinal: true, content: true, truncated: true },
        });
        const evaluated = evaluateSeedCandidates(messages, snapshot.messageCount);
        if (evaluated.results.current.eligibleNonBlank === 0) {
          noEligibleText += 1;
          continue;
        }
        // Only the evaluation leaves this loop: no id, no text.
        samples.push({ ...evaluated, weight: snapshot._count.continuationBridges });
      }
    }
    const deletedSourceContinuations = await prisma.conversationContinuationBridge.count({
      where: { externalConversationId: null },
    });
    await prisma.$disconnect().catch(() => undefined);
    database = {
      source: "database",
      note: "Read-only. Counts and quantiles only; groups under 5 snapshots suppressed.",
      scope: {
        measuredSnapshots: samples.length,
        lockedSnapshotsNotRead: lockedSnapshots,
        snapshotsWithNoEligibleText: noEligibleText,
        continuationsOfDeletedSources: deletedSourceContinuations,
      },
      byScript: aggregateSeedSamples(samples),
    };
  } catch (error) {
    const message = String(error?.message || error).replaceAll(databaseUrl, "[redacted]");
    database = {
      source: "unreadable",
      note: `DATABASE_URL was set but could not be read, so nothing was measured: ${message.slice(0, 200)}`,
    };
  }
}

// ------------------------------------------------------------------ output

if (json) {
  console.log(JSON.stringify({ candidates: SEED_CANDIDATES.map((c) => c.id), fixtures: fixtureRows, database }, null, 2));
} else {
  console.log("Continuation seed candidates (CONT-01) -- evidence for a policy decision, not a gate\n");
  console.log("  current = shipped rule; B6000/B8000 = larger budget; C-head/C-tail = cut the boundary turn.\n");
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
    console.log(`  Scope: ${JSON.stringify(database.scope)}`);
    for (const [script, group] of Object.entries(database.byScript)) {
      if (group.suppressed) {
        console.log(`    ${script}: suppressed (${group.reason})`);
        continue;
      }
      console.log(`    ${script}: ${group.snapshots} snapshot(s), ${group.continuations} continuation(s)`);
      for (const [id, figures] of Object.entries(group.byCandidate)) {
        console.log(`      ${id.padEnd(8)} ${JSON.stringify(figures)}`);
      }
    }
  }
}
