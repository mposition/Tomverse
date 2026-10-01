import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { runInNewContext } from "node:vm";
import * as canonical from "../lib/memoryEvalVnext/protocol/canonicalJson.ts";
import * as wire from "../lib/memoryEvalVnext/protocol/wire.ts";
import * as signatures from "../lib/memoryEvalVnext/protocol/signatures.ts";
import * as trust from "../lib/memoryEvalVnext/protocol/trust.ts";

// Q + the separate approval receipt govern this component-only subset.
// F40/F42/F43/F44 are external repository audits, not fabricated unit passes.
// The only file read here is this public, non-operational test fixture.
const fixtureBytes = readFileSync(new URL("./fixtures/memory-eval-vnext/wire-vectors.json", import.meta.url));
const fixtures = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(fixtureBytes));
const bytes = (text) => Buffer.from(text, "utf8");
const sha = (value) => createHash("sha256").update(value).digest("hex");
const clone = (value) => structuredClone(value);
const registered = new Set();
const completed = new Set();
function scenario(id, title, fn) {
  assert.equal(registered.has(id), false, `duplicate ${id}`);
  registered.add(id);
  test(`${id}: ${title}`, async (t) => {
    await fn(t);
    completed.add(id);
  });
}
function value(result) {
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.scope, "offline_component_only");
  assert.equal(result.authorityEstablished, false);
  return result.value;
}
function error(result, expected = "invalid_input") {
  assert.deepEqual(result, { ok: false, error: expected });
}
function match(result) {
  assert.deepEqual(value(result), {
    scope: "offline_component_only", authorityEstablished: false, fieldsMatch: true,
  });
}
const canonicalBytes = (input) => Buffer.from(value(canonical.encodeCanonical(input)));
const publicVector = fixtures.publicEd25519[0];
const publicKeyBase64 = Buffer.from(publicVector.publicKeyHex, "hex").toString("base64");
const blob = {
  path: "fixtures/public-registration.txt",
  byteLength: fixtures.publicOpaqueBytes.registration.byteLength,
  rawSha256: fixtures.publicOpaqueBytes.registration.rawSha256,
};
const payload = {
  schemaVersion: 1, purpose: "s2_activation_approval", signerId: "synthetic-approver",
  keyId: "a".repeat(32), trustEpoch: "opaque-epoch-A", contentDigest: "b".repeat(64),
  issuedAt: "2026-09-08T00:00:00Z",
};
// Shape-only signature: the RFC signature is NOT a signature of this payload.
const receipt = { payload, signatureBase64: Buffer.from(publicVector.signatureHex, "hex").toString("base64") };
const anchor = {
  trustEpoch: payload.trustEpoch, signerId: payload.signerId, keyId: payload.keyId,
  publicKeyBase64, roles: ["approver", "importer"],
  validFrom: "2026-09-07T00:00:00Z", validUntil: null, revokedAt: null,
  registrationReceipt: blob, previousEpochDigest: null,
};
const expected = (p = payload, a = anchor) => ({
  purpose: p.purpose, signerId: p.signerId, keyId: p.keyId,
  trustEpoch: p.trustEpoch, contentDigest: p.contentDigest,
  previousEpochDigest: a.previousEpochDigest,
});
const binding = (p = payload, a = anchor, e = expected(), at = payload.issuedAt) =>
  trust.compareTrustBinding(p, a, e, at);
const gitRef = (name) => ({ commit: (name === "D" ? "d" : "e").repeat(40),
  path: `fixtures/synthetic-${name}.txt`, rawSha256: fixtures.publicOpaqueBytes[name].rawSha256 });

// OS-F3: KeyObjects live only in the synchronous test callback. Only the public
// key is exported; no seed/private-key encoding, persistence, logging or signer
// exported from a runtime module. These signatures convey no operational trust.
function withSynthetic(purpose, fn) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ type: "spki", format: "der" });
  assert.equal(spki.subarray(0, -32).toString("hex"), "302a300506032b6570032100");
  const key = spki.subarray(-32).toString("base64");
  const p = { ...payload, purpose };
  const message = Buffer.from(value(signatures.signatureMessage(p)));
  const r = { payload: p, signatureBase64: sign(null, message, privateKey).toString("base64") };
  fn({ p, r, key, message, signTestBytes: (input) => sign(null, input, privateKey).toString("base64") });
}

scenario("F01", "ASCII object ordering and exact G01/G02 bytes", () => {
  for (const g of fixtures.goldenCanonical.slice(0, 2)) {
    const reversed = Object.fromEntries(Object.entries(JSON.parse(g.canonicalText)).reverse());
    const out = canonicalBytes(reversed);
    assert.equal(out.toString(), g.canonicalText);
    assert.equal(out.toString("hex"), g.utf8Hex);
    assert.equal(out.length, g.byteLength);
    assert.deepEqual(value(canonical.decodeCanonical(out)), reversed);
  }
  assert.equal(canonicalBytes({ "2": 2, "10": 10 }).toString(), '{"10":10,"2":2}');
  const special = JSON.parse('{"__proto__":{"a":1},"constructor":2}');
  assert.deepEqual(value(canonical.decodeCanonical(canonicalBytes(special))), special);
  assert.equal(Object.hasOwn({}, "a"), false);
  const controls = String.fromCharCode(...Array.from({ length: 32 }, (_, i) => i));
  assert.equal(canonicalBytes(controls).toString(), '"' + Array.from({ length: 32 }, (_, i) => "\\u" + i.toString(16).padStart(4, "0")).join("") + '"');
  const nullPrototype = Object.assign(Object.create(null), { a: 1 });
  assert.equal(canonicalBytes(nullPrototype).toString(), '{"a":1}');
});
scenario("F02", "safe integer boundaries and JavaScript negative zero", () => {
  const g = fixtures.goldenCanonical[2];
  assert.equal(canonicalBytes([null, true, false, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, -0]).toString("hex"), g.utf8Hex);
});
scenario("F03", "sequences keep order and duplicates", () => {
  const g = fixtures.goldenCanonical[3];
  assert.equal(canonicalBytes(["b", "a", "b"]).toString("hex"), g.utf8Hex);
  assert.deepEqual(value(canonical.decodeCanonical(bytes(g.canonicalText))), ["b", "a", "b"]);
});
scenario("F04", "NFD and non-ASCII keys are rejected without normalization", () => {
  for (const input of ["e\u0301", { "é": 1 }, { "한": 1 }, { "a\u2028": 1 }, { "a\u2029": 1 }]) {
    error(canonical.encodeCanonical(input));
    error(canonical.decodeCanonical(bytes(JSON.stringify(input))));
  }
});
scenario("F05", "duplicate keys are rejected before last-wins parsing", () => {
  for (const text of ['{"a":1,"a":2}', '{"a":1,"\\u0061":2}', '{"x":{"a":1,"a":1}}']) {
    error(canonical.decodeCanonical(bytes(text)));
  }
});
scenario("F06", "non-integers, non-finite and unsafe numbers are refused", () => {
  for (const input of [0.5, 9007199254740992, -9007199254740992, NaN, Infinity, -Infinity]) {
    error(canonical.encodeCanonical(input));
    error(canonical.decodeCanonical(bytes(String(input))));
  }
});
scenario("F07", "non-JSON values, accessors, custom prototypes and cycles", () => {
  let calls = 0;
  const accessor = Object.defineProperty({}, "x", { enumerable: true, get() { calls++; return 1; } });
  const cyclic = {}; cyclic.self = cyclic;
  const symbolKey = { [Symbol("key")]: 1 };
  const hidden = Object.defineProperty({}, "hidden", { value: 1 });
  const accessorArray = [0]; Object.defineProperty(accessorArray, "0", { get() { calls++; return 1; } });
  const extraArray = [1]; extraArray.extra = 2;
  for (const input of [undefined, 1n, () => 1, Symbol("x"), new Array(2), accessor,
    Object.create({ inherited: 1 }), cyclic, symbolKey, hidden, accessorArray, extraArray,
    new Date("2026-09-08T00:00:00Z"), new Number(1), { toJSON() { calls++; return 1; } }]) {
    error(canonical.encodeCanonical(input));
  }
  assert.equal(calls, 0);
  const shared = { a: 1 };
  assert.equal(canonicalBytes([shared, shared]).toString(), '[{"a":1},{"a":1}]');
});
scenario("F08", "strict UTF-8 and scalar strings without replacement", () => {
  for (const hex of ["c080", "eda080", "ff", "22c32822", "22f490808022"]) error(canonical.decodeCanonical(Buffer.from(hex, "hex")));
  for (const input of ["\ud800", "\udfff"]) {
    error(canonical.encodeCanonical(input));
    error(canonical.decodeCanonical(bytes(JSON.stringify(input))));
  }
  assert.equal(canonicalBytes("😀한\u007f").toString(), '"😀한\u007f"');
});
scenario("F09", "non-canonical spellings, ordering and tokens are refused", () => {
  for (const text of ['\ufeff{}', '{}{}', ' {}', '{} ', '{"b":1,"a":2}', '1.0', '1e0', '-0',
    '"\\n"', '"\\u000A"', '"\\/"', '"\\uD55C"', '[1,]', '{"a":}', '+1', '01', '', '"unfinished']) {
    error(canonical.decodeCanonical(bytes(text)));
  }
  error(canonical.decodeCanonical("{}"));
  error(canonical.rawSha256("{}"));
  error(canonical.domainSha256("bad\ndomain", {}));
  for (const suffix of ["\n", "\r", "\u2028", "\u2029"]) error(canonical.domainSha256("mem-signature-1" + suffix, {}));
});
scenario("F10", "raw, LF-file and domain hashes match independent goldens", () => {
  for (const g of fixtures.goldenCanonical) {
    const input = JSON.parse(g.canonicalText), raw = bytes(g.canonicalText);
    assert.equal(value(canonical.rawSha256(raw)), g.rawSha256);
    assert.equal(value(canonical.rawSha256(Buffer.concat([raw, bytes("\n")]))), g.fileWithLfSha256);
    assert.equal(value(canonical.domainSha256(g.testDomain, input)), g.domainSha256);
    assert.equal(new Set([g.rawSha256, g.fileWithLfSha256, g.domainSha256]).size, 3);
  }
  assert.notEqual(value(canonical.rawSha256(bytes("e\u0301"))), value(canonical.rawSha256(bytes("é"))));
});
scenario("F11", "file mode requires exactly one LF and never trims", () => {
  const text = fixtures.goldenCanonical[0].canonicalText;
  value(canonical.decodeCanonical(bytes(text)));
  value(canonical.decodeCanonical(bytes(text + "\n"), "file-with-single-lf"));
  for (const suffix of ["\n", "\n\n", "\r\n", " ", "\n "]) error(canonical.decodeCanonical(bytes(text + suffix)));
  for (const suffix of ["", "\n\n", "\r\n", " ", " \n"]) error(canonical.decodeCanonical(bytes(text + suffix), "file-with-single-lf"));
  error(canonical.decodeCanonical(bytes(text), "invented-mode"));
});
scenario("F12", "S3 signs domain-LF plus CJSON, not a digest", () => {
  const literal = '{"contentDigest":"' + "b".repeat(64) + '","issuedAt":"2026-09-08T00:00:00Z","keyId":"' + "a".repeat(32) + '","purpose":"s2_activation_approval","schemaVersion":1,"signerId":"synthetic-approver","trustEpoch":"opaque-epoch-A"}';
  const message = Buffer.from(value(signatures.signatureMessage(payload)));
  assert.deepEqual(message, bytes("mem-signature-1\n" + literal));
  assert.notDeepEqual(message, bytes(sha(message)));
});

