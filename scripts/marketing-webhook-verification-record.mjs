// Draft the staging webhook verification record from what staging stored and
// what Zernio delivered (S2 plan, S2e-verification; docs/policy/marketing-automation.md §8.1.1).
//
//   npm run marketing:webhook-record -- --record-id 2026-10-03__zernio-shadow
//     --executor staging-operator --commit <deployed staging sha>
//     --receiver-url https://staging.tomverse.app/api/webhooks/zernio
//     --c2 <tampered-body probe ref> [--evidence <ref>]... [--write]
//
// Run against staging (railway run, staging environment). Reads the shadow
// reports and the shadow switch from the database and the delivery attempts
// from Zernio's webhook log (read only, with ZERNIO_API_KEY); writes nothing to
// either. The staging configuration snapshot hashes the declared environment
// values in this process -- no value is printed. Without --write it prints the
// draft and its digest; with --write it creates the record file, refusing to
// overwrite one that exists (a record is immutable once written).
//
// Only attempts made to --receiver-url exactly are read, and only those whose
// answer names this build's pipeline fingerprint and this staging snapshot
// count as evidence (the receiver stamps both on what it answers).
// Conditions 1, 3 and 4 are judged per event type from the delivery order;
// condition 2 needs a refused delivery in the log and the executor's reference
// for the tampered-body probe, which Zernio cannot send.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { MARKETING_WEBHOOK_SHADOW_KEY } from "../lib/marketingAutomationAccess.ts";
import { parseMarketingReportPayload } from "../lib/marketingAutomationSchema.ts";
import {
  marketingWebhookIsStaging,
  marketingWebhookStagingConfigSnapshotDigest,
} from "../lib/marketingWebhookCore.ts";
import { draftMarketingWebhookVerificationRecord } from "../lib/marketingWebhookRecordDraft.ts";
import { marketingWebhookVerificationRecordPath } from "../lib/marketingWebhookVerification.ts";
import { ZERNIO_API_BASE_URL } from "../lib/zernioPublishAdapter.ts";

const RECEIVER_PATH = "/api/webhooks/zernio";

const args = process.argv.slice(2);
const values = (name) =>
  args.flatMap((arg, index) => (arg === `--${name}` && args[index + 1] ? [args[index + 1]] : []));
const one = (name) => {
  const found = values(name);
  if (found.length !== 1) {
    console.error(`--${name} is required exactly once.`);
    process.exit(64);
  }
  return found[0];
};

const recordId = one("record-id");
const executor = one("executor");
const stagingCommitSha = one("commit");
const receiverUrl = one("receiver-url");
if (new URL(receiverUrl).pathname !== RECEIVER_PATH || new URL(receiverUrl).protocol !== "https:") {
  console.error(`--receiver-url must be the https receiver URL ending in ${RECEIVER_PATH}.`);
  process.exit(64);
}
const write = args.includes("--write");

if (!marketingWebhookIsStaging(process.env)) {
  console.error("Not staging: the record is staging evidence and is drafted only there.");
  process.exit(65);
}

/** Every attempt Zernio's log still holds for the receiver path (30-day retention). */
const readDeliveries = async () => {
  const key = process.env.ZERNIO_API_KEY;
  if (!key) throw new Error("ZERNIO_API_KEY is not set in this environment.");
  const deliveries = [];
  for (let skip = 0; ; skip += 100) {
    const response = await fetch(`${ZERNIO_API_BASE_URL}/v1/webhooks/logs?limit=100&skip=${skip}`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!response.ok) throw new Error(`Zernio webhook log answered ${response.status}.`);
    const page = await response.json();
    for (const log of page.logs ?? []) {
      // This receiver exactly: another deployment's attempts never join this record.
      if (log.url !== receiverUrl) continue;
      let body = null;
      try {
        body = JSON.parse(log.responseBody ?? "");
      } catch {
        body = null;
      }
      const text = (value) => (typeof value === "string" ? value : null);
      deliveries.push({
        eventId: log.eventId,
        event: log.event,
        at: log.createdAt,
        statusCode: log.statusCode,
        answer: text(body?.status) ?? text(body?.code),
        pipeline: text(body?.pipeline),
        config: text(body?.config),
      });
    }
    if (!page.pagination?.hasMore) return deliveries;
  }
};

const { prisma } = await import("../lib/prisma.ts");
try {
  const [shadowSetting, rows, deliveries] = await Promise.all([
    prisma.appSetting.findUnique({
      where: { key: MARKETING_WEBHOOK_SHADOW_KEY },
      select: { value: true },
    }),
    prisma.marketingReport.findMany({
      where: { kind: "webhook_shadow" },
      select: { payload: true },
    }),
    readDeliveries(),
  ]);
  const reports = rows.map((row) => parseMarketingReportPayload("webhook_shadow", row.payload));

  // The same function the receiver stamps its signed answers with.
  const stagingConfigSnapshotDigest = marketingWebhookStagingConfigSnapshotDigest(
    process.env,
    shadowSetting?.value ?? null,
  );

  const draft = draftMarketingWebhookVerificationRecord({
    recordId,
    executor,
    stagingCommitSha,
    stagingConfigSnapshotDigest,
    reports: reports.map((report) => ({
      eventIdDigest: report.eventIdDigest,
      eventType: report.eventType,
      channelId: report.channelId,
      statusQueryMatch: report.statusQueryMatch,
    })),
    deliveries,
    c2EvidenceRefs: values("c2"),
    evidenceRefs: values("evidence"),
  });

  console.log(`shadow reports read: ${reports.length}; delivery attempts read: ${deliveries.length}`);
  for (const excluded of draft.excludedTypes) {
    console.log(`left out: ${excluded.eventType} (not proved: ${excluded.missing.join(", ")})`);
  }
  if (!draft.ok) {
    console.log(`not drafted: ${draft.problems.join(", ")}`);
    process.exitCode = 1;
  } else {
    for (const pair of draft.excludedPairs) {
      console.log(`left out (status query disagreed): ${pair.eventType} on ${pair.channelId}`);
    }
    console.log(`record digest: ${draft.recordDigest}`);
    if (write) {
      const relative = marketingWebhookVerificationRecordPath(recordId);
      const target = path.join(process.cwd(), relative);
      if (existsSync(target)) {
        console.error("A record with this id exists; records are immutable. Choose a new id.");
        process.exitCode = 1;
      } else {
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, draft.fileText, { flag: "wx" });
        console.log(`written: ${relative}`);
      }
    } else {
      process.stdout.write(draft.fileText);
    }
  }
} finally {
  await prisma.$disconnect();
}
