import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  PIPELINE_STALE_REFUSAL_CODE,
  RECORD_REFUSED,
  RECORD_SIGNABLE,
  RECORD_STALE,
  summariseMarketingWebhookRecordSignability,
} from "../scripts/report-marketing-webhook-record-signability-core.mjs";

/**
 * The signability report (S2 plan, S2e-verification).
 *
 * Its whole value is agreeing with the production console, so the thing these
 * assertions hold is that the report does not own the rule: the verdict is a
 * function of the refusal code the signing route produced, and of nothing else.
 * A copy of the fingerprint comparison here would be a report that can say
 * "signable" about a record the console refuses.
 */

const SCRIPT = "scripts/report-marketing-webhook-record-signability.mjs";

const summarise = (records) =>
  summariseMarketingWebhookRecordSignability({ buildFingerprint: "build-fp", records });

test("an accepted record is signable and a stale one is stale", () => {
  const summary = summarise([
    { recordId: "2026-10-09__a", declaredFingerprint: "build-fp", refusalCode: null },
    {
      recordId: "2026-10-08__b",
      declaredFingerprint: "older-fp",
      refusalCode: PIPELINE_STALE_REFUSAL_CODE,
      refusalMessage: "stale",
    },
  ]);
  assert.deepEqual(summary.signableRecordIds, ["2026-10-09__a"]);
  assert.deepEqual(summary.staleRecordIds, ["2026-10-08__b"]);
  assert.deepEqual(
    summary.records.map((record) => record.verdict),
    [RECORD_SIGNABLE, RECORD_STALE],
  );
  assert.deepEqual(summary.refusedRecordIds, []);
  assert.equal(summary.verdict, "signable");
});

test("the verdict reads the refusal code, never the declared fingerprint", () => {
  // The case that matters: a record whose declared fingerprint differs from the
  // build's, which the route nevertheless accepted. Only the route decides, so
  // this is signable. A report that compared the two strings itself would call
  // it stale and contradict the console.
  const summary = summarise([
    { recordId: "2026-10-09__accepted", declaredFingerprint: "other-fp", refusalCode: null },
  ]);
  assert.equal(summary.records[0].verdict, RECORD_SIGNABLE);
  assert.equal(summary.verdict, "signable");
  assert.equal(
    summary.records[0].declaredFingerprint,
    "other-fp",
    "the declared fingerprint is reported, so a reader can see which build it belongs to",
  );
});

test("two records with the same refusal get the same verdict whatever they declare", () => {
  const [first, second] = summarise([
    { recordId: "2026-10-01__x", declaredFingerprint: "aaa", refusalCode: "record_invalid" },
    { recordId: "2026-10-02__y", declaredFingerprint: "bbb", refusalCode: "record_invalid" },
  ]).records;
  assert.equal(first.verdict, RECORD_REFUSED);
  assert.equal(second.verdict, RECORD_REFUSED);
});

test("a refusal that is not staleness is reported as its own kind", () => {
  // `record_not_found` and `record_invalid` are different problems from a record
  // made against another build, and a re-run of the staging exercise is not
  // their answer. Folding them into "stale" would send the operator to do the
  // wrong work.
  const summary = summarise([
    { recordId: "2026-10-09__gone", declaredFingerprint: null, refusalCode: "record_not_found" },
  ]);
  assert.deepEqual(summary.staleRecordIds, []);
  assert.deepEqual(summary.refusedRecordIds, ["2026-10-09__gone"]);
  assert.equal(summary.verdict, "none_signable");
});

test("no records is not the same answer as nothing signable", () => {
  assert.equal(summarise([]).verdict, "no_records");
  assert.equal(
    summarise([{ recordId: "2026-10-08__b", refusalCode: PIPELINE_STALE_REFUSAL_CODE }]).verdict,
    "none_signable",
  );
});

