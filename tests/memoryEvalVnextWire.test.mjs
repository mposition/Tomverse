import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
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
