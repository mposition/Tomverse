/**
 * The browser's half of the passkey that confirms a remote approval (docs/ops/desktop-remote-control.md): turns the
 * server's JSON options into what `navigator.credentials` takes, and the answer back into base64url text. The server
 * checks everything; nothing here decides whether a passkey is valid.
 */

type CredentialDescriptor = { type: "public-key"; id: string };
type CreationJson = {
  rp: { id: string; name: string };
  user: { id: string; name: string; displayName: string };
  challenge: string;
  pubKeyCredParams: Array<{ type: "public-key"; alg: number }>;
  timeout: number;
  attestation: "none";
  authenticatorSelection: { residentKey: "discouraged"; userVerification: "required" };
  excludeCredentials: CredentialDescriptor[];
};
type RequestJson = {
  rpId: string;
  challenge: string;
  timeout: number;
  userVerification: "required";
  allowCredentials: CredentialDescriptor[];
};

export type PasskeyCreation = { credentialId: string; clientDataJSON: string; attestationObject: string };
export type PasskeyAssertion = { credentialId: string; clientDataJSON: string; authenticatorData: string; signature: string };

export const passkeysSupported = () =>
  typeof window !== "undefined" && typeof window.PublicKeyCredential === "function" && typeof navigator !== "undefined" && Boolean(navigator.credentials);

function bytes(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) out[index] = binary.charCodeAt(index);
  return out;
}

function text(buffer: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

const descriptors = (list: CredentialDescriptor[]): PublicKeyCredentialDescriptor[] => list.map((entry) => ({ type: entry.type, id: bytes(entry.id) }));

/** Makes a passkey. Rejects when the person cancels or the authenticator refuses. */
export async function createPasskey(options: CreationJson): Promise<PasskeyCreation> {
  const credential = await navigator.credentials.create({
    publicKey: {
      ...options, challenge: bytes(options.challenge), user: { ...options.user, id: bytes(options.user.id) },
      excludeCredentials: descriptors(options.excludeCredentials),
    },
  });
  if (!(credential instanceof PublicKeyCredential) || !(credential.response instanceof AuthenticatorAttestationResponse)) throw new Error("No passkey was made.");
  return { credentialId: text(credential.rawId), clientDataJSON: text(credential.response.clientDataJSON), attestationObject: text(credential.response.attestationObject) };
}

/** Signs the challenge with one of the account's passkeys. Rejects when the person cancels or the authenticator refuses. */
export async function getPasskeyAssertion(options: RequestJson): Promise<PasskeyAssertion> {
  const credential = await navigator.credentials.get({
    publicKey: { ...options, challenge: bytes(options.challenge), allowCredentials: descriptors(options.allowCredentials) },
  });
  if (!(credential instanceof PublicKeyCredential) || !(credential.response instanceof AuthenticatorAssertionResponse)) throw new Error("No passkey answered.");
  return {
    credentialId: text(credential.rawId), clientDataJSON: text(credential.response.clientDataJSON),
    authenticatorData: text(credential.response.authenticatorData), signature: text(credential.response.signature),
  };
}

export type PasskeyCreationOptions = CreationJson;
export type PasskeyRequestOptions = RequestJson;