const examples = { BlobRef: blob, GitFileRef: gitRef("D"), SignaturePayload: payload, SignatureReceipt: receipt, TrustAnchor: anchor };
scenario("F13", "five closed shapes return only structure-checked copies", () => {
  for (const [kind, input] of Object.entries(examples)) {
    const out = value(wire.checkWire(kind, input));
    assert.deepEqual(out, input);
    assert.notEqual(out, input);
  }
  error(wire.checkWire("InventedRecord", {}));
});
scenario("F14", "all required fields: omission, null, wrong type, extra and nesting", () => {
  function mutations(kind, base, check) {
    for (const field of fixtures.closedTypes[kind].required) {
      const missing = clone(base); delete missing[field]; error(check(missing));
      error(check({ ...clone(base), [field]: { wrong: true } }));
      if (fixtures.closedTypes[kind].nullable.includes(field)) value(check({ ...clone(base), [field]: null }));
      else error(check({ ...clone(base), [field]: null }));
    }
    error(check({ ...clone(base), unexpected: 1 }));
  }
  for (const [kind, input] of Object.entries(examples)) mutations(kind, input, (x) => wire.checkWire(kind, x));
  mutations("SignaturePayload", payload, (x) => wire.checkWire("SignatureReceipt", { ...receipt, payload: x }));
  mutations("BlobRef", blob, (x) => wire.checkWire("TrustAnchor", { ...anchor, registrationReceipt: x }));
  let calls = 0;
  const getter = Object.defineProperty({ ...payload }, "purpose", { get() { calls++; return payload.purpose; } });
  error(wire.checkWire("SignaturePayload", getter));
  assert.equal(calls, 0);
});
scenario("F15", "digest, commit, key ID and byte length leaf constraints", () => {
  for (const [kind, field, size] of [["BlobRef", "rawSha256", 64], ["GitFileRef", "commit", 40], ["SignaturePayload", "keyId", 32]]) {
    for (const bad of ["A".repeat(size), "a".repeat(size - 1), "a".repeat(size + 1), "g".repeat(size), ...["\n", "\r", "\u2028", "\u2029"].map((x) => "a".repeat(size) + x)]) {
      error(wire.checkWire(kind, { ...examples[kind], [field]: bad }));
    }
  }
  for (const bad of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, "1"]) error(wire.checkWire("BlobRef", { ...blob, byteLength: bad }));
  for (const good of [0, Number.MAX_SAFE_INTEGER]) value(wire.checkWire("BlobRef", { ...blob, byteLength: good }));
  for (const field of ["signerId", "trustEpoch", "purpose"]) {
    for (const bad of ["", "é", "e\u0301", "a\u2028", "a\u2029", 1]) error(wire.checkWire("SignaturePayload", { ...payload, [field]: bad }));
  }
  error(wire.checkWire("SignaturePayload", { ...payload, schemaVersion: 2 }));
});
scenario("F16", "UTC fields enforce calendar seconds-Z without reading a clock", () => {
  const fields = [["SignaturePayload", "issuedAt"], ...["validFrom", "validUntil", "revokedAt"].map((x) => ["TrustAnchor", x])];
  for (const [kind, field] of fields) {
    for (const suffix of ["\n", "\r", "\u2028", "\u2029"]) error(wire.checkWire(kind, { ...examples[kind], [field]: "2026-09-08T00:00:00Z" + suffix }));
    for (const good of ["2026-09-08T00:00:00Z", "2024-02-29T23:59:59Z", "2000-02-29T00:00:00Z"]) value(wire.checkWire(kind, { ...examples[kind], [field]: good }));
    for (const bad of ["2026-02-30T00:00:00Z", "2026-09-08T00:00:00+00:00", "2026-09-08T00:00:00.000Z", "2026-09-08T00:00Z", "2026-09-08T00:00:00z", "1900-02-29T00:00:00Z", "2026-13-01T00:00:00Z", "2026-01-00T00:00:00Z", "2026-01-01T24:00:00Z", "2026-01-01T00:60:00Z", "2026-01-01T00:00:60Z"]) error(wire.checkWire(kind, { ...examples[kind], [field]: bad }));
  }
});
scenario("F17", "both reference paths are relative POSIX paths", () => {
  for (const kind of ["BlobRef", "GitFileRef"]) {
    value(wire.checkWire(kind, { ...examples[kind], path: "fixtures/public.json" }));
    for (const path of ["/absolute", "C:/drive", "a\\b", "a//b", "./a", "a/../b", "", "a/", "C:relative", "a\0b"]) error(wire.checkWire(kind, { ...examples[kind], path }));
  }
});
scenario("F18", "Base64 is canonical padded encoding of exact key/signature lengths", () => {
  for (const [kind, field, size] of [["TrustAnchor", "publicKeyBase64", 32], ["SignatureReceipt", "signatureBase64", 64]]) {
    const good = Buffer.alloc(size, 255).toString("base64");
    value(wire.checkWire(kind, { ...examples[kind], [field]: good }));
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const last = good.indexOf("=") - 1;
    const padBits = good.slice(0, last) + chars[chars.indexOf(good[last]) + 1] + good.slice(last + 1);
    for (const bad of [good.replace(/=+$/, ""), good + "=", " " + good, good + "\n", good.replaceAll("/", "_"), good.replaceAll("/", "-"), padBits, Buffer.alloc(size - 1).toString("base64"), Buffer.alloc(size + 1).toString("base64")]) error(wire.checkWire(kind, { ...examples[kind], [field]: bad }));
  }
});
scenario("F19", "roles are a known sorted unique set, never an authority grant", () => {
  value(wire.checkWire("TrustAnchor", anchor)); match(binding());
  for (const roles of [["importer", "approver"], ["approver", "approver"], ["invented_role"]]) error(wire.checkWire("TrustAnchor", { ...anchor, roles }));
  const roles = ["approver", "authoring_reviewer", "controller", "custodian", "importer", "reviewer"];
  value(wire.checkWire("TrustAnchor", { ...anchor, roles }));
  error(binding(payload, { ...anchor, roles: [] }), "binding_mismatch");
});
scenario("F20", "RFC 8032 TEST 1/2/3 public vectors and tampering (OS-F2)", () => {
  assert.equal(fixtures.publicEd25519.length, 3);
  for (const g of fixtures.publicEd25519) {
    const message = Buffer.from(g.messageHex, "hex"), signature = Buffer.from(g.signatureHex, "hex"), key = Buffer.from(g.publicKeyHex, "hex").toString("base64");
    match(signatures.verifyPureEd25519(message, key, signature.toString("base64")));
    const mutated = Buffer.from(signature); mutated[0] ^= 1;
    error(signatures.verifyPureEd25519(message, key, mutated.toString("base64")), "signature_mismatch");
    error(signatures.verifyPureEd25519(Buffer.concat([message, Buffer.from([0])]), key, signature.toString("base64")), "signature_mismatch");
    error(signatures.verifyPureEd25519(message, key, signature.subarray(1).toString("base64")));
  }
});
scenario("F21", "volatile synthetic S3 positive signatures for all three purposes", () => {
  for (const { purpose } of fixtures.purposeRoles) withSynthetic(purpose, ({ p, r, key }) => match(signatures.verifySignatureReceipt(r, key, p)));
});
scenario("F22", "payload/signature/key mutations and deterministic error ordering", () => {
  withSynthetic(payload.purpose, ({ p, r, key }) => {
    const changes = { purpose: "s2_source_evidence", signerId: "different", keyId: "c".repeat(32), trustEpoch: "other-epoch", contentDigest: "c".repeat(64), issuedAt: "2026-09-08T00:00:01Z" };
    for (const [field, other] of Object.entries(changes)) {
      error(signatures.verifySignatureReceipt({ ...r, payload: { ...p, [field]: other } }, key, p), "signature_mismatch");
      error(signatures.verifySignatureReceipt(r, key, { ...p, [field]: other }), "binding_mismatch");
    }
    const sig = Buffer.from(r.signatureBase64, "base64"); sig[0] ^= 1;
    error(signatures.verifySignatureReceipt({ ...r, signatureBase64: sig.toString("base64") }, key, p), "signature_mismatch");
    error(signatures.verifySignatureReceipt(r, publicKeyBase64, p), "signature_mismatch");
    error(signatures.verifySignatureReceipt({ ...r, extra: true }, key, p));
    error(signatures.verifySignatureReceipt(r, "malformed", { ...p, purpose: "unknown_purpose" }));
    error(signatures.verifySignatureReceipt({ ...r, payload: { ...p, purpose: "unknown_purpose" } }, key, p), "unsupported_subset");
    error(signatures.verifySignatureReceipt(r, key, { ...p, unexpected: true }));
  });
});
scenario("F23", "framing, digest and prehash substitutions never verify as S3", () => {
  for (const g of fixtures.publicNonPureEd25519) {
    error(signatures.verifyPureEd25519(Buffer.from(g.messageHex, "hex"), Buffer.from(g.publicKeyHex, "hex").toString("base64"), Buffer.from(g.signatureHex, "hex").toString("base64")), "signature_mismatch");
  }
  withSynthetic(payload.purpose, ({ p, r, key, message, signTestBytes }) => {
    const body = canonicalBytes(p);
    const wrongMessages = [createHash("sha256").update(message).digest(), bytes(sha(message)), createHash("sha512").update(message).digest(), Buffer.concat([bytes("mem-signature-2\n"), body]), Buffer.concat([bytes("mem-signature-1"), body]), Buffer.concat([bytes("mem-signature-1\r\n"), body]), Buffer.concat([message, bytes("\n")])];
    for (const wrong of wrongMessages) {
      error(signatures.verifyPureEd25519(wrong, key, r.signatureBase64), "signature_mismatch");
      error(signatures.verifySignatureReceipt({ payload: p, signatureBase64: signTestBytes(wrong) }, key, p), "signature_mismatch");
    }
  });
});
scenario("F24", "receipt domain digest is not raw/file SHA or a self-digest", () => {
  const raw = canonicalBytes(receipt);
  const digest = value(signatures.signatureReceiptDigest(receipt));
  assert.equal(digest, sha(Buffer.concat([bytes("mem-signature-receipt-1\n"), raw])));
  assert.notEqual(digest, sha(raw)); assert.notEqual(digest, sha(Buffer.concat([raw, bytes("\n")])));
  error(signatures.signatureReceiptDigest({ ...receipt, signatureReceiptDigest: digest }));
});
scenario("F25", "three exact purpose/role pairs remain component-only", () => {
  for (const { purpose, role } of fixtures.purposeRoles) {
    const p = { ...payload, purpose }, a = { ...anchor, roles: [role] };
    match(binding(p, a, expected(p, a)));
  }
});
scenario("F26", "importer cannot substitute for the activation approver", () => {
  error(binding(payload, { ...anchor, roles: ["importer"] }), "binding_mismatch");
  withSynthetic(payload.purpose, ({ p, r, key }) => {
    match(signatures.verifySignatureReceipt(r, key, p));
    error(binding(p, { ...anchor, publicKeyBase64: key, roles: ["importer"] }), "binding_mismatch");
  });
});
scenario("F27", "other upstream purposes are unsupported, not redefined", () => {
  for (const purpose of ["provenance_checkpoint", "authoring_bundle", "unknown_purpose"]) {
    const p = { ...payload, purpose };
    value(wire.checkWire("SignaturePayload", p));
    error(signatures.signatureMessage(p), "unsupported_subset");
    error(signatures.signatureReceiptDigest({ ...receipt, payload: p }), "unsupported_subset");
    error(binding(p, anchor, expected(p)), "unsupported_subset");
  }
});
scenario("F28", "new D approver handle grammar is exact and role-specific", () => {
  for (const signerId of ["mposition", "a".repeat(39), "A-1"]) {
    const p = { ...payload, signerId }, a = { ...anchor, signerId }; match(binding(p, a, expected(p, a)));
  }
  for (const signerId of ["@mposition", "a".repeat(40), "-abc", "a_b", "mposition\n", "mposition\r", "mposition\u2028", "mposition\u2029"]) {
    const p = { ...payload, signerId }, a = { ...anchor, signerId }; error(binding(p, a, expected(p, a)));
  }
  const p = { ...payload, signerId: "Mposition" }, a = { ...anchor, signerId: "Mposition" };
  error(binding(p, a, { ...expected(p, a), signerId: "mposition" }), "binding_mismatch");
  const importer = { ...payload, purpose: "s2_source_evidence", signerId: "@synthetic" };
  match(binding(importer, { ...anchor, signerId: importer.signerId }, expected(importer)));
});
scenario("F29", "payload, anchor and explicit expected identity must all match", () => {
  for (const field of ["signerId", "keyId", "trustEpoch"]) {
    const other = field === "keyId" ? "f".repeat(32) : "other-value";
    error(binding({ ...payload, [field]: other }), "binding_mismatch");
    error(binding(payload, { ...anchor, [field]: other }), "binding_mismatch");
    error(binding(payload, anchor, { ...expected(), [field]: other }), "binding_mismatch");
  }
  for (const field of Object.keys(expected())) { const e = expected(); delete e[field]; error(binding(payload, anchor, e)); }
  error(binding(payload, anchor, { ...expected(), unexpected: true }));
  error(trust.compareTrustBinding(payload, anchor, expected()));
});
scenario("F30", "epoch is opaque and previous-null proves no first-epoch history", () => {
  const p = { ...payload, trustEpoch: "not-an-ordinal" }, a = { ...anchor, trustEpoch: p.trustEpoch };
  match(binding(p, a, expected(p, a)));
  const previous = "e".repeat(64), withPrevious = { ...a, previousEpochDigest: previous };
  match(binding(p, withPrevious, expected(p, withPrevious)));
  error(binding(p, withPrevious, expected(p, a)), "binding_mismatch");
  error(binding(p, a, { ...expected(p, a), previousEpochDigest: 0 }));
  error(trust.checkAuthorityAvailability(), "authority_unavailable");
});
scenario("F31", "explicit time checks only obvious outside/revoked bounds", () => {
  error(binding(payload, anchor, expected(), "2026-09-06T23:59:59Z"), "binding_mismatch");
  const a = { ...anchor, validUntil: "2026-09-08T01:00:00Z", revokedAt: "2026-09-08T00:30:00Z" };
  error(binding(payload, a, expected(), "2026-09-08T01:00:01Z"), "binding_mismatch");
  error(binding(payload, a, expected(), "2026-09-08T00:30:01Z"), "binding_mismatch");
  for (const [field, at] of [["validFrom", anchor.validFrom], ["validUntil", a.validUntil], ["revokedAt", a.revokedAt]]) {
    const boundaryAnchor = { ...anchor, [field]: at };
    error(binding(payload, boundaryAnchor, expected(), at), "authority_unavailable");
  }
  // A boundary in one field cannot hide an already-obvious refusal in another.
  error(binding(payload, a, expected(), a.validUntil), "binding_mismatch");
  match(binding(payload, a));
  error(binding(payload, { ...anchor, validUntil: "2026-09-06T00:00:00Z" }), "binding_mismatch");
});
scenario("F32", "registration bytes stay opaque and parsing is unsupported", () => {
  match(trust.compareBlobRef(blob, bytes(fixtures.publicOpaqueBytes.registration.text), blob));
  error(trust.compareBlobRef(blob, bytes("different"), blob), "bytes_mismatch");
  error(trust.compareBlobRef(blob, undefined, blob));
  for (const text of ['{"role":"invented"}', "not: [valid: yaml", "\u0000opaque\ufffd"]) {
    const raw = bytes(text), ref = { path: "fixtures/opaque", byteLength: raw.length, rawSha256: sha(raw) };
    match(trust.compareBlobRef(ref, raw, ref));
  }
  error(trust.checkRegistrationParsingAvailability(), "unsupported_subset");
});
scenario("F33", "policy/previous digests are syntax and equality only", () => {
  for (const compare of [trust.compareTrustPolicyDigest, trust.comparePreviousEpochDigest]) {
    match(compare("a".repeat(64), "a".repeat(64)));
    error(compare("a".repeat(64), "b".repeat(64)), "binding_mismatch");
    error(compare("A".repeat(64), "a".repeat(64)));
    error(compare(undefined, "a".repeat(64)));
  }
  match(trust.comparePreviousEpochDigest(null, null));
  error(trust.comparePreviousEpochDigest(null, "a".repeat(64)), "binding_mismatch");
  error(trust.compareTrustPolicyDigest(null, null));
  error(trust.checkAuthorityAvailability(), "authority_unavailable");
});
scenario("F34", "D/K reference plus raw bytes match only explicit caller facts", () => {
  for (const name of ["D", "K"]) match(trust.compareGitFileRef(gitRef(name), bytes(fixtures.publicOpaqueBytes[name].text), gitRef(name)));
});
scenario("F35", "D/K commit, path, hash and raw bytes cannot be substituted", () => {
  for (const name of ["D", "K"]) {
    const ref = gitRef(name), raw = bytes(fixtures.publicOpaqueBytes[name].text);
    for (const [field, other] of [["commit", "c".repeat(40)], ["path", "fixtures/different"], ["rawSha256", "c".repeat(64)]]) {
      error(trust.compareGitFileRef({ ...ref, [field]: other }, raw, ref), "binding_mismatch");
    }
    error(trust.compareGitFileRef(ref, bytes("different"), ref), "bytes_mismatch");
    error(trust.compareGitFileRef(ref, Buffer.concat([raw, bytes("\n")]), ref), "bytes_mismatch");
    error(trust.compareGitFileRef(ref, undefined, ref));
    error(trust.compareGitFileRef({ ...ref, path: "../bad" }, bytes("different"), ref));
  }
});
scenario("F36", "synthetic Git equality establishes no Git existence or approval", () => {
  const ref = { ...gitRef("D"), commit: "0".repeat(40) };
  match(trust.compareGitFileRef(ref, bytes(fixtures.publicOpaqueBytes.D.text), ref));
  error(trust.checkAuthorityAvailability(), "authority_unavailable");
});
scenario("F37", "component checks do not read clock, global randomness or network", (t) => {
  const fail = () => assert.fail("unexpected ambient operation");
  t.mock.method(globalThis, "fetch", fail);
  t.mock.method(Math, "random", fail);
  t.mock.method(globalThis, "Date", fail);
  canonicalBytes(payload); value(wire.checkWire("TrustAnchor", anchor)); match(binding());
  value(signatures.signatureReceiptDigest(receipt));
  match(signatures.verifyPureEd25519(Buffer.from(publicVector.messageHex, "hex"), publicKeyBase64, receipt.signatureBase64));
  match(trust.compareBlobRef(blob, bytes(fixtures.publicOpaqueBytes.registration.text), blob));
  // The complementary static import/call audit is external; no source-file read here.
});
scenario("F38", "fixtures contain public data only; synthetic results are not persisted", () => {
  assert.equal(fixtures.kind, "non_operational_offline_component_vectors");
  assert.equal(fixtures.authorityEstablished, false);
  assert.doesNotMatch(fixtureBytes.toString(), /BEGIN .*PRIVATE KEY|"(?:privateKey|secretKey|seed|privateKeyHex)"/i);
  for (const g of fixtures.publicEd25519) assert.deepEqual(Object.keys(g).sort(), ["id", "messageHex", "name", "publicKeyHex", "signatureHex", "source"]);
  withSynthetic(payload.purpose, ({ p, r, key }) => match(signatures.verifySignatureReceipt(r, key, p)));
});
scenario("F39", "positive bytes and signatures never issue authority or trusted context", () => {
  withSynthetic(payload.purpose, ({ p, r, key }) => {
    match(signatures.verifySignatureReceipt(r, key, p));
    match(binding(p, { ...anchor, publicKeyBase64: key }));
    error(trust.checkAuthorityAvailability(), "authority_unavailable");
  });
  for (const component of [canonical, wire, signatures, trust]) {
    for (const name of Object.keys(component)) assert.doesNotMatch(name, /^(issue|approve|activate)|VerifiedHistory|HistoryContext|ApprovedTrustRoot|sign$/);
  }
});
scenario("F41", "case/AC trace includes external audits and preserves all upstream deferrals", () => {
  const external = ["F40", "F42", "F43", "F44"];
  const ids = Array.from({ length: 44 }, (_, i) => `F${String(i + 1).padStart(2, "0")}`);
  assert.deepEqual(fixtures.caseTrace.map((x) => x.id), ids);
  assert.deepEqual([...registered].sort(), ids.filter((x) => !external.includes(x)));
  assert.deepEqual([...completed].sort(), ids.filter((x) => !external.includes(x) && x !== "F41"));
  assert.deepEqual(fixtures.caseTrace.filter((x) => x.verification === "external_repository_audit").map((x) => x.id), external);
  assert.deepEqual(fixtures.acTrace.map((x) => x.id), Array.from({ length: 12 }, (_, i) => `AC-${i + 1}`));
  for (const row of fixtures.caseTrace) for (const ac of row.acIds) assert.ok(fixtures.acTrace.find((x) => x.id === ac)?.caseIds.includes(row.id));
  for (const ac of fixtures.acTrace) for (const id of ac.caseIds) assert.ok(fixtures.caseTrace.find((x) => x.id === id)?.acIds.includes(ac.id));
  for (const [id, required] of [["AC-9", ["NFR-2", "NFR-3"]], ["AC-10", ["NFR-4"]], ["AC-12", ["NFR-1"]]]) {
    for (const nfr of required) assert.ok(fixtures.acTrace.find((x) => x.id === id).requirementIds.includes(nfr));
  }
  assert.equal(fixtures.upstreamDisposition.length, 54);
  assert.equal(new Set(fixtures.upstreamDisposition.map((x) => `${x.namespace}/${x.id}`)).size, 54);
  assert.equal(fixtures.upstreamDisposition.filter((x) => x.disposition === "partial_components").length, 9);
  assert.equal(fixtures.upstreamDisposition.filter((x) => x.disposition === "deferred").length, 45);
  assert.ok(fixtures.upstreamDisposition.every((x) => x.fullySatisfied === false));
});


