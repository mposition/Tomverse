// The shape of the two secret-store entries the rotation contract depends on.
//
// `docs/ops/mobile-auth-key-rotation.md` section 2.2 says the store holds an
// `Active` entry (what is deployed) and a `Pending` entry (the next candidate),
// and that Pending carries five things: a rotationId, a createdAt, a candidate
// fingerprint, a target SHA and, once the deploy exists, its Railway
// deployment id. Saying that in prose left every one of them optional in
// practice, which is how a Pending with no deployment id becomes a rollback
// nobody can aim.
//
// So the entries have a shape, and it is checked. Pure: documents in, problems
// out. The script around it owns files and exits.
//
// ## What this does NOT establish
//
// **A valid pair is not evidence that anything was deployed.** Every field
// here is written by the operator, including the deployment id. This checks
// that the two entries are internally consistent and are not each other's
// leftovers -- nothing more. Whether the running deployment holds the material
// these entries describe is the post-deploy verification, and binding evidence
// to a deployment is still an open decision.
//
// ## Secrets, and why no problem message quotes a value
//
// The rings live in the vault's own secret fields. This document is the
// metadata beside them and is not secret -- which is only true as long as
// nobody pastes a ring into it.
//
// **No message here contains a value read from the document.** The reason a
// value is suspect is usually that it might be key material, and a checker
// that quotes it back does the disclosure it exists to prevent. Messages name
// the *field*; the operator reads the value in their own file. Field names are
// echoed only when they match a conservative pattern, because in JSON a key
// can hold arbitrary text too.

/** Entry kinds. `emergency-pending` is section 5.1's, and has Pending's shape. */
export const MOBILE_STORE_ENTRY_KINDS = ["active", "pending", "emergency-pending"];

/**
 * When in its life an entry was written.
 *
 * `drafted` is before the deploy exists: there is no deployment id to name yet,
 * and requiring one would mean writing a placeholder, which is worse than an
 * absence because it reads as an answer. `deployed` is after, and then it is
 * required -- that id is the only thing that names what a rollback goes back
 * to.
 */
export const MOBILE_STORE_ENTRY_PHASES = ["drafted", "deployed"];

/**
 * The exact placeholders the repository templates carry, and nothing else.
 *
 * The fingerprint rule is undecided, so the templates cannot hold a real
 * value; they hold these. `allowPlaceholders` accepts *these strings*, not
 * "anything that looks unfinished" -- a rule that accepted the shape would
 * accept a real entry somebody left half-written.
 */
export const MOBILE_STORE_FINGERPRINT_PLACEHOLDERS = {
  algorithm: ["<undecided -- see docs/ops/mobile-auth-key-rotation.md section 6>"],
  value: [
    "<the fingerprint of the material this entry describes>",
    "<the fingerprint of the candidate material>",
  ],
};

const ISO_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?Z$/;
const ROTATION_ID = /^[a-z0-9][a-z0-9-]{2,63}$/;
const SHA = /^[0-9a-f]{40}$/;
/** Railway's own ids are UUIDs; anything else is accepted but must be sane. */
const DEPLOYMENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/;
/** A fingerprint is opaque, so only its bounds are checked. See below. */
const FINGERPRINT_VALUE = /^[A-Za-z0-9+/=:._-]{8,128}$/;

/**
 * A real UTC instant, not merely something instant-shaped.
 *
 * The regex alone accepts `2026-13-40T99:99:99Z`, and `Date.parse` alone
 * accepts `2026-02-31` by rolling it into March. Neither is a date somebody
 * meant, and both survive into the pair check, where `NaN` or a silently moved
 * day makes the ordering rule say nothing. So the components are re-derived
 * from the parsed instant and have to come back unchanged.
 */
