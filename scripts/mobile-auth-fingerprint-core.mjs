// The keyring fingerprint, as approved on 2026-09-08.
//
// Rule: `.github/audits/2026-09-08-mobile-auth-fingerprint-rule-approval.md`
// section 5, first tranche (D1 · D2 · D2a-D2d · D3 · D5 · D7 · D10 · D11),
// approved by `mposition` after reviewing `7c19509`, all as recommended.
// The fixed comparison values are section 5.6 and `tests/
// mobileAuthFingerprint.test.mjs` reproduces every one of them.
//
// ## What the value answers, and what it does not
//
// It answers one question: **is the candidate's material the same as what is
// deployed?** Same fingerprint under the same algorithm means the rotation is
// a rename. That is all. It is not evidence that anything was deployed, that
// the material is usable, or that the entry describes the running deployment
// -- every field of a store entry is written by hand, and binding evidence to
// a deployment is still an open decision (rotation runbook section 6, item 5).
//
// ## Why it is keyed
//
// A signing key has a public half, so hashing it leaks nothing. A pepper does
// not: it is an operator-chosen string with a 32-character floor and no
// entropy floor, so a plain digest of one, written into the non-secret half of
// a store entry, is an offline oracle for a guess. `K` is what stops that, and
// its own conditions are part of the approved rule (section 5.3): CSPRNG
// bytes, 32 of them, stored base64 and used as the decoded bytes, derived from
// no existing key, used for nothing else.
//
// **The fingerprint of a weak pepper is still only as strong as `K`'s
// secrecy.** What to do when `K` may be in someone else's hands is D6, which
// is NOT approved, and this module deliberately contains none of it: no
// rotation, no recomputation policy, no exemption.
//
// ## Shape
//
// Pure, and takes the rings *already parsed*. The rule says the parse is
// `lib/mobileAuthKeyring.ts`'s and no second parser may exist; keeping that
// parser on the caller's side is how this file cannot grow one. It is the same
// division `mobile-auth-keyring-state.mjs` uses -- judgement here, I/O and
// TypeScript imports there.
//
// Nothing here logs, and no error message contains key material: a message
// that quoted the value would be the disclosure the rule exists to prevent.

import { createHmac, createPrivateKey, createPublicKey } from "node:crypto";

/** The rule half of the algorithm identifier. A new rule gets a new number. */
export const MOBILE_FINGERPRINT_RULE_ID = "tv-mobile-keyring-fp-1";

/** Approved key length, in bytes (D2b). SHA-256's output length. */
export const MOBILE_FINGERPRINT_KEY_BYTES = 32;

/** Domain tags. Without them a signing material and a pepper could collide. */
const SIGNING_TAG = "sig";
const PEPPER_TAG = "pep";

const SEPARATOR = Buffer.from([0]);

export class MobileFingerprintError extends Error {}

/**
 * The algorithm identifier written into a store entry.
 *
 * Two halves: the rule, and the generation of `K`. Both matter -- a value
 * computed under a different key is not comparable with this one, and the pair
 * check answers "undetermined" rather than "different" when the identifiers
 * disagree.
 *
 * **The generation label's format is not part of the approved rule.** The
 * examples are `k1`, `k2`. All this enforces is what the identifier's own
 * syntax forces: a non-empty label with no `/` (the separator) and no
 * whitespace. Anything narrower would be a decision nobody made.
 */
export const mobileFingerprintAlgorithm = (generation) => {
  if (typeof generation !== "string" || generation === "") {
    throw new MobileFingerprintError("The key generation label must be a non-empty string.");
  }
  if (/[\s/]/.test(generation)) {
    throw new MobileFingerprintError(
      "The key generation label cannot contain '/' or whitespace: '/' separates it from the rule id."
    );
  }
  return `${MOBILE_FINGERPRINT_RULE_ID}/${generation}`;
};

/**
 * `K` from how it is stored (D2c).
 *
 * Base64 in the vault, **the decoded bytes** in the HMAC. Storing one and
 * hashing the other is the ambiguity this settles: without it the same `K`
 * yields two different fingerprints depending on who implemented it.
 *
 * The refusals never echo the input.
 */
export const mobileFingerprintKeyFromBase64 = (base64) => {
  if (typeof base64 !== "string" || base64.trim() === "") {
    throw new MobileFingerprintError("The fingerprint key must be a non-empty base64 string.");
  }
  let bytes;
  try {
    bytes = Buffer.from(base64, "base64");
  } catch {
    throw new MobileFingerprintError("The fingerprint key is not valid base64.");
  }
  // Node's base64 decoder is lenient, so a round trip is the actual check.
  if (bytes.toString("base64").replace(/=+$/, "") !== base64.trim().replace(/=+$/, "")) {
    throw new MobileFingerprintError("The fingerprint key is not valid base64.");
  }
  if (bytes.length !== MOBILE_FINGERPRINT_KEY_BYTES) {
    throw new MobileFingerprintError(
      `The fingerprint key must be ${MOBILE_FINGERPRINT_KEY_BYTES} bytes; this one decodes to ${bytes.length}.`
    );
  }
  return bytes;
};

/**
 * A signing entry's material: the SPKI DER of the derived public key.
 *
 * The public half, not the private one -- two ring entries holding the same
 * key get the same bytes whatever they are called, which is what makes a
 * rename visible.
 *
 * Unusable material throws. It does not return an empty buffer or a zero
 * digest: a fingerprint computed over "nothing went wrong here" is worse than
 * no fingerprint, because it compares equal to every other failure.
 */
