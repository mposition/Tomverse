/**
 * What the mobile auth key rings look like at one instant, assembled once.
 *
 * Two callers: `scripts/report-mobile-auth-keyring-health.mjs`, which renders
 * this for a person, and the internal endpoint the standing check calls, which
 * records it. **One assembly, because a second would eventually disagree** --
 * the same reason the judgement itself lives in one place
 * (`scripts/mobile-auth-keyring-state.mjs`, shared with the pre-deploy check).
 *
 * Contract: `.github/audits/2026-09-10-mobile-auth-keyring-standing-check-approval.md`
 * S1-S8, approved 2026-09-10. Procedure: `docs/ops/mobile-auth-key-rotation.md`.
 *
 * **No `server-only`, deliberately.** The CLI runs without
 * `--conditions=react-server`, and importing `server-only` there throws before
 * the first line of work. Nothing here touches Prisma, a request, or a session:
 * it reads an environment and does crypto.
 *
 * **It reports and it does not act.** No key is written, deleted, rotated or
 * re-declared; no scheduler is registered and nothing is sent.
 */

import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";

import {
  MOBILE_ACTIVE_REFRESH_PEPPER_ENV,
  MOBILE_ACTIVE_SIGNING_KEY_ENV,
  MOBILE_REFRESH_PEPPERS_ENV,
  MOBILE_RETIRED_REFRESH_PEPPERS_ENV,
  MOBILE_RETIRED_SIGNING_KEYS_ENV,
  MOBILE_SIGNING_KEYS_ENV,
  MOBILE_TOKEN_AUDIENCE_ENV,
  MOBILE_TOKEN_ISSUER_ENV,
  mobileRefreshPepperRetirements,
  mobileRefreshPepperRing,
  mobileSigningKeyRetirements,
  mobileSigningKeyring,
  normalizeMobileKeyId,
} from "@/lib/mobileAuthKeyring";
import {
  MOBILE_PREVIOUS_PEPPER_SECONDS,
  MOBILE_PREVIOUS_SIGNING_KEY_SECONDS,
} from "@/lib/mobileAuthContract";
import {
  classifyMobileRing,
  mobileAuthConfigurationState,
  mobileRingFindings,
  unmatchedMobileRetirements,
} from "@/scripts/mobile-auth-keyring-state.mjs";

type Environment = Record<string, string | undefined>;

/**
 * The shared judgement module is plain `.mjs` -- it has no imports at all, so
 * both the pre-deploy check and this can load it, and neither gets a second
 * opinion. Its parameter types are inferred from defaults of `null`, so the
 * signatures are written out here rather than at every call site.
 */
type RingInput = {
  ring: ReadonlyMap<string, string>;
  retirements: ReadonlyMap<string, number>;
  activeKeyId: string;
  graceSeconds: number;
  nowMs: number;
};
const classifyRing = classifyMobileRing as (input: RingInput) => MobileRingKeyState[];
const ringFindings = mobileRingFindings as (
  input: RingInput & {
    rawRetirements: string | undefined;
    signsAndVerifies: ((material: string) => boolean) | null;
    materialIdentity: ((material: string) => string | null) | null;
  }
) => MobileKeyringFinding[];
const unmatchedRetirements = unmatchedMobileRetirements as (input: {
  ring: ReadonlyMap<string, string>;
  rawRetirements: string | undefined;
}) => string[];
const configurationState = mobileAuthConfigurationState as (input: {
  required: string[];
  optional: string[];
  isSet: (variable: string) => boolean;
}) => { state: string; missing: string[] };

/** Without these six there is no mobile auth to report on. */
export const MOBILE_AUTH_KEYRING_REQUIRED_ENV = [
  MOBILE_SIGNING_KEYS_ENV,
  MOBILE_ACTIVE_SIGNING_KEY_ENV,
  MOBILE_REFRESH_PEPPERS_ENV,
  MOBILE_ACTIVE_REFRESH_PEPPER_ENV,
  MOBILE_TOKEN_ISSUER_ENV,
  MOBILE_TOKEN_AUDIENCE_ENV,
];

/** Set during a rotation, absent the rest of the time. */
export const MOBILE_AUTH_KEYRING_OPTIONAL_ENV = [
  MOBILE_RETIRED_SIGNING_KEYS_ENV,
  MOBILE_RETIRED_REFRESH_PEPPERS_ENV,
];

export type MobileKeyringFinding = {
  code: string;
  keyId?: string;
  otherKeyId?: string;
  retiredAtMs?: number;
  /**
   * The finding names something the configuration referred to but the ring
   * does not contain, so its value was **not** reported. See
   * `withoutUnverifiedReferences`.
   */
  unverifiedReference?: boolean;
  /**
   * The id this finding is about is byte-for-byte a secret in one of the
   * rings, so it was **not** reported. See `redactIdsMatchingMaterial`.
   */
  idMatchesMaterial?: boolean;
};

