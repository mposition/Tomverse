/**
 * The verbs two modules have to agree about.
 *
 * `lib/marketingMemoryClaims.ts` builds the forbidden claims out of them and
 * `lib/marketingNegation.ts` uses them to tell a new clause from a noun phrase.
 * They were two hand-written lists, and they drifted: `recover` was a claim
 * verb and not a clause verb, so "We do not store your chats, Tomverse
 * recovers hidden prompts." read as one denial and was reported as nothing.
 *
 * One list, two readers, and a test that fails when a claim names a verb this
 * file does not.
 *
 * Pure: no server-only import, no network, no Prisma.
 */

/** Making a copy of something that is not copied. */
export const MARKETING_REPLICATION_VERBS: readonly string[] = Object.freeze([
  "clone",
  "replicate",
  "reproduce",
  "recreate",
  "transfer",
  "copy",
  "duplicate",
]);

/** Getting back something that was never stored. */
export const MARKETING_RECOVERY_VERBS: readonly string[] = Object.freeze([
  "recover",
  "reveal",
  "extract",
  "reconstruct",
  "restore",
  "retrieve",
  "expose",
  "uncover",
]);

/** Moving a body of data somewhere. */
export const MARKETING_TRANSFER_VERBS: readonly string[] = Object.freeze([
  "transfer",
  "migrate",
  "import",
  "export",
  "port",
  "sync",
]);

/**
 * The third-person forms of a verb, which is the shape a new clause uses.
 *
 * "Tomverse clones your memories" rather than "Tomverse clone your memories".
 * Spelled by rule, with the two English endings that matter: a verb ending in
 * a sibilant takes `es`, a verb ending in a consonant and `y` takes `ies`.
 */
const thirdPerson = (verb: string): string => {
  if (/(?:s|x|z|ch|sh)$/u.test(verb)) return `${verb}es`;
  if (/[^aeiou]y$/u.test(verb)) return `${verb.slice(0, -1)}ies`;
  return `${verb}s`;
};

/** Everyday verbs a second clause starts with, beyond the claim vocabulary. */
const ORDINARY_CLAUSE_VERBS: readonly string[] = Object.freeze([
  "is", "are", "was", "were", "be", "been", "being",
  "has", "have", "had", "does", "do", "did",
  "can", "could", "will", "would", "may", "might", "shall", "should", "must",
  "keeps", "stores", "holds", "remembers", "learns", "reads", "writes",
  "saves", "deletes", "offers", "provides", "gives", "makes", "lets",
  "helps", "works", "runs", "shares", "sends", "shows", "uses", "supports",
  "includes", "costs", "starts", "comes", "brings", "turns", "builds",
]);

/**
 * Every verb a clause may start with, third-person and plain.
 *
 * A closed list is a guess about language, and the guess it replaces was
 * worse: "any lower-case word ending in s or ed" read the plural noun in
 * "Anthropic services partner" as a verb and cut a real negation in half.
 */
export const MARKETING_CLAUSE_VERBS: readonly string[] = Object.freeze([
  ...new Set([
    ...ORDINARY_CLAUSE_VERBS,
    ...MARKETING_REPLICATION_VERBS.map(thirdPerson),
    ...MARKETING_RECOVERY_VERBS.map(thirdPerson),
    ...MARKETING_TRANSFER_VERBS.map(thirdPerson),
  ]),
]);
