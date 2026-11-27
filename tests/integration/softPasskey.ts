import { createHash, createSign, generateKeyPairSync, randomBytes } from "node:crypto";

/**
 * A software WebAuthn authenticator (ES256, user verification always done) for the tests that drive the passkey routes:
 * it answers the JSON options the server sends the way a browser and an authenticator would.
 */

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

const sha = (data: string | Buffer) => createHash("sha256").update(data).digest();

type CreationOptions = { rp: { id: string }; challenge: string };
type RequestOptions = { rpId: string; challenge: string; allowCredentials: Array<{ id: string }> };

export function softPasskey(origin: string) {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const cose = cbor(new Map<unknown, unknown>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x!, "base64url")], [-3, Buffer.from(jwk.y!, "base64url")]]));
  const credentialId = randomBytes(32);
  let counter = 0;

  const authData = (rpId: string, flags: number, attested: boolean) => {
    const count = Buffer.alloc(4);
    count.writeUInt32BE(counter);
    const length = Buffer.alloc(2);
    length.writeUInt16BE(credentialId.length);
    return Buffer.concat([sha(rpId), Buffer.from([flags]), count, ...(attested ? [Buffer.alloc(16), length, credentialId, cose] : [])]);
  };

  return {
    credentialId: credentialId.toString("base64url"),
    /** `navigator.credentials.create` for the server's options. */
    create(options: CreationOptions, over: { origin?: string } = {}) {
      const clientData = Buffer.from(JSON.stringify({ type: "webauthn.create", challenge: options.challenge, origin: over.origin ?? origin, crossOrigin: false }));
      const attestation = cbor(new Map<unknown, unknown>([["fmt", "none"], ["attStmt", new Map()], ["authData", authData(options.rp.id, 0x45, true)]]));
      return { credentialId: credentialId.toString("base64url"), clientDataJSON: clientData.toString("base64url"), attestationObject: attestation.toString("base64url") };
    },
    /** `navigator.credentials.get` for the server's options. */
    get(options: RequestOptions, over: { origin?: string; flags?: number } = {}) {
      counter += 1;
      const clientData = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge: options.challenge, origin: over.origin ?? origin, crossOrigin: false }));
      const data = authData(options.rpId, over.flags ?? 0x05, false);
      const signer = createSign("sha256");
      signer.update(Buffer.concat([data, sha(clientData)]));
      return {
        credentialId: credentialId.toString("base64url"), clientDataJSON: clientData.toString("base64url"),
        authenticatorData: data.toString("base64url"), signature: signer.sign(privateKey).toString("base64url"),
      };
    },
  };
}