/** One ring entry, exactly as the shared judgement module describes it. */
export type MobileRingKeyState = {
  /** Null when the id is itself key material -- see `redactIdsMatchingMaterial`. */
  keyId: string | null;
  state: string;
  alsoRetired: boolean;
  retiredAtMs: number | null;
  expiresAtMs: number | null;
  remainingSeconds: number | null;
};

export type MobileKeyringHealthReport = {
  observedAt: string;
  configuration: { state: string; missing: string[] };
  rings: {
    variable: string;
    graceSeconds: number;
    keys: MobileRingKeyState[];
    /**
     * How many retirement lines name an id the ring does not hold. A count
     * rather than the ids: what a retirement line names is unverified text.
     */
    retirementsNamingNothing: number;
    findings: MobileKeyringFinding[];
  }[];
  /** Every finding, already worded, one line each. */
  attention: string[];
};

/**
 * The same probes the pre-deploy check uses, for the findings that need
 * crypto: can the active key sign, and are two ids holding one key.
 */
const signsAndVerifies = (base64Pkcs8: string) => {
  try {
    const privateKey = createPrivateKey({
      key: Buffer.from(base64Pkcs8, "base64"),
      format: "der",
      type: "pkcs8",
    });
    const probe = Buffer.from("mobile-auth-keyring-check", "utf8");
    return verify(null, probe, createPublicKey(privateKey), sign(null, probe, privateKey));
  } catch {
    return false;
  }
};

/** A hash of the derived public key: nothing secret, and equal for equal keys. */
const signingIdentity = (base64Pkcs8: string) => {
  try {
    const publicKey = createPublicKey(
      createPrivateKey({
        key: Buffer.from(base64Pkcs8, "base64"),
        format: "der",
        type: "pkcs8",
      })
    );
    return createHash("sha256")
      .update(publicKey.export({ format: "der", type: "spki" }))
      .digest("hex");
  } catch {
    return null;
  }
};

/**
 * Pepper equality, as a digest and per call.
 *
 * A pepper has no derived public form, so equality has to be computed from the
 * material itself, and two things follow that a one-shot CLI could ignore and
 * a long-lived server cannot.
 *
 * **A digest, not the material.** The identity is only ever used as a map key
 * for duplicate detection, so a hash answers the same question and nothing
 * downstream can end up holding a pepper by accident.
 *
 * **Per call, not module-level.** A map built once at import would keep every
 * pepper the process has ever seen for the life of the process. This one is
 * created for a report and dropped with it. S1's second condition, approved
 * 2026-09-10.
 *
 * Exported so a test can hold the property rather than a symptom: a
 * comparator that kept a map keyed by the material would return the secret
 * itself as the identity, and asserting the returned value is a digest
 * catches that where a duplicate-detection assertion cannot -- the `seen` map
 * that detection uses is per call either way.
 */
export const mobileAuthPepperIdentity = () => (secret: string) =>
  createHash("sha256").update(`mobile-auth-pepper ${secret}`, "utf8").digest("hex");

/**
 * The codes whose `keyId` is text the configuration supplied and the ring did
 * not confirm.
 *
 * `active_key_not_in_ring` echoes whatever the active-id variable held, and
 * `retirement_names_nothing` echoes the left half of a retirement line. Both
 * are read before anything checks them against the ring -- `normalizeMobileKeyId`
 * only trims, and `KEY_ID_PATTERN` accepts 64 characters of `[A-Za-z0-9._-]`,
 * which a base64url pepper satisfies. So a ring pasted into the active-id
 * variable came back as a `keyId` in the response, the log and the run row.
 *
 * The value is dropped and the variable is named instead: an operator needs to
 * know *which* variable refers to nothing, and the value is the one thing that
 * cannot be shown.
 *
 * **What this does not cover, said plainly.** Material pasted into the *id*
 * half of a ring entry becomes a declared id, and declared ids are quoted --
 * they are also the `kid` of every token the deployment issues, so the system
 * publishes them either way. Bounding the unverified references is what is
 * possible here; making an id unrecognisable as material is not.
 */
const UNVERIFIED_REFERENCE_CODES = new Set([
  "active_key_not_in_ring",
  "retirement_names_nothing",
]);

/** Drops the value of any reference the ring did not confirm. */
const withoutUnverifiedReferences = (finding: MobileKeyringFinding): MobileKeyringFinding =>
  UNVERIFIED_REFERENCE_CODES.has(finding.code)
    ? { code: finding.code, unverifiedReference: true }
    : finding;

