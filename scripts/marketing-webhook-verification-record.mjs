// Draft the staging webhook verification record from what staging stored and
// what Zernio delivered (S2 plan, S2e-verification; docs/policy/marketing-automation.md §8.1.1).
//
//   npm run marketing:webhook-record -- --record-id 2026-10-03__zernio-shadow
//     --executor staging-operator --commit <deployed staging sha>
//     --receiver-url https://staging.tomverse.app/api/webhooks/zernio
//     [--config <digest>] [--evidence <ref>]... [--write]
//
// Run against staging (railway run, staging environment). Reads the shadow
// reports from the database and the delivery attempts from Zernio's webhook
// log (read only, with ZERNIO_API_KEY); writes nothing to either. The staging
// configuration snapshot is the one the receiver stamped on the evidence: the
// configuration the events were handled under, not one recomputed here. If the
// evidence carries more
// than one, --config chooses which to certify. Without --write it prints the
// draft and its digest; with --write it creates the record file, refusing to
// overwrite one that exists (a record is immutable once written).
//
// Only attempts made to --receiver-url exactly are read, and only those whose
// answer names this build's pipeline fingerprint and this staging snapshot
// count as evidence (the receiver stamps both on what it answers).
// Conditions 1, 3 and 4 are judged per event type from the delivery order.
// For condition 2 the script itself sends three requests the receiver must
// refuse (see sendC2Probes): the only requests it makes to staging.

import { spawnSync } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { MARKETING_WEBHOOK_PIPELINE_FINGERPRINT } from "../lib/marketingAutomationAccess.ts";
import { parseMarketingReportPayload } from "../lib/marketingAutomationSchema.ts";
import { marketingWebhookIsStaging } from "../lib/marketingWebhookCore.ts";
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
 * Condition 2, sent by this script. Two bodies are not JSON, so a receiver
 * that parsed before it verified would answer 400 rather than 401; one is a
 * well-formed event under a wrong signature; and two are signed correctly and
 * then changed by one byte, or extended by one, after signing -- a receiver
 * that trimmed or normalised the body before verifying would accept those.
 * Each must leave the stored reports as they were. First, a control: the same
 * signing untampered, which must be accepted about an account that is not
 * ours -- or the secret here is not the receiver's and the refusals prove
 * nothing.
 *
 * The signed probes are the one place outside the receiver route that reads
 * ZERNIO_WEBHOOK_SECRET (operator approval 2026-10-02, AGENTS.md S2e): the
 * value is used for the HMAC and nothing else, never printed or stored.
 */
const sendC2Probes = async () => {
  const results = [];
  for (const kind of MARKETING_WEBHOOK_C2_PROBE_KINDS) {
    const eventId = randomUUID();
    const event = JSON.stringify({
      id: eventId,
      event: "post.published",
      timestamp: new Date().toISOString(),
      post: { id: "c2-probe", status: "published", platforms: [{ platform: "linkedin", accountId: "c2-probe" }] },
    });
    const headers = { "content-type": "application/json", "x-zernio-event-id": eventId };
    let body = event;
    if (kind === "unsigned_not_json" || kind === "wrong_signature_not_json") {
      body = `{"id":"${eventId}","event":`;
    }
    if (kind !== "unsigned_not_json") headers["x-zernio-signature"] = "0".repeat(64);
    if (kind === "signed_control" || kind === "signed_byte_changed" || kind === "signed_byte_appended") {
      const secret = process.env.ZERNIO_WEBHOOK_SECRET;
      if (!secret) throw new Error("ZERNIO_WEBHOOK_SECRET is not set in this environment.");
      headers["x-zernio-signature"] = createHmac("sha256", secret).update(event).digest("hex");
      // The control goes untampered: its acceptance shows this secret is the receiver's.
      if (kind === "signed_byte_changed") body = event.replace("c2-probe", "c2-proba");
      if (kind === "signed_byte_appended") body = `${event} `;
    }
    const reportsBefore = await prisma.marketingReport.count({ where: { kind: "webhook_shadow" } });
    const at = new Date().toISOString();
    const response = await fetch(receiverUrl, { method: "POST", headers, body });
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
  const [rows, deliveries] = await Promise.all([
    prisma.marketingReport.findMany({
      where: { kind: "webhook_shadow" },
      select: { payload: true },
    }),
    readDeliveries(),
  ]);
  const reports = rows.map((row) => parseMarketingReportPayload("webhook_shadow", row.payload));

  // The configurations this build stamped on processed answers.
  const stamped = [
    ...new Set(
      deliveries
        .filter(
          (attempt) =>
            attempt.pipeline === MARKETING_WEBHOOK_PIPELINE_FINGERPRINT &&
            attempt.config !== null &&
            ["recorded", "duplicate", "deliberate_fault"].includes(attempt.answer ?? ""),
        )
        .map((attempt) => attempt.config),
    ),
  ].sort();
  const chosen = values("config");
  let stagingConfigSnapshotDigest = null;
  if (chosen.length === 1) {
    stagingConfigSnapshotDigest = stamped.includes(chosen[0]) ? chosen[0] : null;
    if (!stagingConfigSnapshotDigest) console.error("--config is not a configuration this build stamped on evidence.");
  } else if (stamped.length === 1) {
    stagingConfigSnapshotDigest = stamped[0];
  } else if (stamped.length > 1) {
    console.error(`The evidence carries ${stamped.length} configurations; choose one with --config:`);
    for (const digest of stamped) console.error(`  ${digest}`);
  }

  const draft = draftMarketingWebhookVerificationRecord({
    recordId,
    // No stamped configuration: nothing this build processed can be evidence,
    // and the drafter will say so per type.
    stagingConfigSnapshotDigest: stagingConfigSnapshotDigest ?? "0".repeat(64),
    executor,
    stagingCommitSha,
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