// PB-R1 adds a separate B inventory; it does not reclassify F40/F42/F43/F44
// or claim B20-B24's external audits as unit passes. Runtime/intrinsics are
// trusted; these input-boundary tests are not a JavaScript sandbox.
const trapNames = ["getPrototypeOf", "setPrototypeOf", "isExtensible", "preventExtensions",
  "getOwnPropertyDescriptor", "defineProperty", "has", "get", "set", "deleteProperty",
  "ownKeys", "apply", "construct"];
const hookNames = ["getter", "setter", "toJSON", "Symbol.iterator", "Symbol.toPrimitive",
  "Symbol.toStringTag", "constructor", "Symbol.species"];
const bRegistered = new Set();
const bCompleted = new Set();
function bScenario(id, title, fn) {
  assert.equal(bRegistered.has(id), false, "duplicate " + id);
  bRegistered.add(id);
  const declaration = fixtures.proxySafety.find((row) => row.id === id);
  assert.ok(declaration, "missing declaration " + id);
  assert.deepEqual(declaration.trapNames, trapNames);
  assert.deepEqual(declaration.hookNames, hookNames);
  assert.equal(declaration.expectedInvocationCount, 0);
  test(id + ": " + title, async () => {
    await fn();
    bCompleted.add(id);
  });
}
function instrumentation() {
  const traps = Object.fromEntries(trapNames.map((name) => [name, 0]));
  const hooks = Object.fromEntries(hookNames.map((name) => [name, 0]));
  const handler = (throwing) => Object.fromEntries(trapNames.map((name) => [name, (...args) => {
    traps[name]++;
    if (throwing) throw new Error("unexpected trap " + name);
    return Reflect[name](...args);
  }]));
  return {
    traps, hooks,
    proxy(target, mode = "forwarding") {
      const revocable = Proxy.revocable(target, handler(mode === "throwing"));
      if (mode === "revoked") revocable.revoke();
      return revocable.proxy;
    },
    measure(fn) {
      for (const name of trapNames) traps[name] = 0;
      for (const name of hookNames) hooks[name] = 0;
      // Setup/revoke is finished. Neither assertions nor formatting inspect
      // the untrusted input; only plain result/counter data reaches assert.
      fn();
      for (const name of trapNames) assert.equal(traps[name], 0, "trap " + name);
      for (const name of hookNames) assert.equal(hooks[name], 0, "hook " + name);
    },
  };
}
const proxyModes = ["forwarding", "throwing", "revoked"];
function placements(input, path = []) {
  const paths = [path];
  if (input !== null && typeof input === "object") {
    for (const [key, value] of Object.entries(input)) paths.push(...placements(value, [...path, key]));
  }
  return paths;
}
function replacePlacement(base, path, probe, mode) {
  const output = clone(base);
  if (path.length === 0) return probe.proxy(output, mode);
  let parent = output;
  for (const key of path.slice(0, -1)) parent = parent[key];
  const key = path.at(-1), old = parent[key];
  parent[key] = probe.proxy(old !== null && typeof old === "object" ? old : {}, mode);
  return output;
}
function objectBoundary(base, call) {
  for (const path of placements(base)) for (const mode of proxyModes) {
    const probe = instrumentation(), input = replacePlacement(base, path, probe, mode);
    probe.measure(() => error(call(input)));
  }
}
function byteEntries(raw) {
  const ref = { path: "fixtures/pb-public", rawSha256: sha(raw), byteLength: raw.length };
  const git = { path: ref.path, rawSha256: ref.rawSha256, commit: "a".repeat(40) };
  return [
    ["copyByteInput", (input) => canonical.copyByteInput(input)],
    ["decodeCanonical", (input) => canonical.decodeCanonical(input)],
    ["rawSha256", (input) => canonical.rawSha256(input)],
    ["verifyPureEd25519", (input) => signatures.verifyPureEd25519(input, publicKeyBase64, receipt.signatureBase64)],
    ["compareBlobRef", (input) => trust.compareBlobRef(ref, input, ref)],
    ["compareGitFileRef", (input) => trust.compareGitFileRef(git, input, git)],
  ];
}
function rejectedBytes(input, probe) {
  for (const [, call] of byteEntries(bytes("{}"))) probe.measure(() => error(call(input)));
}
function storageBytes(input, raw, probe) {
  for (const [name, call] of byteEntries(raw)) {
    const reference = call(raw);
    probe.measure(() => assert.deepEqual(call(input), reference, name));
  }
}

