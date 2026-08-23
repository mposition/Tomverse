// Reports what the Conversation.productKey backfill would write, and -- only
// under a full approval line -- writes it.
//
// Contract: docs/policy/conversation-product-key.md §4, decision record v1.2 §2.
// Runbook:  docs/ops/product-key-transition.md.
//
// Usage:
//   node --import tsx scripts/report-product-key-backfill.mjs
//   npm run --silent report:product-key-backfill -- \
//     --classifications=<path.json> --json > report.json
//
// `--silent` matters when redirecting: without it npm writes its own banner to
// stdout and the saved file is not JSON.
//   node --import tsx scripts/report-product-key-backfill.mjs \
//     --apply --approved-backfill --ticket="<url>" --actor="<name>" \
//     --classifications=<path.json> --dry-run-report=<report.json>
//
// A dry run needs nothing and is the default. A write needs the whole line
// above, refuses to run inside CI or an npm build/start/deploy/migrate
// lifecycle step at all, and refuses outright while a single conversation with
// selectionMode='auto' is unclassified -- relabelling it review destroys the
// only evidence of what it was, and leaving it NULL makes the NULL = 0 exit
// condition unreachable, so there is no safe default and the only path through
// is a person resolving it.
//
// Requires DATABASE_URL. Reads Conversation.{id,kind,selectionMode,productKey}
// and nothing else -- no titles, no messages -- so the report can be attached
// to a ticket.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

// The application's own client, not a bare `new PrismaClient()`: this project
// connects through a PrismaPg driver adapter.
import { prisma } from "../lib/prisma.ts";
import {
  backfillPlanFingerprint,
  findBackfillApprovalProblems,
  planProductKeyBackfill,
  verifyProductKeyBackfill,
} from "../lib/productKeyBackfillCore.ts";
import { readReconciliationEnvironment } from "../lib/reconciliationApprovalCore.ts";

const PAGE_SIZE = 1000;

const argValue = (name) => {
  const match = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  return match ? match.slice(name.length + 3).trim() || null : null;
};

const apply = process.argv.includes("--apply");
const asJson = process.argv.includes("--json");

const readClassifications = () => {
  const path = argValue("classifications");
  if (!path) return [];
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(parsed)) {
    throw new Error(`${path} must contain a JSON array of classifications.`);
  }
  for (const entry of parsed) {
    if (!entry?.conversationId || !entry?.productKey || !entry?.evidence) {
      throw new Error(
        `${path}: every entry needs conversationId, productKey and evidence. ` +
          "The evidence field is the point -- an entry without it is an assumption."
      );
    }
  }
  return parsed;
};

const readDryRunReport = () => {
  const path = argValue("dry-run-report");
  if (!path) return { path: null, digest: null };
  const text = readFileSync(path, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Almost always npm's own banner in a redirected file. Saying so beats a
    // JSON parse error at the top of a run that is about to write rows.
    throw new Error(
      `${path} is not JSON. If it was produced by "npm run ... --json > ${path}", ` +
        "re-run it with `npm run --silent` -- npm writes its banner to stdout."
    );
  }
  return { path, digest: parsed?.fingerprintDigest ?? null };
};