test("a record that does not state a refusal code is refused, not read as signable", () => {
  // Review finding, 2026-10-10 (copilot/moonshot, nit): an absent key read as
  // "accepted" is the one wrong answer this report must not give -- it would
  // print "signable" for a record nobody judged.
  assert.throws(
    () => summarise([{ recordId: "2026-10-09__unjudged" }]),
    /does not state a refusalCode/,
  );
  // Review finding, 2026-10-10 round 2 (codex and copilot, independently): the
  // first version of this check read the key and then coalesced, so a stated
  // `undefined` passed `"refusalCode" in record` and became "accepted". The
  // value is what has to say something.
  assert.throws(
    () => summarise([{ recordId: "2026-10-09__stated-undefined", refusalCode: undefined }]),
    /does not state a refusalCode/,
  );
  // Neither does anything that is not a code: a verdict may only come from the
  // route's own two answers.
  for (const notACode of [0, false, {}, []]) {
    assert.throws(
      () => summarise([{ recordId: "2026-10-09__wrong-type", refusalCode: notACode }]),
      /does not state a refusalCode/,
      `expected ${JSON.stringify(notACode)} to be refused as a refusal code`,
    );
  }
  // Stated as null is a different thing: that is the route accepting it.
  assert.equal(
    summarise([{ recordId: "2026-10-09__ok", refusalCode: null }]).verdict,
    "signable",
  );
});

test("the display parse normalises the way the route does", () => {
  // Review finding, 2026-10-10 (cursor, minor): the route parses through
  // canonicalMarketingWebhookFileText, which strips a byte-order mark and
  // normalises CRLF. Parsing the raw bytes for display would blank the
  // fingerprint line on records the route accepts -- exactly the line that says
  // which build a stale record belongs to. So: one parse, through that function.
  const source = readFileSync(SCRIPT, "utf8");
  const parses = [...source.matchAll(/JSON\.parse\(/g)];
  assert.equal(parses.length, 1, "one place turns record bytes into an object");
  assert.match(source, /JSON\.parse\(canonicalMarketingWebhookFileText\(/);
});

test("an absent declared fingerprint is null, not the build's", () => {
  // Reporting the build's fingerprint for a record that does not state one
  // would make an unreadable record look like a current one.
  const [record] = summarise([
    { recordId: "2026-10-09__bad", refusalCode: "record_invalid" },
  ]).records;
  assert.equal(record.declaredFingerprint, null);
});

test("the script asks the signing route's own check", () => {
  // The report predicts the console, so it has to call what the console calls.
  // Anchored to the import, not to a word anywhere in the file.
  const source = readFileSync(SCRIPT, "utf8");
  const imports = source.matchAll(
    /import\s*\{([^}]*)\}\s*from\s*"(\.\.\/lib\/marketingWebhookVerification\.ts)"/g,
  );
  const named = [...imports].flatMap(([, names]) =>
    names.split(",").map((name) => name.trim()),
  );
  assert.ok(
    named.includes("checkMarketingWebhookRecordForSigning"),
    `expected the script to import the route's check, found ${JSON.stringify(named)}`,
  );
  assert.ok(
    named.includes("readMarketingWebhookVerificationRecordFile"),
    "the record must be read the way the route reads it, from the deployed tree",
  );
});

test("the script's directory and id rules come from the module, not from itself", () => {
  // A second copy of the directory path or the id pattern would drift from the
  // route and report on files the route cannot be asked about.
  const source = readFileSync(SCRIPT, "utf8");
  assert.ok(source.includes("MARKETING_WEBHOOK_VERIFICATION_RECORD_DIR"));
  assert.ok(source.includes("MARKETING_WEBHOOK_RECORD_ID_PATTERN"));
  assert.doesNotMatch(
    source,
    /"docs\/ops\/marketing-webhook-verification-records/,
    "the directory is imported, never written again as a literal",
  );
});

test("the report writes nothing and calls nothing", () => {
  const source = readFileSync(SCRIPT, "utf8");
  for (const forbidden of [
    "writeFileSync",
    "writeFile",
    "fetch(",
    "spawnSync",
    "execSync",
    "ZERNIO",
    "SECRET",
  ]) {
    assert.ok(
      !source.includes(forbidden),
      `a read-only report must not contain ${forbidden}`,
    );
  }
});
