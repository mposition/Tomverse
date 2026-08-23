// The one secret scanner both sides run, and the waiver comparison (Slice 2).
//
// docs/policy/assistant-package-import.md §3 (A5), §9.
//
// The detections matter less than three properties a reviewer cannot see from
// the rule list: that a finding never carries the matched text, that only one
// direction of the client/server disagreement is a refusal, and that the
// disclosure of URLs names hosts rather than reproducing the URL.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
    ASSISTANT_PACKAGE_SECRET_RULES,
    collectUrlHosts,
    compareSecretFindings,
    findingKey,
    scanForSecrets,
    secretOverrideFingerprint,
    sortFindings,
} from "../lib/assistantPackageSecretScan.ts";

const sha256Hex = async (input) =>
    createHash("sha256").update(input, "utf8").digest("hex");

/**
 * Sample credentials are assembled from pieces rather than written whole.
 *
 * They are invented, but a scanner cannot tell that from the shape, and this
 * repository is scanned by more than its own rules -- a literal that matches a
 * provider's format is a literal that gets flagged on push. Joining the parts
 * keeps the fixture readable without leaving the pattern in the file.
 */
const forge = (...parts) => parts.join("");

const SAMPLES = {
    "aws-access-key-id": forge("AKIA", "3EXAMPLE7SAMPLE1"),
    "github-token": forge("ghp", "_", "A".repeat(36)),
    "slack-token": forge("xox", "b-", "1234567890", "abcdef"),
    "google-api-key": forge("AIza", "S".repeat(35)),
    "stripe-key": forge("sk", "_live_", "0123456789abcdef"),
    "openai-key": forge("sk", "-", "A".repeat(24)),
    "anthropic-key": forge("sk", "-ant-", "A".repeat(24)),
    "private-key-block": forge("-----BEGIN ", "RSA PRIVATE KEY-----"),
    "authorization-bearer": forge("Authorization: ", "Bearer ", "a".repeat(24)),
    "json-web-token": forge("eyJ", "hbGciOiJIUzI1NiJ9", ".", "eyJzdWIiOiJ4In0", ".", "c2lnbmF0dXJl"),
    "credential-assignment": forge("client_secret=", "Zk9q", "1234567890abcd"),
};

const scan = (text, source = "instructions") =>
    scanForSecrets({ source, text }, sha256Hex);

/* ------------------------------------------------------------- detections */

test("every rule has a sample that it finds", async () => {
    // Not a coverage ritual: a rule with no sample is a rule nobody has
    // confirmed still matches anything after an edit.
    for (const rule of ASSISTANT_PACKAGE_SECRET_RULES) {
        const sample = SAMPLES[rule.id];
        assert.ok(sample, `no sample for ${rule.id}`);
        const findings = await scan(`Here it is: ${sample}`);
        assert.ok(
            findings.some((finding) => finding.ruleId === rule.id),
            `${rule.id} did not match its own sample`
        );
    }
});

test("ordinary prose produces nothing", async () => {
    const findings = await scan(
        "Review the diff, keep the summary under five lines, and cite file paths."
    );
    assert.deepEqual(findings, []);
});

test("a documentation placeholder is not reported", async () => {
    // A scanner that flags this teaches people to wave everything, which is
    // the failure A5's waiver is most exposed to.
    for (const line of [
        "API_KEY=your-key-here",
        "client_secret=<your-client-secret>",
        "password: changeme-please-now",
        "access_token={{ACCESS_TOKEN_GOES_HERE}}",
        "secret_key=${SECRET_KEY_FROM_ENVIRONMENT}",
    ]) {
        assert.deepEqual(await scan(line), [], `flagged: ${line}`);
    }
});

test("an Anthropic key is one finding, not one per overlapping rule", async () => {
    // The owner waves findings, so a credential that two rules both claim is a
    // credential that has to be waved twice to clear a single problem.
    const findings = await scan(SAMPLES["anthropic-key"]);
    assert.deepEqual(
        findings.map((finding) => finding.ruleId),
        ["anthropic-key"]
    );
});

/* --------------------------------------------------------- what it carries */

test("a finding carries a hash and a position, never the text", async () => {
    const sample = SAMPLES["aws-access-key-id"];
    const [finding] = await scan(`key ${sample} end`);
    assert.equal(finding.ruleId, "aws-access-key-id");
    assert.equal(finding.source, "instructions");
    assert.equal(finding.offset, 4);
    assert.equal(finding.matchDigest, await sha256Hex(sample));
    assert.deepEqual(Object.keys(finding).sort(), [
        "matchDigest",
        "offset",
        "ruleId",
        "source",
    ]);
    assert.ok(!JSON.stringify(finding).includes(sample));
});