const signingMaterial = (base64Pkcs8) => {
  try {
    const publicKey = createPublicKey(
      createPrivateKey({
        key: Buffer.from(base64Pkcs8, "base64"),
        format: "der",
        type: "pkcs8",
      })
    );
    return publicKey.export({ format: "der", type: "spki" });
  } catch {
    // The material is not named and not quoted. Which entry it was is the
    // caller's to say, from the id it holds.
    throw new MobileFingerprintError(
      "A signing ring entry does not hold a usable PKCS#8 private key, so no fingerprint can be computed."
    );
  }
};

/**
 * A pepper's material: exactly what the parser returned, as UTF-8.
 *
 * No trim, no case folding, no Unicode normalisation. `parseRing()` already
 * trimmed the whole entry, so a trailing space is gone before this sees it and
 * a space right after the colon is part of the secret. Normalising here would
 * give one fingerprint to two values the runtime treats as different.
 */
const pepperMaterial = (secret) => {
  if (typeof secret !== "string") {
    throw new MobileFingerprintError("A pepper ring entry is not a string.");
  }
  return Buffer.from(secret, "utf8");
};

const leaf = (key, tag, material) =>
  createHmac("sha256", key).update(Buffer.concat([Buffer.from(tag, "ascii"), SEPARATOR, material])).digest();

const uint32be = (value) => {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value);
  return buffer;
};

/**
 * Whatever the parser handed back, as a list of secrets.
 *
 * A `Map` from `mobileSigningKeyring()` / `mobileRefreshPepperRing()` is the
 * expected shape; its keys are the ids and the ids are deliberately not part
 * of the calculation. An array of secrets is accepted so a caller that already
 * has them need not build a Map to be ignored.
 */
const secretsOf = (ring) => {
  if (ring instanceof Map) return [...ring.values()];
  if (Array.isArray(ring)) return ring;
  throw new MobileFingerprintError("A ring must be the parser's Map or an array of secrets.");
};

/**
 * Steps 4-7 over materials that are already derived.
 *
 * Exported because **the approved fixed vectors are defined at this level**:
 * section 5.6 names an SPKI DER directly (`302a300506032b6570032100 || aa*32`),
 * and no PKCS#8 private key derives to a public key somebody chose. So those
 * six values pin the leaf construction, the sort, the counts, the byte order
 * and the encoding -- steps 4 through 7 -- and step 2, the derivation, is
 * pinned separately with real generated keys.
 *
 * That is a property of the published vectors, not a gap in the rule. Saying
 * which steps a vector covers is the difference between checking an
 * arithmetic and checking a calculator.
 */
export const mobileKeyringFingerprintFromMaterials = ({ key, signingMaterials, pepperMaterials }) => {
  if (!Buffer.isBuffer(key) && !(key instanceof Uint8Array)) {
    throw new MobileFingerprintError("The fingerprint key must be bytes; decode it first.");
  }
  if (key.length !== MOBILE_FINGERPRINT_KEY_BYTES) {
    throw new MobileFingerprintError(
      `The fingerprint key must be ${MOBILE_FINGERPRINT_KEY_BYTES} bytes.`
    );
  }

  const leaves = [
    ...signingMaterials.map((material) => leaf(key, SIGNING_TAG, material)),
    ...pepperMaterials.map((material) => leaf(key, PEPPER_TAG, material)),
  ].sort(Buffer.compare);

  // The counts are redundant today: every leaf is 32 bytes, so the multiset is
  // recoverable from the concatenation. They are here to make that length
  // assumption explicit -- a future change to the leaf size would otherwise
  // become ambiguous silently rather than needing a new rule id.
  return createHmac("sha256", key)
    .update(
      Buffer.concat([
        Buffer.from(MOBILE_FINGERPRINT_RULE_ID, "ascii"),
        SEPARATOR,
        uint32be(signingMaterials.length),
        uint32be(pepperMaterials.length),
        ...leaves,
      ])
    )
    .digest("hex");
};

/**
 * The fingerprint of both rings, from the parser's own output.
 *
 * Both rings in one value, because the pair check asks about the material as a
 * whole: a pepper-only rotation changes it, and a grace-expired cleanup
 * changes it too. Scoping it to the active key alone would call that cleanup
 * "the same material" and refuse a legitimate candidate.
 *
 * Ids are not in the input, so a rename produces the same value -- that is the
 * point, not an oversight.
 */
export const mobileKeyringFingerprint = ({ key, signing, peppers }) =>
  mobileKeyringFingerprintFromMaterials({
    key,
    signingMaterials: secretsOf(signing).map(signingMaterial),
    pepperMaterials: secretsOf(peppers).map(pepperMaterial),
  });

/**
 * The pair a store entry carries: the value and the identifier that scopes it.
 *
 * Kept together because a fingerprint without its algorithm is a number nobody
 * can compare -- which is the failure the pair check reports as undetermined.
 */
export const mobileKeyringFingerprintEntry = ({ key, generation, signing, peppers }) => ({
  algorithm: mobileFingerprintAlgorithm(generation),
  value: mobileKeyringFingerprint({ key, signing, peppers }),
});