const isoInstantMs = (value) => {
  if (typeof value !== "string") return undefined;
  const parts = ISO_INSTANT.exec(value);
  if (!parts) return undefined;
  const [, year, month, day, hour, minute, second] = parts.map(Number);
  const ms = Date.UTC(year, month - 1, day, hour, minute, second);
  const back = new Date(ms);
  const same =
    back.getUTCFullYear() === year &&
    back.getUTCMonth() === month - 1 &&
    back.getUTCDate() === day &&
    back.getUTCHours() === hour &&
    back.getUTCMinutes() === minute &&
    back.getUTCSeconds() === second;
  return same ? ms : undefined;
};

/**
 * Things that would mean a ring was pasted in.
 *
 * Not a general secret scanner -- it is the two shapes this document could
 * plausibly be given: an `id:material` ring entry, and a long base64 run.
 */
const looksLikeRing = (value) =>
  /^[A-Za-z0-9_-]{1,64}:[A-Za-z0-9+/=]{24,}/.test(value) ||
  /[A-Za-z0-9+/]{60,}={0,2}/.test(value);

/**
 * The same, for a fingerprint value.
 *
 * **A digest and raw key material cannot be told apart by shape** -- a 64
 * character hex digest and a base64 private key are both long opaque runs, so
 * the general rule above would refuse every real fingerprint. What is left is
 * the realistic paste (a ring, ids and all) plus a length bound, and the
 * limitation is one more thing the undecided fingerprint rule has to answer:
 * whatever it computes must be safe to keep in the non-secret half.
 */
const fingerprintLooksLikeRing = (value) =>
  /^[A-Za-z0-9_-]{1,64}:[A-Za-z0-9+/=]{24,}/.test(value);

const FORBIDDEN_KEYS = [
  "signingRing",
  "refreshPepperRing",
  "signingKeys",
  "refreshPeppers",
  "secret",
  "material",
];

/** Keys an entry may carry, and nothing else: an unknown key can hide a ring. */
const ENTRY_KEYS = [
  "$comment",
  "kind",
  "phase",
  "rotationId",
  "createdAt",
  "fingerprint",
  "targetSha",
  "deploymentId",
];
const FINGERPRINT_KEYS = ["$comment", "algorithm", "value"];

const isPlainObject = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * A field name safe to print.
 *
 * A JSON key is arbitrary text, so an unknown key could itself be the pasted
 * material. Anything that is not a short, plain identifier is described rather
 * than quoted.
 */
const safeName = (key) => (/^[A-Za-z0-9_.$-]{1,40}$/.test(key) ? `"${key}"` : "an unnamed extra field");

/**
 * Every string the document carries, with a printable path to it.
 *
 * Only the structure declared above is walked, because only that structure is
 * allowed -- an object or array somewhere unexpected is refused by the caller
 * before this runs, so there is no corner for a string to hide in.
 */
const stringsIn = (entry) => {
  const found = [];
  const push = (path, value) => {
    if (typeof value === "string") found.push([path, value]);
  };
  for (const [key, value] of Object.entries(entry)) {
    const path = safeName(key);
    if (Array.isArray(value)) {
      value.forEach((item, index) => push(`${path}[${index}]`, item));
    } else if (isPlainObject(value)) {
      for (const [inner, innerValue] of Object.entries(value)) {
        push(`${path}.${safeName(inner)}`, innerValue);
      }
    } else {
      push(path, value);
    }
  }
  return found;
};

/**
 * One entry, judged on its own.
 *
 * Returns problems rather than throwing: an operator fixing a store entry
 * wants the list, not the first one. Pass `allowPlaceholders` only for the
 * repository templates.
 */
