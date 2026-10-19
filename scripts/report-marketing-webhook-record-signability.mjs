/**
 * Reports which staging webhook verification records this build could sign.
 *
 * Read-only: it reads the record files the deployed tree carries, asks the
 * signing route's own check what it would answer, and prints the result. It
 * signs nothing, writes nothing, reads no secret and makes no network call.
 *
 * Each record is offered **its own** digest, computed from the bytes on disk,
 * so the digest check always passes and what the report isolates is the rest of
 * the route's judgement -- in practice the pipeline fingerprint, which goes
 * stale on almost every selective release to main.
 *
 * A record being signable is not approval to sign it. The signature is the
 * operator's act in the production console, and the console reads the tree
 * *production* is running, which is this report's answer only when it is run
 * against that same commit.
 *
 * Usage, from a repository clone:
 *   npm run report:marketing-webhook-record-signability
 *   npm run report:marketing-webhook-record-signability -- --json
 */

import { readdirSync } from "node:fs";
import path from "node:path";

import {
  MARKETING_WEBHOOK_PIPELINE_FINGERPRINT,
  canonicalMarketingWebhookFileText,
  digestMarketingWebhookVerificationRecord,
} from "../lib/marketingAutomationAccess.ts";
import {
  MARKETING_WEBHOOK_RECORD_ID_PATTERN,
  MARKETING_WEBHOOK_VERIFICATION_RECORD_DIR,
  MarketingWebhookVerificationRefusedError,
  checkMarketingWebhookRecordForSigning,
  readMarketingWebhookVerificationRecordFile,
} from "../lib/marketingWebhookVerification.ts";
import {
  RECORD_SIGNABLE,
  RECORD_STALE,
  summariseMarketingWebhookRecordSignability,
} from "./report-marketing-webhook-record-signability-core.mjs";

const asJson = process.argv.includes("--json");

/** The record ids in the tree, in file order, ignoring anything that is not one. */
const recordIdsInTree = () => {
  const directory = path.join(process.cwd(), MARKETING_WEBHOOK_VERIFICATION_RECORD_DIR);
  let entries;
  try {
    entries = readdirSync(directory);
  } catch (error) {
    // The report cannot be trusted if it cannot see the directory: an empty
    // listing and an unreadable one would print the same "no records".
    console.error(
      `Cannot read ${MARKETING_WEBHOOK_VERIFICATION_RECORD_DIR} from ${process.cwd()}:`,
      error,
    );
    process.exit(2);
  }
  return entries
    .filter((entry) => entry.endsWith(".json"))
    .map((entry) => entry.slice(0, -".json".length))
    .filter((id) => MARKETING_WEBHOOK_RECORD_ID_PATTERN.test(id))
    .sort();
};

/**
 * The record as an object, for display only, or `null` when these bytes are not
 * one.
 *
 * Normalised the way the route's check normalises before it parses: a record
 * written with a byte-order mark is one the route accepts, and parsing the raw
 * bytes instead would report its fingerprint as unknown -- so the line telling
 * the reader *which* build a stale record belongs to would go blank for exactly
 * the records that are fine.
 */
const parsedForDisplay = (fileText) => {
  try {
    return JSON.parse(canonicalMarketingWebhookFileText(fileText ?? "null"));
  } catch {
    return null;
  }
};

/** One record, judged by the signing route's own check. */
const judge = async (recordId) => {
  const fileText = await readMarketingWebhookVerificationRecordFile(recordId);
  const declaredFingerprint = parsedForDisplay(fileText)?.pipelineFingerprint ?? null;
  try {
    checkMarketingWebhookRecordForSigning({
      recordId,
      recordDigest: digestMarketingWebhookVerificationRecord(fileText ?? ""),
      fileText,
    });
    return { recordId, declaredFingerprint, refusalCode: null, refusalMessage: null };
  } catch (error) {
    if (error instanceof MarketingWebhookVerificationRefusedError) {
      return {
        recordId,
        declaredFingerprint,
        refusalCode: error.code,
        refusalMessage: error.message,
      };
    }
    throw error;
  }
};

const short = (value) => (typeof value === "string" ? value.slice(0, 12) : "unknown");

const summary = summariseMarketingWebhookRecordSignability({
  buildFingerprint: MARKETING_WEBHOOK_PIPELINE_FINGERPRINT,
  records: await Promise.all(recordIdsInTree().map(judge)),
});

if (asJson) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log(`build pipeline fingerprint: ${summary.buildFingerprint}`);
  console.log(`records in the tree:         ${summary.records.length}`);
  console.log("");
  for (const record of summary.records) {
    const marker =
      record.verdict === RECORD_SIGNABLE
        ? "signable"
        : record.verdict === RECORD_STALE
          ? "stale   "
          : "refused ";
    console.log(`  ${marker}  ${record.recordId}  ${short(record.declaredFingerprint)}`);
    if (record.refusalCode !== null) {
      console.log(`            ${record.refusalCode}: ${record.refusalMessage}`);
    }
  }
  console.log("");
  console.log(`verdict: ${summary.verdict}`);
  if (summary.verdict === "none_signable") {
    console.log(
      "No record in this tree can be signed against this build. A signable record" +
        " has to be made against a commit whose fingerprint is still this one.",
    );
  }
}
