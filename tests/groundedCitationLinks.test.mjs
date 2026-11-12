import assert from "node:assert/strict";
import test from "node:test";
import { fromMarkdown } from "mdast-util-from-markdown";
import { createGroundedCitationPacket, createGroundedCitationStream } from "../lib/groundedCitationLinks.ts";

const pdf = "https://official.example/2026/02/18/rules_(final).pdf#page=62";
const mission = "https://official.example/mission?id=1977-084A&tab=dates";
const row = { title: "Official rules", url: pdf, snippet: "See rule 9.", publishedAt: "2026-02-18" };
const other = { title: "Mission", url: mission, snippet: JSON.stringify(row) };

test("source handles preserve every returned record, even different extracts from the same URL", () => {
  const later = { ...row, snippet: "Rule 9.2", publishedAt: "2026-02-19" };
  for (const packet of [
    { results: [row, other, later] },
    { searches: [{ results: [row, other] }, { results: [later] }, { status: "failed" }] },
    { searches: [{ sourceIds: ["S1", "S2", "S3"] }], sources: { S1: row, S2: other, S3: later } },
  ]) {
    const labeled = createGroundedCitationPacket(JSON.stringify(packet));
    assert.deepEqual(labeled.urls, [pdf, mission]);
    const handles = [];
    const original = JSON.parse(labeled.json, (_key, value) => {
      if (value?.R1 || value?.R2) {
        const [id] = Object.keys(value);
        handles.push(id);
        return value[id];
      }
      return value;
    });
    assert.deepEqual(original, packet);
    assert.deepEqual(handles, ["R1", "R2", "R1"]);
  }
  assert.equal(createGroundedCitationPacket("invalid"), undefined);
  assert.equal(createGroundedCitationPacket(JSON.stringify({ results: [{ title: "x", url: "/relative" }] })), undefined);
});

test("streamed source markers yield the exact clicked URL and correct original byte count at every split", () => {
  const raw = "관측 📄 [[cite:R1]], NASA [[cite:R2]]. 다시 [[cite:R1]]. 끝 [[ci";
  const expected = "관측 📄 [1](<" + pdf + ">), NASA [2](<" + mission + ">). 다시 (1). 끝 [[ci";
  for (let split = 0; split <= raw.length; split++) {
    const stream = createGroundedCitationStream([pdf, mission]);
    const first = stream.write(raw.slice(0, split));
    assert.equal(Buffer.byteLength(first) + stream.providerByteAdjustment, Buffer.byteLength(raw.slice(0, split)));
    const rest = stream.write(raw.slice(split)) + stream.finish();
    assert.equal(first + rest, expected);
    assert.equal(Buffer.byteLength(expected) + stream.providerByteAdjustment, Buffer.byteLength(raw));
    assert.equal(stream.finish(), "");
  }
  const hrefs = fromMarkdown(expected).children[0].children.filter(node => node.type === "link").map(node => node.url);
  assert.deepEqual(hrefs, [pdf, mission]);
});

test("markers in code and unknown or escaped references cannot select a source", () => {
  const marker = "[[cite:R1]]";
  const literal = ["`" + marker + "`", "~~~txt", marker, "~~~",
    "````md", "```", marker, "````", "> ~~~", "> " + marker, "> ~~~",
    "", "    " + marker, "\t" + marker, "", "\\" + marker, "[[cite:R99]]"].join("\n");
  const stream = createGroundedCitationStream([pdf]);
  const text = literal + "\n!" + marker;
  const result = [...text].map(c => stream.write(c)).join("") + stream.finish();
  assert.equal(result, literal + "\n! [1](<" + pdf + ">)");
  assert.ok(!JSON.stringify(fromMarkdown(result)).includes('"type":"image"'));
});

const ruleFile = "e6815ecc-06d9-4f0b-98e9-4c441cf5e6a3/2026-02-18_World-Aquatics_CR-Final.pdf#page=62";
const officialRules = "https://resources.fina.org/fina/document/2026/02/18/" + ruleFile;
const typedRules = officialRules.replace("/2026/02/18/", "/2026-02-18/");

test("an otherwise exact bare PDF URL recovers the supplied date directories across every chunk boundary", () => {
  for (const suffix of ["", " [[cite:R1]]"]) {
    const raw = "규정 링크\n" + typedRules + suffix;
    const expected = "규정 링크\n" + officialRules + (suffix ? " [1](<" + officialRules + ">)" : "");
    for (let split = 0; split <= raw.length; split++) {
      const stream = createGroundedCitationStream([officialRules]);
      const first = stream.write(raw.slice(0, split));
      assert.equal(Buffer.byteLength(first) + stream.providerByteAdjustment, Buffer.byteLength(raw.slice(0, split)));
      const output = first + stream.write(raw.slice(split)) + stream.finish();
      assert.equal(output, expected);
      assert.equal(Buffer.byteLength(output) + stream.providerByteAdjustment, Buffer.byteLength(raw));
      assert.equal(stream.finish(), "");
    }
  }
});

test("literal PDF repair preserves different resources, supplied alternate URLs, page variants and code", () => {
  const examples = [
    typedRules.replace("resources.fina.org", "example.org"),
    typedRules.replace("e6815ecc", "a6815ecc"),
    typedRules.replace("CR-Final", "CR-Revised"),
    typedRules.replace("#page=62", ""),
    typedRules.replace("#page=62", "#page=61"),
    typedRules + "9", typedRules + "?x=1", typedRules + "/other",
    "https://other.example/?u=" + typedRules, "`" + typedRules + "`",
    "~~~txt\n" + typedRules + "\n~~~", "    " + typedRules, officialRules,
  ].join("\n");
  function byCharacter(urls, raw) {
    const stream = createGroundedCitationStream(urls);
    return [...raw].map(ch => stream.write(ch)).join("") + stream.finish();
  }
  assert.equal(byCharacter([officialRules], examples), examples);
  assert.equal(byCharacter([mission], typedRules), typedRules);
  assert.equal(byCharacter([officialRules, typedRules], typedRules), typedRules);
  const unanchored = officialRules.replace("#page=62", "");
  assert.equal(byCharacter([unanchored], typedRules), typedRules);
  assert.equal(byCharacter([unanchored, officialRules], typedRules), officialRules);
});