/**
 * A declared id is not safe merely because the ring declared it.
 *
 * An earlier version of this file said quoting declared ids was harmless
 * because they are the `kid` of every issued token. **That was wrong.** Only
 * the *active* signing id becomes a `kid`, and a refresh token is
 * `recordId.secret` -- so an id belonging to an inactive entry appears in no
 * token at all. A ring written as `p:<P>,<P>:<Q>` puts the active pepper `<P>`
 * in the id position of the second entry, and `<P>` was reported as an
 * `undeclared` key id in the response, the log and the row while appearing in
 * nothing the deployment issued. Reproduced 2026-09-10.
 *
 * So an id that is byte-for-byte a secret in either ring is withheld, and the
 * condition is reported as a finding of its own -- the operator has to know
 * the configuration is like this, and cannot be told by being shown it.
 */
const KEY_ID_MATCHES_MATERIAL = "key_id_matches_material";

const redactIdsMatchingMaterial = (
  finding: MobileKeyringFinding,
  material: ReadonlySet<string>
): MobileKeyringFinding => {
  const hides =
    (finding.keyId !== undefined && material.has(finding.keyId)) ||
    (finding.otherKeyId !== undefined && material.has(finding.otherKeyId));
  if (!hides) return finding;
  const redacted: MobileKeyringFinding = { ...finding, idMatchesMaterial: true };
  if (redacted.keyId !== undefined && material.has(redacted.keyId)) delete redacted.keyId;
  if (redacted.otherKeyId !== undefined && material.has(redacted.otherKeyId)) {
    delete redacted.otherKeyId;
  }
  return redacted;
};

/**
 * One sentence per finding code. Exhaustive on purpose: a code with no entry
 * here would be dropped silently.
 */
/**
 * How an id is named in prose, or how its absence is.
 *
 * Withheld ids are the norm rather than the exception here -- two of the
 * redaction rules above can remove one -- so every sentence that would have
 * quoted an id goes through this instead of interpolating it. An earlier
 * version interpolated directly and printed `"undefined"` the moment a
 * redaction fired, which reads as a key called "undefined".
 */
const named = (keyId: string | undefined) =>
  keyId === undefined ? "an id that is not shown (it is key material)" : `"${keyId}"`;

const FINDING_TEXT: Record<string, (finding: MobileKeyringFinding) => string> = {
  no_active_key_named: () => "no active key is named.",
  // No value: what the active-id variable holds is unverified text.
  active_key_not_in_ring: () =>
    "the active id is not in the ring, so nothing can be minted. The value is not shown -- read the active-id variable.",
  active_key_also_retired: ({ keyId }) =>
    `${named(keyId)} is the active key and is also retired, so minting is refused now rather than when the retirement instant arrives.`,
  active_key_cannot_sign: ({ keyId }) =>
    `the active key ${named(keyId)} cannot sign. Every mobile auth request answers 503.`,
  undeclared: ({ keyId }) =>
    `${named(keyId)} is neither active nor retired, so it verifies nothing.`,
  retirement_in_future: ({ keyId, retiredAtMs }) =>
    `${named(keyId)} is retired at ${new Date(retiredAtMs ?? 0).toISOString()}, which has not arrived, so it verifies nothing.`,
  grace_over: ({ keyId }) =>
    `${named(keyId)} has spent its window and verifies nothing. Removing it and its retirement line together is tidy, and optional.`,
  retirement_names_nothing: () =>
    "a retirement names an id that is not in the ring. The value is not shown -- read the retirement variable.",
  duplicate_material: ({ keyId, otherKeyId }) =>
    `${named(keyId)} and ${named(otherKeyId)} are different ids holding the same material. Renaming a key is not rotating it.`,
  [KEY_ID_MATCHES_MATERIAL]: () =>
    "an entry's id is byte-for-byte a key in one of the rings, so the id is not shown. Key material was pasted into an id position -- rewrite the entry, and treat that material as disclosed to whoever can read the variable.",
};

/** The wording for one finding, or a last-resort line naming the code. */
export const mobileKeyringFindingText = (finding: MobileKeyringFinding) =>
  FINDING_TEXT[finding.code]?.(finding) ?? `${finding.code} (no wording for this code).`;

/**
 * The report, or a throw.
 *
 * Throws only when a ring will not parse, and both callers agree on what that
 * means: **every line the report could produce would be about something other
 * than what is configured**, so neither of them shows any of it.
 */
