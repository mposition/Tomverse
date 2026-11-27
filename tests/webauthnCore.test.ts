import assert from "node:assert/strict";
import { createHash, createSign, generateKeyPairSync, randomBytes } from "node:crypto";
import test from "node:test";

import { fromBase64url, verifyAssertion, verifyRegistration, WebAuthnError } from "@/lib/webauthnCore";

const ORIGIN = "https://tomverse.app";
const RP = "tomverse.app";
const CHALLENGE = randomBytes(32).toString("base64url");

// A tiny CBOR encoder for the shapes an authenticator produces.
function cbor(value: unknown): Buffer {
  const head = (major: number, arg: number) => {
    if (arg < 24) return Buffer.from([(major << 5) | arg]);
    if (arg < 256) return Buffer.from([(major << 5) | 24, arg]);
    const out = Buffer.alloc(3);
    out[0] = (major << 5) | 25;
    out.writeUInt16BE(arg, 1);
    return out;
  };
  if (typeof value === "number") return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === "string") return Buffer.concat([head(3, Buffer.byteLength(value)), Buffer.from(value)]);
  if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value]);
  if (value instanceof Map) return Buffer.concat([head(5, value.size), ...[...value].flatMap(([key, entry]) => [cbor(key), cbor(entry)])]);
  throw new Error("unsupported");
}

const sha = (text: string | Buffer) => createHash("sha256").update(text).digest();
const clientData = (type: string, over: Record<string, unknown> = {}) =>
  Buffer.from(JSON.stringify({ type, challenge: CHALLENGE, origin: ORIGIN, crossOrigin: false, ...over }));

function authData(options: { rp?: string; flags?: number; counter?: number; credential?: { id: Buffer; cose: Buffer } } = {}) {
  const flags = options.flags ?? 0x05;
  const counter = Buffer.alloc(4);
  counter.writeUInt32BE(options.counter ?? 0);
  const parts: Buffer[] = [sha(options.rp ?? RP), Buffer.from([flags | (options.credential ? 0x40 : 0)]), counter];
  if (options.credential) {
    const length = Buffer.alloc(2);
    length.writeUInt16BE(options.credential.id.length);
    parts.push(Buffer.alloc(16), length, options.credential.id, options.credential.cose);
  }
  return Buffer.concat(parts);
}

function ecKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const cose = cbor(new Map<unknown, unknown>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x!, "base64url")], [-3, Buffer.from(jwk.y!, "base64url")]]));
  return { cose, sign: (data: Buffer) => { const signer = createSign("sha256"); signer.update(data); return signer.sign(privateKey); } };
}

function rsaKey(bits = 2048) {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: bits });
  const jwk = publicKey.export({ format: "jwk" });
  const cose = cbor(new Map<unknown, unknown>([[1, 3], [3, -257], [-1, Buffer.from(jwk.n!, "base64url")], [-2, Buffer.from(jwk.e!, "base64url")]]));
  return { cose, sign: (data: Buffer) => { const signer = createSign("sha256"); signer.update(data); return signer.sign(privateKey); } };
}

const registration = (key: { cose: Buffer }, over: { auth?: Buffer; client?: Buffer; id?: Buffer } = {}) => {
  const id = over.id ?? randomBytes(32);
  const auth = over.auth ?? authData({ credential: { id, cose: key.cose } });
  return {
    id,
    clientDataJSON: (over.client ?? clientData("webauthn.create")).toString("base64url"),
    attestationObject: cbor(new Map<unknown, unknown>([["fmt", "none"], ["attStmt", new Map()], ["authData", auth]])).toString("base64url"),
  };
};

const expected = { challenge: CHALLENGE, origin: ORIGIN, rpId: RP };

function assertion(key: { sign(data: Buffer): Buffer }, over: { auth?: Buffer; client?: Buffer; signWith?: { sign(data: Buffer): Buffer } } = {}) {
  const auth = over.auth ?? authData({ counter: 5 });
  const client = over.client ?? clientData("webauthn.get");
  const signature = (over.signWith ?? key).sign(Buffer.concat([auth, sha(client)]));
  return { clientDataJSON: client.toString("base64url"), authenticatorData: auth.toString("base64url"), signature: signature.toString("base64url") };
}

const refused = (run: () => unknown, code: string) => assert.throws(run, (error) => error instanceof WebAuthnError && error.code === code);

test("a registration reads the credential id and the public key, and an ES256 assertion then verifies", () => {
  const key = ecKey();
  const made = registration(key);
  const credential = verifyRegistration({ clientDataJSON: made.clientDataJSON, attestationObject: made.attestationObject, expected });
  assert.equal(credential.alg, -7);
  assert.equal(credential.credentialId, made.id.toString("base64url"));
  const result = verifyAssertion({ ...assertion(key), expected, stored: { publicKey: credential.publicKey, alg: credential.alg, signCount: credential.signCount } });
  assert.equal(result.signCount, 5);
});