const readAllRows = async () => {
  const rows = [];
  let cursor = null;
  for (;;) {
    const page = await prisma.conversation.findMany({
      select: { id: true, kind: true, selectionMode: true, productKey: true },
      orderBy: { id: "asc" },
      take: PAGE_SIZE,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    if (page.length === 0) break;
    rows.push(...page);
    cursor = page[page.length - 1].id;
    if (page.length < PAGE_SIZE) break;
  }
  return rows;
};

const main = async () => {
  const classifications = readClassifications();
  const rows = await readAllRows();
  const plan = planProductKeyBackfill({ rows, classifications });

  const fingerprint = backfillPlanFingerprint(plan);
  const fingerprintDigest = createHash("sha256").update(fingerprint).digest("hex");

  const dryRunReport = readDryRunReport();
  const approvalProblems = findBackfillApprovalProblems({
    approval: {
      apply,
      approvedBackfill: process.argv.includes("--approved-backfill"),
      ticket: argValue("ticket"),
      actor: argValue("actor"),
      dryRunReportPath: dryRunReport.path,
      dryRunReportDigest: dryRunReport.digest,
      environment: readReconciliationEnvironment(process.env),
    },
    plan,
    currentReportDigest: fingerprintDigest,
  });

  const report = {
    mode: apply ? "APPLY" : "DRY RUN",
    generatedAt: new Date().toISOString(),
    fingerprintDigest,
    totals: {
      conversations: rows.length,
      alreadySet: plan.alreadySet.length,
      extractedAuto: plan.extracted.length,
      classified: plan.classified.length,
      unclassified: plan.unclassified.length,
      toStudio: plan.toStudio.length,
      toReview: plan.toReview.length,
    },
    // Ids only. A backfill report goes on a ticket.
    unclassifiedIds: plan.unclassified.map((row) => row.id),
    blockers: plan.blockers,
    approvalProblems,
  };

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`productKey backfill — ${report.mode}`);
    console.log(`  conversations           ${report.totals.conversations}`);
    console.log(`  already carry a product ${report.totals.alreadySet}`);
    console.log(`  selectionMode='auto'    ${report.totals.extractedAuto}  <- extracted for human review, never auto-classified`);
    console.log(`    classified by a person ${report.totals.classified}`);
    console.log(`    unclassified           ${report.totals.unclassified}`);
    console.log(`  step 4  kind='image' -> studio  ${report.totals.toStudio}`);
    console.log(`  step 5  remaining NULL -> review ${report.totals.toReview}`);
    console.log(`  fingerprint ${fingerprintDigest}`);
    for (const blocker of plan.blockers) console.error(`\nBLOCKED: ${blocker.message}`);
    for (const problem of approvalProblems) {
      if (problem.code !== "plan_blocked") console.error(`\nREFUSED: ${problem.message}`);
    }
  }

  if (!apply) {
    // Step 3 is a gate on the write, not on the report: the report is exactly
    // how the exception list becomes visible, so it must always be producible.
    if (plan.blockers.length > 0) {
      console.error(
        "\nThe backfill and the strict transition are both blocked. Resolve every " +
          "row above before running with --apply."
      );
    }
    await prisma.$disconnect();
    process.exit(0);
  }

  if (approvalProblems.length > 0) {
    console.error("\nNothing was written.");
    await prisma.$disconnect();
    process.exit(1);
  }

  // Steps 4 and 5, in that order: an image row must reach studio before the
  // catch-all sees it.
  let written = 0;
  for (const { row, classification } of plan.classified) {
    await prisma.conversation.update({
      where: { id: row.id, productKey: null },
      data: { productKey: classification.productKey },
    });
    written += 1;
  }
  for (const [productKey, group] of [
    ["studio", plan.toStudio],
    ["review", plan.toReview],
  ]) {
    for (let index = 0; index < group.length; index += PAGE_SIZE) {
      const batch = group.slice(index, index + PAGE_SIZE).map((row) => row.id);
      const result = await prisma.conversation.updateMany({
        // `productKey: null` in the filter, not just the id: a row that
        // acquired a product between the report and the write is not one this
        // run may overwrite.
        where: { id: { in: batch }, productKey: null },
        data: { productKey },
      });
      written += result.count;
    }
  }

  // Step 6.
  const remainingNull = await prisma.conversation.count({ where: { productKey: null } });
  const verification = verifyProductKeyBackfill({
    nullCount: remainingNull,
    unclassifiedCount: plan.unclassified.length,
    drillConversations: await prisma.conversation.findMany({
      where: { id: { in: plan.classified.map(({ row }) => row.id) } },
      select: { id: true, productKey: true },
    }),
  });

  console.log(`\nWrote ${written} row(s).`);
  console.log(`  NULL remaining     ${verification.nullCount}`);
  console.log(`  unclassified       ${verification.unclassifiedCount}`);
  console.log(`  drill rows not chat ${verification.drillRowsNotChat.length}`);
  console.log(verification.passed ? "Verification passed." : "VERIFICATION FAILED.");

  await prisma.$disconnect();
  process.exit(verification.passed ? 0 : 1);
};

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