bScenario("B01", "root object/array Proxy is rejected before any forwarding/throwing trap", () => {
  for (const target of [{}, []]) for (const mode of ["forwarding", "throwing"]) {
    const probe = instrumentation(), input = probe.proxy(target, mode);
    probe.measure(() => error(canonical.encodeCanonical(input)));
  }
});
bScenario("B02", "callable, constructable and multiply wrapped Proxy inputs", () => {
  for (const target of [() => 1, function Synthetic() {}, {}, []]) for (const mode of ["forwarding", "throwing"]) {
    const probe = instrumentation(), first = probe.proxy(target, mode);
    for (const input of [first, probe.proxy(first, mode)]) {
      probe.measure(() => error(canonical.encodeCanonical(input)));
    }
  }
});
bScenario("B03", "revoked object/array/function Proxy has no escaping native exception", () => {
  for (const target of [{}, [], () => 1, function Synthetic() {}]) {
    const probe = instrumentation(), input = probe.proxy(target, "revoked");
    probe.measure(() => error(canonical.encodeCanonical(input)));
  }
});
bScenario("B04", "each nested data/array placement rejects active and revoked Proxy", () => {
  const graph = { a: [{ b: { c: [0, 1] } }], z: true };
  objectBoundary(graph, canonical.encodeCanonical);
  objectBoundary(graph, (input) => canonical.domainSha256("mem-pb-test-1", input));
  for (const mode of proxyModes) {
    const probe = instrumentation(), input = { fn: probe.proxy(() => 1, mode) };
    probe.measure(() => error(canonical.encodeCanonical(input)));
  }
});
bScenario("B05", "an ordinary object's Proxy prototype is only compared, not explored", () => {
  for (const mode of proxyModes) for (const base of [{ a: 1 }, [1]]) {
    const probe = instrumentation(), prototype = probe.proxy({}, mode);
    Object.setPrototypeOf(base, prototype);
    probe.measure(() => error(canonical.encodeCanonical(base)));
    probe.measure(() => error(canonical.domainSha256("mem-pb-test-1", base)));
  }
});
bScenario("B06", "ordinary accessor/hook/extra/prototype/cycle rejections remain non-invoking", () => {
  const probe = instrumentation(), h = probe.hooks;
  const accessor = Object.defineProperty({}, "a", { enumerable: true,
    get() { h.getter++; return 1; }, set(value) { void value; h.setter++; } });
  const setter = Object.defineProperty({}, "a", { enumerable: true, set(value) { void value; h.setter++; } });
  const array = [1]; Object.defineProperty(array, "0", { get() { h.getter++; return 1; } });
  const toJSON = { toJSON() { h.toJSON++; return {}; } };
  const iterator = { [Symbol.iterator]() { h["Symbol.iterator"]++; return [][Symbol.iterator](); } };
  const primitive = { [Symbol.toPrimitive]() { h["Symbol.toPrimitive"]++; return "x"; } };
  const tagged = { get [Symbol.toStringTag]() { h["Symbol.toStringTag"]++; return "Object"; } };
  const constructor = { get constructor() { h.constructor++; return Object; } };
  const species = { get [Symbol.species]() { h["Symbol.species"]++; return Array; } };
  const hidden = Object.defineProperty({}, "x", { value: 1 });
  const extra = [0]; extra.x = 1;
  const cycle = {}; cycle.self = cycle;
  for (const input of [accessor, setter, array, toJSON, iterator, primitive, tagged, constructor,
    species, hidden, extra, { [Symbol("x")]: 1 }, Object.create({ a: 1 }), cycle, new Array(2)]) {
    probe.measure(() => error(canonical.encodeCanonical(input)));
    probe.measure(() => error(canonical.domainSha256("mem-pb-test-1", input)));
  }
  const shared = { a: 1 };
  probe.measure(() => assert.equal(canonicalBytes([shared, shared]).toString(), '[{"a":1},{"a":1}]'));
});
bScenario("B07", "five closed wire shapes reject Proxy at every own data placement", () => {
  for (const [kind, base] of Object.entries(examples)) objectBoundary(base, (input) => wire.checkWire(kind, input));
});
bScenario("B08", "every C03/C04 object argument rejects root/nested/revoked Proxy", () => {
  const raw = bytes(fixtures.publicOpaqueBytes.registration.text), git = gitRef("D");
  const boundaries = [
    [payload, signatures.signatureMessage], [receipt, signatures.signatureReceiptDigest],
    [receipt, (x) => signatures.verifySignatureReceipt(x, publicKeyBase64, payload)],
    [payload, (x) => signatures.verifySignatureReceipt(receipt, publicKeyBase64, x)],
    [payload, (x) => binding(x)], [anchor, (x) => binding(payload, x)],
    [expected(), (x) => binding(payload, anchor, x)],
    [blob, (x) => trust.compareBlobRef(x, raw, blob)], [blob, (x) => trust.compareBlobRef(blob, raw, x)],
    [git, (x) => trust.compareGitFileRef(x, bytes(fixtures.publicOpaqueBytes.D.text), git)],
    [git, (x) => trust.compareGitFileRef(git, bytes(fixtures.publicOpaqueBytes.D.text), x)],
  ];
  for (const [base, call] of boundaries) objectBoundary(base, call);
});
bScenario("B09", "all six bytes APIs reject direct/typed-array/Buffer/revoked Proxy", () => {
  for (const target of [{}, [], new Uint8Array([123, 125]), bytes("{}"), () => 1]) for (const mode of proxyModes) {
    const probe = instrumentation(), input = probe.proxy(target, mode);
    rejectedBytes(input, probe);
    rejectedBytes(probe.proxy(input, "forwarding"), probe);
  }
});
bScenario("B10", "fake views and other storage brands cannot enter the Uint8Array boundary", () => {
  const probe = instrumentation();
  const fake = Object.create(Uint8Array.prototype);
  Object.defineProperty(fake, "length", { get() { probe.hooks.getter++; return 2; } });
  const duck = { get byteLength() { probe.hooks.getter++; return 2; },
    [Symbol.iterator]() { probe.hooks["Symbol.iterator"]++; return [123, 125][Symbol.iterator](); } };
  for (const input of [fake, duck, new DataView(new ArrayBuffer(2)), new ArrayBuffer(2),
    new SharedArrayBuffer(2), new Uint8ClampedArray(2), new Int8Array(2), new Uint16Array(2),
    new Int16Array(2), new Uint32Array(2), new Int32Array(2), new Float32Array(2),
    new Float64Array(2), new BigInt64Array(2), new BigUint64Array(2), null, undefined, "{}", [123, 125]]) {
    rejectedBytes(input, probe);
  }
});
bScenario("B11", "attached empty/offset/Buffer and stable RAB/SAB/GSAB raw storage", () => {
  const probe = instrumentation(), raw = bytes("{}");
  storageBytes(new Uint8Array(0), Buffer.alloc(0), probe);
  storageBytes(Buffer.alloc(0), Buffer.alloc(0), probe);
  storageBytes(new Uint8Array([99, 123, 125, 99]).subarray(1, 3), raw, probe);
  storageBytes(Buffer.from([99, 123, 125, 99]).subarray(1, 3), raw, probe);
  const rab = new ArrayBuffer(4, { maxByteLength: 8 });
  new Uint8Array(rab).set([99, 123, 125, 99]);
  storageBytes(new Uint8Array(rab, 1, 2), raw, probe);
  rab.resize(8);
  storageBytes(new Uint8Array(rab, 1, 2), raw, probe);
  const tracking = new ArrayBuffer(2, { maxByteLength: 8 });
  const trackingView = new Uint8Array(tracking); trackingView.set(raw);
  storageBytes(trackingView, raw, probe);
  tracking.resize(3); new Uint8Array(tracking)[2] = 10;
  storageBytes(trackingView, bytes("{}\n"), probe);
  probe.measure(() => assert.deepEqual(canonical.decodeCanonical(trackingView, "file-with-single-lf"),
    canonical.decodeCanonical(bytes("{}\n"), "file-with-single-lf")));
  const sab = new SharedArrayBuffer(4); new Uint8Array(sab).set([99, 123, 125, 99]);
  storageBytes(new Uint8Array(sab, 1, 2), raw, probe);
  const gsab = new SharedArrayBuffer(2, { maxByteLength: 8 }), growing = new Uint8Array(gsab);
  growing.set(raw); storageBytes(growing, raw, probe);
  gsab.grow(3); growing[2] = 10; storageBytes(growing, bytes("{}\n"), probe);
});
bScenario("B12", "subclass shadow getters/constructor/species/iterator never override storage", () => {
  const probe = instrumentation(), h = probe.hooks;
  class PublicBytes extends Uint8Array {
    static get [Symbol.species]() { h["Symbol.species"]++; return Uint8Array; }
  }
  const input = new PublicBytes([123, 125]);
  for (const name of ["length", "byteLength", "buffer", "byteOffset"]) {
    Object.defineProperty(input, name, { get() { h.getter++; throw new Error("shadow " + name); },
      set(value) { void value; h.setter++; } });
  }
  Object.defineProperty(input, "constructor", { get() { h.constructor++; return PublicBytes; } });
  Object.defineProperty(input, Symbol.toStringTag, { get() { h["Symbol.toStringTag"]++; return "Fake"; } });
  Object.defineProperty(input, Symbol.toPrimitive, { value() { h["Symbol.toPrimitive"]++; return "fake"; } });
  Object.defineProperty(input, Symbol.iterator, { value() { h["Symbol.iterator"]++; throw new Error("iterator"); } });
  Object.defineProperty(input, "toJSON", { value() { h.toJSON++; return []; } });
  for (const name of ["slice", "set", "subarray"]) Object.defineProperty(input, name, {
    get() { h.getter++; throw new Error("caller method " + name); },
  });
  storageBytes(input, bytes("{}"), probe);
  const plainSubclass = new PublicBytes([123, 125]);
  storageBytes(plainSubclass, bytes("{}"), probe);
});
bScenario("B13", "approved cross-realm bytes and Proxy-prototype genuine views", () => {
  const probe = instrumentation();
  // PB-D2 permits only fixed constant cross-realm byte fixtures, not a sandbox.
  const other = runInNewContext("new Uint8Array([123, 125])");
  storageBytes(other, bytes("{}"), probe);
  for (const mode of proxyModes) for (const input of [new Uint8Array([123, 125]), bytes("{}")]) {
    Object.setPrototypeOf(input, probe.proxy(Uint8Array.prototype, mode));
    storageBytes(input, bytes("{}"), probe);
    probe.measure(() => error(canonical.encodeCanonical(input)));
  }
});
bScenario("B14", "unused own Proxy metadata is neither traversed nor rejected on genuine bytes", () => {
  for (const mode of proxyModes) {
    const probe = instrumentation(), input = new Uint8Array([123, 125]);
    input.metadata = probe.proxy({}, mode);
    input[Symbol("metadata")] = probe.proxy({}, mode);
    Object.defineProperty(input, "unused", { get() { probe.hooks.getter++; throw new Error("unused"); } });
    storageBytes(input, bytes("{}"), probe);
  }
});
bScenario("B15", "detached and zero-length-looking OOB views differ from attached empty", () => {
  const probe = instrumentation();
  for (const length of [0, 2]) {
    const buffer = new ArrayBuffer(length), input = new Uint8Array(buffer);
    structuredClone(buffer, { transfer: [buffer] }); // Only this test-owned buffer.
    rejectedBytes(input, probe);
  }
  const rab = new ArrayBuffer(4, { maxByteLength: 8 });
  const fixed = new Uint8Array(rab, 2, 2), tracking = new Uint8Array(rab, 2);
  rab.resize(1); rejectedBytes(fixed, probe); rejectedBytes(tracking, probe);
  storageBytes(new Uint8Array(0), Buffer.alloc(0), probe);
  // A zero-length view exactly at the current boundary is still attached.
  storageBytes(new Uint8Array(rab, 1, 0), Buffer.alloc(0), probe);
});
bScenario("B16", "private copies are independently owned in both mutation directions", () => {
  const input = new Uint8Array([99, 123, 125, 99]).subarray(1, 3);
  const copied = value(canonical.copyByteInput(input));
  assert.notEqual(copied, input);
  assert.notEqual(copied.buffer, input.buffer);
  assert.deepEqual([...copied], [123, 125]);
  input[0] = 0; assert.deepEqual([...copied], [123, 125]);
  copied[1] = 0; assert.equal(input[1], 125);
  const empty = new Uint8Array(0), emptyCopy = value(canonical.copyByteInput(empty));
  assert.notEqual(emptyCopy.buffer, empty.buffer);
});
bScenario("B17", "invalid object/bytes take precedence over unsupported and mismatch results", () => {
  const unsupported = { ...payload, purpose: "unknown_purpose" };
  for (const mode of proxyModes) {
    const probe = instrumentation(), bad = probe.proxy({}, mode);
    for (const call of [
      () => signatures.signatureMessage({ ...unsupported, contentDigest: bad }),
      () => signatures.signatureReceiptDigest({ ...receipt, payload: bad }),
      () => signatures.verifySignatureReceipt({ ...receipt, payload: unsupported }, publicKeyBase64, bad),
      () => signatures.verifySignatureReceipt(bad, publicKeyBase64, unsupported),
      () => signatures.verifyPureEd25519(bad, publicKeyBase64, receipt.signatureBase64),
      () => signatures.verifyPureEd25519(bad, "malformed", "malformed"),
      () => binding(unsupported, bad),
      () => binding(unsupported, anchor, bad),
      () => trust.compareBlobRef({ ...blob, rawSha256: "c".repeat(64) }, bad, blob),
      () => trust.compareBlobRef(bad, bytes("wrong"), blob),
      () => trust.compareBlobRef(blob, bytes("wrong"), bad),
      () => trust.compareGitFileRef(gitRef("D"), bad, gitRef("K")),
      () => trust.compareGitFileRef(bad, bytes("wrong"), gitRef("K")),
      () => trust.compareGitFileRef(gitRef("D"), bytes("wrong"), bad),
    ]) probe.measure(() => error(call()));
  }
  error(signatures.verifySignatureReceipt({ ...receipt, payload: unsupported }, publicKeyBase64, payload), "unsupported_subset");
  error(trust.compareBlobRef({ ...blob, path: "other" }, bytes("wrong"), blob), "bytes_mismatch");
});
bScenario("B18", "scalar slots reject Proxy/boxed values without coercion or native leakage", () => {
  const probe = instrumentation();
  const coercion = { [Symbol.toPrimitive]() { probe.hooks["Symbol.toPrimitive"]++; return payload.purpose; } };
  const inputs = [new String(payload.purpose), new Number(32), new Boolean(true), coercion,
    ...proxyModes.map((mode) => probe.proxy(coercion, mode))];
  for (const input of inputs) {
    for (const predicate of [wire.isDigest, wire.isKeyId, wire.isAsciiId, wire.isApproverId, wire.isUtcSecond]) {
      probe.measure(() => assert.equal(predicate(input), false));
    }
    probe.measure(() => assert.equal(wire.requiredRole(input), undefined));
    for (const call of [
      () => canonical.domainSha256(input, {}),
      () => canonical.decodeCanonical(bytes("{}"), input),
      () => wire.checkWire(input, payload),
      () => wire.decodeBase64(input, 32),
      () => wire.decodeBase64(publicKeyBase64, input),
      () => signatures.verifyPureEd25519(Buffer.alloc(0), input, receipt.signatureBase64),
      () => signatures.verifyPureEd25519(Buffer.alloc(0), publicKeyBase64, input),
      () => signatures.verifySignatureReceipt(receipt, input, payload),
      () => binding(payload, anchor, expected(), input),
      () => trust.compareTrustPolicyDigest(input, "a".repeat(64)),
      () => trust.compareTrustPolicyDigest("a".repeat(64), input),
      () => trust.comparePreviousEpochDigest(input, null),
      () => trust.comparePreviousEpochDigest(null, input),
    ]) probe.measure(() => error(call()));
  }
});
bScenario("B19", "unchanged F goldens/40 scenarios plus complete separate B declarations", () => {
  const original = Object.fromEntries(Object.entries(fixtures).filter(([key]) => key !== "proxySafety" && key !== "idPathPolicy"));
  assert.equal(sha(JSON.stringify(original)), "1d286a257c44d3444de99b945a8276cd680b8b30adc41bf0fc5df32a5f4123ca");
  const fExternal = ["F40", "F42", "F43", "F44"];
  const fUnits = fixtures.caseTrace.map((row) => row.id).filter((id) => !fExternal.includes(id));
  assert.equal(fUnits.length, 40);
  assert.deepEqual([...registered].sort(), fUnits);
  assert.deepEqual([...completed].sort(), fUnits);
  const bIds = Array.from({ length: 24 }, (_, i) => "B" + String(i + 1).padStart(2, "0"));
  assert.deepEqual(fixtures.proxySafety.map((row) => row.id), bIds);
  for (const row of fixtures.proxySafety) {
    assert.deepEqual(row.trapNames, trapNames);
    assert.deepEqual(row.hookNames, hookNames);
    assert.equal(row.expectedInvocationCount, 0);
    assert.match(row.acId, /^AC-(?:[1-9]|1[0-2])$/);
  }
  assert.deepEqual([...bRegistered].sort(), bIds.slice(0, 19));
  assert.deepEqual([...bCompleted].sort(), bIds.slice(0, 18));
  for (const g of fixtures.goldenCanonical) {
    assert.equal(canonicalBytes(JSON.parse(g.canonicalText)).toString("hex"), g.utf8Hex);
    assert.equal(value(canonical.rawSha256(bytes(g.canonicalText))), g.rawSha256);
    assert.equal(value(canonical.domainSha256(g.testDomain, JSON.parse(g.canonicalText))), g.domainSha256);
  }
});


