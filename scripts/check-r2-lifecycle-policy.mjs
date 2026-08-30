// Does this bucket's lifecycle configuration delete objects the database still
// references?
//
//   npm run check:r2-lifecycle-policy
//   npm run check:r2-lifecycle-policy -- --json
//
// Read-only. It issues exactly one S3 call -- GetBucketLifecycleConfiguration
// -- and writes nothing, anywhere. It cannot change a rule, and it is not the
// thing that fixes one: the runbook for that is docs/ops/r2-object-lifecycle.md
// and the change itself needs an approval, because a lifecycle edit applies to
// every object in the bucket at once.
//
// Written after a production incident: a signed-in user's JPEG disappeared from
// R2 about a day after upload while its MessageAttachment row stayed, and the
// resulting storage 404 was recorded as an AI provider outage. Nothing in the
// application had deleted it. The bucket had.
//
// Fail-closed on purpose, in three ways:
//
//   * an enabled deletion rule covering a protected prefix exits 2;
//   * a rule with no prefix is treated as covering the whole bucket, because
//     that is what S3 does with it;
//   * a configuration that cannot be read exits 1 rather than 0 -- "we could
//     not check" is not "it is fine". The single exception is
//     NoSuchLifecycleConfiguration, which is a definite answer: the bucket has
//     no rules, so no rule deletes anything.
//
// An environment with no R2 credentials exits 0 with "not configured": this is
// an operational check against a live bucket, and a developer machine or a CI
// job without a bucket has nothing to say about production. The prefix-overlap
// logic itself is unit tested (tests/r2LifecyclePolicy.test.mjs) and runs
// without any of this.
//
// Never printed: object keys, the bucket name, the endpoint, the account id,
// any credential. Rule ids and rule prefixes are printed, because they are the
// finding.

import {
  GetBucketLifecycleConfigurationCommand,
  S3Client,
} from "@aws-sdk/client-s3";

import {
  EPHEMERAL_OBJECT_PREFIXES,
  PROTECTED_OBJECT_PREFIXES,
  auditLifecycleConfiguration,
  describeLifecycleAudit,
} from "./check-r2-lifecycle-policy-core.mjs";

const args = process.argv.slice(2);
const asJson = args.includes("--json");

const emit = (payload, lines) => {
  if (asJson) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  for (const line of lines) console.log(line);
};

const accountId = process.env.R2_ACCOUNT_ID;
const accessKeyId = process.env.R2_ACCESS_KEY_ID;
const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
const bucket = process.env.R2_BUCKET_NAME;

if (!accessKeyId || !secretAccessKey || !bucket || !(accountId || process.env.R2_ENDPOINT)) {
  emit(
    { status: "not_configured", protectedPrefixes: PROTECTED_OBJECT_PREFIXES },
    [
      "R2 is not configured in this environment; nothing to check.",
      "This check is meaningful only against a live bucket.",
    ]
  );
  process.exit(0);
}

const client = new S3Client({
  region: "auto",
  endpoint:
    process.env.R2_ENDPOINT || `https://${accountId}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId, secretAccessKey },
});

let configuration;
try {
  configuration = await client.send(
    new GetBucketLifecycleConfigurationCommand({ Bucket: bucket })
  );
} catch (error) {
  const name = typeof error?.name === "string" ? error.name : "UnknownError";
  const status =
    typeof error?.$metadata?.httpStatusCode === "number"
      ? error.$metadata.httpStatusCode
      : null;
  if (name === "NoSuchLifecycleConfiguration") {
    // A definite answer, and the safe one: no rules means no rule deletes
    // anything a row points at.
    emit(
      {
        status: "ok",
        ruleCount: 0,
        violations: [],
        protectedPrefixes: PROTECTED_OBJECT_PREFIXES,
        ephemeralPrefixes: EPHEMERAL_OBJECT_PREFIXES,
      },
      ["This bucket has no lifecycle configuration. Nothing is expired by rule."]
    );
    process.exit(0);
  }
  // Deliberately not the SDK's message: it echoes the request, which is how a
  // bucket name and an endpoint end up in a CI log.
  emit({ status: "unreadable", errorName: name, httpStatus: status }, [
    `Could not read the lifecycle configuration (${name}${status ? `, HTTP ${status}` : ""}).`,
    "Exiting non-zero: an unchecked bucket is not a checked one.",
    "A token needs s3:GetLifecycleConfiguration on this bucket to answer this.",
  ]);
  process.exit(1);
}

const audit = auditLifecycleConfiguration(configuration);
emit(
  {
    status: audit.ok ? "ok" : "violation",
    ruleCount: audit.ruleCount,
    violations: audit.violations,
    allowed: audit.allowed,
    protectedPrefixes: PROTECTED_OBJECT_PREFIXES,
    ephemeralPrefixes: EPHEMERAL_OBJECT_PREFIXES,
  },
  [
    ...describeLifecycleAudit(audit),
    ...(audit.ok
      ? []
      : [
          "",
          "A signed-in user's attachment is kept until the conversation or the",
          "account is deleted (docs/policy/user-attachment-persistence.md §7).",
          "A rule that expires it by age deletes a file a row still points at.",
          "Runbook: docs/ops/r2-object-lifecycle.md",
        ]),
  ]
);
process.exit(audit.ok ? 0 : 2);
