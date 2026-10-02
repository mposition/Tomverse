// Draft the staging webhook verification record from what staging stored and
// what Zernio delivered (S2 plan, S2e-verification; docs/policy/marketing-automation.md §8.1.1).
//
//   npm run marketing:webhook-record -- --record-id 2026-10-03__zernio-shadow
//     --executor staging-operator --commit <deployed staging sha>
//     --receiver-url https://staging.tomverse.app/api/webhooks/zernio
//     [--evidence <ref>]... [--write]
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
// Conditions 1, 3 and 4 are judged per event type from the delivery order.
// For condition 2 the script itself sends three refused requests to the
// receiver (no signature, a wrong one, a signed body with one byte changed):
// the only writes it makes, to staging, and each must leave the reports as
// they were.

import { spawnSync } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { MARKETING_WEBHOOK_SHADOW_KEY } from "../lib/marketingAutomationAccess.ts";
import { parseMarketingReportPayload } from "../lib/marketingAutomationSchema.ts";
import {
  marketingWebhookIsStaging,
  marketingWebhookStagingConfigSnapshotDigest,
} from "../lib/marketingWebhookCore.ts";
import {
  MARKETING_WEBHOOK_C2_PROBE_KINDS,
  draftMarketingWebhookVerificationRecord,
} from "../lib/marketingWebhookRecordDraft.ts";
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

// The fingerprint this script compares against is the checkout's own, so the
// checkout must be the commit staging runs; anything else certifies a build
// that was never observed.
const head = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" });
if (head.status !== 0 || head.stdout.trim() !== stagingCommitSha) {
  console.error("--commit must be this checkout's HEAD: check out the commit staging runs.");
  process.exit(64);
}
const dirty = spawnSync("git", ["status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" });
if (dirty.status !== 0 || dirty.stdout.trim() !== "") {
  console.error("The checkout has local changes; the fingerprint would not be the committed one.");
  process.exit(64);
}

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

/**
 * Condition 2, sent by this script: Zernio only ever signs. Each probe is a
 * well-formed post event under a fresh random id; the receiver must refuse it
 * 401 before parsing, and the stored reports must not change.
 */
const sendC2Probes = async () => {
  const secret = process.env.ZERNIO_WEBHOOK_SECRET;
  if (!secret) throw new Error("ZERNIO_WEBHOOK_SECRET is not set in this environment.");
  const results = [];
  for (const kind of MARKETING_WEBHOOK_C2_PROBE_KINDS) {
    const eventId = randomUUID();
    const body = JSON.stringify({
      id: eventId,
      event: "post.published",
      timestamp: new Date().toISOString(),
      post: { id: "c2-probe", status: "published", platforms: [{ platform: "linkedin", accountId: "c2-probe" }] },
    });
    const signature = createHmac("sha256", secret).update(body).digest("hex");
    const headers = { "content-type": "application/json", "x-zernio-event-id": eventId };
    let sent = body;
    if (kind === "wrong_signature") headers["x-zernio-signature"] = "0".repeat(64);
    if (kind === "tampered_body") {
      headers["x-zernio-signature"] = signature;
      // One byte changed after signing.
      sent = body.replace("c2-probe", "c2-proba");
    }
    const reportsBefore = await prisma.marketingReport.count({ where: { kind: "webhook_shadow" } });
    const at = new Date().toISOString();
    const response = await fetch(receiverUrl, { method: "POST", headers, body: sent });
    let answerBody = null;
    try {
      answerBody = await response.json();
    } catch {
      answerBody = null;
    }
    const reportsAfter = await prisma.marketingReport.count({ where: { kind: "webhook_shadow" } });
    const text = (value) => (typeof value === "string" ? value : null);
    results.push({
      kind,
      at,
      statusCode: response.status,
      answer: text(answerBody?.code) ?? text(answerBody?.status),
      pipeline: text(answerBody?.pipeline),
      reportsBefore,
      reportsAfter,
    });
  }
  return results;
};

try {
  const c2Probes = await sendC2Probes();
  const [shadowSetting, channels, rows, deliveries] = await Promise.all([
    prisma.appSetting.findUnique({
      where: { key: MARKETING_WEBHOOK_SHADOW_KEY },
      select: { value: true },
    }),
    // The same read the receiver makes for its stamp.
    prisma.marketingChannel.findMany({
      where: { provider: "zernio", externalAccountRef: { not: null } },
      select: { id: true, externalAccountRef: true },
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
    channels.flatMap((channel) =>
      channel.externalAccountRef ? [{ id: channel.id, externalAccountRef: channel.externalAccountRef }] : [],
    ),
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
    c2Probes,
    evidenceRefs: values("evidence"),
  });

  console.log(`shadow reports read: ${reports.length}; delivery attempts read: ${deliveries.length}`);
  for (const result of c2Probes) {
    console.log(`c2 probe ${result.kind}: ${result.statusCode} ${result.answer ?? "-"} (reports ${result.reportsBefore} -> ${result.reportsAfter})`);
  }
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