// IP-D1-D5 were approved separately. This literal expectation table is transcribed
// from R2 (13a6b088...), not derived from the fixture under test. External rows
// are declarations only; no unit test can issue their repository-audit verdicts.
const ipExpected = [
  {
    "id": "IP01",
    "acId": "IP-AC1",
    "verification": "unit",
    "expected": "primitive isAsciiId에 U+0000..U+007F 각각 및 prefix/middle/suffix 위치를 넣고 U+0021..U+007E만 true; 빈 문자열/boxed/non-string은 false, coercion 0회."
  },
  {
    "id": "IP02",
    "acId": "IP-AC1",
    "verification": "unit",
    "expected": "SignaturePayload purpose/signerId/trustEpoch 각 field 독립 변형. C0 32개·space·DEL·non-ASCII·NFD·surrogate를 모두 invalid_input, 새 허용 ASCII는 shape ok."
  },
  {
    "id": "IP03",
    "acId": "IP-AC1",
    "verification": "unit",
    "expected": "SignatureReceipt.payload의 세 ID field에 IP02와 같은 negative/positive 범위를 적용; nested shape bypass 없음."
  },
  {
    "id": "IP04",
    "acId": "IP-AC1",
    "verification": "unit",
    "expected": "TrustAnchor signerId/trustEpoch 독립 변형, invalid_input과 새 허용값 구조 통과. keyId/roles schema는 기존 그대로."
  },
  {
    "id": "IP05",
    "acId": "IP-AC1",
    "verification": "unit",
    "expected": "C04 BindingExpectation의 purpose/signerId/trustEpoch만 독립 변형해 다른 값은 정상이어도 새 금지 입력은 invalid_input. payload/anchor/expected 모두 같은 금지 signer/epoch여도 invalid_input."
  },
  {
    "id": "IP06",
    "acId": "IP-AC3",
    "verification": "unit",
    "expected": "signatureMessage/signatureReceiptDigest/verifySignatureReceipt의 receipt 및 expectedPayload ID 오류가 invalid_input으로 전파. 구조 실패를 unsupported_subset/signature_mismatch보다 우선, 새 key/signing API 추가 없음."
  },
  {
    "id": "IP07",
    "acId": "IP-AC3",
    "verification": "unit",
    "expected": "@importer와 !~ 및 ASCII punctuation은 opaque ID로 수용. C02의 approval-purpose shape와 C04 ApproverId 추가 제약을 구별; 신규 approver @user는 C04에서 invalid_input. 미지원 정상 purpose는 C03/C04 unsupported_subset."
  },
  {
    "id": "IP08",
    "acId": "IP-AC3",
    "verification": "unit",
    "expected": "허용 signer/epoch의 case-only 차이는 binding_mismatch. 금지 whitespace를 trim/normalize/alias로 성공시키지 않음. 서로 다른 정상 path 및 raw bytes 불일치의 기존 error 우선순위를 보존."
  },
  {
    "id": "IP09",
    "acId": "IP-AC2",
    "verification": "unit",
    "expected": "BlobRef.path/GitFileRef.path/TrustAnchor.registrationReceipt.path 각각 C0 32개·DEL을 segment의 시작/중간/끝에 삽입해 invalid_input. byteLength/hash는 정상으로 고정."
  },
  {
    "id": "IP10",
    "acId": "IP-AC2",
    "verification": "unit",
    "expected": "NFC 한글/é/astral scalar·space 포함·선행/후행 space·space-only segment 및 원 문자 exact 보존. IP-D2가 명시적으로 유지하는 C1/U+2028/U+2029/format scalar 사례도 구조상 수용하되 운영 권한 없음."
  },
  {
    "id": "IP11",
    "acId": "IP-AC2",
    "verification": "unit",
    "expected": "NFD/unpaired surrogate/non-string/boxed string은 invalid_input. 입력을 NFC로 고치거나 Unicode를 ASCII로 바꾸지 않음. typed-array/raw bytes를 checkWire object 입력으로 혼동하지 않음."
  },
  {
    "id": "IP12",
    "acId": "IP-AC2",
    "verification": "unit",
    "expected": "빈 path/segment, leading/trailing slash, backslash, drive prefix, dot/dotdot segment 거절. ..x, percent-encoded 점, nested colon, CON, trailing-dot은 lexical layer에서 기존과 동일; fs/URL decoding/OS alias 처리 없음."
  },
  {
    "id": "IP13",
    "acId": "IP-AC3",
    "verification": "unit",
    "expected": "compareBlobRef/compareGitFileRef에서 actual와 expected의 path를 각각 독립 변형; 금지 path와 wrong bytes 동시 입력은 invalid_input. compareTrustBinding의 anchor.registrationReceipt.path에도 같은 구조 거절."
  },
  {
    "id": "IP14",
    "acId": "IP-AC4",
    "verification": "unit",
    "expected": "C01은 일반 CJSON string의 C0/DEL과 raw source bytes를 계속 원 규약대로 처리; ASCII object key 범위 불변. 기존 B Proxy/hook·bytes copy 경계, 모든 정상 golden/error 우선순위 보존."
  },
  {
    "id": "IP15",
    "acId": "IP-AC4",
    "verification": "unit",
    "expected": "새 IP unit inventory를 F/B와 분리. 기존 15 top-level fixture 값/순서의 JSON.stringify projection SHA 및 original14/B19 hash 유지; idPathPolicy 한 key만 추가, IP16–IP20은 external이며 unit pass로 세지 않음. idPathPolicy는 IP01–IP20 순서의 정확히 20개 row 배열이며 각 row는 id/acId/verification/expected 네 key만, 모두 비어 있지 않은 primitive string. T01에 이 패키지 futureCases의 네 필드 값을 전사한 독립 고정 기대표와 row별 exact equality를 검사하고 fixture에서 정답을 유도하지 않음. IP01–IP15는 unit, IP16–IP20은 external_repository_audit. row의 acId에서 역으로 모은 case ID 목록을 acceptanceCriteria의 각 caseIds와 집합·순서까지 양방향 대조해 누락·중복·알 수 없는 ID·잘못된 대응을 거절. IP15 자신의 expected도 고정 문자열 데이터로 비교하며 재귀 생성·자기 hash 없음."
  },
  {
    "id": "IP16",
    "acId": "IP-AC5",
    "verification": "external_repository_audit",
    "expected": "새 implementation commit은 C02/T01/T11 M3만, hidden helper/import/builtin/package/config/runner/static gate 추가 0; C01/C03/C04 exact blob 보존."
  },
  {
    "id": "IP17",
    "acId": "IP-AC5",
    "verification": "external_repository_audit",
    "expected": "정책 패키지 두 raw SHA/reviewCommit와 별도 receipt, 원 SHA develop inclusion 및 현재 별도 착수 지시를 대조. Q/S1/S3/D/PB/IB/BF/receipt bytes와 과거 판정 무변경."
  },
  {
    "id": "IP18",
    "acId": "IP-AC4",
    "verification": "external_repository_audit",
    "expected": "새 IP01–IP15와 모든 기존 F/B unit 실제 실행·누락/중복/skip 0. exact field matrix/긍정·음성 집합 대조, baseline 실패가 있으면 같은 이름·원인 대조. B20–B24 및 F 외부 감사 분류 유지."
  },
  {
    "id": "IP19",
    "acId": "IP-AC5",
    "verification": "external_repository_audit",
    "expected": "실제 착수 tip support9 Git/working hash, runtime/lock/설치, branch/ancestry/CI·검사 조건을 별도 사전 기록. 이번 문서 준비 관측을 미래 착수 검증이나 전체 dependency closure로 대용하지 않음."
  },
  {
    "id": "IP20",
    "acId": "IP-AC5",
    "verification": "external_repository_audit",
    "expected": "S2 activation, full P/scorer/holdout/운영 key/provider/flags가 없고 상위54 AC partial9/deferred45/full0 및 잔여를 보존. 정책/시험통과는 외부 OI-F2 closure의 대용 아님."
  }
];
const ipAcceptance = [
  {
    "id": "IP-AC1",
    "caseIds": [
      "IP01",
      "IP02",
      "IP03",
      "IP04",
      "IP05"
    ]
  },
  {
    "id": "IP-AC2",
    "caseIds": [
      "IP09",
      "IP10",
      "IP11",
      "IP12"
    ]
  },
  {
    "id": "IP-AC3",
    "caseIds": [
      "IP06",
      "IP07",
      "IP08",
      "IP13"
    ]
  },
  {
    "id": "IP-AC4",
    "caseIds": [
      "IP14",
      "IP15",
      "IP18"
    ]
  },
  {
    "id": "IP-AC5",
    "caseIds": [
      "IP16",
      "IP17",
      "IP19",
      "IP20"
    ]
  }
];
const ipRegistered = new Set();
const ipCompleted = new Set();
function ipScenario(id, title, fn) {
  assert.equal(ipRegistered.has(id), false, "duplicate " + id);
  ipRegistered.add(id);
  test(id + ": " + title, async () => {
    await fn();
    ipCompleted.add(id);
  });
}
const ipControls = [...Array.from({ length: 32 }, (_, i) => String.fromCharCode(i)), "\x7f"];
const ipBadIdChars = [...ipControls, " ", "é", "한", "😀", "e\u0301", "\ud800", "\udfff", "\u2028", "\u2029"];
const ipPositions = (char) => [char, char + "ab", "a" + char + "b", "ab" + char];
const ipGoodIdChars = Array.from({ length: 94 }, (_, i) => String.fromCharCode(i + 33));
const ipWrongStrings = ["", null, undefined, 1, true, {}, [], new String("valid")];
function ipIdFields(base, fields, check) {
  for (const field of fields) {
    for (const char of ipBadIdChars) for (const text of ipPositions(char)) {
      error(check({ ...base, [field]: text }));
    }
    for (const input of ipWrongStrings) error(check({ ...base, [field]: input }));
    for (const char of ipGoodIdChars) for (const text of ipPositions(char)) {
      const input = { ...base, [field]: text };
      assert.deepEqual(value(check(input)), input);
    }
  }
}
function ipPathLeaves(path) {
  return [
    ["BlobRef", { ...blob, path }],
    ["GitFileRef", { ...gitRef("D"), path }],
    ["TrustAnchor", { ...anchor, registrationReceipt: { ...blob, path } }],
  ];
}
function ipPathShapes(path, accepted) {
  for (const [kind, input] of ipPathLeaves(path)) {
    if (accepted) assert.deepEqual(value(wire.checkWire(kind, input)), input);
    else error(wire.checkWire(kind, input));
  }
}

