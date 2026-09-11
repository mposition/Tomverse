// Closes the queue items the candidate filters would no longer file, and
// stamps the decision key on the rows that stay.
//
// The filters only decide what happens next. A prerelease snapshot queued
// before prerelease models were excluded, and an older generation of a line
// Tomverse already serves at a higher version, both sit in the queue until
// somebody closes them -- which is why the discovery panel still shows preview
// models and Opus 4.6 on a morning when the scan would no longer file either.
//
// Two jobs, one pass, because they read the same rows:
//
//   1. close  -- open items that today's rules would not have queued
//   2. stamp  -- `evidence.decisionKey` on every row that has none, so a later
//                change to the normalisation rules cannot move a decision off
//                the model it was made about
//
// Usage:
//   npm run cleanup:model-lifecycle-queue
//   npm run cleanup:model-lifecycle-queue -- --apply --actor you@example.com
//
// Defaults to a dry run and writes nothing without `--apply`. Closing is a
// decision, so `--apply` needs `--actor`: the state machine refuses a
// transition with no person behind it, and this script does not get to be the
// exception. Items past `deferred` are reported and left alone -- somebody is
// already working on them, and that work is not this script's to discard.
//
// Requires DATABASE_URL.

import { prisma } from "../lib/prisma.ts";
import {
  candidateDecisionKey,
  isPrereleaseModel,
  shouldQueueModelCandidate,
  supersedingServedModel,
} from "../lib/modelLifecycleTriage.ts";
import { OPEN_WORK_ITEM_STATUSES } from "../lib/modelLifecycleWorkItemCore.ts";
import { transitionWorkItems } from "../lib/modelLifecycleWorkItems.ts";
import { listImageModels } from "../lib/imageModelRegistry.ts";

const argv = process.argv.slice(2);
const apply = argv.includes("--apply");
const actor = (() => {
  const flag = argv.indexOf("--actor");
  if (flag < 0) return null;
  const value = argv[flag + 1];
  return value && !value.startsWith("--") ? value.trim() : null;
})();

if (!process.env.DATABASE_URL?.trim()) {
  console.error("DATABASE_URL is required.");
  process.exit(1);
}
if (apply && !actor) {
  console.error(
    "--apply needs --actor <email>: closing an item is a decision and the queue records who made it."
  );
  process.exit(1);
}

// Only `add` items. A `retire` item is about a model Tomverse serves, so its
// own line always contains a model at least as new as itself, and closing it
// on that basis would throw away the one kind of item in this queue that is
// urgent.
const CLOSEABLE_FROM = new Set(["discovered", "awaiting_decision", "deferred"]);

try {
  const [items, registry] = await Promise.all([
    prisma.modelLifecycleWorkItem.findMany({
      where: { status: { in: [...OPEN_WORK_ITEM_STATUSES] }, action: "add" },
      orderBy: [{ firstSeenAt: "asc" }, { id: "asc" }],
      select: {
        id: true,
        provider: true,
        apiModel: true,
        status: true,
        firstSeenAt: true,
      },
    }),
    prisma.modelRegistryEntry.findMany({
      where: { catalogDeleted: false },
      select: { apiModel: true },
    }),
  ]);

  const servedApiModels = [
    ...registry.map((row) => row.apiModel),
    ...listImageModels().map((model) => model.apiModelId),
  ];

  const closeable = [];
  const blocked = [];
  for (const item of items) {
    const supersededBy = supersedingServedModel(item.apiModel, servedApiModels);
    const reason = !shouldQueueModelCandidate(item.apiModel)
      ? isPrereleaseModel(item.apiModel)
        ? "prerelease"
        : "not_reviewable"
      : supersededBy
        ? "superseded_by_served_version"
        : null;
    if (!reason) continue;
    const entry = { ...item, reason, supersededBy };
    if (CLOSEABLE_FROM.has(item.status)) closeable.push(entry);
    else blocked.push(entry);
  }

  const counts = closeable.reduce((tally, entry) => {
    tally[entry.reason] = (tally[entry.reason] ?? 0) + 1;
    return tally;
  }, {});

  console.log(
    `Model lifecycle queue cleanup (${apply ? "APPLY" : "DRY RUN"})\n` +
      `  open add items        : ${items.length}\n` +
      `  to close              : ${closeable.length}` +
      `${
        Object.keys(counts).length
          ? ` (${Object.entries(counts)
              .map(([reason, count]) => `${reason} ${count}`)
              .join(", ")})`
          : ""
      }\n` +
      `  past deferred, left   : ${blocked.length}\n`
  );

  for (const entry of closeable) {
    console.log(
      `  - ${entry.provider.padEnd(12)} ${entry.apiModel.padEnd(40)} ${entry.reason}` +
        (entry.supersededBy ? ` (served: ${entry.supersededBy})` : "")
    );
  }
  for (const entry of blocked) {
    console.log(
      `  ! ${entry.provider.padEnd(12)} ${entry.apiModel.padEnd(40)} ${entry.status} — somebody is working on this; close it in the panel if that is wrong`
    );
  }

  const unkeyed = await prisma.modelLifecycleWorkItem.findMany({
    select: { id: true, apiModel: true, evidence: true },
  });
  const needsKey = unkeyed.filter((row) => {
    const evidence = row.evidence;
    if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
      return true;
    }
    return typeof evidence.decisionKey !== "string";
  });
  console.log(`\n  decision keys to stamp: ${needsKey.length}`);

  if (!apply) {
    console.log("\nDry run. Re-run with --apply --actor <email> to write.");
    process.exit(0);
  }

  // Stamped first. The key is an annotation rather than a decision, and doing
  // it before the closures means a closure that fails partway still leaves
  // every row it did not reach with a key of its own.
  let stamped = 0;
  for (const row of needsKey) {
    const evidence =
      row.evidence && typeof row.evidence === "object" && !Array.isArray(row.evidence)
        ? { ...row.evidence }
        : {};
    await prisma.modelLifecycleWorkItem.update({
      where: { id: row.id },
      data: {
        evidence: { ...evidence, decisionKey: candidateDecisionKey(row.apiModel) },
      },
    });
    stamped += 1;
  }

  let closed = 0;
  for (const entry of closeable) {
    const result = await transitionWorkItems({
      workItemIds: [entry.id],
      to: "closed_no_action",
      actorEmail: actor,
      note:
        entry.reason === "superseded_by_served_version"
          ? `Closed by queue cleanup: Tomverse already serves ${entry.supersededBy}, a later generation of the same line.`
          : "Closed by queue cleanup: prerelease and other non-reviewable models are no longer queued for review.",
    });
    if (result.ok) {
      closed += 1;
      continue;
    }
    console.error(
      `  refused: ${entry.apiModel} (${result.refusal.code}) ${result.refusal.message}`
    );
  }

  console.log(`\nStamped ${stamped} decision keys. Closed ${closed} items.`);
} finally {
  await prisma.$disconnect();
}