export const mobileStoreEntryProblems = (entry, label = "entry", { allowPlaceholders = false } = {}) => {
  const problems = [];
  const say = (message) => problems.push(`${label}: ${message}`);

  if (!isPlainObject(entry)) {
    return [`${label}: is not a JSON object.`];
  }

  if (!MOBILE_STORE_ENTRY_KINDS.includes(entry.kind)) {
    // The value is not quoted back: it is unvalidated input like any other.
    say(`kind is not one of ${MOBILE_STORE_ENTRY_KINDS.join(", ")}.`);
  }
  if (!MOBILE_STORE_ENTRY_PHASES.includes(entry.phase)) {
    say(`phase is not one of ${MOBILE_STORE_ENTRY_PHASES.join(", ")}.`);
  }
  if (typeof entry.rotationId !== "string" || !ROTATION_ID.test(entry.rotationId)) {
    say("rotationId must be 3-64 characters of a-z, 0-9 and '-', starting alphanumeric.");
  }
  if (isoInstantMs(entry.createdAt) === undefined) {
    say("createdAt must be a real UTC instant like 2026-09-03T10:00:00Z (2026-02-31 is not a day).");
  }
  if (typeof entry.targetSha !== "string" || !SHA.test(entry.targetSha)) {
    say("targetSha must be the full 40-character commit SHA.");
  }

  // The fingerprint's *value* cannot be judged here: how it is computed is not
  // decided. What is checked is that the entry says which algorithm produced
  // it, so a later reader can tell two fingerprints apart instead of comparing
  // numbers from different rules.
  if (!isPlainObject(entry.fingerprint)) {
    say("fingerprint must be an object with algorithm and value.");
  } else {
    for (const key of Object.keys(entry.fingerprint)) {
      if (!FINGERPRINT_KEYS.includes(key)) {
        say(`fingerprint carries ${safeName(key)}, which is not part of its shape (algorithm, value).`);
      }
    }
    for (const field of ["algorithm", "value"]) {
      const value = entry.fingerprint[field];
      const placeholders = MOBILE_STORE_FINGERPRINT_PLACEHOLDERS[field];
      if (typeof value !== "string" || value.trim() === "") {
        say(
          field === "algorithm"
            ? "fingerprint.algorithm must name how the value was computed."
            : "fingerprint.value must not be empty."
        );
        continue;
      }
      if (placeholders.includes(value)) {
        // Exactly the template's placeholder. Tolerated only when the caller
        // says it is checking the templates; anywhere else it is unfinished.
        if (!allowPlaceholders) {
          say(`fingerprint.${field} is still the template placeholder, which is not a value.`);
        }
        continue;
      }
      if (field === "value" && !FINGERPRINT_VALUE.test(value)) {
        say("fingerprint.value must be 8-128 characters of A-Za-z0-9 and +/=:._- .");
      }
    }
  }

  // Active is what is deployed, so it always names the deployment. Pending
  // before its deploy does not have one to name.
  const deployed = entry.kind === "active" || entry.phase === "deployed";
  const hasDeploymentId =
    typeof entry.deploymentId === "string" && entry.deploymentId.trim() !== "";
  if (deployed && !hasDeploymentId) {
    say(
      entry.kind === "active"
        ? "an active entry names what is deployed, so deploymentId is required."
        : "phase is deployed, so deploymentId is required -- it is the only thing a rollback can aim at."
    );
  }
  if (!deployed && entry.deploymentId !== undefined) {
    say(
      "phase is drafted, so deploymentId must be absent rather than empty or a placeholder: an absent field reads as 'not yet', a placeholder reads as an answer."
    );
  }
  if (hasDeploymentId && !DEPLOYMENT_ID.test(entry.deploymentId)) {
    say("deploymentId does not look like an id (8-128 characters of A-Z, a-z, 0-9, '.', '_', '-').");
  }
  if (entry.kind === "active" && entry.phase !== "deployed") {
    say("an active entry is by definition deployed, so its phase is 'deployed'.");
  }

  // Structure first: the ring scan below only reaches strings, so a nested
  // object or array somewhere unexpected would be a place it cannot look.
  for (const [key, value] of Object.entries(entry)) {
    if (FORBIDDEN_KEYS.includes(key)) {
      say(`has a ${safeName(key)} field. The rings live in the vault's secret fields, never in this document.`);
      continue;
    }
    if (!ENTRY_KEYS.includes(key)) {
      say(`carries ${safeName(key)}, which is not part of an entry. Extra fields are refused because nothing checks what is inside them.`);
      continue;
    }
    if (key === "$comment") {
      if (!Array.isArray(value) && typeof value !== "string") {
        say("$comment must be a string or an array of strings.");
      } else if (Array.isArray(value) && value.some((item) => typeof item !== "string")) {
        say("$comment must contain only strings.");
      }
      continue;
    }
    if (key === "fingerprint") continue;
    if (typeof value !== "string") {
      say(`${safeName(key)} must be a string; an entry has no nested structure other than fingerprint.`);
    }
  }

  for (const [path, value] of stringsIn(entry)) {
    const ring = path.startsWith('"fingerprint"') ? fingerprintLooksLikeRing(value) : looksLikeRing(value);
    if (ring) {
      // The value is not repeated: if it is a ring, quoting it back is the
      // mistake this check exists to prevent.
      say(`the value at ${path} looks like key material. This document is metadata; the rings live in the vault's secret fields.`);
    }
  }

  return problems;
};