ipScenario("IP01", "ID alphabet is exhaustive", () => {
  for (let code = 0; code < 128; code++) for (const input of ipPositions(String.fromCharCode(code))) {
    assert.equal(wire.isAsciiId(input), code >= 33 && code <= 126, "ASCII " + code);
  }
  for (const char of ipBadIdChars) for (const input of ipPositions(char)) assert.equal(wire.isAsciiId(input), false);
  for (const input of ipWrongStrings) assert.equal(wire.isAsciiId(input), false);
  const probe = instrumentation();
  const coercion = { [Symbol.toPrimitive]() { probe.hooks["Symbol.toPrimitive"]++; return "valid"; } };
  for (const input of [coercion, ...proxyModes.map((mode) => probe.proxy(coercion, mode))]) {
    probe.measure(() => assert.equal(wire.isAsciiId(input), false));
  }
});
ipScenario("IP02", "Payload ID field coverage", () => {
  ipIdFields(payload, ["purpose", "signerId", "trustEpoch"], (input) => wire.checkWire("SignaturePayload", input));
});
ipScenario("IP03", "Receipt nested payload coverage", () => {
  ipIdFields(payload, ["purpose", "signerId", "trustEpoch"], (input) => {
    const result = wire.checkWire("SignatureReceipt", { ...receipt, payload: input });
    return result.ok ? { ...result, value: result.value.payload } : result;
  });
});
ipScenario("IP04", "Anchor ID field coverage", () => {
  ipIdFields(anchor, ["signerId", "trustEpoch"], (input) => wire.checkWire("TrustAnchor", input));
  assert.deepEqual(value(wire.checkWire("TrustAnchor", anchor)).roles, ["approver", "importer"]);
  for (const keyId of ["", "A".repeat(32), "a".repeat(31)]) error(wire.checkWire("TrustAnchor", { ...anchor, keyId }));
  error(wire.checkWire("TrustAnchor", { ...anchor, roles: ["unknown"] }));
});
ipScenario("IP05", "Expectation has no legacy bypass", () => {
  for (const field of ["purpose", "signerId", "trustEpoch"]) {
    for (const input of [...ipBadIdChars.flatMap(ipPositions), ...ipWrongStrings]) {
      error(binding(payload, anchor, { ...expected(), [field]: input }));
    }
  }
  // Use importer purpose so the stricter approver grammar cannot mask a missing
  // opaque-ID check when all three local comparison values are equally invalid.
  for (const field of ["signerId", "trustEpoch"]) for (const input of ipBadIdChars.flatMap(ipPositions)) {
    const p = { ...payload, purpose: "s2_source_evidence", [field]: input };
    const a = { ...anchor, [field]: input };
    error(binding(p, a, expected(p, a)));
  }
});
ipScenario("IP06", "Signature entry-point propagation", () => {
  for (const field of ["purpose", "signerId", "trustEpoch"]) for (const input of ipBadIdChars.flatMap(ipPositions)) {
    const p = { ...payload, [field]: input }, r = { ...receipt, payload: p };
    error(signatures.signatureMessage(p));
    error(signatures.signatureReceiptDigest(r));
    error(signatures.verifySignatureReceipt(r, publicKeyBase64, payload));
    error(signatures.verifySignatureReceipt(receipt, publicKeyBase64, p));
    const unsupported = { ...payload, purpose: "unknown_purpose" };
    error(signatures.verifySignatureReceipt(r, publicKeyBase64, unsupported));
    error(signatures.verifySignatureReceipt({ ...receipt, payload: unsupported }, publicKeyBase64, p));
  }
  const bad = { ...payload, purpose: "unknown_purpose", trustEpoch: "bad\n" };
  error(signatures.signatureMessage(bad));
  error(signatures.signatureReceiptDigest({ ...receipt, payload: bad }));
});
ipScenario("IP07", "Role-specific and unsupported boundaries", () => {
  for (const signerId of ["@importer", "!~", ipGoodIdChars.join("")]) {
    const p = { ...payload, purpose: "s2_source_evidence", signerId };
    const a = { ...anchor, signerId };
    assert.deepEqual(value(wire.checkWire("SignaturePayload", p)), p);
    match(binding(p, a, expected(p, a)));
  }
  for (const signerId of ["@user", "!~"]) {
    const p = { ...payload, signerId }, a = { ...anchor, signerId };
    value(wire.checkWire("SignaturePayload", p));
    error(binding(p, a, expected(p, a)));
  }
  for (const purpose of ["unknown_purpose", "!~", "@importer"]) {
    const p = { ...payload, purpose };
    value(wire.checkWire("SignaturePayload", p));
    error(signatures.signatureMessage(p), "unsupported_subset");
    error(signatures.signatureReceiptDigest({ ...receipt, payload: p }), "unsupported_subset");
    error(signatures.verifySignatureReceipt({ ...receipt, payload: p }, publicKeyBase64, p), "unsupported_subset");
    error(binding(p, anchor, expected(p)), "unsupported_subset");
  }
  for (const { purpose, role } of fixtures.purposeRoles) {
    const p = { ...payload, purpose }, a = { ...anchor, roles: [role] };
    match(binding(p, a, expected(p, a)));
  }
});
ipScenario("IP08", "Exact equality and no repair", () => {
  const p = { ...payload, purpose: "s2_source_evidence", signerId: "@Importer", trustEpoch: "Epoch-A" };
  const a = { ...anchor, signerId: p.signerId, trustEpoch: p.trustEpoch };
  match(binding(p, a, expected(p, a)));
  for (const [field, other] of [["signerId", "@importer"], ["trustEpoch", "epoch-A"]]) {
    error(binding({ ...p, [field]: other }, a, expected(p, a)), "binding_mismatch");
    error(binding(p, { ...a, [field]: other }, expected(p, a)), "binding_mismatch");
    error(binding(p, a, { ...expected(p, a), [field]: other }), "binding_mismatch");
  }
  error(binding(p, a, { ...expected(p, a), signerId: "Importer" }), "binding_mismatch");
  for (const char of [" ", "\t", "\n", "\r", "\u00a0", "e\u0301"]) {
    for (const text of ipPositions(char)) error(binding(p, a, { ...expected(p, a), signerId: text }));
  }
  for (const [ref, raw, compare] of [
    [blob, bytes(fixtures.publicOpaqueBytes.registration.text), trust.compareBlobRef],
    [gitRef("D"), bytes(fixtures.publicOpaqueBytes.D.text), trust.compareGitFileRef],
  ]) {
    for (const path of ["Fixtures/other", " " + ref.path, ref.path + " "]) {
      error(compare({ ...ref, path }, raw, ref), "binding_mismatch");
      error(compare({ ...ref, path }, bytes("wrong"), ref), "bytes_mismatch");
    }
  }
});
ipScenario("IP09", "Path controls at all leaf locations", () => {
  for (const char of ipControls) for (const segment of ipPositions(char)) {
    ipPathShapes("dir/" + segment + "/leaf", false);
  }
});
ipScenario("IP10", "NFC Unicode and spaces remain allowed", () => {
  for (const path of ["한글/증거 파일.json", "é/한.txt", "😀/자료", " leading/file", "dir/trailing ",
    "dir/ /leaf", " ", ...Array.from({ length: 32 }, (_, i) => "a/" + String.fromCharCode(128 + i) + "/b"),
    "a/\u2028/b", "a/\u2029/b", "a/\u200b/b", "a/\u202e/b", "a/\u2066/b", "a/\ufeff/b"]) {
    ipPathShapes(path, true);
  }
});
ipScenario("IP11", "Path canonical precondition and type", () => {
  for (const path of ["e\u0301/a", "a/\ud800", "\udfff/a", null, undefined, 1, false, {}, [],
    new String("a/b"), new Uint8Array([97]), bytes("a/b")]) ipPathShapes(path, false);
  for (const kind of ["BlobRef", "GitFileRef", "TrustAnchor"]) {
    const input = examples[kind];
    for (const raw of [canonicalBytes(input), new Uint8Array(canonicalBytes(input))]) {
      error(wire.checkWire(kind, raw));
    }
    assert.deepEqual(value(wire.checkWire(kind, input)), input);
  }
});
ipScenario("IP12", "Relative syntax is unchanged", () => {
  for (const path of ["", "/", "/a", "a/", "a//b", "//server/share", "a\\b", "\\\\server\\share",
    "C:a", "c:/a", ".", "..", "./a", "../a", "a/./b", "a/../b"]) ipPathShapes(path, false);
  for (const path of ["a/..x", "a/%2e%2e/b", "dir/C:a", "CON", "a/trailing.", "a/%00/b", "dir/a:b"]) {
    ipPathShapes(path, true);
  }
});
ipScenario("IP13", "Ref and expectation propagation", () => {
  for (const char of ipControls) for (const segment of ipPositions(char)) {
    const path = "dir/" + segment + "/leaf";
    for (const [ref, raw, compare] of [
      [blob, bytes(fixtures.publicOpaqueBytes.registration.text), trust.compareBlobRef],
      [gitRef("D"), bytes(fixtures.publicOpaqueBytes.D.text), trust.compareGitFileRef],
    ]) {
      const bad = { ...ref, path };
      for (const actualBytes of [raw, bytes("wrong")]) {
        error(compare(bad, actualBytes, ref));
        error(compare(ref, actualBytes, bad));
      }
    }
    const badAnchor = { ...anchor, registrationReceipt: { ...blob, path } };
    error(binding(payload, badAnchor, expected()));
    const unsupported = { ...payload, purpose: "unknown_purpose" };
    error(binding(unsupported, badAnchor, expected(unsupported)));
  }
});
ipScenario("IP14", "Canonical and Proxy guarantees are not narrowed", () => {
  for (let code = 0; code < 128; code++) {
    const char = String.fromCharCode(code);
    const quoted = code < 32 ? '"\\u' + code.toString(16).padStart(4, "0") + '"' : JSON.stringify(char);
    assert.equal(canonicalBytes(char).toString(), quoted);
    const object = { [char]: char };
    assert.equal(canonicalBytes(object).toString(), "{" + quoted + ":" + quoted + "}");
    assert.deepEqual(value(canonical.decodeCanonical(canonicalBytes(object))), object);
  }
  const raw = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
  assert.equal(value(canonical.rawSha256(raw)), sha(raw));
  assert.deepEqual(Buffer.from(value(canonical.copyByteInput(raw))), raw);
  assert.deepEqual([...completed], [...registered]);
  assert.equal(completed.size, 40);
  assert.deepEqual([...bCompleted], [...bRegistered]);
  assert.equal(bCompleted.size, 19);
  for (const g of fixtures.goldenCanonical) {
    const input = JSON.parse(g.canonicalText);
    assert.equal(canonicalBytes(input).toString("hex"), g.utf8Hex);
    assert.equal(value(canonical.domainSha256(g.testDomain, input)), g.domainSha256);
  }
  for (const mode of proxyModes) {
    const probe = instrumentation(), input = probe.proxy({ ...payload }, mode);
    probe.measure(() => error(wire.checkWire("SignaturePayload", input)));
  }
});
function checkIpInventory(rows) {
  assert.equal(Array.isArray(rows), true);
  assert.equal(rows.length, 20);
  assert.deepEqual(rows.map((row) => row.id), ipExpected.map((row) => row.id));
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    assert.deepEqual(Object.keys(row).sort(), ["acId", "expected", "id", "verification"]);
    for (const field of ["id", "acId", "verification", "expected"]) {
      assert.equal(typeof row[field], "string");
      assert.notEqual(row[field].length, 0);
      assert.equal(row[field], ipExpected[index][field]);
    }
  }
  for (const { id, caseIds } of ipAcceptance) {
    const reverse = rows.filter((row) => row.acId === id).map((row) => row.id);
    assert.deepEqual(reverse, caseIds);
    assert.equal(new Set(reverse).size, caseIds.length);
    for (const caseId of caseIds) assert.equal(rows.find((row) => row.id === caseId)?.acId, id);
  }
}
ipScenario("IP15", "Separate inventory and exact fixture projection", () => {
  const originalKeys = ["kind","authorityEstablished","provenance","goldenCanonical","publicEd25519","publicNonPureEd25519","publicOpaqueBytes","closedTypes","purposeRoles","acTrace","caseTrace","externalVerificationNote","upstreamDisposition","upstreamCounts","proxySafety"];
  assert.deepEqual(Object.keys(fixtures), [...originalKeys, "idPathPolicy"]);
  const original15 = Object.fromEntries(Object.entries(fixtures).filter(([key]) => key !== "idPathPolicy"));
  assert.equal(sha(JSON.stringify(original15)), "e59c8ef30d4dae1430e113392d63924e9d2a77cd764edd8297e59ed2d987e652");
  const original14 = Object.fromEntries(Object.entries(fixtures).filter(([key]) => key !== "proxySafety" && key !== "idPathPolicy"));
  assert.equal(sha(JSON.stringify(original14)), "1d286a257c44d3444de99b945a8276cd680b8b30adc41bf0fc5df32a5f4123ca");
  checkIpInventory(fixtures.idPathPolicy);
  const ids = Array.from({ length: 20 }, (_, i) => "IP" + String(i + 1).padStart(2, "0"));
  assert.deepEqual([...ipRegistered], ids.slice(0, 15));
  assert.deepEqual([...ipCompleted], ids.slice(0, 14));
  assert.deepEqual(fixtures.idPathPolicy.filter((row) => row.verification === "unit").map((row) => row.id), ids.slice(0, 15));
  assert.deepEqual(fixtures.idPathPolicy.filter((row) => row.verification === "external_repository_audit").map((row) => row.id), ids.slice(15));
  // Reject missing/duplicate/unknown/reordered declarations and every altered
  // four-field value, including IP15's own literal expected text.
  for (const mutate of [
    (rows) => rows.pop(),
    (rows) => rows.push(clone(rows[0])),
    (rows) => { rows[1] = clone(rows[0]); },
    (rows) => { rows.reverse(); },
    (rows) => { rows[0].id = "IP99"; },
    (rows) => { rows[0].extra = "forbidden"; },
    (rows) => { delete rows[0].expected; },
    (rows) => { rows[0].expected = new String(rows[0].expected); },
  ]) {
    const rows = clone(fixtures.idPathPolicy); mutate(rows);
    assert.throws(() => checkIpInventory(rows));
  }
  for (let index = 0; index < 20; index++) for (const field of ["id", "acId", "verification", "expected"]) {
    const rows = clone(fixtures.idPathPolicy);
    rows[index][field] += "-changed";
    assert.throws(() => checkIpInventory(rows));
  }
});