test("an RS256 credential works, and a modulus below 2048 bits is refused", () => {
  const key = rsaKey();
  const made = registration(key);
  const credential = verifyRegistration({ clientDataJSON: made.clientDataJSON, attestationObject: made.attestationObject, expected });
  assert.equal(credential.alg, -257);
  assert.equal(verifyAssertion({ ...assertion(key), expected, stored: { publicKey: credential.publicKey, alg: -257, signCount: 0 } }).signCount, 5);
  const small = registration(rsaKey(1024));
  refused(() => verifyRegistration({ clientDataJSON: small.clientDataJSON, attestationObject: small.attestationObject, expected }), "key");
});

test("a registration is refused for another challenge, origin, relying party, type, a missing user check or an unsupported algorithm", () => {
  const key = ecKey();
  const run = (made: ReturnType<typeof registration>, over: Partial<typeof expected> = {}) =>
    verifyRegistration({ clientDataJSON: made.clientDataJSON, attestationObject: made.attestationObject, expected: { ...expected, ...over } });
  refused(() => run(registration(key), { challenge: randomBytes(32).toString("base64url") }), "challenge");
  refused(() => run(registration(key), { origin: "https://evil.example" }), "origin");
  refused(() => run(registration(key), { rpId: "evil.example" }), "rp");
  refused(() => run(registration(key, { client: clientData("webauthn.get") })), "type");
  refused(() => run(registration(key, { client: clientData("webauthn.create", { crossOrigin: true }) })), "origin");
  const id = randomBytes(32);
  refused(() => run(registration(key, { auth: authData({ flags: 0x01, credential: { id, cose: key.cose } }) })), "verification");
  refused(() => run(registration(key, { auth: authData({ flags: 0x04, credential: { id, cose: key.cose } }) })), "presence");
  refused(() => run(registration(key, { id: randomBytes(8) })), "malformed");
  const eddsa = cbor(new Map<unknown, unknown>([[1, 1], [3, -8], [-1, 6], [-2, randomBytes(32)]]));
  refused(() => run(registration({ cose: eddsa })), "algorithm");
});

test("an assertion is refused for a wrong signature, challenge, origin, relying party or missing user verification", () => {
  const key = ecKey();
  const made = registration(key);
  const credential = verifyRegistration({ clientDataJSON: made.clientDataJSON, attestationObject: made.attestationObject, expected });
  const stored = { publicKey: credential.publicKey, alg: credential.alg, signCount: 0 };
  const run = (over: Parameters<typeof assertion>[1], exp: Partial<typeof expected> = {}) =>
    verifyAssertion({ ...assertion(key, over), expected: { ...expected, ...exp }, stored });
  refused(() => run({ signWith: ecKey() }), "signature");
  refused(() => run({}, { challenge: randomBytes(32).toString("base64url") }), "challenge");
  refused(() => run({}, { origin: "https://evil.example" }), "origin");
  refused(() => run({}, { rpId: "evil.example" }), "rp");
  refused(() => run({ auth: authData({ flags: 0x01, counter: 5 }) }), "verification");
  refused(() => run({ client: clientData("webauthn.create") }), "type");
  // Signed over different bytes than the ones sent.
  const good = assertion(key);
  refused(() => verifyAssertion({ ...good, authenticatorData: authData({ counter: 6 }).toString("base64url"), expected, stored }), "signature");
  refused(() => verifyAssertion({ ...good, expected, stored: { ...stored, alg: -8 } }), "algorithm");
});

test("the signature counter must rise once either side counts, and may stay zero when neither does", () => {
  const key = ecKey();
  const made = registration(key);
  const credential = verifyRegistration({ clientDataJSON: made.clientDataJSON, attestationObject: made.attestationObject, expected });
  const check = (counter: number, held: number) => verifyAssertion({
    ...assertion(key, { auth: authData({ counter }) }), expected, stored: { publicKey: credential.publicKey, alg: credential.alg, signCount: held },
  });
  assert.equal(check(0, 0).signCount, 0);
  assert.equal(check(8, 7).signCount, 8);
  refused(() => check(7, 7), "counter");
  refused(() => check(3, 7), "counter");
  refused(() => check(0, 7), "counter");
});

test("base64url input is strict", () => {
  assert.equal(fromBase64url("AQID", 8).length, 3);
  for (const bad of ["", "AQID=", "AQ ID", "AQ+D", "AQJ", 5, null, "A".repeat(20_000)]) refused(() => fromBase64url(bad, 8), "malformed");
});