test("the same credential twice is two findings the owner can wave apart", async () => {
    const sample = SAMPLES["github-token"];
    const findings = await scan(`${sample} and again ${sample}`);
    const mine = findings.filter((finding) => finding.ruleId === "github-token");
    assert.equal(mine.length, 2);
    assert.notEqual(mine[0].offset, mine[1].offset);
    assert.equal(mine[0].matchDigest, mine[1].matchDigest);
    assert.notEqual(findingKey(mine[0]), findingKey(mine[1]));
});

test("scanning twice gives the same result, so a shared lastIndex cannot leak", async () => {
    const text = `${SAMPLES["openai-key"]} then ${SAMPLES["google-api-key"]}`;
    assert.deepEqual(await scan(text), await scan(text));
});

test("the order is stable regardless of how the findings arrived", async () => {
    const findings = await scan(
        `${SAMPLES["stripe-key"]} ${SAMPLES["aws-access-key-id"]} ${SAMPLES["github-token"]}`
    );
    assert.deepEqual(sortFindings([...findings].reverse()), findings);
});

/* -------------------------------------------------------- the A5 comparison */

test("nothing found on the server is clear", () => {
    assert.deepEqual(
        compareSecretFindings({ serverFindings: [], clientOverrides: [] }),
        { outcome: "clear" }
    );
});

test("a finding the client waved is not a refusal", async () => {
    const serverFindings = await scan(SAMPLES["slack-token"]);
    assert.deepEqual(
        compareSecretFindings({ serverFindings, clientOverrides: serverFindings }),
        { outcome: "clear" }
    );
});

test("a finding the client did not wave is a refusal", async () => {
    const serverFindings = await scan(
        `${SAMPLES["slack-token"]} and ${SAMPLES["google-api-key"]}`
    );
    const clientOverrides = serverFindings.filter(
        (finding) => finding.ruleId === "slack-token"
    );
    const verdict = compareSecretFindings({ serverFindings, clientOverrides });
    assert.equal(verdict.outcome, "unwaived");
    assert.equal(verdict.unwaived.length, 1);
    assert.equal(verdict.unwaived[0].ruleId, "google-api-key");
});

test("a waiver naming something the server no longer finds is not a refusal", async () => {
    // What this describes is an owner who edited the instruction after waving
    // a finding inside it. Refusing here would make fixing the problem harder
    // than leaving it alone.
    const stale = await scan(SAMPLES["github-token"]);
    assert.deepEqual(
        compareSecretFindings({ serverFindings: [], clientOverrides: stale }),
        { outcome: "clear" }
    );
});

test("a waiver from a different field does not cover this one", async () => {
    const inInstructions = await scan(SAMPLES["github-token"], "instructions");
    const inKnowledge = await scan(SAMPLES["github-token"], "knowledge/a.md");
    const verdict = compareSecretFindings({
        serverFindings: inKnowledge,
        clientOverrides: inInstructions,
    });
    assert.equal(verdict.outcome, "unwaived");
});

/* -------------------------------------------------------------- the digest */

test("waving nothing is its own value, not an empty string", () => {
    assert.equal(secretOverrideFingerprint([]), "none");
});

test("the fingerprint does not depend on the order sent", async () => {
    const findings = await scan(
        `${SAMPLES["stripe-key"]} ${SAMPLES["aws-access-key-id"]}`
    );
    assert.equal(
        secretOverrideFingerprint(findings),
        secretOverrideFingerprint([...findings].reverse())
    );
});

test("waving one more finding changes the fingerprint", async () => {
    const findings = await scan(
        `${SAMPLES["stripe-key"]} ${SAMPLES["aws-access-key-id"]}`
    );
    assert.notEqual(
        secretOverrideFingerprint(findings),
        secretOverrideFingerprint(findings.slice(0, 1))
    );
});

test("no fingerprint contains a matched string", async () => {
    const findings = await scan(SAMPLES["openai-key"]);
    assert.ok(!secretOverrideFingerprint(findings).includes(SAMPLES["openai-key"]));
});

/* ------------------------------------------------------------------- URLs */

test("URLs are disclosed as hosts, deduplicated and sorted", () => {
    const result = collectUrlHosts(
        "See https://zeta.example/a and http://alpha.example/b and https://zeta.example/c"
    );
    assert.equal(result.count, 3);
    assert.deepEqual(result.hosts, ["alpha.example", "zeta.example"]);
});

test("a path or query string never reaches the disclosure", () => {
    const result = collectUrlHosts("https://example.com/download?token=abc123def456");
    assert.deepEqual(result.hosts, ["example.com"]);
});

test("credentials in the authority are stripped rather than republished", () => {
    const result = collectUrlHosts(
        forge("https://", "admin:", "hunter2hunter2@", "internal.example:8443/x")
    );
    assert.deepEqual(result.hosts, ["internal.example"]);
});

test("text with no URL discloses nothing", () => {
    assert.deepEqual(collectUrlHosts("No links here at all."), {
        count: 0,
        hosts: [],
    });
});