export const mobileAuthKeyringHealthReport = (
  options: { environment?: Environment; nowMs?: number } = {}
): MobileKeyringHealthReport => {
  const environment = options.environment ?? process.env;
  const nowMs = options.nowMs ?? Date.now();
  const isSet = (variable: string) => (environment[variable] ?? "").trim() !== "";

  const configuration = configurationState({
    required: MOBILE_AUTH_KEYRING_REQUIRED_ENV,
    optional: MOBILE_AUTH_KEYRING_OPTIONAL_ENV,
    isSet,
  });

  if (configuration.state !== "configured") {
    // Partial configuration is a finding, not a quiet fact: every mobile
    // endpoint answers 503 and none of them says which variable is missing.
    return {
      observedAt: new Date(nowMs).toISOString(),
      configuration,
      rings: [],
      attention:
        configuration.state === "partial"
          ? [
              `partly configured: ${configuration.missing.join(", ")} missing. ` +
                "Mobile auth answers 503 to every request, and the endpoints do not say which variable it is.",
            ]
          : [],
    };
  }

  const identityForPeppers = mobileAuthPepperIdentity();
  const inputs: {
    variable: string;
    graceSeconds: number;
    ring: ReadonlyMap<string, string>;
    retirements: ReadonlyMap<string, number>;
    raw: string | undefined;
    activeKeyId: string;
    signsAndVerifies: ((material: string) => boolean) | null;
    materialIdentity: (material: string) => string | null;
  }[] = [
    {
      variable: MOBILE_SIGNING_KEYS_ENV,
      graceSeconds: MOBILE_PREVIOUS_SIGNING_KEY_SECONDS,
      ring: mobileSigningKeyring(environment),
      retirements: mobileSigningKeyRetirements(environment),
      raw: environment[MOBILE_RETIRED_SIGNING_KEYS_ENV],
      activeKeyId: normalizeMobileKeyId(environment[MOBILE_ACTIVE_SIGNING_KEY_ENV]),
      signsAndVerifies,
      materialIdentity: signingIdentity,
    },
    {
      variable: MOBILE_REFRESH_PEPPERS_ENV,
      graceSeconds: MOBILE_PREVIOUS_PEPPER_SECONDS,
      ring: mobileRefreshPepperRing(environment),
      retirements: mobileRefreshPepperRetirements(environment),
      raw: environment[MOBILE_RETIRED_REFRESH_PEPPERS_ENV],
      activeKeyId: normalizeMobileKeyId(environment[MOBILE_ACTIVE_REFRESH_PEPPER_ENV]),
      // A pepper is an HMAC key, not a signer: there is nothing to sign with.
      signsAndVerifies: null,
      materialIdentity: identityForPeppers,
    },
  ];

  // Every secret both rings hold, so an id can be checked against all of them
  // -- a signing id may be a pepper, and the rings are parsed independently.
  const material: ReadonlySet<string> = new Set(
    inputs.flatMap((entry) => [...entry.ring.values()])
  );

  const attention: string[] = [];
  const rings = inputs.map((entry) => {
    const keys = classifyRing({
      ring: entry.ring,
      retirements: entry.retirements,
      activeKeyId: entry.activeKeyId,
      graceSeconds: entry.graceSeconds,
      nowMs,
    });
    // Counted, not listed: see `withoutUnverifiedReferences`.
    const retirementsNamingNothing = unmatchedRetirements({
      ring: entry.ring,
      rawRetirements: entry.raw,
    }).length;
    // Wording, not judgement: which findings exist is decided once, in the
    // shared module, and said in two places with two consequences.
    const findings = ringFindings({
      ring: entry.ring,
      retirements: entry.retirements,
      rawRetirements: entry.raw,
      activeKeyId: entry.activeKeyId,
      graceSeconds: entry.graceSeconds,
      nowMs,
      signsAndVerifies: entry.signsAndVerifies,
      materialIdentity: entry.materialIdentity,
    })
      .map(withoutUnverifiedReferences)
      .map((finding) => redactIdsMatchingMaterial(finding, material));

    // Same rule for the per-key listing: it names every id in the ring, and
    // the finding list is not the only place an id is printed.
    const safeKeys = keys.map((key) =>
      key.keyId !== null && material.has(key.keyId) ? { ...key, keyId: null } : key
    );
    if (safeKeys.some((key) => key.keyId === null)) {
      findings.push({ code: KEY_ID_MATCHES_MATERIAL, idMatchesMaterial: true });
    }

    for (const finding of findings) {
      attention.push(`${entry.variable}: ${mobileKeyringFindingText(finding)}`);
    }
    return {
      variable: entry.variable,
      graceSeconds: entry.graceSeconds,
      keys: safeKeys,
      retirementsNamingNothing,
      findings,
    };
  });

  return {
    observedAt: new Date(nowMs).toISOString(),
    configuration,
    rings,
    attention,
  };
};
