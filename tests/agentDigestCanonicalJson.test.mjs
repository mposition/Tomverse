import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  AgentDigestCanonicalJsonError,
  agentDigestCanonicalBytes,
  agentDigestCanonicalJson,
} from "../lib/agentDigestCanonicalJson.ts";

test("RFC 8785 string and literal vector", () => {
  // From RFC 8785 section 3.2.3, without the non-integer numbers this contract does not admit.
  const input = JSON.parse(
    '{"string":"\\u20ac$\\u000F\\u000aA\'\\u0042\\u0022\\u005c\\\\\\"\\/","literals":[null,true,false]}',
  );
  assert.equal(
    agentDigestCanonicalJson(input),
    '{"literals":[null,true,false],"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}',
  );
});

test("keys sort by UTF-16 code unit, where code point order would differ", () => {
  // RFC 8785 section 3.2.3 sorting vector: the emoji's high surrogate (U+D83D)
  // sorts before U+FB33 by code unit, although its code point (U+1F600) is larger.
  const input = {
    "€": "Euro Sign",
    "\r": "Carriage Return",
    "דּ": "Hebrew Letter Dalet With Dagesh",
    1: "One",
    "😀": "Emoji: Grinning Face",
    "\u0080": "Control",
    "ö": "Latin Small Letter O With Diaeresis",
  };
  // Compared as text: parsing back would let JavaScript list the integer-like key "1" first.
  const text = agentDigestCanonicalJson(input);
  const order = ["\\r", '"1"', "\u0080", "ö", "€", "😀", "דּ"].map((key) => text.indexOf(key));
  assert.ok(order.every((at) => at >= 0), JSON.stringify(order));
  assert.deepEqual(order, [...order].sort((a, b) => a - b), text);
});

test("no Unicode normalization: NFC and NFD keys stay distinct", () => {
  const nfc = "é";
  const nfd = "é";
  const text = agentDigestCanonicalJson({ [nfc]: 1, [nfd]: 2 });
  assert.equal(Object.keys(JSON.parse(text)).length, 2);
  assert.notEqual(agentDigestCanonicalJson({ k: nfc }), agentDigestCanonicalJson({ k: nfd }));
});

test("numbers outside the safe-integer domain are refused", () => {
  for (const bad of [2 ** 53, -(2 ** 53), 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => agentDigestCanonicalJson({ n: bad }), AgentDigestCanonicalJsonError, String(bad));
  }
  assert.equal(agentDigestCanonicalJson({ n: 2 ** 53 - 1 }), '{"n":9007199254740991}');
  assert.equal(agentDigestCanonicalJson({ n: -0 }), '{"n":0}');
});

test("a lone surrogate is an error, never replaced", () => {
  for (const bad of ["\ud800", "a\udc00b", "\ud83d"]) {
    assert.throws(() => agentDigestCanonicalJson({ s: bad }), /lone_surrogate/, JSON.stringify(bad));
    assert.throws(() => agentDigestCanonicalJson({ [bad]: 1 }), /lone_surrogate/);
  }
  assert.doesNotThrow(() => agentDigestCanonicalJson({ s: "😀" }));
});

test("non-JSON values are refused", () => {
  for (const bad of [undefined, () => 1, Symbol("x"), 1n, new Date(0), new Map()]) {
    assert.throws(() => agentDigestCanonicalJson({ v: bad }), AgentDigestCanonicalJsonError);
  }
});

test("a sparse array is refused rather than read as shorter or printed as invalid JSON", () => {
  for (const bad of [Array(1), Array(2), [1, , 2]]) {
    assert.throws(() => agentDigestCanonicalJson({ a: bad }), /sparse_array/, String(bad.length));
  }
  assert.throws(() => agentDigestCanonicalJson([undefined]), AgentDigestCanonicalJsonError);
  assert.equal(agentDigestCanonicalJson([null, 1]), "[null,1]");
});

test("canonical text is independent of key insertion order and has no whitespace", () => {
  assert.equal(agentDigestCanonicalJson({ b: [1, { d: 2, c: 3 }], a: true }), '{"a":true,"b":[1,{"c":3,"d":2}]}');
  assert.equal(
    agentDigestCanonicalJson({ a: true, b: [1, { c: 3, d: 2 }] }),
    agentDigestCanonicalJson({ b: [1, { d: 2, c: 3 }], a: true }),
  );
});

test("size and hash are computed from the UTF-8 bytes of the canonical text", () => {
  const value = { z: "€", a: 1 };
  const { sizeBytes, payloadSha256 } = agentDigestCanonicalBytes(value);
  const text = '{"a":1,"z":"€"}';
  assert.equal(sizeBytes, Buffer.byteLength(text, "utf8"));
  assert.equal(payloadSha256, createHash("sha256").update(text, "utf8").digest("hex"));
  assert.match(payloadSha256, /^[0-9a-f]{64}$/);
});

test("a value read back through jsonb-style normalisation can differ -- so stored rows are never re-hashed", () => {
  // jsonb drops duplicate keys keeping the last and reorders keys by length then
  // bytes; a re-serialized read-back is not the canonical text in general. The
  // store therefore hashes only the received value, once.
  const received = { bb: 1, a: 2 };
  const jsonbStyle = '{"a": 2, "bb": 1}';
  assert.notEqual(jsonbStyle, agentDigestCanonicalJson(received));
});
