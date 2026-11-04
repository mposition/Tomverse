import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { marketingLlmRequestBody } from "../lib/marketingLlmClientCore.ts";
import {
  SEO_AGENT_PROPOSAL_SCHEMA,
  applySeoProposal,
  diagnoseSeoAnswer,
  redactSeoLogText,
} from "../lib/marketingSeoAgentCore.ts";

/**
 * Why a proposal is `unreadable`, in the run log (operator decision 2026-11-04).
 *
 * The refusal itself stays `applySeoProposal`'s; this only names the cause, and
 * the proposal call now asks the provider for the schema it is read with.
 */

const files = { "lib/seo.ts": "export const A = 1;\n", "components/seo/StructuredData.tsx": null, "app/sitemap.ts": null, "app/llms.txt/route.ts": null };
const valid = JSON.stringify({ summary: "Tidy", edits: [{ path: "lib/seo.ts", find: "A = 1", replace: "A = 2" }] });

test("a readable answer has no diagnosis, a fenced one is still readable", () => {
  assert.equal(diagnoseSeoAnswer(valid), null);
  assert.equal(diagnoseSeoAnswer("```json\n" + valid + "\n```"), null);
});

test("every answer the reader calls unreadable gets a diagnosis, and none the reader accepts does", () => {
  const answers = [
    "",
    "   ",
    "not json",
    "Here is the change:\n" + valid,
    valid + "\nHope this helps.",
    valid.slice(0, 40),
    "[]",
    "{}",
    JSON.stringify({ summary: "", edits: [] }),
    JSON.stringify({ summary: "x", edits: [{ path: "lib/seo.ts", find: "A = 1", replace: "A = 2", extra: 1 }] }),
    JSON.stringify({ summary: "x", edits: [{ path: "lib/seo.ts", find: "A = 1", replace: "y".repeat(8001) }] }),
    valid,
    "```json\n" + valid + "\n```",
  ];
  for (const answer of answers) {
    const unreadable = applySeoProposal(answer, files).refusal === "unreadable";
    assert.equal(diagnoseSeoAnswer(answer) !== null, unreadable, JSON.stringify(answer.slice(0, 60)));
  }
});

test("the diagnosis names the kind, the length and the first issue", () => {
  assert.equal(diagnoseSeoAnswer("").kind, "empty");
  assert.equal(diagnoseSeoAnswer("").length, 0);

  const prose = diagnoseSeoAnswer("Here is the change:\n" + valid);
  assert.equal(prose.kind, "not_json");
  assert.match(prose.issueMessage, /\S/);
  assert.equal(prose.head.startsWith("Here is the change:"), true);

  const cutOff = diagnoseSeoAnswer(valid.slice(0, valid.length - 5));
  assert.equal(cutOff.kind, "not_json");
  assert.equal(cutOff.length, valid.length - 5);

  const tooLong = diagnoseSeoAnswer(
    JSON.stringify({ summary: "x", edits: [{ path: "lib/seo.ts", find: "A = 1", replace: "y".repeat(8001) }] }),
  );
  assert.equal(tooLong.kind, "schema");
  assert.equal(tooLong.issuePath, "edits.0.replace");

  const stray = diagnoseSeoAnswer(JSON.stringify({ summary: "x", edits: [], note: "n" }));
  assert.equal(stray.kind, "schema");

  assert.equal(diagnoseSeoAnswer("```json\n{bad}\n```").fenced, true);
  assert.equal(diagnoseSeoAnswer("{bad}").fenced, false);
});

test("the head is at most 300 characters, the tail 100, and the tail only when there is more", () => {
  const long = "x ".repeat(400);
  const diagnosis = diagnoseSeoAnswer(long);
  assert.equal(diagnosis.head.length <= 300, true);
  assert.equal(diagnosis.tail.length <= 100, true);
  assert.equal(diagnosis.length, 800);
  assert.equal(diagnoseSeoAnswer("short answer").tail, null);
});

test("anything shaped like a credential is replaced before it is logged", () => {
  // Assembled at run time: spelled out whole, these fakes read as real
  // credentials to the repository's secret scan.
  const body = "abcdefghijklmnopqrstuvwxyz0123456789";
  const secrets = [
    ["sk", "proj", body].join("-"),
    ["ghp", body].join("_"),
    ["github", "pat", "11ABCDEFG0abcdefghijklmnop"].join("_"),
    ["AKIA", "ABCDEFGHIJKLMNOP"].join(""),
    ["xoxb", "123456789012", "abcdefghijkl"].join("-"),
    "Bearer abc.def.ghi-123",
    "0123456789abcdef".repeat(3),
    ["-----BEGIN PRIVATE", "KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE", "KEY-----"].join(" "),
  ];
  for (const secret of secrets) {
    const redacted = redactSeoLogText(`before ${secret} after`);
    assert.equal(redacted.includes(secret), false, secret);
    assert.match(redacted, /^before .*redacted.* after$|^before \[redacted\]/s, secret);
    // ...in the parser's own complaint and the head and the tail alike.
    const diagnosis = diagnoseSeoAnswer(`${secret} ${"z ".repeat(300)} ${secret}`);
    const logged = JSON.stringify(diagnosis);
    assert.equal(logged.includes(secret), false, secret);
  }
  assert.equal(redactSeoLogText("export const A = 1;"), "export const A = 1;");
});

test("the proposal call asks for the schema the answer is read with", () => {
  const body = marketingLlmRequestBody({ model: "m", maxOutputTokens: 100 }, [], SEO_AGENT_PROPOSAL_SCHEMA);
  assert.equal(body.response_format.type, "json_schema");
  assert.equal(body.response_format.json_schema.strict, true);

  // Strict Structured Outputs: every object closed, every property required, no length keywords.
  const walk = (node, path) => {
    if (node && typeof node === "object" && node.type === "object") {
      assert.equal(node.additionalProperties, false, path);
      assert.deepEqual([...node.required].sort(), Object.keys(node.properties).sort(), path);
      for (const [key, child] of Object.entries(node.properties)) walk(child, `${path}.${key}`);
    }
    if (node && typeof node === "object" && node.type === "array") walk(node.items, `${path}[]`);
    for (const unsupported of ["minLength", "maxLength", "minItems", "maxItems", "pattern", "format"]) {
      assert.equal(node && Object.hasOwn(node, unsupported), false, `${path} uses ${unsupported}`);
    }
  };
  walk(SEO_AGENT_PROPOSAL_SCHEMA.schema, "$");

  // The schema's keys are the reader's keys: a model that follows it is read.
  const properties = SEO_AGENT_PROPOSAL_SCHEMA.schema.properties;
  assert.deepEqual(Object.keys(properties).sort(), Object.keys(JSON.parse(valid)).sort());
  assert.deepEqual(
    Object.keys(properties.edits.items.properties).sort(),
    Object.keys(JSON.parse(valid).edits[0]).sort(),
  );
});

test("the runner sends the schema with the paid call and logs the diagnosis", () => {
  const script = readFileSync("scripts/marketing-seo-agent.mjs", "utf8");
  assert.match(script, /purpose: "seo", messages, answerSchema: SEO_AGENT_PROPOSAL_SCHEMA/);
  assert.match(script, /event: "marketing_seo_agent_proposal_unreadable"/);
  assert.ok(
    script.indexOf("diagnoseSeoAnswer(outcome.content)") < script.indexOf("return outcome;"),
    "the diagnosis is logged before the answer goes on",
  );
});