/**
 * The two entries together.
 *
 * Every rule here is about one entry being the other's leftover, which is what
 * a stale Pending is and what makes it dangerous: it reads as a candidate.
 * As above, no message quotes a value.
 */
export const mobileStorePairProblems = ({ active, pending }) => {
  const problems = [];
  if (!isPlainObject(active) || !isPlainObject(pending)) return problems;

  if (active.rotationId && active.rotationId === pending.rotationId) {
    problems.push(
      "pair: both entries carry the same rotationId. A Pending that is the same rotation as Active is what is already deployed, left behind."
    );
  }

  // Fingerprints are only comparable under one rule. Two values computed by
  // different algorithms are not the same measurement, so equality between
  // them means nothing and inequality proves nothing -- the leftover check
  // simply cannot run, and saying so is not the same as passing.
  const activeAlgorithm = active.fingerprint?.algorithm;
  const pendingAlgorithm = pending.fingerprint?.algorithm;
  const bothNamed =
    typeof activeAlgorithm === "string" &&
    activeAlgorithm.trim() !== "" &&
    typeof pendingAlgorithm === "string" &&
    pendingAlgorithm.trim() !== "";
  if (bothNamed && activeAlgorithm !== pendingAlgorithm) {
    problems.push(
      "pair: the two entries name different fingerprint algorithms, so whether they describe the same material is undetermined. Recompute both under one rule -- an undetermined answer is not a pass."
    );
  } else if (
    bothNamed &&
    active.fingerprint?.value &&
    active.fingerprint.value === pending.fingerprint?.value
  ) {
    problems.push(
      "pair: the two entries have the same fingerprint under the same algorithm. A candidate whose material equals what is deployed is not a rotation -- renaming is not rotating."
    );
  }

  if (active.deploymentId && active.deploymentId === pending.deploymentId) {
    problems.push(
      "pair: both entries name the same deployment. Pending names the deploy that carried *it*, which cannot be the one Active came from."
    );
  }
  const activeAt = isoInstantMs(active.createdAt);
  const pendingAt = isoInstantMs(pending.createdAt);
  if (activeAt !== undefined && pendingAt !== undefined && pendingAt < activeAt) {
    problems.push(
      "pair: Pending was created before Active. A candidate older than what is deployed is a leftover from a rotation that already finished or was abandoned."
    );
  }
  if (pending.kind === "active") {
    problems.push("pair: the pending entry declares itself active.");
  }
  if (active.kind !== "active") {
    problems.push("pair: the active entry does not declare kind 'active'.");
  }
  return problems;
};

/**
 * What this check is not, in one line the caller prints.
 *
 * Kept here so it travels with the judgement rather than being a sentence
 * somebody remembers to add.
 */
export const MOBILE_STORE_ENTRY_DISCLAIMER =
  "Structure only. Every field here is written by hand, including the deployment id, " +
  "so a valid pair is not evidence that anything was deployed or that the running " +
  "deployment holds this material.";
