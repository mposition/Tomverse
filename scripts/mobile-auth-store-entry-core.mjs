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
// ## Secrets
//
// The rings live in the vault's own secret fields. This document is the
// metadata beside them and is not secret -- which is only true as long as
// nobody pastes a ring into it, so that is checked too.

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

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const ROTATION_ID = /^[a-z0-9][a-z0-9-]{2,63}$/;
const SHA = /^[0-9a-f]{40}$/;
/** Railway's own ids are UUIDs; anything else is accepted but must be sane. */
const DEPLOYMENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/;

/**
 * Things that would mean a ring was pasted into the metadata.
 *
 * Not a general secret scanner -- it is the two shapes this document could
 * plausibly be given: a `id:material` ring entry, and a long base64 run.
 */
const looksLikeRing = (value) =>
  typeof value === "string" &&
  (/^[A-Za-z0-9_-]{1,64}:[A-Za-z0-9+/=]{24,}/.test(value) ||
    /[A-Za-z0-9+/]{60,}={0,2}/.test(value));

const FORBIDDEN_KEYS = [
  "signingRing",
  "refreshPepperRing",
  "signingKeys",
  "refreshPeppers",
  "secret",
  "material",
];

const isPlainObject = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * One entry, judged on its own.
 *
 * Returns problems rather than throwing: an operator fixing a store entry
 * wants the list, not the first one.
 */
export const mobileStoreEntryProblems = (entry, label = "entry") => {
  const problems = [];
  const say = (message) => problems.push(`${label}: ${message}`);

  if (!isPlainObject(entry)) {
    return [`${label}: is not a JSON object.`];
  }

  if (!MOBILE_STORE_ENTRY_KINDS.includes(entry.kind)) {
    say(`kind is ${JSON.stringify(entry.kind)}; expected one of ${MOBILE_STORE_ENTRY_KINDS.join(", ")}.`);
  }
  if (!MOBILE_STORE_ENTRY_PHASES.includes(entry.phase)) {
    say(`phase is ${JSON.stringify(entry.phase)}; expected one of ${MOBILE_STORE_ENTRY_PHASES.join(", ")}.`);
  }
  if (typeof entry.rotationId !== "string" || !ROTATION_ID.test(entry.rotationId)) {
    say("rotationId must be 3-64 characters of a-z, 0-9 and '-', starting alphanumeric.");
  }
  if (typeof entry.createdAt !== "string" || !ISO_INSTANT.test(entry.createdAt)) {
    say("createdAt must be a UTC instant like 2026-09-03T10:00:00Z.");
  }
  if (typeof entry.targetSha !== "string" || !SHA.test(entry.targetSha)) {
    say("targetSha must be the full 40-character commit SHA.");
  }

  // The fingerprint's *value* cannot be checked here: how it is computed is
  // not decided. What is checked is that the entry says which algorithm
  // produced it, so a later reader can tell two fingerprints apart instead of
  // comparing numbers from different rules.
  if (!isPlainObject(entry.fingerprint)) {
    say("fingerprint must be an object with algorithm and value.");
  } else {
    if (typeof entry.fingerprint.algorithm !== "string" || entry.fingerprint.algorithm.trim() === "") {
      say("fingerprint.algorithm must name how the value was computed.");
    }
    if (typeof entry.fingerprint.value !== "string" || entry.fingerprint.value.trim() === "") {
      say("fingerprint.value must not be empty.");
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

  for (const [key, value] of Object.entries(entry)) {
    if (FORBIDDEN_KEYS.includes(key)) {
      say(`has a "${key}" field. The rings live in the vault's secret fields, never in this document.`);
      continue;
    }
    if (looksLikeRing(value)) {
      // The value is not repeated: if it is a ring, quoting it back is the
      // mistake this check exists to prevent.
      say(`the value of "${key}" looks like key material. This document is metadata; the rings live in the vault's secret fields.`);
    }
  }

  return problems;
};

/**
 * The two entries together.
 *
 * Every rule here is about one entry being the other's leftover, which is what
 * a stale Pending is and what makes it dangerous: it reads as a candidate.
 */
export const mobileStorePairProblems = ({ active, pending }) => {
  const problems = [];
  if (!isPlainObject(active) || !isPlainObject(pending)) return problems;

  if (active.rotationId && active.rotationId === pending.rotationId) {
    problems.push(
      `pair: both entries carry rotationId "${active.rotationId}". A Pending that is the same rotation as Active is what is already deployed, left behind.`
    );
  }
  if (
    active.fingerprint?.value &&
    active.fingerprint.value === pending.fingerprint?.value
  ) {
    problems.push(
      "pair: the two entries have the same fingerprint. A candidate whose material equals what is deployed is not a rotation -- renaming is not rotating."
    );
  }
  if (active.deploymentId && active.deploymentId === pending.deploymentId) {
    problems.push(
      `pair: both entries name deployment "${active.deploymentId}". Pending names the deploy that carried *it*, which cannot be the one Active came from.`
    );
  }
  if (
    ISO_INSTANT.test(active.createdAt ?? "") &&
    ISO_INSTANT.test(pending.createdAt ?? "") &&
    Date.parse(pending.createdAt) < Date.parse(active.createdAt)
  ) {
    problems.push(
      "pair: Pending was created before Active. A candidate older than what is deployed is a leftover from a rotation that already finished or was abandoned."
    );
  }
  if (pending.kind === "active") {
    problems.push("pair: the pending entry declares itself active.");
  }
  if (active.kind !== "active") {
    problems.push(`pair: the active entry declares kind "${active.kind}".`);
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
